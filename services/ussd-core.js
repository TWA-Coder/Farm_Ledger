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
//
// Languages: English and Kinyarwanda (services/ussd-text.js). The first screen of a session (welcome, PIN setup or
// main menu) offers "0" to switch; the choice is remembered per phone number (services/lang.js) and also sets the
// language of the farmer's SMS (services/sms-text.js). New numbers start in USSD_DEFAULT_LANG (en).
const crypto = require("crypto");
const { ethers } = require("ethers");
const { TEXT } = require("./ussd-text");
const { SMS } = require("./sms-text");
const lang = require("./lang");

const hashOf = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const fromB32 = (x) => { try { return ethers.decodeBytes32String(x); } catch { return x; } };
const fmt = (n) => Number(n).toLocaleString("en-US");
const date = (ts) => new Date(Number(ts) * 1000).toLocaleDateString("en-GB");
const CON = (m) => "CON " + m;
const END = (m) => "END " + m;

const WRITE_SURFACE = ["fileClaimFor"]; // the ONLY state-changing call this service can make

function createUssd(opts) {
  const { provider, abi, ledgerAddress, cropClaimsAddress = null, deskAddress = null, agent, accounts = null, payments = null, db = require("../web/server/db").get() } = opts;
  const defaultLang = lang.defaultLang(opts.defaultLang);
  const deskRO = deskAddress && abi.policyDesk ? new ethers.Contract(deskAddress, abi.policyDesk, provider) : null;
  const { PROVINCES } = require("../web/shared/districts");
  const profiles = require("../web/server/profiles");
  if (!agent) throw new Error("agent wallet (CLAIMS_AGENT_ROLE) is required");

  const sessions = new Map();
  const replyCache = new Map(); // "sessionId|text" -> {reply, at}: a network retry must never repeat a transaction
  const ledgerRO = new ethers.Contract(ledgerAddress, abi.ledger, provider);
  // The only write path. A one-function interface: nothing else can be called through this object.
  const claimsAgent = new ethers.Contract(ledgerAddress, ["function fileClaimFor(uint256 policyId, bytes32 evidenceHash) returns (uint256)"], agent);
  // Crop loss claims (CropClaims.sol): the same single function, on the claims contract, for the same agent role.
  const cropRO = cropClaimsAddress && abi.cropClaims ? new ethers.Contract(cropClaimsAddress, abi.cropClaims, provider) : null;
  const cropAgent = cropRO ? new ethers.Contract(cropClaimsAddress, ["function fileClaimFor(uint256 policyId, bytes32 evidenceHash, uint256 requested) returns (uint256)"], agent) : null;

  // ---------------------------------------------------------------- PINs (services/pins.js, shared with the portal)
  // Wrong National IDs count like wrong PINs (3 -> locked for 30 minutes), so IDs cannot be guessed by redialling.
  const { getUser, setPin, checkPin, isLocked, failAttempt } = require("./pins").createPinStore({ db });

  // ---------------------------------------------------------------- language (per phone number)
  // "0" on a first screen: switch to the other language, remember it, and show the same screen again.
  async function switchLang(env, consumed) {
    env.lang = env.lang === "en" ? "rw" : "en";
    env.s = TEXT[env.lang];
    await lang.setLang(db, env.phone, env.lang);
    consumed();
  }
  const withSwitch = (env, screen) => `${screen}\n${env.s.switchTo}`;

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
    if (p === undefined) return CON(env.s.enterPin);
    const r = await checkPin(env.phone, p);
    if (r.ok) return null;
    return END(r.locked ? env.s.pinLocked : env.s.wrongPin);
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
    const s = env.s;
    const all = await policiesOf(env.addr);
    if (!all.length) return END(s.noPolicies);
    const shown = all.slice(0, 5);
    const a = env.next();
    if (a === undefined) return list(s.yourPolicies, shown.map((p) => `#${p.id} ${s.coverShort[p.cover]} ${s.status[p.status]}`));
    const i = pickIndex(a, shown.length); if (i < 0) return END(s.invalid);
    const p = shown[i];
    const lines = [
      s.policyHead(p.id, s.cover[p.cover]),
      await describeAsset(p.policy, p.prod),
      s.coverAmount(fmt(p.policy.sumInsured)),
      s.premium(fmt(p.policy.premium)),
      s.valid(date(p.policy.start), date(p.policy.end)),
      s.statusLine(s.status[p.status]),
    ];
    if (p.cover !== 3 && p.status === 0) lines.push(s.paysItself);
    return END(lines.join("\n"));
  }

  // ---------------------------------------------------------------- 2. Report a claim (registers a claim only)
  async function reportClaim(env) {
    const s = env.s;
    const all = await policiesOf(env.addr);
    const active = all.filter((p) => p.status === 0);
    const claimable = [];
    for (const p of active) {
      if (p.cover === 3) claimable.push(p);
      else if (cropRO && Number(await cropRO.openClaimOf(p.id)) === 0) claimable.push(p);
    }
    if (!claimable.length) {
      if (cropRO && active.some((p) => p.cover !== 3)) return END(s.cropClaimOpen);
      return END(active.some((p) => p.cover !== 3) ? s.cropAuto : s.noCattleCover);
    }
    const labels = [];
    for (const p of claimable) labels.push(s.assetLabel(await describeAsset(p.policy, p.prod), p.id));
    const a = env.next();
    if (a === undefined) return list(cropRO ? s.claimWhich : s.whichAnimal, labels);
    const i = pickIndex(a, claimable.length); if (i < 0) return END(s.invalid);
    const p = claimable[i];
    const crop = p.cover !== 3;

    if (!crop) {
      const opens = Number(p.policy.start) + Number(await ledgerRO.waitingPeriod());
      if ((await chainNow()) < opens) return END(s.claimsOpenOn(date(opens)));
    }

    const c = env.next();
    if (c === undefined) return CON(`${crop ? s.confirmCrop(labels[i]) : s.confirmDeath(labels[i])}\n${s.yesNo}`);
    if (c !== "1") return END(s.cancelled);
    const pin = await needPin(env); if (pin) return pin;

    const evidence = hashOf(`ussd-report:${env.phone}:${p.id}:${Date.now()}`);
    if (crop) {
      const rc = await (await cropAgent.fileClaimFor(p.id, evidence, 0)).wait();
      const ev = rc.logs.map((l) => { try { return cropRO.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "CropClaimFiled");
      return END(s.cropFiled(ev.args.claimId));
    }
    const rc = await (await claimsAgent.fileClaimFor(p.id, evidence)).wait();
    const ev = rc.logs.map((l) => { try { return ledgerRO.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "ClaimFiled");
    return END(s.deathFiled(ev.args.claimId));
  }

  // ---------------------------------------------------------------- 3. Claim status (read-only)
  async function claimStatus(env) {
    const s = env.s;
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
        claims.push({ kind: "crop", at: e.blockNumber, id, label: s.cropLoss, c, status: Number(c.status), policyId: Number(c.policyId) });
      }
    }
    if (!claims.length) return END(s.noClaims);
    claims.sort((x, y) => y.at - x.at);
    const shown = claims.slice(0, 5);
    const word = (x) => (x.kind === "vet" ? s.vetWord[x.status === 1 || x.status === 2 ? x.status : 3] : s.cropWord[x.status]);
    const name = (x) => (x.kind === "vet" ? s.vetClaimName(x.id, x.label) : s.cropClaimName(x.id));
    const a = env.next();
    if (a === undefined) return list(s.yourClaims, shown.map((x) => `${name(x)} ${word(x)}`));
    const i = pickIndex(a, shown.length); if (i < 0) return END(s.invalid);
    const x = shown[i];
    const lines = [x.kind === "vet" ? s.vetClaimHead(x.id, x.label) : s.cropClaimHead(x.id, x.policyId), s.filed(date(x.c.filedAt))];
    if (x.kind === "crop") {
      if (x.status === 1) lines.push(s.stReviewed, s.approvals(Number(x.c.approvals), Number(x.c.quorum)));
      else if (x.status === 2) lines.push(s.stApproved, s.paidToYou(fmt(x.c.amount)));
      else if (x.status === 3) lines.push(s.stRejected, s.coverContinues);
      else lines.push(s.stClosed, s.paidAuto);
    } else if (x.status === 1) {
      lines.push(s.stAwaitingVets, s.signatures(Number(x.c.approvals), Number(x.c.quorum)));
    } else if (x.status === 2) {
      const pol = await ledgerRO.getPolicy(x.policyId);
      lines.push(s.stApproved, s.paidToYou(fmt(pol.sumInsured)));
    } else {
      lines.push(s.stRejected, s.coverContinues);
    }
    return END(lines.join("\n"));
  }

  // ---------------------------------------------------------------- account services (phone accounts)
  const codeLimit = (s, r) => (r.reason === "wait" ? s.codeWait(r.waitS) : r.reason === "not-sent" ? s.codeNotSent : s.codeDaily);
  const when = (env, ms) => new Date(ms).toLocaleString("en-GB", env.lang === "en"
    ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }
    : { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); // no English month names
  async function resend(env, purpose) {
    const r = await accounts.resendCode(env.phone, purpose);
    return END(r.ok ? env.s.codeResent : codeLimit(env.s, r));
  }
  const toIntl = (v) => { const d = normalize(v); return /^07\d{8}$/.test(d) ? "25" + d : d; };

  async function newcomer(env, consumed) {
    const phone = env.phone;
    if (await isLocked(phone)) return END(env.s.locked);
    const mv = await accounts.moveTo(phone);
    if (mv) {
      if (accounts.now() < mv.ready_at) return END(env.s.moveWaiting(when(env, mv.ready_at)));
      await accounts.completeMove(mv.id);
      consumed();
      return CON(env.s.movedHere);
    }
    if (await accounts.pendingCode(phone, "move")) return enterMoveCode(env, consumed);
    if ((await accounts.pendingCode(phone, "register")) || (await accounts.verifiedCode(phone, "register"))) return finishRegistration(env, consumed);

    let c = env.next();
    if (c === "0") { await switchLang(env, consumed); c = env.next(); }
    if (c === undefined) return CON(withSwitch(env, env.s.welcome));
    if (c === "1") return startRegistration(env);
    if (c === "2") return startMove(env);
    return END(env.s.invalid);
  }

  async function startRegistration(env) {
    const s = env.s;
    const nid = env.next();
    if (nid === undefined) return CON(s.enterNid16);
    if (!/^\d{16}$/.test(nid)) return END(s.nid16);
    if (await idTaken(nid)) return END(s.nidTaken);
    // the farmer's name, for their agent and the insurer (kept off-chain, web/server/profiles.js)
    const rawName = env.next();
    if (rawName === undefined) return CON(s.enterName);
    let name;
    try { name = profiles.cleanName(rawName); } catch (e) { return END(s.badName(e.message)); }
    let district = null; // with PolicyDesk: where the farm is, so the farmer gets the agent covering that district
    if (deskRO) {
      const pv = env.next();
      if (pv === undefined) return list(s.province, PROVINCES.map((x, k) => s.provinces[k] || x[0]));
      const pi = pickIndex(pv, PROVINCES.length); if (pi < 0) return END(s.invalid);
      const ds = PROVINCES[pi][1];
      const dv = env.next();
      if (dv === undefined) return list(s.district, ds);
      const di = pickIndex(dv, ds.length); if (di < 0) return END(s.invalid);
      district = ds[di];
    }
    const ok = env.next();
    if (ok === undefined) return CON(`${s.confirmRegister(name, nid.slice(-4), district)}\n${s.yesNo}`);
    if (ok !== "1") return END(s.cancelled);
    // only the hash of the ID is kept, and only until the code is used
    const r = await accounts.sendCode(env.phone, "register", { idHash: hashOf(nid), district: district && district.toUpperCase(), name });
    if (!r.ok) return END(codeLimit(s, r));
    return END(s.codeSent);
  }

  async function finishRegistration(env, consumed) {
    const s = env.s;
    if (!(await accounts.verifiedCode(env.phone, "register"))) {
      const code = env.next();
      if (code === undefined) return CON(s.enterCode);
      if (code === "0") return resend(env, "register");
      const r = await accounts.checkCode(env.phone, "register", code);
      if (!r.ok) return END(r.left > 0 ? s.wrongCode(r.left) : s.codeDead);
    }
    const { data } = await accounts.verifiedCode(env.phone, "register");
    const { account } = await accounts.register(env.phone, data.idHash, data.district || null);
    if (data.name) await profiles.put(account, data.name, db);
    await accounts.clearCode(env.phone, "register");
    consumed();
    return CON(s.registered);
  }

  async function startMove(env) {
    const s = env.s;
    const old = env.next();
    if (old === undefined) return CON(s.enterOld);
    const oldPhone = toIntl(old);
    if (!/^2507\d{8}$/.test(oldPhone) || oldPhone === env.phone) return END(s.badOld);
    const nid = env.next();
    if (nid === undefined) return CON(s.enterNid);
    const r = await accounts.startMove(oldPhone, env.phone, nid);
    if (r.ok) return END(s.moveCodeSent);
    if (r.reason === "no-match") return END((await failAttempt(env.phone)) ? s.locked : s.noMatch);
    if (r.reason === "pending") return END(s.movePending);
    if (r.reason === "taken") return END(s.numberTaken);
    return END(codeLimit(s, r));
  }

  async function enterMoveCode(env, consumed) {
    const s = env.s;
    const code = env.next();
    if (code === undefined) return CON(s.enterCode);
    if (code === "0") return resend(env, "move");
    const r = await accounts.confirmMove(env.phone, code);
    if (!r.ok) return END(r.left > 0 ? s.wrongCode(r.left) : s.codeDead);
    if (r.request.status === "done") { consumed(); return CON(s.movedHere); }
    return END(s.moveSaved(when(env, r.request.ready_at)));
  }

  async function resetPin(env) {
    const s = env.s;
    if (await isLocked(env.phone)) return END(s.locked);
    const nid = env.next();
    if (nid === undefined) return CON(s.enterNid);
    if ((await ledgerRO.getFarmer(env.addr)).idHash !== hashOf(nid)) {
      return END((await failAttempt(env.phone)) ? s.locked : s.idMismatch);
    }
    const p1 = env.next();
    if (p1 === undefined) return CON(s.newPin);
    if (!/^\d{4}$/.test(p1)) return END(s.pinDigits);
    const p2 = env.next();
    if (p2 === undefined) return CON(s.repeatNewPin);
    if (p1 !== p2) return END(s.pinMismatch);
    await setPin(env.phone, p1);
    await accounts.notify(env.phone, SMS[env.lang].pinChanged);
    return END(s.pinChanged);
  }

  async function cancelMove(env, mv) {
    const c = env.next();
    if (c === undefined) return CON(env.s.confirmCancelMove);
    if (c !== "1") return END(env.s.nothingChanged);
    await accounts.cancelMove(mv.id, "old number");
    return END(env.s.moveCancelled);
  }

  // ---------------------------------------------------------------- offers and agent (PolicyDesk)
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
    const s = env.s;
    const offers = (await openOffers(env.addr)).slice(0, 5);
    if (!offers.length) return END(s.noOffers);
    const c = env.next();
    if (c === undefined) return list(s.offersHead, offers.map((o) => s.offerLine(o.id, s.coverShort[o.cover], fmt(o.a.sumInsured))));
    const i = pickIndex(c, offers.length); if (i < 0) return END(s.invalid);
    const o = offers[i];
    const subsidy = await ledgerRO.subsidyFor(env.addr, o.a.productId, o.a.premium).catch(() => 0n);
    const pays = o.a.premium - subsidy;
    const starts = Number(o.a.startAt) ? s.fromDate(date(o.a.startAt)) : s.fromPayment;
    const head = [
      s.offerHead(o.id, s.cover[o.cover], fmt(o.a.sumInsured), Number(o.a.coverDays), starts),
      s.offerPay(fmt(o.a.premium), subsidy > 0n ? fmt(subsidy) : null, fmt(pays)),
      s.validTo(date(o.a.offerExpires)),
    ].join("\n");
    if (!(await isPhoneAccount(env))) return END(`${head}\n${s.payOnWeb}`);
    const d = env.next();
    if (d === undefined) return CON(`${head}\n${s.payOrDecline}`);
    if (d === "1") {
      if (!payments) return END(s.payUnavailable);
      const pin = await needPin(env); if (pin) return pin;
      const r = await payments.startPremium({ phone: env.phone, applicationId: o.id });
      if (r.status === "failed") return END(s.payFailed);
      return END(s.payApprove(fmt(r.farmerPays)));
    }
    if (d === "2") {
      const ok = env.next();
      if (ok === undefined) return CON(s.confirmDecline(o.id));
      if (ok !== "1") return END(s.nothingChanged);
      const pin = await needPin(env); if (pin) return pin;
      await accounts.declineOffer(env.phone, o.id);
      return END(s.declined(o.id));
    }
    return END(s.invalid);
  }

  async function myAgent(env) {
    const agentAddr = await deskRO.agentOf(env.addr);
    if (agentAddr === ethers.ZeroAddress) return END(env.s.noAgent);
    const c = await db.one("SELECT phone FROM contacts WHERE lower(address) = lower(?)", [agentAddr]);
    return END(env.s.agentInfo(c ? c.phone : null));
  }

  // ---------------------------------------------------------------- PIN setup (first call only)
  async function pinSetup(env, consumed) {
    let p1 = env.next();
    if (p1 === "0") { await switchLang(env, consumed); p1 = env.next(); }
    if (p1 === undefined) return CON(withSwitch(env, env.s.choosePin));
    if (!/^\d{4}$/.test(p1)) return END(env.s.pinDigits);
    const p2 = env.next();
    if (p2 === undefined) return CON(env.s.repeatPin);
    if (p1 !== p2) return END(env.s.pinMismatch);
    await setPin(env.phone, p1);
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

  // Paying and declining need the farmer's own key, which the server holds only for phone accounts.
  const isPhoneAccount = async (env) => Boolean(accounts && (await accounts.accountOf(env.phone))?.status === "active");
  async function menuFor(env) {
    const m = env.s.menu;
    const items = [["1", m.policies], ["2", m.claim], ["3", m.status]];
    if (accounts) {
      items.push(["4", m.resetPin]);
      if (await accounts.moveFrom(env.phone)) items.push(["5", m.cancelMove]);
    }
    if (deskRO) items.push(["6", m.offers], ["7", m.agent]);
    return withSwitch(env, [env.s.menuHead, ...items.map(([k, t]) => `${k}. ${t}`)].join("\n"));
  }

  async function route(env, consumed) {
    const addr = await farmerByPhone(env.phone);
    if (!addr) return accounts ? newcomer(env, consumed) : END(env.s.notRegistered);
    env.addr = addr;
    if (!(await getUser(env.phone)).pinHash) {
      const r = await pinSetup(env, consumed);
      if (r) return r;
      consumed();
      return CON(`${env.s.pinSaved}\n${await menuFor(env)}`);
    }
    let choice = env.next();
    if (choice === "0") { await switchLang(env, consumed); choice = env.next(); }
    if (choice === undefined) return CON(await menuFor(env));
    switch (choice) {
      case "1": return myPolicies(env);
      case "2": return reportClaim(env);
      case "3": return claimStatus(env);
      case "4": if (accounts) return resetPin(env); break;
      case "5": { const mv = accounts && (await accounts.moveFrom(env.phone)); if (mv) return cancelMove(env, mv); break; }
      case "6": if (deskRO) return myOffers(env); break;
      case "7": if (deskRO) return myAgent(env); break;
    }
    return END(env.s.invalid);
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
    const env = { phone, lang: defaultLang, s: TEXT[defaultLang], next: () => parts[i++] };

    let reply;
    try {
      env.lang = await lang.langOf(db, phone, defaultLang);
      env.s = TEXT[env.lang];
      reply = await route(env, () => { sess.skip += i; parts = parts.slice(i); i = 0; });
    } catch (e) {
      const name = errorName(e);
      reply = END(env.s.friendly[name] || env.s.busy);
      if (!env.s.friendly[name]) console.error("[ussd] error:", e.shortMessage || e.message);
    }
    if (reply.startsWith("END")) sessions.delete(sessionId);
    replyCache.set(cacheKey, { reply, at: Date.now() });
    return reply;
  }

  return { handle, hashOf, writeSurface: WRITE_SURFACE, agentAddress: agent.address };
}

module.exports = { createUssd, WRITE_SURFACE };
