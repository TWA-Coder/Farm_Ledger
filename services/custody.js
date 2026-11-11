// Key custody: the ONLY process that holds PHONE_KEY_SECRET and can decrypt farmers' phone-account keys and staff
// keys. The USSD service, the notifier and the portal server ask it over loopback HTTP:
//   farmers (phone accounts, smart accounts with sponsored fees)
//   POST /keys          {phone}                     create the phone's account key (stored encrypted) -> {account}
//   POST /calls         {phone, calls}              sign and send a sponsored operation for that phone -> {hash}
//   POST /sign          {phone, message}            sign a FarmLedger document request as that account -> {signature}
//   staff (portal logins: admin, underwriter, vet, agent; ordinary accounts, services/staff-keys.js)
//   POST /staff/create  {username, name, role, phone?, createdBy}   new login key, topped up with gas -> {address}
//   POST /staff/send    {username, tx: {to, data}}  sign and send a transaction to a FarmLedger contract -> {hash}
//   POST /staff/sign    {username, message} | {username, typed: {domain, types, value}}  -> {signature}
// Every request needs X-Custody-Token (CUSTODY_TOKEN, see custody-client.js). It listens on 127.0.0.1 only. The
// caller checks the PIN or the password session first; custody limits what any caller can make a key do:
//   farmers: FarmLedger.registerFarmer / updatePhone / registerPlot / registerAnimal / fileClaim / expirePolicy,
//            PolicyDesk.join / acceptOffer / declineOffer, token.approve(FarmLedger), token.transfer(<treasury>) and,
//            on the local chain only, token.mint (test money) - never send money anywhere else.
//   staff:   only calls to the deployed FarmLedger contracts, no coins attached (each contract checks the role).
//   both:    only messages in FarmLedger's document-request format, typed data only for the FarmLedger contract.
//
//   npm run phone starts it automatically. Alone: npm run custody
const http = require("http");
const { ethers } = require("ethers");
const { loadDeployment, loadAbi } = require("./common");
const { createPhoneAccounts, loadSecret } = require("./phone-accounts");
const { LOCAL_TREASURY } = require("./payments");
const { createStaffKeys } = require("./staff-keys");
const { custodyConfig } = require("./custody-client");

function allowedCalls({ abi, ledger, desk, token, treasury, local = false }) {
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
      const ok = (eq(c.to, ledger) && ["registerFarmer", "updatePhone", "registerPlot", "registerAnimal", "fileClaim", "expirePolicy"].includes(f.name))
        || (eq(c.to, desk) && ["join", "acceptOffer", "declineOffer"].includes(f.name))
        || (eq(c.to, token) && f.name === "approve" && eq(f.args[0], ledger))
        || (eq(c.to, token) && f.name === "transfer" && eq(f.args[0], treasury))
        || (local && eq(c.to, token) && f.name === "mint");
      if (!ok) return `${f.name} is not allowed${f.name === "transfer" ? " to that address" : ""}`;
    }
    return null;
  };
}

// Staff transactions: only to the deployed FarmLedger contracts and with no coins attached. What each staff member may
// do there is decided by the contracts' roles, the same as for anyone else.
function allowedStaffTx(contracts) {
  const ok = new Set(contracts.filter(Boolean).map((a) => a.toLowerCase()));
  return (tx) => {
    if (!tx || !ethers.isAddress(tx.to || "")) return "a transaction needs a contract address";
    if (!ok.has(tx.to.toLowerCase())) return `contract ${tx.to} is not a FarmLedger contract`;
    if (tx.value && BigInt(tx.value) !== 0n) return "no coins may be sent";
    if (typeof tx.data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(tx.data)) return "unreadable call data";
    return null;
  };
}

const MESSAGE_PREFIX = "FarmLedger document request\n"; // web/shared/signing.js
function allowedMessage(m) { return typeof m === "string" && m.startsWith(MESSAGE_PREFIX) && m.length < 2000 ? null : "only FarmLedger document requests may be signed"; }
function allowedTyped(t, ledger) {
  const d = t && t.domain;
  return d && d.name === "FarmLedger" && String(d.verifyingContract || "").toLowerCase() === ledger.toLowerCase() ? null : "only FarmLedger claim decisions may be signed";
}

// The contract error behind a refused transaction, by name (the portal turns it into plain words).
function revertName(e, ifaces) {
  for (const data of [e?.data, e?.info?.error?.data, e?.error?.data]) {
    if (typeof data !== "string" || data.length < 10) continue;
    for (const i of ifaces) { try { const p = i.parseError(data); if (p) return p.name; } catch { /* not this contract */ } }
  }
  return e?.revert?.name || null;
}

// Wallet that tops up staff accounts with gas: FUNDER_PRIVATE_KEY, else the deployer (PRIVATE_KEY), else (local chain)
// Hardhat's public development account #0.
const LOCAL_FUNDER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const STAFF_GAS = ethers.parseEther(process.env.STAFF_GAS || "0.05");

