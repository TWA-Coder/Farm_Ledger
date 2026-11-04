// SMS menu channel through an Android phone running "SMS Gateway for Android" (capcom6/android-sms-gateway).
//
// A farmer with any basic phone texts the gateway phone's number. The app forwards each SMS to us as a webhook
// (event sms:received); we feed it into the SAME menu engine as USSD (ussd-core.js) and text the screen back from the
// gateway phone. So every menu, PIN, one-time code and phone account works the same over SMS, without a USSD
// shortcode, a regulator or a monthly fee. One SMS = one answer.
//
//   Text "FL" (or MENU / START, or anything after 10 minutes of silence) -> the main menu
//   Then reply with the number of a choice, a PIN, an ID ... exactly as on USSD
//
// Webhook security (all three apply):
//   * ?key=<CALLBACK_TOKEN> on the URL (checked in ussd-http.js for anything arriving through the tunnel)
//   * X-Signature = hex HMAC-SHA256(SMSGATE_SIGNING_KEY, rawBody + X-Timestamp), timestamp within 5 minutes
//   * each webhook id is processed once (the app retries until it gets a 2xx, so duplicates are expected)
// Trust note: the sender number of an SMS is set by the network, but SMS sender numbers can be spoofed on some
// international routes. Actions still need the PIN, and account creation needs a code sent BACK to that number.
const crypto = require("crypto");
const dbm = require("../web/server/db");

const START = /^(fl|farmledger|menu|start)$/i;
const SESSION_MS = Number(process.env.SMS_SESSION_MINUTES || 10) * 60 * 1000;
const MAX_SKEW_S = 300;

function verifySignature({ raw, signature, timestamp, key, nowS }) {
  if (!signature || !timestamp) return { ok: false, reason: "missing X-Signature / X-Timestamp" };
  if (!/^\d+$/.test(String(timestamp)) || Math.abs(nowS - Number(timestamp)) > MAX_SKEW_S) return { ok: false, reason: "timestamp too old or invalid" };
  const want = crypto.createHmac("sha256", key).update(raw + timestamp).digest("hex");
  const got = String(signature).toLowerCase();
  const ok = got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  return ok ? { ok: true } : { ok: false, reason: "bad signature" };
}

function createSmsChannel({ db = dbm.get(), ussd, outbox, signingKey = process.env.SMSGATE_SIGNING_KEY || "", now = () => Date.now(), replyVia = "smsgate" }) {
  const digits = (p) => String(p || "").replace(/\D/g, "");

  // One SMS in, one screen out. The session is the list of answers so far, like a USSD session's text.
  async function converse(phone, text) {
    const clean = String(text || "").replace(/[*#]/g, "").trim(); // "*" separates answers in the menu engine
    const row = db.prepare("SELECT * FROM sms_sessions WHERE phone = ?").get(phone);
    const fresh = !row || now() - row.updated_at > SESSION_MS || START.test(clean);
    const sessionId = fresh ? "sms-" + crypto.randomBytes(6).toString("hex") : row.session_id;
    const inputs = fresh ? [] : [...JSON.parse(row.inputs), clean];
    const screen = await ussd.handle({ sessionId, phoneNumber: "+" + phone, text: inputs.join("*") });
    const body = screen.replace(/^(CON|END) /, "");
    if (screen.startsWith("END")) {
      db.prepare("DELETE FROM sms_sessions WHERE phone = ?").run(phone);
      return `${body}\nText FL for the menu.`;
    }
    db.prepare(`INSERT INTO sms_sessions (phone, session_id, inputs, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET session_id = excluded.session_id, inputs = excluded.inputs, updated_at = excluded.updated_at`)
      .run(phone, sessionId, JSON.stringify(inputs), now());
    return body;
  }

  // -> {status, body}. raw = the request body exactly as received (the signature covers it).
  async function handleWebhook({ raw, headers }) {
    if (signingKey) {
      const v = verifySignature({ raw, signature: headers["x-signature"], timestamp: headers["x-timestamp"], key: signingKey, nowS: Math.floor(now() / 1000) });
      if (!v.ok) return { status: 401, body: v.reason };
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return { status: 400, body: "bad json" }; }
    const p = msg.payload || {};

    if (msg.event === "sms:received") {
      const id = String(msg.id || p.messageId || "");
      const phone = digits(p.sender);
      if (!id || !phone) return { status: 400, body: "missing id or sender" };
      const fresh = db.prepare("INSERT OR IGNORE INTO sms_inbound (id, phone, text, received_at) VALUES (?, ?, ?, ?)")
        .run(id, phone, String(p.message || "").slice(0, 500), now()).changes;
      if (!fresh) return { status: 200, body: "duplicate" }; // the app retried a webhook we already handled
      const reply = await converse(phone, p.message);
      db.prepare("UPDATE sms_inbound SET reply = ? WHERE id = ?").run(reply, id);
      await outbox.sendNow(phone, reply, { kind: "sms-menu", via: replyVia });
      return { status: 200, body: "ok" };
    }
    if (["sms:sent", "sms:delivered", "sms:failed"].includes(msg.event)) {
      const status = msg.event === "sms:delivered" ? "Delivered" : msg.event === "sms:failed" ? "Failed" : "Sent";
      outbox.recordDelivery({ id: p.messageId || p.id, status, failureReason: p.reason || p.error || null });
      return { status: 200, body: "ok" };
    }
    return { status: 200, body: "ignored" }; // system:ping etc.
  }

  return { handleWebhook, converse, signed: Boolean(signingKey) };
}

module.exports = { createSmsChannel, verifySignature, START };
