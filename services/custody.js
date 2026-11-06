// Key custody for phone accounts: the ONLY process that holds PHONE_KEY_SECRET and can decrypt farmers' keys.
// The USSD service and the notifier (which face the internet / handle payments) ask it over loopback HTTP:
//   POST /keys   {phone}          create the phone's account key (stored encrypted)   -> {account}
//   POST /calls  {phone, calls}   sign and send a sponsored operation for that phone  -> {hash}
// Every request needs X-Custody-Token (CUSTODY_TOKEN). It listens on 127.0.0.1 only.
//
// Defence in depth: even a compromised caller can only make a farmer's account do what the workflow needs:
//   FarmLedger.registerFarmer / updatePhone, PolicyDesk.join / acceptOffer / declineOffer,
//   token.approve(FarmLedger, ...) and token.transfer(<treasury>, ...)   - never send money anywhere else.
// The PIN is checked by the caller (USSD menu) before it asks.
//
//   npm run phone starts it automatically with a fresh token. Alone: CUSTODY_TOKEN=... npm run custody
const http = require("http");
const { ethers } = require("ethers");
const { loadDeployment, loadAbi } = require("./common");
const { createPhoneAccounts, loadSecret } = require("./phone-accounts");
const { LOCAL_TREASURY } = require("./payments");

function allowedCalls({ abi, ledger, desk, token, treasury }) {
  const L = new ethers.Interface(abi.ledger), T = new ethers.Interface(abi.token), D = abi.policyDesk ? new ethers.Interface(abi.policyDesk) : null;
  const eq = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  return function check(calls) {
    if (!Array.isArray(calls) || calls.length === 0 || calls.length > 4) return "1 to 4 calls";
    for (const c of calls) {
      if (c.value && BigInt(c.value) !== 0n) return "no ETH may be sent";
      let f;
      try {
        if (eq(c.to, ledger)) f = L.parseTransaction({ data: c.data });
        else if (D && eq(c.to, desk)) f = D.parseTransaction({ data: c.data });
        else if (eq(c.to, token)) f = T.parseTransaction({ data: c.data });
      } catch { return "unreadable call"; }
      if (!f) return `contract ${c.to} is not allowed`;
      const ok = (eq(c.to, ledger) && ["registerFarmer", "updatePhone"].includes(f.name))
        || (eq(c.to, desk) && ["join", "acceptOffer", "declineOffer"].includes(f.name))
        || (eq(c.to, token) && f.name === "approve" && eq(f.args[0], ledger))
        || (eq(c.to, token) && f.name === "transfer" && eq(f.args[0], treasury));
      if (!ok) return `${f.name} is not allowed${f.name === "transfer" ? " to that address" : ""}`;
    }
    return null;
  };
}

function main() {
  const dep = loadDeployment();
  const abi = loadAbi();
  const local = ["localhost", "hardhat"].includes(dep.network);
  const token = process.env.CUSTODY_TOKEN || "";
  if (token.length < 16) throw new Error("Set CUSTODY_TOKEN (at least 16 characters); npm run phone does this for you.");
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || dep.rpcUrl, undefined, { cacheTimeout: -1 });
  const accounts = createPhoneAccounts({ provider, aa: dep.aa, ledgerAddress: dep.ledger, deskAddress: dep.policyDesk, abi, secret: loadSecret({ local }), sendSms: async () => {} });
  const treasury = process.env.TREASURY_ADDRESS || new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY || LOCAL_TREASURY).address;
  const check = allowedCalls({ abi, ledger: dep.ledger, desk: dep.policyDesk, token: dep.token, treasury });

  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/health") return send(200, { ok: true });
    if (req.method !== "POST") return send(405, { error: "POST only" });
    if ((req.headers["x-custody-token"] || "") !== token) return send(401, { error: "bad custody token" });
    let body = "";
    for await (const c of req) { body += c; if (body.length > 64 * 1024) return send(413, { error: "too large" }); }
    let j;
    try { j = JSON.parse(body); } catch { return send(400, { error: "bad json" }); }
    const phone = String(j.phone || "").replace(/\D/g, "");
    if (!/^\d{9,15}$/.test(phone)) return send(400, { error: "bad phone" });
    try {
      if (req.url === "/keys") return send(200, await accounts.keyring.createKey(phone));
      if (req.url === "/calls") {
        const why = check(j.calls);
        if (why) { console.warn(`[custody] refused for +${phone}: ${why}`); return send(403, { error: `Refused by custody: ${why}.` }); }
        const tx = await accounts.keyring.sendCalls(phone, j.calls.map((c) => ({ to: c.to, data: c.data })));
        return send(200, { hash: tx.hash });
      }
      return send(404, { error: "not found" });
    } catch (e) {
      return send(e.revert ? 422 : 500, { error: e.shortMessage || e.message, revert: e.revert ? { name: e.revert.name } : undefined });
    }
  });
  const port = Number(process.env.CUSTODY_PORT || 4100);
  server.listen(port, "127.0.0.1", () => console.log(`Key custody on http://127.0.0.1:${port} (loopback only) · treasury ${treasury}`));
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { allowedCalls };