function main() {
  const dep = loadDeployment();
  const abi = loadAbi();
  const local = ["localhost", "hardhat"].includes(dep.network);
  const { token } = custodyConfig({ local });
  if (token.length < 16) throw new Error("CUSTODY_TOKEN must have at least 16 characters.");
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || dep.rpcUrl, undefined, { cacheTimeout: -1 });
  const accounts = createPhoneAccounts({ provider, aa: dep.aa, ledgerAddress: dep.ledger, deskAddress: dep.policyDesk, abi, secret: loadSecret({ local }), sendSms: async () => {} });
  const treasury = process.env.TREASURY_ADDRESS || new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY || LOCAL_TREASURY).address;
  const check = allowedCalls({ abi, ledger: dep.ledger, desk: dep.policyDesk, token: dep.token, treasury, local });
  const staffKeys = createStaffKeys({ secret: loadSecret({ local }) });
  const checkStaff = allowedStaffTx([dep.ledger, dep.policyDesk, dep.token, dep.cropClaims]);
  const ifaces = [abi.ledger, abi.policyDesk, abi.token, abi.cropClaims].filter(Boolean).map((a) => new ethers.Interface(a));
  const funderKey = process.env.FUNDER_PRIVATE_KEY || process.env.PRIVATE_KEY || (local ? LOCAL_FUNDER : null);
  const funder = funderKey ? new ethers.Wallet(funderKey, provider) : null;
  let funding = Promise.resolve();
  // Keep a staff account able to pay for its transactions (one top-up at a time, so the funder's nonces stay in order).
  const ensureGas = (address) => (funding = funding.then(async () => {
    if (!funder || (await provider.getBalance(address)) >= STAFF_GAS / 2n) return;
    await (await funder.sendTransaction({ to: address, value: STAFF_GAS })).wait();
    console.log(`[custody] gas top-up ${address}: ${ethers.formatEther(STAFF_GAS)}`);
  }).catch((e) => console.warn(`[custody] gas top-up for ${address} failed: ${e.shortMessage || e.message}`)));
  const staffSending = new Map(); // username -> promise: one transaction at a time per staff key (nonces)

  async function staffRoute(route, j, send) {
    if (route === "/staff/create") {
      const r = staffKeys.create({ username: j.username, name: j.name, role: j.role, phone: j.phone || null, createdBy: j.createdBy || null, privateKey: null });
      await ensureGas(r.address);
      return send(200, r);
    }
    if (route === "/staff/send") {
      const why = checkStaff(j.tx);
      if (why) { console.warn(`[custody] refused staff tx for ${j.username}: ${why}`); return send(403, { error: `Refused by custody: ${why}.` }); }
      const wallet = staffKeys.walletFor(j.username, provider);
      const prev = staffSending.get(wallet.address) || Promise.resolve();
      const job = prev.catch(() => {}).then(async () => {
        await ensureGas(wallet.address);
        return wallet.sendTransaction({ to: j.tx.to, data: j.tx.data });
      });
      staffSending.set(wallet.address, job);
      try {
        const tx = await job;
        return send(200, { hash: tx.hash });
      } catch (e) {
        const name = revertName(e, ifaces);
        return send(name ? 422 : 500, { error: e.shortMessage || e.message, revert: name ? { name } : undefined });
      }
    }
    if (route === "/staff/sign") {
      const wallet = staffKeys.walletFor(j.username, provider);
      if (j.typed) {
        const why = allowedTyped(j.typed, dep.ledger);
        if (why) return send(403, { error: `Refused by custody: ${why}.` });
        return send(200, { signature: await wallet.signTypedData(j.typed.domain, j.typed.types, j.typed.value) });
      }
      const why = allowedMessage(j.message);
      if (why) return send(403, { error: `Refused by custody: ${why}.` });
      return send(200, { signature: await wallet.signMessage(j.message) });
    }
    return send(404, { error: "not found" });
  }

  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/health") return send(200, { ok: true });
    if (req.method !== "POST") return send(405, { error: "POST only" });
    if ((req.headers["x-custody-token"] || "") !== token) return send(401, { error: "bad custody token" });
    let body = "";
    for await (const c of req) { body += c; if (body.length > 64 * 1024) return send(413, { error: "too large" }); }
    let j;
    try { j = JSON.parse(body); } catch { return send(400, { error: "bad json" }); }
    if (req.url.startsWith("/staff/")) {
      try { return await staffRoute(req.url, j, send); } catch (e) { return send(400, { error: e.shortMessage || e.message }); }
    }
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
      if (req.url === "/sign") {
        const why = allowedMessage(j.message);
        if (why) return send(403, { error: `Refused by custody: ${why}.` });
        return send(200, { signature: await accounts.signMessageFor(phone, j.message) });
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

module.exports = { allowedCalls, allowedStaffTx, allowedMessage, allowedTyped };
