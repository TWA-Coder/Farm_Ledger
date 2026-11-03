// Minimal ERC-4337 bundler for the local demo chain (v0.7 EntryPoint), JSON-RPC on http://localhost:4337.
//
//   eth_chainId, eth_supportedEntryPoints, eth_sendUserOperation, eth_getUserOperationReceipt
//
// It simulates each UserOperation (handleOps as a static call, which runs the account's signature check and the
// paymaster's sponsorship rules), then submits it on its own in one handleOps transaction from a relayer key and
// returns once it is mined. A production bundler (e.g. a hosted one on Arbitrum Sepolia) also runs the ERC-7562
// validation rules, a mempool and gas estimation; the RPC format is the same, so the portal can point at one by
// changing aa.bundlerUrl in the deployment file.
//
//   node services/bundler.js          (env: BUNDLER_PORT, BUNDLER_PRIVATE_KEY, RPC_URL, NETWORK)
const http = require("http");
const { ethers } = require("ethers");
const { loadDeployment } = require("./common");
const uo = require("../web/shared/userop");

const PORT = Number(process.env.BUNDLER_PORT || 4337);
// Hardhat development account #10 (public key, local chain only)
const LOCAL_RELAYER = "0xf214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897";

const dep = loadDeployment();
if (!dep.aa) throw new Error("No smart-account contracts in the deployment. Run npm run deploy:local again.");
const local = ["localhost", "hardhat"].includes(dep.network);
const key = process.env.BUNDLER_PRIVATE_KEY || (local ? LOCAL_RELAYER : null);
if (!key) throw new Error("Set BUNDLER_PRIVATE_KEY (a funded key that submits handleOps).");

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || dep.rpcUrl, undefined, { cacheTimeout: -1 });
const relayer = new ethers.Wallet(key, provider);
const entryPoint = new ethers.Contract(dep.aa.entryPoint, uo.ENTRYPOINT_ABI, relayer);
const receipts = new Map(); // userOpHash -> receipt object
let queue = Promise.resolve(); // one handleOps at a time keeps the relayer's nonces in order

class RpcError extends Error { constructor(code, message, data) { super(message); this.code = code; this.data = data; } }

function reasonOf(e) {
  const data = e?.data || e?.info?.error?.data || e?.error?.data;
  try {
    const p = entryPoint.interface.parseError(data);
    if (p) return p.name === "FailedOpWithRevert" ? `${p.args.reason} (${p.args.inner})` : p.args.reason;
  } catch { /* not an EntryPoint error */ }
  return e?.shortMessage || e?.message || String(e);
}

async function sendUserOperation([op, ep]) {
  if (!op || typeof op !== "object") throw new RpcError(-32602, "Missing UserOperation.");
  if (String(ep).toLowerCase() !== dep.aa.entryPoint.toLowerCase()) throw new RpcError(-32602, `Unsupported EntryPoint ${ep}.`);
  const packed = uo.packUserOp(op);
  const userOpHash = await entryPoint.getUserOpHash(packed);
  // Simulation: rejects bad signatures (AA2x), refused sponsorship (AA3x) etc. before spending any gas.
  try { await entryPoint.handleOps.staticCall([packed], relayer.address); } catch (e) { throw new RpcError(-32500, `UserOperation rejected: ${reasonOf(e)}`); }

  const job = queue.then(async () => {
    // Explicit gas limit from the operation's own limits (+ EntryPoint overhead), as bundlers do. Also avoids
    // estimateGas, which some nodes refuse when it starts from a block gas limit above the per-transaction cap.
    const g = (k) => BigInt(op[k] || 0);
    const gasLimit = g("verificationGasLimit") + g("callGasLimit") + g("paymasterVerificationGasLimit") + g("paymasterPostOpGasLimit") + g("preVerificationGas") + 150_000n;
    const tx = await entryPoint.handleOps([packed], relayer.address, { gasLimit });
    const rc = await tx.wait();
    const logs = rc.logs.map((l) => { try { return { ...entryPoint.interface.parseLog(l), log: l }; } catch { return null; } }).filter(Boolean);
    const ev = logs.find((x) => x.name === "UserOperationEvent" && x.args.userOpHash === userOpHash);
    const revert = logs.find((x) => x.name === "UserOperationRevertReason" && x.args.userOpHash === userOpHash);
    receipts.set(userOpHash, {
      userOpHash, sender: op.sender, nonce: ethers.toBeHex(packed.nonce), entryPoint: dep.aa.entryPoint,
      success: Boolean(ev?.args.success), reason: revert ? revert.args.revertReason : "0x",
      actualGasCost: ev ? ethers.toBeHex(ev.args.actualGasCost) : "0x0", actualGasUsed: ev ? ethers.toBeHex(ev.args.actualGasUsed) : "0x0",
      receipt: { transactionHash: rc.hash, blockNumber: ethers.toBeHex(rc.blockNumber), status: ethers.toBeHex(rc.status) },
    });
    console.log(`${new Date().toISOString()}  op ${userOpHash.slice(0, 10)}… from ${op.sender.slice(0, 10)}… ${ev?.args.success ? "succeeded" : "REVERTED"} in tx ${rc.hash.slice(0, 10)}…`);
  });
  queue = job.catch(() => {});
  await job;
  return userOpHash;
}

const METHODS = {
  eth_chainId: async () => ethers.toBeHex((await provider.getNetwork()).chainId),
  eth_supportedEntryPoints: async () => [dep.aa.entryPoint],
  eth_sendUserOperation: sendUserOperation,
  eth_getUserOperationReceipt: async ([hash]) => receipts.get(hash) || null,
};

const server = http.createServer((req, res) => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  if (req.method === "OPTIONS") { res.writeHead(204, headers); return res.end(); }
  if (req.method !== "POST") { res.writeHead(405, headers); return res.end(); }
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 256 * 1024) req.destroy(); });
  req.on("end", async () => {
    let msg;
    try { msg = JSON.parse(body); } catch { res.writeHead(400, headers); return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })); }
    const reply = { jsonrpc: "2.0", id: msg.id ?? null };
    try {
      const fn = METHODS[msg.method];
      if (!fn) throw new RpcError(-32601, `Method not found: ${msg.method}`);
      reply.result = await fn(msg.params || []);
    } catch (e) {
      reply.error = { code: e.code && Number.isInteger(e.code) ? e.code : -32603, message: e.message };
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify(reply));
  });
});

server.listen(PORT, () => console.log(`Bundler on http://localhost:${PORT} · EntryPoint ${dep.aa.entryPoint} · relayer ${relayer.address}`));
