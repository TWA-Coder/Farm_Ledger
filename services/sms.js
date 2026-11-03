// Outgoing SMS for the notifier and the phone-account service, through an outbox in the database (table sms_outbox).
//
//   enqueue()  records a message once (dedupe_key: e.g. "<tx>:<logIndex>:<n>", so an event never texts twice)
//   drain()    sends due messages in order. Per phone the order is kept: a message waits while an earlier one to the
//              same phone is waiting for a retry. Temporary failures retry after 30 s, 2 min, 10 min, 1 h, 6 h.
//   sendNow()  enqueue + send at once (one-time codes). Codes are never retried from the queue and their text is stored
//              with the code masked, so the database never holds a usable code.
//   recordDelivery()  Africa's Talking delivery report -> delivered / undeliverable.
//
// Providers (SMS_PROVIDER, or picked automatically in this order):
//   intouch         IntouchSMS, a Rwandan gateway with direct MTN / Airtel routes (INTOUCH_USERNAME + INTOUCH_PASSWORD,
//                   INTOUCH_SENDER). No delivery webhook: refreshStatuses() asks for the status of sent messages.
//   africastalking  AT_USERNAME + AT_API_KEY ("sandbox" = their simulator)
//   smsgate         an Android phone running SMS Gateway for Android (SMSGATE_URL + SMSGATE_USER/PASSWORD), which
//                   also receives farmers' SMS (services/sms-channel.js). Replies to a farmer's SMS always go out
//                   through the gateway phone, so the conversation stays on one number.
//   log             only written to services/out/sms.log (local development)
// Safety: SMS_ALLOWLIST (comma-separated 2507... numbers) limits live sending to those numbers. On the local chain
// live sending REQUIRES an allowlist. SMS_ALLOWLIST=* sends to every number EXCEPT the seeded demo numbers
// (25078800xxxx: Aline, Jean, the demo vets...), which may belong to real people and are texted on every demo event.
const fs = require("fs");
const path = require("path");
const dbm = require("../web/server/db");

const OUT = path.join(__dirname, "out");
const SMS_LOG = path.join(OUT, "sms.log");
const DAY_MS = 24 * 3600 * 1000;
const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];
const OK_CODES = new Set([100, 101, 102]);                 // Processed, Sent, Queued
const TRANSIENT_CODES = new Set([405, 500, 501, 502]);     // InsufficientBalance, InternalServerError, GatewayError, RejectedByGateway

const atConfigured = () => Boolean(process.env.AT_USERNAME && process.env.AT_API_KEY);
const intouchConfigured = () => Boolean(process.env.INTOUCH_USERNAME && process.env.INTOUCH_PASSWORD);
const gateConfigured = () => Boolean(process.env.SMSGATE_URL && process.env.SMSGATE_USER && process.env.SMSGATE_PASSWORD);
function defaultVia() {
  const p = (process.env.SMS_PROVIDER || "").toLowerCase();
  if (p) return p;
  return intouchConfigured() ? "intouch" : atConfigured() ? "africastalking" : gateConfigured() ? "smsgate" : "log";
}
const DEMO_NUMBER = /^25078800\d{4}$/;
const allowlist = () => (process.env.SMS_ALLOWLIST || "").split(",").map((s) => s.replace(/\D/g, "")).filter(Boolean);


// One message through Africa's Talking. -> {ok, transient, providerId, status, cost, error}
async function atSend(phone, text) {
  const sandbox = process.env.AT_USERNAME === "sandbox";
  const base = process.env.AT_BASE_URL || `https://api.${sandbox ? "sandbox." : ""}africastalking.com`;
  const form = { username: process.env.AT_USERNAME, to: `+${phone}`, message: text };
  if (process.env.AT_SENDER_ID) form.from = process.env.AT_SENDER_ID;
  let res, body;
  try {
    res = await fetch(`${base}/version1/messaging`, {
      method: "POST",
      headers: { apiKey: process.env.AT_API_KEY, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form),
    });
    body = await res.json().catch(() => null);
  } catch (e) {
    return { ok: false, transient: true, error: `network: ${e.message}` };
  }
  if (!res.ok) return { ok: false, transient: res.status >= 500 || res.status === 429, error: `HTTP ${res.status}${body ? " " + JSON.stringify(body).slice(0, 120) : ""}` };
  const r = body?.SMSMessageData?.Recipients?.[0];
  if (!r) return { ok: false, transient: false, error: body?.SMSMessageData?.Message || "no recipient in response" };
  const code = Number(r.statusCode);
  if (OK_CODES.has(code)) return { ok: true, providerId: r.messageId, status: r.status, cost: r.cost };
  return { ok: false, transient: TRANSIENT_CODES.has(code), status: r.status, error: `${code} ${r.status}` };
}

