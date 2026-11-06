// USSD menu engine (Africa's Talking callback format): monitoring, claim registration and, when phone accounts are
// enabled, account services for farmers on basic phones.
//
// Request  : sessionId, phoneNumber, text   ("text" = every answer so far joined by "*")
// Response : "CON <screen>"  (session continues)   or   "END <screen>"  (session over)
//
// What this channel does
//   1. My policies    - read-only: list the caller's policies and show one in detail.
//   2. Report a claim - registers a livestock death claim, or (with CropClaims deployed) a crop loss claim for the
//                       insurer's reviewers, on one of the caller's ACTIVE policies.
//   3. Claim status   - read-only: progress of the caller's claims (vet signatures / review, outcome).
//
// Account services (only when `accounts` is passed, see services/phone-accounts.js)
//   * Unregistered number: 1. Register (National ID + SMS code, then a PIN) or 2. I changed my number.
//   * Registered number:   4. Reset PIN (National ID check), and 5. Cancel number change while a move is pending.
//   * With PolicyDesk: 6. My offers (review a contract drafted by the underwriter; phone accounts pay it by MTN Mobile
//     Money, services/payments.js) and 7. My agent. Farmers do not book cover themselves: their agent applies.
//   The farmer's own smart account signs these, inside phone-accounts.js. THIS file still holds no key and the
//   gateway key below still has CLAIMS_AGENT_ROLE only.
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

const WELCOME = "Welcome to FarmLedger\n1. Register\n2. I changed my number";
const NO_MATCH = "No phone account matches that number and ID. If you registered on the website, change your number there.";
const NOT_REGISTERED = "This number is not registered. Register and buy cover on the FarmLedger website or at an agent. USSD is for checking cover and claims.";

const FRIENDLY = {
  WaitingPeriodNotElapsed: "Claims are not open yet for this policy.",
  PolicyNotActive: "This policy is not active.",
  OutsidePolicyPeriod: "The cover period has ended.",
  WrongAssetType: "This cover pays automatically. No claim needed.",
  EnforcedPause: "Service is paused. Try later.",
  AccessControlUnauthorizedAccount: "Service is not set up. Try later.",
  IdAlreadyUsed: "This National ID is already registered.",
  TagAlreadyRegistered: "This ear tag is already registered.",
  AssetAlreadyCovered: "This animal already has cover.",
  InsufficientPool: "The insurer cannot cover that amount now. Try a smaller amount.",
  ProductInactive: "This cover is not offered at the moment.",
  AlreadyRegistered: "This number is already registered.",
};

