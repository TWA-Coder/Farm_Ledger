// Past contract events for the USSD service, in a form public RPC providers accept.
//
// contract.queryFilter(filter, 0, "latest") asks for every block in one request. A local node answers it, but
// Alchemy's free plan answers eth_getLogs for at most 10 blocks. So, like the portal's indexer (web/server/indexer.js):
//   - scanning starts at the deployment block (deployment.json "deployBlock"), not block 0;
//   - with INDEXER_RPC_URL set, a node that accepts wide ranges (e.g. a public one) only FINDS the blocks holding
//     matching events, INDEXER_CHUNK_BLOCKS at a time, and each such block's events are then read from the main
//     provider by block hash. The scanner can make a lookup incomplete, but cannot invent an event.
// Without INDEXER_RPC_URL (the local chain) it is a plain queryFilter from fromBlock.
const { ethers } = require("ethers");

let scanner; // undefined = not created yet, null = not configured
function scanProvider() {
  if (scanner === undefined) {
    const url = process.env.INDEXER_RPC_URL;
    scanner = url ? new ethers.JsonRpcProvider(url, undefined, { cacheTimeout: -1 }) : null;
  }
  return scanner;
}

// Same result shape as contract.queryFilter: EventLog objects (args, blockNumber, index) in chain order.
async function queryEvents(contract, filter, fromBlock = 0) {
  const scan = scanProvider();
  if (!scan) return contract.queryFilter(filter, fromBlock, "latest");
  const provider = contract.runner.provider || contract.runner;
  const address = await contract.getAddress();
  const topics = await filter.getTopicFilter();
  const fragment = filter.fragment;
  const chunk = Number(process.env.INDEXER_CHUNK_BLOCKS || 2000);
  const head = await provider.getBlockNumber();
  const blocks = new Set();
  for (let from = Number(fromBlock) || 0; from <= head; from += chunk) {
    const to = Math.min(from + chunk - 1, head);
    for (const l of await scan.getLogs({ address, topics, fromBlock: from, toBlock: to })) blocks.add(l.blockNumber);
  }
  const out = [];
  for (const n of [...blocks].sort((a, b) => a - b)) {
    const block = await provider.getBlock(n);
    if (!block) continue;
    for (const l of await provider.getLogs({ address, topics, blockHash: block.hash })) out.push(new ethers.EventLog(l, contract.interface, fragment));
  }
  return out;
}

module.exports = { queryEvents };