// logFile: where every message is written (null = nowhere, for tests); quiet: no console output
// One message through the Android gateway (cloud: https://api.sms-gate.app/3rdparty/v1, local: http://<phone-ip>:8080).
async function gateSend(phone, text) {
  const base = String(process.env.SMSGATE_URL || "").replace(/\/+$/, "");
  const auth = Buffer.from(`${process.env.SMSGATE_USER}:${process.env.SMSGATE_PASSWORD}`).toString("base64");
  let res, body;
  try {
    res = await fetch(`${base}/message`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ textMessage: { text }, phoneNumbers: [`+${phone}`], withDeliveryReport: true }),
    });
    body = await res.json().catch(() => null);
  } catch (e) {
    return { ok: false, transient: true, error: `network: ${e.message}` };
  }
  if (!res.ok) return { ok: false, transient: res.status >= 500 || res.status === 429, error: `HTTP ${res.status}${body ? " " + JSON.stringify(body).slice(0, 120) : ""}` };
  return { ok: true, providerId: body?.id || null, status: body?.state || "Pending" };
}

// ---------------------------------------------------------------- IntouchSMS (https://www.intouchsms.co.rw/http-api)
// Send: POST /api/sendsms/.json  recipients, message, sender (+ username/password; also sent as HTTP basic auth, as in
// their samples). Response {success, details: [{status, cost, receipient, messageid}], summary}. Their page says the
// body is JSON but their samples send form fields: INTOUCH_FORMAT=json switches. Recipient number format:
// INTOUCH_RECIPIENT_FORMAT = intl (250788123456, default) | plus (+250...) | local (0788123456).
// Status: POST /api/getsmsstatus/.json  messageid -> {success, results: {status}}: P processing, Q queued,
// S sent to carrier, D delivered, E error, U unsent by carrier.
const INTOUCH_FINAL = { D: "delivered", E: "undeliverable", U: "undeliverable" };

