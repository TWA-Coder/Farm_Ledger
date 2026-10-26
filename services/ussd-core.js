// USSD menu engine - MONITORING AND CLAIM REGISTRATION ONLY (Africa's Talking callback format).
//
// Request  : sessionId, phoneNumber, text   ("text" = every answer so far joined by "*")
// Response : "CON <screen>"  (session continues)   or   "END <screen>"  (session over)
//
// What this channel does
//   1. My policies    - read-only: list the caller's policies and show one in detail.
//   2. Report a claim - registers a livestock death claim for one of the caller's ACTIVE policies.
//   3. Claim status   - read-only: progress of the caller's claims (vet signatures, outcome).
//
// What it cannot do (by construction, not just by menu design)
//   * Policies are booked, priced, activated and paid for ONLY on the web portal.
//   * The service holds a single key that has CLAIMS_AGENT_ROLE and nothing else. On-chain that role can call
//     fileClaimFor() and nothing else: it cannot book a policy (buyPolicy needs the holder's own key), register
//     farmers, plots or animals, move or mint money, or sign for a vet.
//   * The write-capable contract object below is built from a one-function interface, so the code cannot even
//     express another write. A unit test also scans this file for every state-changing method name.
//   * There are no custodial wallets, no gas sponsorship and no Mobile Money collection here.
//
// Identity = the phone number supplied by the network, matched to the phone hash stored when the farmer
// registered on the web. Registering a claim also needs a 4-digit PIN (3 wrong tries lock the number for 30
// minutes). A PIN alone is weak: production needs operator-grade controls (SIM-swap checks, rate limits).
// Screens are kept under 182 characters (the USSD limit).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");

const hashOf = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const fromB32 = (x) => { try { return ethers.decodeBytes32String(x); } catch { return x; } };
const fmt = (n) => Number(n).toLocaleString("en-US");
const date = (ts) => new Date(Number(ts) * 1000).toLocaleDateString("en-GB");
const CON = (m) => "CON " + m;
const END = (m) => "END " + m;

const COVER = ["Drought", "Flood", "Crop stress", "Cattle death"];
const STATUS = ["Active", "Claim pending", "Paid out", "Expired"];
const LOCK_MS = 30 * 60 * 1000;
const WRITE_SURFACE = ["fileClaimFor"]; // the ONLY state-changing call this service can make

const NOT_REGISTERED = "This number is not registered. Register and buy cover on the FarmLedger website or at an agent. USSD is for checking cover and claims.";

const FRIENDLY = {
  WaitingPeriodNotElapsed: "Claims are not open yet for this policy.",
  PolicyNotActive: "This policy is not active.",
  OutsidePolicyPeriod: "The cover period has ended.",
  WrongAssetType: "This cover pays automatically. No claim needed.",
  EnforcedPause: "Service is paused. Try later.",
  AccessControlUnauthorizedAccount: "Service is not set up. Try later.",
};

