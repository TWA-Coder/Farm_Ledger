// Portal sign-in: who is using the portal, and acting on-chain for them.
//
//   staff   (admin, underwriter, vet, agent)  username + password. Passwords are hashed with scrypt; 5 wrong tries lock
//           the login for 15 minutes. A login created by someone else starts with a one-time password that must be
//           changed at first sign-in.
//   farmer  phone number + 4-digit PIN: the same phone account and PIN as on USSD (services/pins.js), so 3 wrong PINs
//           lock the number on both channels.
//
// A session is a random 32-byte token in an HttpOnly, SameSite=Strict cookie; the database keeps only its SHA-256.
// Requests that change anything must also carry the header X-FarmLedger: 1, which a page on another site cannot add
// without the browser asking this server first (CORS), so forged cross-site requests are refused.
//
// Signing: the keys stay in the custody service (services/custody.js). wallet() turns a session into "send this
// transaction / sign this message as me", which custody restricts to FarmLedger's own contracts and message formats.
const crypto = require("crypto");
const dbm = require("./db");
const profiles = require("./profiles");
const { DocError } = require("./documents-core");

const COOKIE = "fl_session";
const SESSION_MS = 12 * 3600 * 1000;
const STAFF_TRIES = 5;
const STAFF_LOCK_MS = 15 * 60 * 1000;
const PHONE_RE = /^2507\d{8}$/;

const fail = (status, msg) => { throw new DocError(status, msg); };
const isLocal = () => ["localhost", "hardhat"].includes(require("./chain").deployment().network);
const pinStore = (db) => require("../../services/pins").createPinStore({ db });

// ---------------------------------------------------------------- passwords
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex") };
}
function passwordMatches(password, salt, hash) {
  if (!salt || !hash) return false;
  return crypto.timingSafeEqual(Buffer.from(hashPassword(password, salt).hash, "hex"), Buffer.from(hash, "hex"));
}
function checkNewPassword(pw) {
  if (typeof pw !== "string" || pw.length < 8) fail(400, "A password has at least 8 characters.");
  if (pw.length > 128) fail(400, "That password is too long.");
}
// readable one-time passwords for new logins and resets, e.g. "kite-4821-moss"
function tempPassword() {
  const words = ["amber", "brook", "cedar", "delta", "ember", "fern", "grove", "harbor", "iris", "juniper", "kite", "lake", "maple", "nova", "olive", "pine", "quartz", "river", "sage", "tide", "umber", "vale", "willow", "zephyr"];
  const w = () => words[crypto.randomInt(words.length)];
  return `${w()}-${String(crypto.randomInt(1000, 10000))}-${w()}`;
}

// ---------------------------------------------------------------- sessions
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function createSession(kind, subject, db = dbm.get()) {
  const token = crypto.randomBytes(32).toString("base64url");
  const t = Date.now();
  await db.run("DELETE FROM sessions WHERE expires_at < ?", [t]);
  await db.run("INSERT INTO sessions (id_hash, kind, subject, created_at, expires_at) VALUES (?, ?, ?, ?, ?)", [sha(token), kind, subject, t, t + SESSION_MS]);
  return token;
}

function tokenOf(request) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

async function sessionOf(request, db = dbm.get()) {
  const token = tokenOf(request);
  if (!token) return null;
  const r = await db.one("SELECT * FROM sessions WHERE id_hash = ?", [sha(token)]);
  if (!r || r.expires_at < Date.now()) return null;
  return { kind: r.kind, subject: r.subject, idHash: r.id_hash };
}

async function endSession(request, db = dbm.get()) {
  const token = tokenOf(request);
  if (token) await db.run("DELETE FROM sessions WHERE id_hash = ?", [sha(token)]);
}
const endAllSessions = (kind, subject, db = dbm.get()) => db.run("DELETE FROM sessions WHERE kind = ? AND subject = ?", [kind, subject]);

const secure = (request) => (request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "")) === "https";
function sessionCookie(request, token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure(request) ? "; Secure" : ""}`;
}
const clearCookie = (request) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure(request) ? "; Secure" : ""}`;

// Changes need the X-FarmLedger header (see top) and a JSON body.
function guard(request) {
  if (request.headers.get("x-farmledger") !== "1") fail(403, "Request refused (missing X-FarmLedger header).");
}

// ---------------------------------------------------------------- who is signed in
const staffRow = (username, db = dbm.get()) => db.one("SELECT * FROM staff_users WHERE username = ?", [String(username || "").toLowerCase()]);
const phoneRow = (phone, db = dbm.get()) => db.one("SELECT * FROM phone_accounts WHERE phone = ? AND status = 'active'", [phone]);