function intouchRequest(pathName, fields) {
  const base = String(process.env.INTOUCH_URL || "https://www.intouchsms.co.rw").replace(/\/+$/, "");
  const user = process.env.INTOUCH_USERNAME, pass = process.env.INTOUCH_PASSWORD;
  const json = (process.env.INTOUCH_FORMAT || "form").toLowerCase() === "json";
  const all = { username: user, password: pass, ...fields };
  return fetch(`${base}${pathName}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
      "Content-Type": json ? "application/json" : "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: json ? JSON.stringify(all) : new URLSearchParams(all),
  });
}

function intouchNumber(phone) {
  const f = (process.env.INTOUCH_RECIPIENT_FORMAT || "intl").toLowerCase();
  if (f === "plus") return `+${phone}`;
  if (f === "local") return phone.startsWith("250") ? "0" + phone.slice(3) : phone;
  return phone;
}

const describe = (body) => (body && typeof body === "object"
  ? String(body.response || body.message || body.error || body.details || JSON.stringify(body)).slice(0, 160)
  : String(body || "").slice(0, 160));

async function intouchSend(phone, text) {
  const fields = { recipients: intouchNumber(phone), message: text };
  if (process.env.INTOUCH_SENDER) fields.sender = process.env.INTOUCH_SENDER;
  let res, raw, body;
  try {
    res = await intouchRequest("/api/sendsms/.json", fields);
    raw = await res.text();
    try { body = JSON.parse(raw); } catch { body = raw; }
  } catch (e) {
    return { ok: false, transient: true, error: `network: ${e.message}` };
  }
  if (res.status >= 500 || res.status === 429) return { ok: false, transient: true, error: `HTTP ${res.status} ${describe(body)}` };
  if (!res.ok || !body || body.success !== true) return { ok: false, transient: false, error: `HTTP ${res.status} ${describe(body)}` };
  const d = Array.isArray(body.details) ? body.details[0] : null;
  if (d && INTOUCH_FINAL[d.status] === "undeliverable") return { ok: false, transient: false, status: d.status, error: `Intouch status ${d.status}` };
  return { ok: true, providerId: d?.messageid != null ? String(d.messageid) : null, status: d?.status || "P", cost: d?.cost != null ? `RWF ${d.cost}` : null };
}

// -> "delivered" | "undeliverable" | null (not final yet) | throws on a network error
async function intouchStatus(messageId) {
  const res = await intouchRequest("/api/getsmsstatus/.json", { messageid: messageId });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) return { final: null, status: null };
  const st = body.results?.status || null;
  return { final: INTOUCH_FINAL[st] || null, status: st };
}

const TRANSPORTS = { africastalking: atSend, intouch: intouchSend, smsgate: gateSend, log: null };

function createOutbox({ db = dbm.get(), send = null, now = () => Date.now(), localChain = true, logFile = SMS_LOG, quiet = false } = {}) {
  const transportFor = (via) => (send ? send : TRANSPORTS[via] ?? null);
  function log(line) {
    if (logFile) { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, line + "\n"); }
    if (!quiet) console.log(line);
  }

  // Live sending on a local/test chain needs an allowlist; with one, only listed numbers are texted.
  function blockedReason(phone, transport) {
    if (!transport || send) return null; // log mode, or a test transport
    const list = allowlist();
    if ((process.env.SMS_ALLOWLIST || "").trim() === "*") return DEMO_NUMBER.test(phone) ? "seeded demo number (never texted live)" : null;
    if (list.length) return list.includes(phone) ? null : "not in SMS_ALLOWLIST";
    return localChain ? "live SMS on the local chain needs SMS_ALLOWLIST" : null;
  }

  // via: provider for this message (null = the default provider when it is sent)
  function enqueue({ phone, text, kind = "notice", key = null, stored = text, via = null }) {
    const t = now();
    const r = db.prepare(`INSERT OR IGNORE INTO sms_outbox (dedupe_key, phone, text, kind, status, next_at, created_at, updated_at, via)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`).run(key, phone, stored, kind, t, t, t, via);
    return r.changes ? Number(r.lastInsertRowid) : null; // null: already recorded
  }

  const update = (id, fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE sms_outbox SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), now(), id);
  };

  // text: the real text to send (differs from the stored row only for one-time codes)
  async function deliver(row, text = row.text, { retry = true } = {}) {
    const via = row.via || defaultVia();
    const transport = transportFor(via);
    if (!transport && via !== "log") { update(row.id, { status: "failed", error: `unknown SMS provider "${via}"` }); return { ok: false }; }
    const blocked = blockedReason(row.phone, transport);
    if (blocked) { update(row.id, { status: "skipped", error: blocked }); log(`${new Date(now()).toISOString()}  SMS skipped (${blocked}) -> +${row.phone}: ${row.text}`); return { ok: false, skipped: true }; }
    if (!transport) { // log mode
      log(`${new Date(now()).toISOString()}  SMS -> +${row.phone}: ${text}`);
      update(row.id, { status: "sent", attempts: row.attempts + 1, provider_status: "logged" });
      return { ok: true, logged: true };
    }
    const r = await transport(row.phone, text);
    const attempts = row.attempts + 1;
    log(`${new Date(now()).toISOString()}  SMS -> +${row.phone}: ${row.text}  [${r.ok ? `sent ${r.providerId || ""} ${r.cost || ""}` : `failed: ${r.error}`}]`);
    if (r.ok) update(row.id, { status: "sent", attempts, via, provider_id: r.providerId || null, provider_status: r.status || null, cost: r.cost || null, error: null });
    else if (retry && r.transient && attempts <= BACKOFF_MS.length) update(row.id, { status: "queued", attempts, next_at: now() + BACKOFF_MS[attempts - 1], error: r.error });
    else update(row.id, { status: "failed", attempts, error: r.error });
    return r;
  }

  // Sends every due message, oldest first, keeping per-phone order.
  async function drain({ limit = 50 } = {}) {
    const t = now();
    const rows = db.prepare("SELECT * FROM sms_outbox WHERE status = 'queued' ORDER BY id LIMIT ?").all(limit * 4);
    const held = new Set(); // phones with an earlier message still waiting
    let sent = 0;
    for (const row of rows) {
      if (sent >= limit) break;
      if (held.has(row.phone)) continue;
      if (row.next_at > t) { held.add(row.phone); continue; }
      const r = await deliver(row);
      sent++;
      if (!r.ok && !r.skipped && r.transient) held.add(row.phone);
    }
    return sent;
  }

  // One-time codes: sent at once, never retried from the queue, stored with the code masked.
  async function sendNow(phone, text, { kind = "notice", secret = null, via = null } = {}) {
    const stored = secret ? text.split(secret).join("******") : text;
    const id = enqueue({ phone, text, kind, stored, via });
    const row = db.prepare("SELECT * FROM sms_outbox WHERE id = ?").get(id);
    return deliver(row, text, { retry: !secret });
  }

  // Delivery report. Africa's Talking: Success|Failed|Rejected|Buffered|Sent|Submitted. Gateway: Delivered|Failed|Sent.
  function recordDelivery({ id, status, failureReason }) {
    const row = id && db.prepare("SELECT * FROM sms_outbox WHERE provider_id = ?").get(id);
    if (!row) return false;
    const final = status === "Success" || status === "Delivered" ? "delivered"
      : status === "Failed" || status === "Rejected" ? "undeliverable" : row.status;
    update(row.id, { status: final, provider_status: status, error: failureReason || row.error });
    return true;
  }

  // Providers without delivery webhooks (Intouch): ask for the status of messages sent in the last 2 days, at most
  // once a minute per message, until it is final. Called by the notifier on every tick.
  async function refreshStatuses({ limit = 20, status = intouchStatus } = {}) {
    const t = now();
    const rows = db.prepare(`SELECT * FROM sms_outbox WHERE status = 'sent' AND via = 'intouch' AND provider_id IS NOT NULL
      AND updated_at <= ? AND created_at >= ? ORDER BY updated_at LIMIT ?`).all(t - 60_000, t - 2 * DAY_MS, limit);
    let changed = 0;
    for (const row of rows) {
      let r;
      try { r = await status(row.provider_id); } catch { break; } // provider unreachable: try again next tick
      if (r.final) { update(row.id, { status: r.final, provider_status: r.status }); changed++; }
      else update(row.id, { provider_status: r.status || row.provider_status }); // touch updated_at: next check in a minute
    }
    return changed;
  }

  const stats = () => Object.fromEntries(db.prepare("SELECT status, COUNT(*) n FROM sms_outbox GROUP BY status").all().map((r) => [r.status, r.n]));

  const via = defaultVia();
  const mode = send ? "test"
    : via === "africastalking" ? (process.env.AT_USERNAME === "sandbox" ? "africastalking-sandbox" : "africastalking-live")
    : via === "smsgate" ? "android-gateway" : via;
  const list = (process.env.SMS_ALLOWLIST || "").trim();
  const reach = mode === "log" || mode === "test" ? ""
    : list === "*" ? " (any number except the seeded demo numbers)"
    : list ? ` (only ${list})`
    : localChain ? " (nobody yet: set SMS_ALLOWLIST)" : "";
  return { enqueue, drain, sendNow, recordDelivery, refreshStatuses, stats, mode, describe: mode + reach, gatewayReady: gateConfigured() };
}

// Simple form kept for callers that just want "send this now" (phone accounts pass a code as `secret`).
let shared = null;
function sendSms(phone, text, opts = {}) {
  if (!shared) shared = createOutbox({ localChain: opts.localChain ?? true });
  return shared.sendNow(phone, text, opts);
}

module.exports = { createOutbox, sendSms, atSend, gateSend, intouchSend, intouchStatus, SMS_LOG, BACKOFF_MS };
