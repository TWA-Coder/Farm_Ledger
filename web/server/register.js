// Farmer registration on the portal: the same phone account as USSD registration (services/phone-accounts.js).
//   1. start   name, National ID, phone, district -> a 6-digit code by SMS (proves the number receives SMS, which is
//              where payouts are announced). Only the ID's hash is kept, and only until the code is used.
//   2. finish  the code and a 4-digit PIN -> the smart account is created and registered on-chain (fees sponsored),
//              the farmer joins the district (which assigns their agent), the name is saved off-chain, and the
//              farmer is signed in. The PIN is the one they will also use on USSD.
// On the local chain, when no SMS provider is set up (or the number is not in SMS_ALLOWLIST), nothing can reach the
// phone, so the code is returned to the page and shown as a test code.
const { ethers } = require("ethers");
const dbm = require("./db");
const profiles = require("./profiles");
const auth = require("./auth");
const { DocError } = require("./documents-core");

const fail = (status, msg) => { throw new DocError(status, msg); };
const hashOf = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

let cached = null;
function services() {
  const chain = require("./chain");
  const dep = chain.deployment();
  if (cached && cached.dep === dep) return cached;
  if (!dep.aa) fail(503, "Phone accounts need the smart-account contracts in this deployment.");
  const fs = require("fs"), path = require("path");
  const abi = JSON.parse(fs.readFileSync(path.join(process.cwd(), "public", "abi.json"), "utf8"));
  const local = ["localhost", "hardhat"].includes(dep.network);
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || dep.rpcUrl, undefined, { cacheTimeout: -1 });
  const { createOutbox } = require("../../services/sms");
  const { createPhoneAccounts } = require("../../services/phone-accounts");
  const { custodyConfig } = require("../../services/custody-client");
  const outbox = createOutbox({ localChain: local, quiet: true });
  const shown = new Map(); // phone -> test code (local chain, SMS not delivered)
  const sendSms = async (phone, text, opts = {}) => {
    const r = await outbox.sendNow(phone, text, opts);
    if (local && opts.secret && (r.logged || r.skipped)) { shown.set(phone, opts.secret); return { ok: true, logged: true }; }
    return r;
  };
  const accounts = createPhoneAccounts({ provider, aa: dep.aa, ledgerAddress: dep.ledger, deskAddress: dep.policyDesk, abi, sendSms, custody: custodyConfig({ local }) });
  cached = { dep, accounts, shown, local, ledger: chain.ledger(), provider };
  return cached;
}

async function idTaken(idHash) {
  const { ledger, provider } = services();
  const indexer = require("./indexer");
  const chain = require("./chain");
  await indexer.sync({ provider, ledger, others: [chain.cropClaims(), chain.policyDesk()].filter(Boolean), startBlock: chain.deployment().deployBlock });
  return (await indexer.events(undefined, { name: "FarmerRegistered" })).some((e) => String(e.args.idHash).toLowerCase() === idHash.toLowerCase());
}

async function start({ name, nid, phone: phoneInput, district }) {
  const { accounts, shown } = services();
  const clean = profiles.cleanName(name);
  const id = String(nid || "").replace(/\s/g, "");
  if (!/^\d{16}$/.test(id)) fail(400, "A National ID has 16 digits.");
  const phone = auth.normalizePhone(phoneInput);
  if (!auth.PHONE_RE.test(phone)) fail(400, "Enter a Rwandan mobile number, e.g. 0788123456.");
  const { DISTRICTS } = require("../shared/districts");
  const d = DISTRICTS.find((x) => x.toLowerCase() === String(district || "").toLowerCase());
  if (!d) fail(400, "Choose the district of your farm.");
  const acc = await accounts.accountOf(phone);
  if (acc && acc.status === "active") fail(409, "This number already has a FarmLedger account. Sign in with your phone number and PIN.");
  if (await idTaken(hashOf(id))) fail(409, "This National ID is already registered. If you changed your number, dial the USSD code and choose 2.");
  shown.delete(phone);
  const r = await accounts.sendCode(phone, "register", { idHash: hashOf(id), district: d.toUpperCase(), name: clean });
  if (!r.ok) fail(429, r.reason === "wait" ? `A code was just sent. Wait ${r.waitS} seconds before asking again.` : r.reason === "not-sent" ? "We could not send the SMS code to this number right now. Try again later." : "Too many codes for this number today. Try again tomorrow.");
  return { phone, testCode: shown.get(phone) || null };
}

async function finish({ phone: phoneInput, code, pin }) {
  const { accounts } = services();
  const phone = auth.normalizePhone(phoneInput);
  if (!/^\d{4}$/.test(String(pin || ""))) fail(400, "Choose a 4-digit PIN.");
  if (["0000", "1234", "1111"].includes(String(pin))) fail(400, "That PIN is too easy to guess. Choose another one.");
  if (!(await accounts.verifiedCode(phone, "register"))) {
    const c = await accounts.checkCode(phone, "register", String(code || "").trim());
    if (!c.ok) fail(400, c.left > 0 ? `Wrong code. ${c.left} tries left.` : "That code no longer works. Start again to get a new one.");
  }
  const { data } = await accounts.verifiedCode(phone, "register");
  const { account } = await accounts.register(phone, data.idHash, data.district || null);
  await accounts.clearCode(phone, "register");
  const db = dbm.get();
  if (data.name) await profiles.put(account, data.name, db);
  await require("../../services/pins").createPinStore({ db }).setPin(phone, String(pin));
  return { phone, account, token: await auth.createSession("farmer", phone, db) };
}

module.exports = { start, finish };