// -> { kind, address, name, role?, username?, phone?, mustChange? } or null
async function viewerOf(session, db = dbm.get()) {
  if (!session) return null;
  if (session.kind === "staff") {
    const r = await staffRow(session.subject, db);
    if (!r || r.disabled) return null;
    return { kind: "staff", username: r.username, name: r.name, role: r.role, address: r.address, phone: r.phone, mustChange: Boolean(r.must_change) };
  }
  if (session.kind === "farmer") {
    const r = await phoneRow(session.subject, db);
    if (!r) return null;
    return { kind: "farmer", role: "farmer", phone: r.phone, address: r.account, name: await profiles.get(r.account, db) };
  }
  return null;
}

async function requireViewer(request, { allowMustChange = false } = {}) {
  const v = await viewerOf(await sessionOf(request));
  if (!v) fail(401, "Please sign in.");
  if (v.mustChange && !allowMustChange) fail(403, "Choose a new password first.");
  return v;
}

// ---------------------------------------------------------------- sign in
async function loginStaff(username, password, db = dbm.get()) {
  const r = await staffRow(username, db);
  const t = Date.now();
  // the same answer for "no such user" and "wrong password", so usernames cannot be discovered here
  const wrong = () => fail(401, "Wrong username or password.");
  if (!r || r.disabled) { hashPassword(String(password || "x")); wrong(); }
  if (r.locked_until > t) fail(429, `Too many wrong passwords. Try again after ${new Date(r.locked_until).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}.`);
  if (!passwordMatches(password, r.pw_salt, r.pw_hash)) {
    const tries = r.tries + 1;
    await db.run("UPDATE staff_users SET tries = ?, locked_until = ? WHERE username = ?", [tries >= STAFF_TRIES ? 0 : tries, tries >= STAFF_TRIES ? t + STAFF_LOCK_MS : 0, r.username]);
    if (tries >= STAFF_TRIES) fail(429, "Too many wrong passwords. This login is locked for 15 minutes.");
    wrong();
  }
  await db.run("UPDATE staff_users SET tries = 0, locked_until = 0 WHERE username = ?", [r.username]);
  return createSession("staff", r.username, db);
}

function normalizePhone(v) {
  const d = String(v || "").replace(/\D/g, "");
  return /^07\d{8}$/.test(d) ? "25" + d : /^7\d{8}$/.test(d) ? "250" + d : d;
}

async function loginFarmer(phoneInput, pin, db = dbm.get()) {
  const phone = normalizePhone(phoneInput);
  const pins = pinStore(db);
  const wrong = () => fail(401, "Wrong phone number or PIN.");
  if (!PHONE_RE.test(phone)) fail(400, "Enter your phone number, e.g. 0788123456.");
  if (await pins.isLocked(phone)) fail(429, "Too many wrong tries. This number is locked for 30 minutes.");
  const r = await phoneRow(phone, db);
  if (!r || !(await pins.hasPin(phone))) wrong();
  const c = await pins.checkPin(phone, String(pin || ""));
  if (!c.ok) { if (c.locked) fail(429, "Too many wrong PINs. This number is locked for 30 minutes (on USSD too)."); wrong(); }
  return createSession("farmer", phone, db);
}

async function changePassword(viewer, current, next, db = dbm.get()) {
  if (viewer.kind !== "staff") fail(400, "Farmers change their PIN from the USSD menu (option 4).");
  const r = await staffRow(viewer.username, db);
  if (!passwordMatches(current, r.pw_salt, r.pw_hash)) fail(401, "Your current password is not right.");
  checkNewPassword(next);
  if (next === current) fail(400, "Choose a password different from the current one.");
  const h = hashPassword(next);
  await db.run("UPDATE staff_users SET pw_salt = ?, pw_hash = ?, must_change = 0 WHERE username = ?", [h.salt, h.hash, r.username]);
}

// ---------------------------------------------------------------- staff management
// Who may create which logins: the admin creates admins, underwriters and vets; an underwriter creates its agents
// (PolicyDesk.appointAgent is underwriter-only). Both checked on the chain, so a stale database cannot hand out powers.
async function canManage(viewer, role) {
  if (viewer.kind !== "staff") return false;
  const l = require("./chain").ledger();
  if (role === "agent") return Boolean(await l.hasRole(await l.UNDERWRITER_ROLE(), viewer.address));
  return Boolean(await l.hasRole(await l.DEFAULT_ADMIN_ROLE(), viewer.address));
}

