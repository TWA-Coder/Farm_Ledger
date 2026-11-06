// FarmLedger off-chain database (SQLite, built into Node 22.5+ as node:sqlite: no extra dependency or native build).
// One file shared by the web portal and the services (oracle, notifier, USSD):
//
//   contacts    plain phone numbers for SMS, keyed by account (the chain only stores keccak256(phone))
//   ussd_users  USSD PIN state (salted hash, failed tries, lock)
//   readings    where each oracle reading came from (real data or sample), keyed by transaction hash
//   events      index of FarmLedger contract events (see indexer.js), so screens never scan the chain from block 0
//   meta        indexer cursor and the identity of the chain the indexed data belongs to
//   phone_accounts  farmers on basic phones: smart account + its owner key, ENCRYPTED (services/phone-accounts.js)
//   otp_codes       one-time SMS codes (hashed), per phone and purpose
//   recovery_requests  moving a phone account to a new number (waiting period, cancellable from the old number)
//   sms_outbox  every SMS: queued -> sent -> delivered/undeliverable, with retries and provider ids (services/sms.js)
//   momo_payments  MTN MoMo premium collections, payouts and refunds, step by step (services/payments.js)
//   sms_inbound / sms_sessions  SMS received by the Android gateway phone, and each phone's menu conversation
//
// Location: $FARMLEDGER_DB, else web/.data/farmledger.db (git-ignored). WAL mode lets the portal and the services
// read and write the same file at the same time.
const fs = require("fs");
const path = require("path");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contacts (address TEXT PRIMARY KEY, phone TEXT NOT NULL, saved_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ussd_users (
  phone TEXT PRIMARY KEY, salt TEXT, pin_hash TEXT, tries INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0, pin_set_at TEXT);
CREATE TABLE IF NOT EXISTS readings (
  tx TEXT PRIMARY KEY, plot_id INTEGER, metric INTEGER, value INTEGER, observed_at INTEGER,
  source TEXT NOT NULL, adapter TEXT, logged_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  block INTEGER NOT NULL, log_index INTEGER NOT NULL, tx TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL,
  PRIMARY KEY (block, log_index));
CREATE INDEX IF NOT EXISTS events_name ON events (name);
CREATE TABLE IF NOT EXISTS phone_accounts (
  phone TEXT PRIMARY KEY, account TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, enc_key TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS otp_codes (
  phone TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL, data TEXT, expires_at INTEGER NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL, sends INTEGER NOT NULL DEFAULT 1, window_start INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (phone, purpose));
CREATE TABLE IF NOT EXISTS sms_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe_key TEXT UNIQUE, phone TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, provider_id TEXT, provider_status TEXT,
  cost TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sms_outbox_due ON sms_outbox (status, next_at);
CREATE INDEX IF NOT EXISTS sms_outbox_provider ON sms_outbox (provider_id);
CREATE TABLE IF NOT EXISTS sms_inbound (
  id TEXT PRIMARY KEY, phone TEXT NOT NULL, text TEXT NOT NULL, received_at INTEGER NOT NULL, reply TEXT);
CREATE TABLE IF NOT EXISTS sms_sessions (
  phone TEXT PRIMARY KEY, session_id TEXT NOT NULL, inputs TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS momo_payments (
  ref TEXT PRIMARY KEY, kind TEXT NOT NULL, phone TEXT NOT NULL, account TEXT NOT NULL, amount INTEGER NOT NULL,
  currency TEXT NOT NULL, external_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, intent TEXT, policy_id INTEGER,
  reason TEXT, financial_tx TEXT, parent TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS momo_payments_status ON momo_payments (status, updated_at);
CREATE TABLE IF NOT EXISTS momo_sim (
  ref TEXT PRIMARY KEY, kind TEXT NOT NULL, phone TEXT NOT NULL, amount TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS recovery_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, old_phone TEXT NOT NULL, new_phone TEXT NOT NULL, account TEXT NOT NULL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, ready_at INTEGER, done_at INTEGER, note TEXT);
`;

// The web server runs with cwd = web/, the services with cwd = the repository root.
function repoRoot() {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, "hardhat.config.js")) ? cwd : path.dirname(cwd);
}
const defaultFile = () => process.env.FARMLEDGER_DB || path.join(repoRoot(), "web", ".data", "farmledger.db");

function quietRequireSqlite() {
  // node:sqlite prints an "experimental feature" warning once per process; it is stable enough for this use.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (String(w).includes("SQLite") ? undefined : emit.call(process, w, ...rest));
  try { return require("node:sqlite"); } finally { process.emitWarning = emit; }
}

function open(file = defaultFile()) {
  const { DatabaseSync } = quietRequireSqlite();
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  upgrade(db);
  if (file !== ":memory:") { try { fs.chmodSync(file, 0o600); } catch { /* not fatal */ } } // phone numbers: owner only
  if (file === defaultFile()) migrateJsonFiles(db); // tests open their own files and never import real data
  return db;
}

// Columns added after a table first shipped (CREATE TABLE IF NOT EXISTS does not add them to an existing file).
function upgrade(db) {
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!has("sms_outbox", "via")) db.exec("ALTER TABLE sms_outbox ADD COLUMN via TEXT"); // provider that sends it
}

let shared = null;
function get() { // one connection per process
  if (!shared) shared = open();
  return shared;
}

function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
}

const getMeta = (db, key) => db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
const setMeta = (db, key, value) => db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));

// One-time import of the JSON files used before the database existed. Each file is renamed to *.imported afterwards.
function migrateJsonFiles(db) {
  if (process.env.FARMLEDGER_DB_NO_IMPORT || getMeta(db, "json_imported")) return;
  const root = repoRoot();
  const files = {
    contacts: process.env.CONTACTS_FILE || path.join(root, "web", ".data", "contacts.json"),
    ussd: path.join(root, "services", "out", "ussd-users.json"),
    readings: process.env.ORACLE_READINGS_LOG || path.join(root, "services", "out", "readings.json"),
  };
  const load = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
  tx(db, () => {
    const c = load(files.contacts);
    if (c && typeof c === "object") for (const [address, v] of Object.entries(c)) {
      if (v && v.phone) db.prepare("INSERT OR IGNORE INTO contacts VALUES (?, ?, ?)").run(address.toLowerCase(), v.phone, v.savedAt || new Date().toISOString());
    }
    const u = load(files.ussd);
    if (u && typeof u === "object") for (const [phone, v] of Object.entries(u)) {
      db.prepare("INSERT OR IGNORE INTO ussd_users VALUES (?, ?, ?, ?, ?, ?)").run(phone, v.salt || null, v.pinHash || null, v.tries || 0, v.lockedUntil || 0, v.pinSetAt || null);
    }
    const r = load(files.readings);
    if (Array.isArray(r)) for (const e of r) {
      if (e && e.tx) db.prepare("INSERT OR IGNORE INTO readings VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(e.tx.toLowerCase(), e.plotId ?? null, e.metric ?? null, e.value ?? null, e.observedAt ?? null, e.source, e.adapter ?? null, e.loggedAt || new Date().toISOString());
    }
    setMeta(db, "json_imported", new Date().toISOString());
  });
  for (const f of Object.values(files)) if (fs.existsSync(f)) { try { fs.renameSync(f, f + ".imported"); } catch { /* leave it */ } }
}

module.exports = { open, get, tx, getMeta, setMeta, defaultFile };