function createUssd(opts) {
  const { provider, abi, ledgerAddress, agent, usersFile } = opts;
  if (!agent) throw new Error("agent wallet (CLAIMS_AGENT_ROLE) is required");

  const sessions = new Map();
  const replyCache = new Map(); // "sessionId|text" -> {reply, at}: a network retry must never repeat a transaction
  const ledgerRO = new ethers.Contract(ledgerAddress, abi.ledger, provider);
  // The only write path. A one-function interface: nothing else can be called through this object.
  const claimsAgent = new ethers.Contract(ledgerAddress, ["function fileClaimFor(uint256 policyId, bytes32 evidenceHash) returns (uint256)"], agent);

  // ---------------------------------------------------------------- storage (PIN state only)
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
  const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
  const getUser = (phone) => readJson(usersFile, {})[phone] || {};
  const putUser = (phone, patch) => { const all = readJson(usersFile, {}); all[phone] = { ...(all[phone] || {}), ...patch }; writeJson(usersFile, all); };

  const hashPin = (pin, salt) => crypto.createHash("sha256").update(salt + ":" + pin).digest("hex");
  function setPin(phone, pin) {
    const salt = crypto.randomBytes(8).toString("hex");
    putUser(phone, { salt, pinHash: hashPin(pin, salt), tries: 0, lockedUntil: 0, pinSetAt: new Date().toISOString() });
  }
  function checkPin(phone, pin) {
    const u = getUser(phone);
    if (u.lockedUntil && Date.now() < u.lockedUntil) return { ok: false, locked: true };
    if (u.pinHash && hashPin(pin, u.salt) === u.pinHash) { putUser(phone, { tries: 0 }); return { ok: true }; }
    const tries = (u.tries || 0) + 1;
    putUser(phone, tries >= 3 ? { tries: 0, lockedUntil: Date.now() + LOCK_MS } : { tries });
    return { ok: false, locked: tries >= 3 };
  }

  // ---------------------------------------------------------------- identity: phone -> registered farmer
  const normalize = (p) => String(p || "").replace(/\D/g, "");
  const phoneIndex = new Map(); // phoneHash -> farmer address
  async function farmerByPhone(phone) {
    const h = hashOf(phone);
    if (phoneIndex.has(h)) return phoneIndex.get(h);
    const evs = await ledgerRO.queryFilter(ledgerRO.filters.FarmerRegistered(), 0, "latest");
    for (const e of evs) phoneIndex.set(e.args.phoneHash, e.args.farmer);
    return phoneIndex.get(h) || null;
  }

  // ---------------------------------------------------------------- helpers
  async function chainNow() { return Number((await provider.getBlock("latest")).timestamp); }
  const list = (title, items) => CON(`${title}\n${items.map((t, i) => `${i + 1}. ${t}`).join("\n")}`);
  const pickIndex = (v, len) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= len ? n - 1 : -1; };
  async function needPin(env) {
    const p = env.next();
    if (p === undefined) return CON("Enter your PIN to confirm");
    const r = checkPin(env.phone, p);
    if (r.ok) return null;
    return END(r.locked ? "Too many wrong PINs. Number locked for 30 minutes." : "Wrong PIN.");
  }

  async function describeAsset(policy, prod) {
    if (Number(prod.cover) === 3) return fromB32((await ledgerRO.getAnimal(policy.assetId)).tagId);
    const plot = await ledgerRO.getPlot(policy.assetId);
    return `${fromB32(plot.crop)} ${fmt(plot.areaM2)}m2`;
  }
  async function policiesOf(addr) {
    const ids = await ledgerRO.policiesOf(addr);
    const out = [];
    for (const id of [...ids].reverse()) {
      const policy = await ledgerRO.getPolicy(id);
      const prod = await ledgerRO.getProduct(policy.productId);
      out.push({ id: Number(id), policy, prod, cover: Number(prod.cover), status: Number(policy.status) });
    }
    return out;
  }

  // ---------------------------------------------------------------- 1. My policies (read-only)
  async function myPolicies(env) {
    const all = await policiesOf(env.addr);
    if (!all.length) return END("You have no policies yet. Buy cover on the FarmLedger website or at an agent.");
    const shown = all.slice(0, 5);
    const a = env.next();
    if (a === undefined) return list("Your policies:", shown.map((p) => `#${p.id} ${COVER[p.cover]} ${STATUS[p.status]}`));
    const i = pickIndex(a, shown.length); if (i < 0) return END("Invalid choice.");
    const p = shown[i];
    const lines = [
      `Policy #${p.id} ${COVER[p.cover]}`,
      await describeAsset(p.policy, p.prod),
      `Cover ${fmt(p.policy.sumInsured)} RWF`,
      `Premium ${fmt(p.policy.premium)} RWF`,
      `Valid ${date(p.policy.start)} - ${date(p.policy.end)}`,
      `Status: ${STATUS[p.status]}`,
    ];
    if (p.cover !== 3 && p.status === 0) lines.push("Pays by itself on weather data.");
    return END(lines.join("\n"));
  }

  // ---------------------------------------------------------------- 2. Report a claim (registers a claim only)
  async function reportClaim(env) {
    const all = await policiesOf(env.addr);
    const cattle = all.filter((p) => p.cover === 3 && p.status === 0);
    if (!cattle.length) {
      return END(all.some((p) => p.cover !== 3 && p.status === 0)
        ? "Crop cover pays by itself when weather data triggers it. No claim needed."
        : "You have no active cattle cover to claim on.");
    }
    const labels = [];
    for (const p of cattle) labels.push(`${await describeAsset(p.policy, p.prod)} (policy #${p.id})`);
    const a = env.next();
    if (a === undefined) return list("Which animal died?", labels);
    const i = pickIndex(a, cattle.length); if (i < 0) return END("Invalid choice.");
    const p = cattle[i];

    const opens = Number(p.policy.start) + Number(await ledgerRO.waitingPeriod());
    if ((await chainNow()) < opens) return END(`Claims for this policy open on ${date(opens)}.`);

    const c = env.next();
    if (c === undefined) return CON(`Report death of ${labels[i]}?\n1. Yes\n2. No`);
    if (c !== "1") return END("Cancelled.");
    const pin = await needPin(env); if (pin) return pin;

    const evidence = hashOf(`ussd-report:${env.phone}:${p.id}:${Date.now()}`);
    const rc = await (await claimsAgent.fileClaimFor(p.id, evidence)).wait();
    const ev = rc.logs.map((l) => { try { return ledgerRO.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "ClaimFiled");
    return END(`Claim #${ev.args.claimId} registered. A vet will verify it. Dial again and choose 3 to follow progress.`);
  }

  // ---------------------------------------------------------------- 3. Claim status (read-only)
  async function claimStatus(env) {
    const evs = await ledgerRO.queryFilter(ledgerRO.filters.ClaimFiled(null, null, env.addr), 0, "latest");
    if (!evs.length) return END("You have no claims.");
    const claims = [];
    for (const e of [...evs].reverse().slice(0, 5)) {
      const id = Number(e.args.claimId);
      const c = await ledgerRO.getClaim(id);
      claims.push({ id, tag: fromB32(e.args.tagId), c, status: Number(c.status), policyId: Number(c.policyId) });
    }
    const word = (x) => (x.status === 1 ? "Awaiting vets" : x.status === 2 ? "Approved" : "Rejected");
    const a = env.next();
    if (a === undefined) return list("Your claims:", claims.map((x) => `#${x.id} ${x.tag} ${word(x)}`));
    const i = pickIndex(a, claims.length); if (i < 0) return END("Invalid choice.");
    const x = claims[i];
    const lines = [`Claim #${x.id} ${x.tag}`, `Filed ${date(x.c.filedAt)}`];
    if (x.status === 1) {
      lines.push(`Status: awaiting vets`, `Signatures: ${Number(x.c.approvals)} of ${Number(x.c.quorum)} needed`);
    } else if (x.status === 2) {
      const pol = await ledgerRO.getPolicy(x.policyId);
      lines.push("Status: approved", `${fmt(pol.sumInsured)} RWF paid to you`);
    } else {
      lines.push("Status: rejected", "Your cover continues.");
    }
    return END(lines.join("\n"));
  }

  // ---------------------------------------------------------------- PIN setup (first call only)
  function pinSetup(env) {
    const p1 = env.next();
    if (p1 === undefined) return CON("Choose a 4-digit PIN to protect your claims:");
    if (!/^\d{4}$/.test(p1)) return END("PIN must be 4 digits.");
    const p2 = env.next();
    if (p2 === undefined) return CON("Repeat your PIN:");
    if (p1 !== p2) return END("PINs did not match. Dial again.");
    setPin(env.phone, p1);
    return null;
  }

  // Name of the contract's custom error, whichever way the provider reports it.
  function errorName(e) {
    if (e?.revert?.name) return e.revert.name;
    if (e?.errorName) return e.errorName;
    for (const data of [e?.data, e?.error?.data, e?.info?.error?.data]) {
      if (typeof data === "string" && data.length >= 10) {
        try { const parsed = ledgerRO.interface.parseError(data); if (parsed) return parsed.name; } catch {}
      }
    }
    const m = /custom error '([A-Za-z0-9_]+)\(/.exec(`${e?.shortMessage || ""} ${e?.message || ""}`);
    return m ? m[1] : undefined;
  }

  const MENU = "FarmLedger\n1. My policies\n2. Report a claim\n3. Claim status";

  async function route(env, consumed) {
    const addr = await farmerByPhone(env.phone);
    if (!addr) return END(NOT_REGISTERED);
    env.addr = addr;
    if (!getUser(env.phone).pinHash) {
      const r = pinSetup(env);
      if (r) return r;
      consumed();
      return CON("PIN saved.\n" + MENU);
    }
    const choice = env.next();
    if (choice === undefined) return CON(MENU);
    switch (choice) {
      case "1": return myPolicies(env);
      case "2": return reportClaim(env);
      case "3": return claimStatus(env);
      default: return END("Invalid choice.");
    }
  }

  // ---------------------------------------------------------------- entry point
  async function handle({ sessionId, phoneNumber, text }) {
    const phone = normalize(phoneNumber);
    const now = Date.now();
    for (const [k, v] of sessions) if (now - v.at > 10 * 60 * 1000) sessions.delete(k);
    for (const [k, v] of replyCache) if (now - v.at > 2 * 60 * 1000) replyCache.delete(k);
    const cacheKey = `${sessionId}|${text || ""}`;
    if (replyCache.has(cacheKey)) return replyCache.get(cacheKey).reply;
    const sess = sessions.get(sessionId) || { skip: 0, at: now };
    sess.at = now;
    sessions.set(sessionId, sess);

    const all = text ? String(text).split("*") : [];
    let parts = all.slice(sess.skip);
    let i = 0;
    const env = { phone, next: () => parts[i++] };

    let reply;
    try {
      reply = await route(env, () => { sess.skip += i; parts = parts.slice(i); i = 0; });
    } catch (e) {
      const name = errorName(e);
      reply = END(FRIENDLY[name] || "Service busy. Please try again.");
      if (!FRIENDLY[name]) console.error("[ussd] error:", e.shortMessage || e.message);
    }
    if (reply.startsWith("END")) sessions.delete(sessionId);
    replyCache.set(cacheKey, { reply, at: Date.now() });
    return reply;
  }

  return { handle, hashOf, writeSurface: WRITE_SURFACE, agentAddress: agent.address };
}

module.exports = { createUssd, WRITE_SURFACE };
