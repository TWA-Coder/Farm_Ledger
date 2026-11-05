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
// Callers: the portal's /api/events route (synchronises on each request, so screens are never behind) and, later,
// the notifier. Several processes may run sync() at once: inserts are idempotent (block, log_index).
const { encodeArgs, reviveArgs } = require("../shared/event-json");
const dbm = require("./db");

const CHUNK = Number(process.env.INDEXER_CHUNK_BLOCKS || 2000);
const CONFIRMATIONS = Number(process.env.INDEXER_CONFIRMATIONS || 0); // set e.g. 3 on a public network

function reset(db, identity) {
  dbm.tx(db, () => {
    // Only events are cleared. Readings are keyed by transaction hash, so old ones can never match a new transaction,
    // and the oracle may already have logged a reading from the new chain before this reset ran.
    db.exec("DELETE FROM events;");
    dbm.setMeta(db, "indexer_identity", identity);
    dbm.setMeta(db, "indexer_block", -1);
    dbm.setMeta(db, "indexer_block_hash", "");
  });
}

const running = new Map(); // one sync at a time per database in this process

async function sync({ db = dbm.get(), provider, ledger, others = [] }) {
  if (running.has(db)) return running.get(db);
  const p = doSync(db, provider, [ledger, ...others]).finally(() => running.delete(db));
  running.set(db, p);
  return p;
}

async function doSync(db, provider, contracts) {
  const byAddress = new Map();
  for (const c of contracts) byAddress.set((await c.getAddress()).toLowerCase(), c);
  const addresses = [...byAddress.keys()];
  const { chainId } = await provider.getNetwork();
  const identity = `${chainId}:${addresses.join(",")}`; // adding a contract rebuilds the index so its history is read
  if (dbm.getMeta(db, "indexer_identity") !== identity) reset(db, identity);

  const head = await provider.getBlockNumber();
  let cursor = Number(dbm.getMeta(db, "indexer_block") ?? -1);
  if (cursor >= 0) {
    const b = cursor <= head ? await provider.getBlock(cursor) : null;
    if (!b || b.hash !== dbm.getMeta(db, "indexer_block_hash")) { reset(db, identity); cursor = -1; }
  }

  const target = head - CONFIRMATIONS;
  const insert = db.prepare("INSERT OR IGNORE INTO events (block, log_index, tx, name, args) VALUES (?, ?, ?, ?, ?)");
  let added = 0;
  for (let from = cursor + 1; from <= target; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, target);
    const logs = await provider.getLogs({ address: addresses, fromBlock: from, toBlock: to });
    const toHash = (await provider.getBlock(to)).hash;
    dbm.tx(db, () => {
      for (const l of logs) {
        let parsed;
        const c = byAddress.get(l.address.toLowerCase());
        try { parsed = c && c.interface.parseLog(l); } catch { continue; }
        if (!parsed) continue;
        added += Number(insert.run(l.blockNumber, l.index, l.transactionHash.toLowerCase(), parsed.name, JSON.stringify(encodeArgs(parsed.fragment, parsed.args))).changes);
      }
      dbm.setMeta(db, "indexer_block", to);
      dbm.setMeta(db, "indexer_block_hash", toHash);
    });
  }
  return { block: Math.max(cursor, target), added };
}

// Events in chain order. `raw` keeps the {"$big"} encoding (for sending as JSON); otherwise BigInts are revived.
function events(db = dbm.get(), { name = null, raw = false } = {}) {
  const rows = name
    ? db.prepare("SELECT * FROM events WHERE name = ? ORDER BY block, log_index").all(name)
    : db.prepare("SELECT * FROM events ORDER BY block, log_index").all();
  return rows.map((r) => {
    const args = JSON.parse(r.args);
    return { name: r.name, args: raw ? args : reviveArgs(args), block: r.block, idx: r.log_index, tx: r.tx };
  });
}

module.exports = { sync, events };
