// Outgoing SMS for the notifier and the phone-account service, through an outbox in the database (table sms_outbox).
//
//   enqueue()  records a message once (dedupe_key: e.g. "<tx>:<logIndex>:<n>", so an event never texts twice)
//   drain()    sends due messages in order. Per phone the order is kept: a message waits while an earlier one to the
//              same phone is waiting for a retry. Temporary failures retry after 30 s, 2 min, 10 min, 1 h, 6 h.
//   sendNow()  enqueue + send at once (one-time codes). Codes are never retried from the queue and their text is stored
//              with the code masked, so the database never holds a usable code.
//   recordDelivery()  Africa's Talking delivery report -> delivered / undeliverable.
//
// Provider: Africa's Talking when AT_USERNAME and AT_API_KEY are set ("sandbox" = their simulator), otherwise "log"
// (the message is only written to services/out/sms.log, which is what local development uses).
// Safety: SMS_ALLOWLIST (comma-separated 2507... numbers) limits live sending to those numbers. On the local chain
// live sending REQUIRES an allowlist, because the demo phone numbers (2507880000xx) may belong to real people.
const fs = require("fs");
const path = require("path");
const dbm = require("../web/server/db");

const OUT = path.join(__dirname, "out");
const SMS_LOG = path.join(OUT, "sms.log");
const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];
const OK_CODES = new Set([100, 101, 102]);                 // Processed, Sent, Queued
const TRANSIENT_CODES = new Set([405, 500, 501, 502]);     // InsufficientBalance, InternalServerError, GatewayError, RejectedByGateway

const live = () => Boolean(process.env.AT_USERNAME && process.env.AT_API_KEY);
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
function createOutbox({ db = dbm.get(), send = null, now = () => Date.now(), localChain = true, logFile = SMS_LOG, quiet = false } = {}) {
  const transport = send || (live() ? atSend : null);
  function log(line) {
    if (logFile) { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, line + "\n"); }
    if (!quiet) console.log(line);
  }

  // Live sending on a local/test chain needs an allowlist; with one, only listed numbers are texted.
  function blockedReason(phone) {
    if (!transport || send) return null; // log mode, or a test transport
    const list = allowlist();
    if (list.length) return list.includes(phone) ? null : "not in SMS_ALLOWLIST";
    return localChain ? "live SMS on the local chain needs SMS_ALLOWLIST" : null;
  }

  function enqueue({ phone, text, kind = "notice", key = null, stored = text }) {
    const t = now();
    const r = db.prepare(`INSERT OR IGNORE INTO sms_outbox (dedupe_key, phone, text, kind, status, next_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`).run(key, phone, stored, kind, t, t, t);
    return r.changes ? Number(r.lastInsertRowid) : null; // null: already recorded
  }

  const update = (id, fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE sms_outbox SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), now(), id);
  };

  // text: the real text to send (differs from the stored row only for one-time codes)
  async function deliver(row, text = row.text, { retry = true } = {}) {
    const blocked = blockedReason(row.phone);
    if (blocked) { update(row.id, { status: "skipped", error: blocked }); log(`${new Date(now()).toISOString()}  SMS skipped (${blocked}) -> +${row.phone}: ${row.text}`); return { ok: false, skipped: true }; }
    if (!transport) { // log mode
      log(`${new Date(now()).toISOString()}  SMS -> +${row.phone}: ${text}`);
      update(row.id, { status: "sent", attempts: row.attempts + 1, provider_status: "logged" });
      return { ok: true, logged: true };
    }
    const r = await transport(row.phone, text);
    const attempts = row.attempts + 1;
    log(`${new Date(now()).toISOString()}  SMS -> +${row.phone}: ${row.text}  [${r.ok ? `sent ${r.providerId || ""} ${r.cost || ""}` : `failed: ${r.error}`}]`);
    if (r.ok) update(row.id, { status: "sent", attempts, provider_id: r.providerId || null, provider_status: r.status || null, cost: r.cost || null, error: null });
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
  async function sendNow(phone, text, { kind = "notice", secret = null } = {}) {
    const stored = secret ? text.split(secret).join("******") : text;
    const id = enqueue({ phone, text, kind, stored });
    const row = db.prepare("SELECT * FROM sms_outbox WHERE id = ?").get(id);
    return deliver(row, text, { retry: !secret });
  }

  // Africa's Talking delivery report: {id, status: Success|Failed|Rejected|Buffered|Sent|Submitted, failureReason}
  function recordDelivery({ id, status, failureReason }) {
    const row = id && db.prepare("SELECT * FROM sms_outbox WHERE provider_id = ?").get(id);
    if (!row) return false;
    const final = status === "Success" ? "delivered" : status === "Failed" || status === "Rejected" ? "undeliverable" : row.status;
    update(row.id, { status: final, provider_status: status, error: failureReason || row.error });
    return true;
  }

  const stats = () => Object.fromEntries(db.prepare("SELECT status, COUNT(*) n FROM sms_outbox GROUP BY status").all().map((r) => [r.status, r.n]));

  return { enqueue, drain, sendNow, recordDelivery, stats, mode: send ? "test" : live() ? (process.env.AT_USERNAME === "sandbox" ? "africastalking-sandbox" : "africastalking-live") : "log" };
}

// Simple form kept for callers that just want "send this now" (phone accounts pass a code as `secret`).
let shared = null;
function sendSms(phone, text, opts = {}) {
  if (!shared) shared = createOutbox({ localChain: opts.localChain ?? true });
  return shared.sendNow(phone, text, opts);
}

module.exports = { createOutbox, sendSms, atSend, SMS_LOG, BACKOFF_MS };