function createUssd(opts) {
  const { provider, abi, ledgerAddress, cropClaimsAddress = null, deskAddress = null, agent, accounts = null, payments = null, db = require("../web/server/db").get() } = opts;
  const deskRO = deskAddress && abi.policyDesk ? new ethers.Contract(deskAddress, abi.policyDesk, provider) : null;
  const { PROVINCES } = require("../web/shared/districts");
  if (!agent) throw new Error("agent wallet (CLAIMS_AGENT_ROLE) is required");

  const sessions = new Map();
  const replyCache = new Map(); // "sessionId|text" -> {reply, at}: a network retry must never repeat a transaction
  const ledgerRO = new ethers.Contract(ledgerAddress, abi.ledger, provider);
  // The only write path. A one-function interface: nothing else can be called through this object.
  const claimsAgent = new ethers.Contract(ledgerAddress, ["function fileClaimFor(uint256 policyId, bytes32 evidenceHash) returns (uint256)"], agent);
  // Crop loss claims (CropClaims.sol): the same single function, on the claims contract, for the same agent role.
  const cropRO = cropClaimsAddress && abi.cropClaims ? new ethers.Contract(cropClaimsAddress, abi.cropClaims, provider) : null;
  const cropAgent = cropRO ? new ethers.Contract(cropClaimsAddress, ["function fileClaimFor(uint256 policyId, bytes32 evidenceHash, uint256 requested) returns (uint256)"], agent) : null;

  // ---------------------------------------------------------------- storage (PIN state only; db.js table "ussd_users")
  const getUser = (phone) => {
    const r = db.prepare("SELECT * FROM ussd_users WHERE phone = ?").get(phone);
    return r ? { salt: r.salt, pinHash: r.pin_hash, tries: r.tries, lockedUntil: r.locked_until, pinSetAt: r.pin_set_at } : {};
  };
  const putUser = (phone, patch) => {
    const u = { tries: 0, lockedUntil: 0, ...getUser(phone), ...patch };
    db.prepare(`INSERT INTO ussd_users (phone, salt, pin_hash, tries, locked_until, pin_set_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET salt = excluded.salt, pin_hash = excluded.pin_hash, tries = excluded.tries,
      locked_until = excluded.locked_until, pin_set_at = excluded.pin_set_at`)
      .run(phone, u.salt ?? null, u.pinHash ?? null, u.tries, u.lockedUntil, u.pinSetAt ?? null);
  };

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

  // Wrong National IDs count like wrong PINs (3 -> locked for 30 minutes), so IDs cannot be guessed by redialling.
  const isLocked = (phone) => { const u = getUser(phone); return Boolean(u.lockedUntil && Date.now() < u.lockedUntil); };
  function failAttempt(phone) {
    const tries = (getUser(phone).tries || 0) + 1;
    putUser(phone, tries >= 3 ? { tries: 0, lockedUntil: Date.now() + LOCK_MS } : { tries });
    return tries >= 3;
  }

  // ---------------------------------------------------------------- identity: phone -> registered farmer
  const normalize = (p) => String(p || "").replace(/\D/g, "");
  // phoneHash -> farmer, built from FarmerRegistered and FarmerPhoneChanged in chain order. A cached answer is
  // re-checked against the farmer's current phone hash, so a number change is never missed.
  let phoneIndex = new Map();
  let idHashes = new Set();
  const hasEvent = (name) => { try { return Boolean(ledgerRO.interface.getEvent(name)); } catch { return false; } };
  async function rebuildIndex() {
    const evs = [...await ledgerRO.queryFilter(ledgerRO.filters.FarmerRegistered(), 0, "latest")];
    if (hasEvent("FarmerPhoneChanged")) evs.push(...await ledgerRO.queryFilter(ledgerRO.filters.FarmerPhoneChanged(), 0, "latest"));
    evs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
    const byPhone = new Map(), phoneOf = new Map(), ids = new Set();
    for (const e of evs) {
      const farmer = e.args.farmer;
      if (phoneOf.has(farmer)) byPhone.delete(phoneOf.get(farmer));
      byPhone.set(e.args.phoneHash, farmer);
      phoneOf.set(farmer, e.args.phoneHash);
      if (e.fragment.name === "FarmerRegistered") ids.add(e.args.idHash);
    }
    phoneIndex = byPhone; idHashes = ids;
  }
  async function farmerByPhone(phone) {
    const h = hashOf(phone);
    const hit = phoneIndex.get(h);
    if (hit && (await ledgerRO.getFarmer(hit)).phoneHash === h) return hit;
    await rebuildIndex();
    return phoneIndex.get(h) || null;
  }
  async function idTaken(nid) { await rebuildIndex(); return idHashes.has(hashOf(nid)); }

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
    const active = all.filter((p) => p.status === 0);
    const claimable = [];
    for (const p of active) {
      if (p.cover === 3) claimable.push(p);
      else if (cropRO && Number(await cropRO.openClaimOf(p.id)) === 0) claimable.push(p);
    }
    if (!claimable.length) {
      if (cropRO && active.some((p) => p.cover !== 3)) return END("Your crop cover already has a loss claim being reviewed. Choose 3 to follow it.");
      return END(active.some((p) => p.cover !== 3)
        ? "Crop cover pays by itself when weather data triggers it. No claim needed."
        : "You have no active cattle cover to claim on.");
    }
    const labels = [];
    for (const p of claimable) labels.push(`${await describeAsset(p.policy, p.prod)} (policy #${p.id})`);
    const a = env.next();
    if (a === undefined) return list(cropRO ? "Claim on which cover?" : "Which animal died?", labels);
    const i = pickIndex(a, claimable.length); if (i < 0) return END("Invalid choice.");
    const p = claimable[i];
    const crop = p.cover !== 3;

    if (!crop) {
      const opens = Number(p.policy.start) + Number(await ledgerRO.waitingPeriod());
      if ((await chainNow()) < opens) return END(`Claims for this policy open on ${date(opens)}.`);
    }

    const c = env.next();
    if (c === undefined) return CON(crop ? `Report a crop loss on ${labels[i]}?\nThe insurer will review it.\n1. Yes\n2. No` : `Report death of ${labels[i]}?\n1. Yes\n2. No`);
    if (c !== "1") return END("Cancelled.");
    const pin = await needPin(env); if (pin) return pin;

    const evidence = hashOf(`ussd-report:${env.phone}:${p.id}:${Date.now()}`);
    if (crop) {
      const rc = await (await cropAgent.fileClaimFor(p.id, evidence, 0)).wait();
      const ev = rc.logs.map((l) => { try { return cropRO.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "CropClaimFiled");
      return END(`Loss claim #${ev.args.claimId} registered. The insurer's reviewers will assess it. Dial again and choose 3 to follow it.`);
    }
    const rc = await (await claimsAgent.fileClaimFor(p.id, evidence)).wait();
    const ev = rc.logs.map((l) => { try { return ledgerRO.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "ClaimFiled");
    return END(`Claim #${ev.args.claimId} registered. A vet will verify it. Dial again and choose 3 to follow progress.`);
  }

  // ---------------------------------------------------------------- 3. Claim status (read-only)
  async function claimStatus(env) {
    const claims = [];
    for (const e of await ledgerRO.queryFilter(ledgerRO.filters.ClaimFiled(null, null, env.addr), 0, "latest")) {
      const id = Number(e.args.claimId);
      const c = await ledgerRO.getClaim(id);
      claims.push({ kind: "vet", at: e.blockNumber, id, label: fromB32(e.args.tagId), c, status: Number(c.status), policyId: Number(c.policyId) });
    }
    if (cropRO) {
      for (const e of await cropRO.queryFilter(cropRO.filters.CropClaimFiled(null, null, env.addr), 0, "latest")) {
        const id = Number(e.args.claimId);
        const c = await cropRO.getClaim(id);
        claims.push({ kind: "crop", at: e.blockNumber, id, label: "crop loss", c, status: Number(c.status), policyId: Number(c.policyId) });
      }
    }
    if (!claims.length) return END("You have no claims.");
    claims.sort((x, y) => y.at - x.at);
    const shown = claims.slice(0, 5);
    const word = (x) => (x.kind === "vet"
      ? (x.status === 1 ? "Awaiting vets" : x.status === 2 ? "Approved" : "Rejected")
      : ["", "Being reviewed", "Approved", "Rejected", "Paid automatically"][x.status]);
    const name = (x) => (x.kind === "vet" ? `#${x.id} ${x.label}` : `Loss #${x.id}`);
    const a = env.next();
    if (a === undefined) return list("Your claims:", shown.map((x) => `${name(x)} ${word(x)}`));
    const i = pickIndex(a, shown.length); if (i < 0) return END("Invalid choice.");
    const x = shown[i];
    const lines = [x.kind === "vet" ? `Claim #${x.id} ${x.label}` : `Loss claim #${x.id}, policy #${x.policyId}`, `Filed ${date(x.c.filedAt)}`];
    if (x.kind === "crop") {
      if (x.status === 1) lines.push("Status: being reviewed", `Approvals: ${Number(x.c.approvals)} of ${Number(x.c.quorum)} needed`);
      else if (x.status === 2) lines.push("Status: approved", `${fmt(x.c.amount)} RWF paid to you`);
      else if (x.status === 3) lines.push("Status: rejected", "Your cover continues.");
      else lines.push("Status: closed", "The policy was paid automatically.");
    } else if (x.status === 1) {
      lines.push(`Status: awaiting vets`, `Signatures: ${Number(x.c.approvals)} of ${Number(x.c.quorum)} needed`);
    } else if (x.status === 2) {
      const pol = await ledgerRO.getPolicy(x.policyId);
      lines.push("Status: approved", `${fmt(pol.sumInsured)} RWF paid to you`);
    } else {
      lines.push("Status: rejected", "Your cover continues.");
    }
    return END(lines.join("\n"));
  }

  // ---------------------------------------------------------------- account services (phone accounts)
  const codeLimit = (r) => (r.reason === "wait" ? `A code was just sent. Wait ${r.waitS} seconds and dial again.`
    : r.reason === "not-sent" ? "We could not send the SMS code to this number right now. Please try again later."
    : "Too many codes today. Try again tomorrow.");
  const when = (ms) => new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const ENTER_CODE = "Enter the 6-digit code from the SMS:\n0. Send a new code";
  async function resend(env, purpose) {
    const r = await accounts.resendCode(env.phone, purpose);
    return END(r.ok ? "We sent a new code by SMS. Dial again within 10 minutes and enter it." : codeLimit(r));
  }
  const toIntl = (v) => { const d = normalize(v); return /^07\d{8}$/.test(d) ? "25" + d : d; };

  async function newcomer(env, consumed) {
    const phone = env.phone;
    if (isLocked(phone)) return END("Too many wrong tries. Number locked for 30 minutes.");
    const mv = accounts.moveTo(phone);
    if (mv) {
      if (accounts.now() < mv.ready_at) return END(`Your number change is waiting for the safety period. Ready from ${when(mv.ready_at)}.`);
      await accounts.completeMove(mv.id);
      consumed();
      return CON("Your account is now on this number.\nChoose a 4-digit PIN to protect it:");
    }
    if (accounts.pendingCode(phone, "move")) return enterMoveCode(env, consumed);
    if (accounts.pendingCode(phone, "register") || accounts.verifiedCode(phone, "register")) return finishRegistration(env, consumed);

    const c = env.next();
    if (c === undefined) return CON(WELCOME);
    if (c === "1") return startRegistration(env);
    if (c === "2") return startMove(env);
    return END("Invalid choice.");
  }

  async function startRegistration(env) {
    const nid = env.next();
    if (nid === undefined) return CON("Enter your 16-digit National ID number:");
    if (!/^\d{16}$/.test(nid)) return END("A National ID has 16 digits. Dial again.");
    if (await idTaken(nid)) return END("This National ID is already registered. If you changed your number, dial again and choose 2.");
    let district = null; // with PolicyDesk: where the farm is, so the farmer gets the agent covering that district
    if (deskRO) {
      const pv = env.next();
      if (pv === undefined) return list("Province of your farm:", PROVINCES.map((x) => x[0]));
      const pi = pickIndex(pv, PROVINCES.length); if (pi < 0) return END("Invalid choice.");
      const ds = PROVINCES[pi][1];
      const dv = env.next();
      if (dv === undefined) return list("District:", ds);
      const di = pickIndex(dv, ds.length); if (di < 0) return END("Invalid choice.");
      district = ds[di];
    }
    const ok = env.next();
    if (ok === undefined) return CON(`Register ID ending ${nid.slice(-4)}${district ? `, farm in ${district},` : ""} with this number?\n1. Yes\n2. No`);
    if (ok !== "1") return END("Cancelled.");
    // only the hash of the ID is kept, and only until the code is used
    const r = await accounts.sendCode(env.phone, "register", { idHash: hashOf(nid), district: district && district.toUpperCase() });
    if (!r.ok) return END(codeLimit(r));
    return END("We sent you a 6-digit code by SMS. Dial again within 10 minutes and enter it to finish.");
  }

  async function finishRegistration(env, consumed) {
    if (!accounts.verifiedCode(env.phone, "register")) {
      const code = env.next();
      if (code === undefined) return CON(ENTER_CODE);
      if (code === "0") return resend(env, "register");
      const r = accounts.checkCode(env.phone, "register", code);
      if (!r.ok) return END(r.left > 0 ? `Wrong code. ${r.left} tries left. Dial again.` : "That code no longer works. Dial again to start over.");
    }
    const { data } = accounts.verifiedCode(env.phone, "register");
    await accounts.register(env.phone, data.idHash, data.district || null);
    accounts.clearCode(env.phone, "register");
    consumed();
    return CON("Registered! Your FarmLedger account is ready.\nChoose a 4-digit PIN to protect it:");
  }

  async function startMove(env) {
    const old = env.next();
    if (old === undefined) return CON("Enter your OLD phone number, e.g. 0788123456:");
    const oldPhone = toIntl(old);
    if (!/^2507\d{8}$/.test(oldPhone) || oldPhone === env.phone) return END("That is not a valid old number. Dial again.");
    const nid = env.next();
    if (nid === undefined) return CON("Enter your National ID number:");
    const r = await accounts.startMove(oldPhone, env.phone, nid);
    if (r.ok) return END("We sent a 6-digit code by SMS to this phone. Dial again within 10 minutes and enter it.");
    if (r.reason === "no-match") return END(failAttempt(env.phone) ? "Too many wrong tries. Number locked for 30 minutes." : NO_MATCH);
    if (r.reason === "pending") return END("A number change for this account is already waiting.");
    if (r.reason === "taken") return END("This number already has an account.");
    return END(codeLimit(r));
  }

  async function enterMoveCode(env, consumed) {
    const code = env.next();
    if (code === undefined) return CON(ENTER_CODE);
    if (code === "0") return resend(env, "move");
    const r = await accounts.confirmMove(env.phone, code);
    if (!r.ok) return END(r.left > 0 ? `Wrong code. ${r.left} tries left. Dial again.` : "That code no longer works. Dial again to start over.");
    if (r.request.status === "done") { consumed(); return CON("Your account is now on this number.\nChoose a 4-digit PIN to protect it:"); }
    return END(`Request saved. For your safety the account moves from ${when(r.request.ready_at)}. We told your old number. Dial again then.`);
  }

  async function resetPin(env) {
    if (isLocked(env.phone)) return END("Too many wrong tries. Number locked for 30 minutes.");
    const nid = env.next();
    if (nid === undefined) return CON("Enter your National ID number:");
    if ((await ledgerRO.getFarmer(env.addr)).idHash !== hashOf(nid)) {
      return END(failAttempt(env.phone) ? "Too many wrong tries. Number locked for 30 minutes." : "That ID does not match this account.");
    }
    const p1 = env.next();
    if (p1 === undefined) return CON("Choose a new 4-digit PIN:");
    if (!/^\d{4}$/.test(p1)) return END("PIN must be 4 digits.");
    const p2 = env.next();
    if (p2 === undefined) return CON("Repeat the new PIN:");
    if (p1 !== p2) return END("PINs did not match. Dial again.");
    setPin(env.phone, p1);
    await accounts.notify(env.phone, "FarmLedger: your USSD PIN was changed. If this was not you, contact FarmLedger support.");
    return END("PIN changed.");
  }

  async function cancelMove(env, mv) {
    const c = env.next();
    if (c === undefined) return CON("Cancel moving your account to another number?\n1. Yes, cancel it\n2. No");
    if (c !== "1") return END("Nothing changed.");
    await accounts.cancelMove(mv.id, "old number");
    return END("Number change cancelled. Your account stays on this number.");
  }

  // ---------------------------------------------------------------- offers and agent (PolicyDesk)
  const COVER_NAME = ["Drought", "Flood", "Crop stress", "Cattle death"];
  const OFFERED = 2;

  // Contracts the underwriter drafted for this farmer that can still be accepted, newest first.
  async function openOffers(addr) {
    const evs = await deskRO.queryFilter(deskRO.filters.ContractDrafted(null, addr), 0, "latest");
    const ids = [...new Set(evs.map((e) => Number(e.args.applicationId)))].reverse();
    const now = await chainNow();
    const out = [];
    for (const id of ids) {
      const a = await deskRO.getApplication(id);
      if (Number(a.status) !== OFFERED || Number(a.offerExpires) < now) continue;
      const prod = await ledgerRO.getProduct(a.productId);
      out.push({ id, a, cover: Number(prod.cover) });
    }
    return out;
  }

  async function myOffers(env) {
    const offers = (await openOffers(env.addr)).slice(0, 5);
    if (!offers.length) return END("You have no contract to review. Your agent applies for cover for you; you will get an SMS when a contract is ready.");
    const c = env.next();
    if (c === undefined) return list("Contracts to review:", offers.map((o) => `#${o.id} ${COVER_NAME[o.cover]} ${fmt(o.a.sumInsured)} RWF`));
    const i = pickIndex(c, offers.length); if (i < 0) return END("Invalid choice.");
    const o = offers[i];
    const subsidy = await ledgerRO.subsidyFor(env.addr, o.a.productId, o.a.premium).catch(() => 0n);
    const pays = o.a.premium - subsidy;
    const starts = Number(o.a.startAt) ? `from ${date(o.a.startAt)}` : "from payment";
    const head = `Contract #${o.id}: ${COVER_NAME[o.cover]}, cover ${fmt(o.a.sumInsured)} RWF, ${Number(o.a.coverDays)} days ${starts}.\nPremium ${fmt(o.a.premium)}${subsidy > 0n ? `, subsidy -${fmt(subsidy)}` : ""}. You pay ${fmt(pays)}.\nValid to ${date(o.a.offerExpires)}`;
    if (!isPhoneAccount(env)) return END(`${head}\nAccept and pay on the FarmLedger website.`);
    const d = env.next();
    if (d === undefined) return CON(`${head}\n1. Pay by MoMo\n2. Decline`);
    if (d === "1") {
      if (!payments) return END("Payment is not available right now. Try again later.");
      const pin = await needPin(env); if (pin) return pin;
      const r = await payments.startPremium({ phone: env.phone, applicationId: o.id });
      if (r.status === "failed") return END("The Mobile Money payment could not be started. Nothing was charged. Try again later.");
      return END(`Approve the MoMo payment of ${fmt(r.farmerPays)} RWF on your phone. Your policy is issued once it is paid; we will SMS you.`);
    }
    if (d === "2") {
      const ok = env.next();
      if (ok === undefined) return CON(`Decline contract #${o.id}? Your agent can apply again later.\n1. Yes, decline\n2. No`);
      if (ok !== "1") return END("Nothing changed.");
      const pin = await needPin(env); if (pin) return pin;
      await accounts.declineOffer(env.phone, o.id);
      return END(`Contract #${o.id} declined.`);
    }
    return END("Invalid choice.");
  }

  async function myAgent(env) {
    const agentAddr = await deskRO.agentOf(env.addr);
    if (agentAddr === ethers.ZeroAddress) return END("No agent is assigned to you yet. FarmLedger will SMS you when one is.");
    const c = db.prepare("SELECT phone FROM contacts WHERE lower(address) = lower(?)").get(agentAddr);
    return END(`Your FarmLedger agent${c ? ` can be reached on +${c.phone}` : " has no phone number on file yet"}. They collect your details and apply for cover for you.`);
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
  // Paying and declining need the farmer's own key, which the server holds only for phone accounts.
  const isPhoneAccount = (env) => Boolean(accounts && accounts.accountOf(env.phone)?.status === "active");
  const menuFor = (env) => (accounts
    ? MENU + "\n4. Reset PIN" + (accounts.moveFrom(env.phone) ? "\n5. Cancel number change" : "") + (deskRO ? "\n6. My offers\n7. My agent" : "")
    : MENU + (deskRO ? "\n6. My offers\n7. My agent" : ""));

  async function route(env, consumed) {
    const addr = await farmerByPhone(env.phone);
    if (!addr) return accounts ? newcomer(env, consumed) : END(NOT_REGISTERED);
    env.addr = addr;
    if (!getUser(env.phone).pinHash) {
      const r = pinSetup(env);
      if (r) return r;
      consumed();
      return CON("PIN saved.\n" + menuFor(env));
    }
    const choice = env.next();
    if (choice === undefined) return CON(menuFor(env));
    switch (choice) {
      case "1": return myPolicies(env);
      case "2": return reportClaim(env);
      case "3": return claimStatus(env);
      case "4": if (accounts) return resetPin(env); break;
      case "5": { const mv = accounts && accounts.moveFrom(env.phone); if (mv) return cancelMove(env, mv); break; }
      case "6": if (deskRO) return myOffers(env); break;
      case "7": if (deskRO) return myAgent(env); break;
    }
    return END("Invalid choice.");
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