function custody() {
  const { custodyConfig } = require("../../services/custody-client");
  return custodyConfig({ local: isLocal() });
}
const custodyCall = (route, body) => require("../../services/custody-client").custodyCall(custody(), route, body);

async function createStaff(viewer, { name, username, role, phone }) {
  if (!(await canManage(viewer, role))) fail(403, role === "agent" ? "Only an underwriter can add agents." : "Only the administrator can add staff.");
  const clean = profiles.cleanName(name);
  const ph = phone ? normalizePhone(phone) : null;
  if (ph && !PHONE_RE.test(ph)) fail(400, "Phone numbers look like 0788123456.");
  let r;
  try { r = await custodyCall("/staff/create", { username, name: clean, role, phone: ph, createdBy: viewer.username }); }
  catch (e) { fail(e.status === 400 ? 400 : 503, e.message); }
  const temp = tempPassword();
  const h = hashPassword(temp);
  const db = dbm.get();
  await db.run("UPDATE staff_users SET pw_salt = ?, pw_hash = ?, must_change = 1 WHERE username = ?", [h.salt, h.hash, r.username]);
  if (ph) await require("./contacts").put(r.address, ph, db); // agents and vets get SMS too
  return { username: r.username, address: r.address, tempPassword: temp };
}

async function listStaff(viewer, db = dbm.get()) {
  if (viewer.kind !== "staff" || !["admin", "underwriter"].includes(viewer.role)) fail(403, "Not allowed.");
  const rows = await db.all("SELECT username, address, name, role, phone, disabled, must_change, created_by, created_at FROM staff_users ORDER BY created_at");
  return rows.filter((r) => viewer.role === "admin" || r.role === "agent")
    .map((r) => ({ username: r.username, address: r.address, name: r.name, role: r.role, phone: r.phone, disabled: Boolean(r.disabled), pending: Boolean(r.must_change), createdBy: r.created_by, createdAt: r.created_at }));
}

async function manageStaff(viewer, username, action, db = dbm.get()) {
  const r = await staffRow(username, db);
  if (!r) fail(404, "No such login.");
  if (!(await canManage(viewer, r.role))) fail(403, "Not allowed.");
  if (r.username === viewer.username) fail(400, "You cannot change your own login here.");
  if (action === "reset") {
    const temp = tempPassword();
    const h = hashPassword(temp);
    await db.run("UPDATE staff_users SET pw_salt = ?, pw_hash = ?, must_change = 1, tries = 0, locked_until = 0 WHERE username = ?", [h.salt, h.hash, r.username]);
    await endAllSessions("staff", r.username, db);
    return { tempPassword: temp };
  }
  if (action === "disable" || action === "enable") {
    await db.run("UPDATE staff_users SET disabled = ? WHERE username = ?", [action === "disable" ? 1 : 0, r.username]);
    if (action === "disable") await endAllSessions("staff", r.username, db);
    return { disabled: action === "disable" };
  }
  fail(400, "Unknown action.");
}

// ---------------------------------------------------------------- acting on-chain for the signed-in person
// Staff: an ordinary transaction from their key. Farmers: a sponsored smart-account operation from their phone account.
async function send(viewer, tx) {
  const t = { to: String(tx?.to || ""), data: String(tx?.data || "0x") };
  if (tx?.value && BigInt(tx.value) !== 0n) fail(400, "The portal never sends coins.");
  if (viewer.kind === "staff") return (await custodyCall("/staff/send", { username: viewer.username, tx: t })).hash;
  return (await custodyCall("/calls", { phone: viewer.phone, calls: [t] })).hash;
}

async function sign(viewer, { message, typed }) {
  if (viewer.kind === "staff") return (await custodyCall("/staff/sign", typed ? { username: viewer.username, typed } : { username: viewer.username, message })).signature;
  if (typed) fail(400, "Farmers do not sign claim decisions.");
  return (await custodyCall("/sign", { phone: viewer.phone, message })).signature;
}

// Names the viewer may see: staff see everyone's; a farmer sees their own and the staff's (their agent, vets).
async function namesFor(viewer, db = dbm.get()) {
  if (viewer.kind === "staff") return profiles.all(db);
  const staff = (await db.all("SELECT address FROM staff_users")).map((r) => r.address);
  return profiles.all(db, [viewer.address, ...staff]);
}

module.exports = {
  COOKIE, guard, sessionOf, viewerOf, requireViewer, sessionCookie, clearCookie, endSession, createSession,
  loginStaff, loginFarmer, changePassword, normalizePhone, createStaff, listStaff, manageStaff, send, sign, namesFor,
  hashPassword, passwordMatches, tempPassword, isLocal, PHONE_RE,
};
