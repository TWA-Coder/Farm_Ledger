// Past contract events for the USSD service, in a form public RPC providers accept.
//
// contract.queryFilter(filter, 0, "latest") asks for every block in one request. A local node answers it, but
// Alchemy's free plan answers eth_getLogs for at most 10 blocks. So, like the portal's indexer (web/server/indexer.js):
//   - scanning starts at the deployment block (deployment.json "deployBlock"), not block 0;
//   - with INDEXER_RPC_URL set, a node that accepts wide ranges (e.g. a public one) only FINDS the blocks holding
//     matching events, INDEXER_CHUNK_BLOCKS at a time, and each such block's events are then read from the main
//     provider by block hash. The scanner can make a lookup incomplete, but cannot invent an event.
//   - results are remembered per filter: the next lookup scans only the blocks after the last one. Blocks within
//     INDEXER_CONFIRMATIONS of the head are read again every time (a public chain may still replace them). Without
//     this, every USSD screen rescanned the whole chain since the deployment (seconds, and growing with every block).
// Without INDEXER_RPC_URL (the local chain) it is a plain queryFilter from fromBlock, as before: a restarted local
// chain reuses block numbers, so nothing is remembered there.
const { ethers } = require("ethers");

let scanner; // undefined = not created yet, null = not configured
function scanProvider() {
  if (scanner === undefined) {
    const url = process.env.INDEXER_RPC_URL;
    scanner = url ? new ethers.JsonRpcProvider(url, undefined, { cacheTimeout: -1 }) : null;
  }
  return scanner;
}

// One retry after a short pause: public nodes and free plans refuse a request now and then (rate limits), and a
// single refusal should not end a farmer's USSD session with "Service busy".
async function twice(call) {
  try { return await call(); } catch { await new Promise((r) => setTimeout(r, 400)); return call(); }
}

// filter key -> { upTo: last block whose events are remembered, logs: EventLog[] up to upTo, in chain order }
const remembered = new Map();

// Same result shape as contract.queryFilter: EventLog objects (args, blockNumber, index) in chain order.
// opts.scan: the scanning provider (tests); default from INDEXER_RPC_URL.
async function queryEvents(contract, filter, fromBlock = 0, { scan = scanProvider(), confirmations = Number(process.env.INDEXER_CONFIRMATIONS || 0) } = {}) {
  if (!scan) return contract.queryFilter(filter, fromBlock, "latest");
  const provider = contract.runner.provider || contract.runner;
  const address = await contract.getAddress();
  const topics = await filter.getTopicFilter();
  const fragment = filter.fragment;
  const key = `${(await provider.getNetwork()).chainId}|${address.toLowerCase()}|${JSON.stringify(topics)}|${Number(fromBlock) || 0}`;
  const chunk = Number(process.env.INDEXER_CHUNK_BLOCKS || 2000);
  const head = await twice(() => provider.getBlockNumber());
  const safe = head - Math.max(0, confirmations); // events up to here are remembered
  const known = remembered.get(key) || { upTo: (Number(fromBlock) || 0) - 1, logs: [] };

  const blocks = new Set();
  for (let from = known.upTo + 1; from <= head; from += chunk) {
    const to = Math.min(from + chunk - 1, head);
    for (const l of await twice(() => scan.getLogs({ address, topics, fromBlock: from, toBlock: to }))) blocks.add(l.blockNumber);
  }
  const settled = [], recent = [];
  for (const n of [...blocks].sort((a, b) => a - b)) {
    const block = await twice(() => provider.getBlock(n));
    if (!block) continue;
    for (const l of await twice(() => provider.getLogs({ address, topics, blockHash: block.hash }))) (n <= safe ? settled : recent).push(new ethers.EventLog(l, contract.interface, fragment));
  }
  if (safe > known.upTo) remembered.set(key, { upTo: safe, logs: [...known.logs, ...settled] });
  return [...known.logs, ...settled, ...recent];
}

module.exports = { queryEvents, _forget: () => remembered.clear() };
