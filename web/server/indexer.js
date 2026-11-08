// Index of FarmLedger contract events in the off-chain database (db.js, table "events").
//
// Before this, every screen refresh asked the node for every log since block 0. That works on a fresh local chain
// but public RPC providers refuse large block ranges, and it gets slower with every block. The indexer instead reads
// only the blocks it has not seen, in chunks, and remembers where it stopped.
//
// Chain resets: a restarted local node mines new blocks with the same numbers (and the redeployed contract lands at
// the same address), so the indexer keeps the hash of the last block it indexed. If that block's hash changed or the
// chain is now shorter, the indexed data belongs to an old chain and is cleared and rebuilt.
//
// Other contracts of the deployment (CropClaims) are indexed into the same table; their event names do not overlap
// with FarmLedger's.
//
// Scanning through a second endpoint (INDEXER_RPC_URL, optional): Alchemy's free plan answers eth_getLogs for at most
// 10 blocks, which on Amoy (a block every ~2 s) means thousands of requests a day. With INDEXER_RPC_URL set, a node
// that accepts wide ranges (e.g. a public one) only FINDS the blocks that hold our events; the events of each such
// block are then read from the main provider (RPC_URL) by block hash. So the scanner can make the index slower or
// incomplete if it misbehaves, but it cannot put an event in the index (and an SMS on someone's phone) that the main
// provider does not confirm.
//
// Callers: the portal's /api/events route (synchronises on each request, so screens are never behind) and, later,
// the notifier. Several processes may run sync() at once: inserts are idempotent (block, log_index), and each write
// takes a transaction-level advisory lock and never moves the cursor backwards.
const { encodeArgs, reviveArgs } = require("../shared/event-json");
const dbm = require("./db");

const CHUNK = Number(process.env.INDEXER_CHUNK_BLOCKS || 2000);
let scanner; // undefined = not created yet, null = not configured

function scanProvider() {
  if (scanner === undefined) {
    const url = process.env.INDEXER_RPC_URL;
    if (url) {
      const { ethers } = require("ethers");
      scanner = new ethers.JsonRpcProvider(url, undefined, { cacheTimeout: -1 });
    } else scanner = null;
  }
  return scanner;
}

// Logs of `addresses` in [from, to]. With a scanner: blocks found by the scanner, events read from `provider`.
async function readLogs(provider, scan, addresses, from, to) {
  if (!scan) return provider.getLogs({ address: addresses, fromBlock: from, toBlock: to });
  const blocks = [...new Set((await scan.getLogs({ address: addresses, fromBlock: from, toBlock: to })).map((l) => l.blockNumber))];
  const logs = [];
  for (const n of blocks.sort((a, b) => a - b)) {
    const block = await provider.getBlock(n);
    if (block) logs.push(...(await provider.getLogs({ address: addresses, blockHash: block.hash })));
  }
  return logs;
}
const CONFIRMATIONS = Number(process.env.INDEXER_CONFIRMATIONS || 0); // set e.g. 3 on a public network

const INDEX_LOCK = 724_310_002; // advisory lock id for index writes

function reset(db, identity) {
  return db.tx(async (t) => {
    await t.one(`SELECT pg_advisory_xact_lock(${INDEX_LOCK})`);
    // Only events are cleared. Readings are keyed by transaction hash, so old ones can never match a new transaction,
    // and the oracle may already have logged a reading from the new chain before this reset ran.
    await t.run("DELETE FROM events");
    await dbm.setMeta(t, "indexer_identity", identity);
    // bumped on every rebuild: a redeployed local chain reuses the same addresses, so the identity alone cannot tell
    // the notifier that its cursor belongs to an old chain
    await dbm.setMeta(t, "indexer_epoch", Number((await dbm.getMeta(t, "indexer_epoch")) || 0) + 1);
    await dbm.setMeta(t, "indexer_block", -1);
    await dbm.setMeta(t, "indexer_block_hash", "");
  });
}

const running = new Map(); // one sync at a time per database in this process

// startBlock: the block the contracts were deployed in (deployment.json "deployBlock"). Nothing before it can hold
// their events, and on a public chain scanning from block 0 would take thousands of requests.
async function sync({ db = dbm.get(), provider, ledger, others = [], startBlock = 0 }) {
  if (running.has(db)) return running.get(db);
  const p = doSync(db, provider, [ledger, ...others], Number(startBlock) || 0).finally(() => running.delete(db));
  running.set(db, p);
  return p;
}

async function doSync(db, provider, contracts, startBlock) {
  const byAddress = new Map();
  for (const c of contracts) byAddress.set((await c.getAddress()).toLowerCase(), c);
  const addresses = [...byAddress.keys()];
  const { chainId } = await provider.getNetwork();
  const scan = scanProvider();
  if (scan && (await scan.getNetwork()).chainId !== chainId) throw new Error("INDEXER_RPC_URL is on a different chain than RPC_URL");
  const identity = `${chainId}:${addresses.join(",")}`; // adding a contract rebuilds the index so its history is read
  if ((await dbm.getMeta(db, "indexer_identity")) !== identity) await reset(db, identity);

  const head = await provider.getBlockNumber();
  let cursor = Number((await dbm.getMeta(db, "indexer_block")) ?? -1);
  if (cursor >= 0) {
    const b = cursor <= head ? await provider.getBlock(cursor) : null;
    if (!b || b.hash !== (await dbm.getMeta(db, "indexer_block_hash"))) { await reset(db, identity); cursor = -1; }
  }

  const target = head - CONFIRMATIONS;
  let added = 0;
  for (let from = Math.max(cursor + 1, startBlock); from <= target; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, target);
    const logs = await readLogs(provider, scan, addresses, from, to);
    const toHash = (await provider.getBlock(to)).hash;
    await db.tx(async (t) => {
      await t.one(`SELECT pg_advisory_xact_lock(${INDEX_LOCK})`);
      for (const l of logs) {
        let parsed;
        const c = byAddress.get(l.address.toLowerCase());
        try { parsed = c && c.interface.parseLog(l); } catch { continue; }
        if (!parsed) continue;
        added += (await t.run("INSERT INTO events (block, log_index, tx, name, args) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
          [l.blockNumber, l.index, l.transactionHash.toLowerCase(), parsed.name, JSON.stringify(encodeArgs(parsed.fragment, parsed.args))])).changes;
      }
      if (Number((await dbm.getMeta(t, "indexer_block")) ?? -1) < to) { // another process may already be further
        await dbm.setMeta(t, "indexer_block", to);
        await dbm.setMeta(t, "indexer_block_hash", toHash);
      }
    });
  }
  return { block: Math.max(cursor, target), added };
}

// Events in chain order. `raw` keeps the {"$big"} encoding (for sending as JSON); otherwise BigInts are revived.
// `after` = {block, idx}: only events after that position (the notifier's cursor).
async function events(db = dbm.get(), { name = null, raw = false, after = null } = {}) {
  const where = [], params = [];
  if (name) { where.push("name = ?"); params.push(name); }
  if (after) { where.push("(block > ? OR (block = ? AND log_index > ?))"); params.push(after.block, after.block, after.idx); }
  const rows = await db.all(`SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY block, log_index`, params);
  return rows.map((r) => {
    const args = JSON.parse(r.args);
    return { name: r.name, args: raw ? args : reviveArgs(args), block: r.block, idx: r.log_index, tx: r.tx };
  });
}

module.exports = { sync, events, readLogs };
