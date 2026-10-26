// USSD gateway callback server (Africa's Talking format).
//   npm run ussd                      -> http://localhost:4000/ussd
// Point the Africa's Talking USSD "callback URL" at https://<your-host>/ussd for a real shortcode.
//
// Env: USSD_PORT (4000)  RPC_URL  AGENT_PRIVATE_KEY (non-local networks)
//
// This service is MONITORING + CLAIM REGISTRATION ONLY. Its key holds CLAIMS_AGENT_ROLE and nothing else, so it
// cannot book or activate a policy, register farmers or assets, or move money. See ussd-core.js.
const http = require("http");
const path = require("path");
const { ethers } = require("ethers");
const { loadDeployment, loadAbi, ROOT } = require("./common");
const { createUssd } = require("./ussd-core");

// Public Hardhat development key (account #9) - LOCAL chain only.
const LOCAL_AGENT = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";

const dep = loadDeployment();
const local = ["localhost", "hardhat"].includes(dep.network);
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || dep.rpcUrl);
const agentKey = process.env.AGENT_PRIVATE_KEY || (local ? LOCAL_AGENT : null);
if (!agentKey) throw new Error("Set AGENT_PRIVATE_KEY (the key that holds CLAIMS_AGENT_ROLE).");
const agent = new ethers.Wallet(agentKey, provider);

const ussd = createUssd({
  provider,
  abi: loadAbi(),
  ledgerAddress: dep.ledger,
  agent,
  usersFile: path.join(ROOT, "services", "out", "ussd-users.json"),
});

(async () => {
  try {
    const ledger = new ethers.Contract(dep.ledger, loadAbi().ledger, provider);
    const ok = await ledger.hasRole(await ledger.CLAIMS_AGENT_ROLE(), agent.address);
    if (!ok) console.warn(`[ussd] WARNING: ${agent.address} does not hold CLAIMS_AGENT_ROLE - claim registration will fail. Re-run deploy.`);
    const bal = await provider.getBalance(agent.address);
    if (bal === 0n) console.warn(`[ussd] WARNING: ${agent.address} has no gas balance.`);
  } catch (e) { console.warn("[ussd] startup check skipped:", e.shortMessage || e.message); }
})();

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  if (req.url === "/health") { res.writeHead(200, CORS); return res.end("ok"); }
  if (req.method === "GET" && (req.url === "/" || req.url === "")) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", ...CORS });
    return res.end("FarmLedger USSD service is running.\n\nThis address is for the phone network (POST /ussd), not for browsers.\nTry it in the simulator: http://localhost:3000/ussd\n");
  }
  if (req.method !== "POST" || !req.url.startsWith("/ussd")) { res.writeHead(404, CORS); return res.end("not found"); }

  let body = "";
  for await (const chunk of req) { body += chunk; if (body.length > 10_000) { res.writeHead(413, CORS); return res.end(); } }
  const ct = req.headers["content-type"] || "";
  const data = ct.includes("json") ? JSON.parse(body || "{}") : Object.fromEntries(new URLSearchParams(body));

  const t0 = Date.now();
  const reply = await ussd.handle({ sessionId: data.sessionId || "s", phoneNumber: data.phoneNumber, text: data.text || "" });
  console.log(`[ussd] ${data.phoneNumber} text="${data.text || ""}" -> ${reply.split("\n")[0]} (${Date.now() - t0} ms)`);
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", ...CORS });
  res.end(reply);
});

const port = Number(process.env.USSD_PORT || 4000);
server.listen(port, () => console.log(`USSD service on http://localhost:${port}/ussd  (registered farmers only: 250788000001 Aline, 250788000002 Jean - monitoring and claims)`));
