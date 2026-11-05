// Phone accounts: a FarmLedger smart account for a farmer who only has a basic phone (USSD + SMS).
//
// Custody model (decision 1A, "backend signer"). This is the ONLY module that holds farmer keys.
//   * One ERC-4337 smart account per phone number. Its owner key is generated here and stored ENCRYPTED
//     (AES-256-GCM, key derived from PHONE_KEY_SECRET with HKDF). It is decrypted only in memory to sign a
//     UserOperation and is never returned, logged or sent anywhere. Fees are paid by the FarmLedger paymaster.
//   * The phone network identifies the caller (USSD phoneNumber). A 4-digit PIN (ussd-core.js) gates actions.
//   * A one-time SMS code is required when an account is created and when it moves to a new number. It proves the
//     number really RECEIVES SMS, which matters because payout notices go there.
//   * This is custodial: whoever runs the server with PHONE_KEY_SECRET can sign for these farmers. That is the
//     trade-off for serving farmers without smartphones. Keep the secret out of the database host's backups,
//     and rotate it with a re-encryption script if it leaks.
//
// Number change ("recovery"): the farmer dials from the NEW number, gives the old number and their National ID
// (checked against the hash on-chain), and confirms a code sent to the new number. The move then waits
// RECOVERY_DELAY_HOURS (default 48) while the old number is told by SMS and can cancel from USSD. The operator
// can cancel or release early (npm run accounts). When it completes, the SAME account (same address, same
// policies) is bound to the new number and updatePhone() records the new number's hash on-chain.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { SmartAccountSigner } = require("../web/shared/smart-account-signer");
const contacts = require("../web/server/contacts");
const dbm = require("../web/server/db");

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_TRIES = 5;
const RESEND_MS = 60 * 1000;
const SENDS_PER_DAY = 5;
const DAY_MS = 24 * 3600 * 1000;
const hashOf = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const maskPhone = (p) => `+${p.slice(0, 5)}...${p.slice(-2)}`;
// SMS texts are kept under 160 characters (one SMS each). USSD_SHORTCODE is the code farmers dial, e.g. *384*123#.
const DIAL = () => process.env.USSD_SHORTCODE || "the FarmLedger USSD code";
const CODE_TEXT = {
  register: (code) => `FarmLedger code: ${code}. Dial ${DIAL()} and enter it to finish registering. Valid 10 minutes.`,
  move: (code) => `FarmLedger code: ${code}. Dial ${DIAL()} from this phone and enter it to move your account here. Valid 10 minutes.`,
};

// 32-byte master secret. Local chain: generated once into web/.data/phone-key.secret (owner-only). Elsewhere: required.
function loadSecret({ local }) {
  if (process.env.PHONE_KEY_SECRET) {
    const b = Buffer.from(process.env.PHONE_KEY_SECRET, "hex");
    if (b.length !== 32) throw new Error("PHONE_KEY_SECRET must be 64 hex characters (32 bytes).");
    return b;
  }
  if (!local) throw new Error("Set PHONE_KEY_SECRET (64 hex chars, e.g. `openssl rand -hex 32`) to run phone accounts on this network.");
  const file = path.join(path.dirname(dbm.defaultFile()), "phone-key.secret");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    console.warn(`[phone-accounts] generated a local key-encryption secret at ${file} (set PHONE_KEY_SECRET in production)`);
  }
  return Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
}

function createPhoneAccounts(opts) {
  const {
    db = dbm.get(), provider, aa, ledgerAddress, abi, secret, sendSms,
    transport = null, now = () => Date.now(),
    recoveryDelayMs = Number(process.env.RECOVERY_DELAY_HOURS ?? 48) * 3600 * 1000,
  } = opts;
  if (!secret || secret.length !== 32) throw new Error("phone accounts need a 32-byte secret");
  if (!aa) throw new Error("phone accounts need the smart-account contracts (deployment aa)");
  const wrapKey = Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.alloc(0), "farmledger/phone-key/v1", 32));
  const codeKey = Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.alloc(0), "farmledger/otp/v1", 32));
  const decoders = [new ethers.Interface(abi.ledger), ...(abi.token ? [new ethers.Interface(abi.token)] : [])];
  const ledgerRO = new ethers.Contract(ledgerAddress, abi.ledger, provider);

  // ---------------------------------------------------------------- key storage
  // The ciphertext is bound to the account address (GCM associated data), so a row cannot be swapped onto another
  // account. It is not bound to the phone number, so a number change needs no re-encryption.
  function seal(privateKey, account) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", wrapKey, iv);
    c.setAAD(Buffer.from(account.toLowerCase()));
    const ct = Buffer.concat([c.update(Buffer.from(privateKey.slice(2), "hex")), c.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") });
  }
  function unseal(row) {
    const e = JSON.parse(row.enc_key);
    const d = crypto.createDecipheriv("aes-256-gcm", wrapKey, Buffer.from(e.iv, "base64"));
    d.setAAD(Buffer.from(row.account.toLowerCase()));
    d.setAuthTag(Buffer.from(e.tag, "base64"));
    return "0x" + Buffer.concat([d.update(Buffer.from(e.ct, "base64")), d.final()]).toString("hex");
  }
  const rowOf = (phone) => db.prepare("SELECT * FROM phone_accounts WHERE phone = ?").get(phone) || null;
  const signerOf = (row) => new SmartAccountSigner(new ethers.Wallet(unseal(row)), provider, aa, decoders, 0n, transport);

  function accountOf(phone) {
    const r = rowOf(phone);
    return r ? { phone: r.phone, account: r.account, owner: r.owner, status: r.status, createdAt: r.created_at } : null;
  }

  // For later phases (buying cover by USSD, paying premiums): a signer for an ACTIVE account. The caller must have
  // checked the PIN. The signer never exposes the key (owner is an ethers.Wallet kept inside it).
  function signerFor(phone) {
    const r = rowOf(phone);
    if (!r || r.status !== "active") throw new Error("No active phone account for this number.");
    return signerOf(r);
  }

  // ---------------------------------------------------------------- one-time codes
  const codeHash = (phone, purpose, code) => crypto.createHmac("sha256", codeKey).update(`${phone}|${purpose}|${code}`).digest("hex");
  const codeRow = (phone, purpose) => db.prepare("SELECT * FROM otp_codes WHERE phone = ? AND purpose = ?").get(phone, purpose) || null;

  // Returns {ok, expiresAt} or {ok:false, reason: "wait" | "limit", waitS}.
  async function sendCode(phone, purpose, data, text = CODE_TEXT[purpose]) {
    const t = now();
    const r = codeRow(phone, purpose);
    let sends = 0, windowStart = t;
    if (r) {
      if (t - r.sent_at < RESEND_MS) return { ok: false, reason: "wait", waitS: Math.ceil((RESEND_MS - (t - r.sent_at)) / 1000) };
      if (t - r.window_start < DAY_MS) { sends = r.sends; windowStart = r.window_start; }
      if (sends >= SENDS_PER_DAY) return { ok: false, reason: "limit" };
    }
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    db.prepare(`INSERT INTO otp_codes (phone, purpose, code_hash, data, expires_at, tries, sent_at, sends, window_start, verified)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 0)
      ON CONFLICT(phone, purpose) DO UPDATE SET code_hash = excluded.code_hash, data = excluded.data, expires_at = excluded.expires_at,
      tries = 0, sent_at = excluded.sent_at, sends = excluded.sends, window_start = excluded.window_start, verified = 0`)
      .run(phone, purpose, codeHash(phone, purpose, code), JSON.stringify(data ?? null), t + CODE_TTL_MS, t, sends + 1, windowStart);
    await sendSms(phone, text(code));
    return { ok: true, expiresAt: t + CODE_TTL_MS };
  }

  const live = (r) => r && r.expires_at > now();
  // A code was sent and has not been entered yet.
  function pendingCode(phone, purpose) {
    const r = codeRow(phone, purpose);
    return live(r) && !r.verified ? { data: JSON.parse(r.data), expiresAt: r.expires_at } : null;
  }
  // A code was entered correctly and the step it unlocks has not finished yet.
  function verifiedCode(phone, purpose) {
    const r = codeRow(phone, purpose);
    return live(r) && r.verified ? { data: JSON.parse(r.data) } : null;
  }
  // {ok:true, data} or {ok:false, left} (left = 0: the code is void, start over)
  function checkCode(phone, purpose, code) {
    const r = codeRow(phone, purpose);
    if (!live(r) || r.verified) return { ok: false, left: 0 };
    const good = /^\d{6}$/.test(String(code)) &&
      crypto.timingSafeEqual(Buffer.from(codeHash(phone, purpose, String(code)), "hex"), Buffer.from(r.code_hash, "hex"));
    if (good) {
      db.prepare("UPDATE otp_codes SET verified = 1 WHERE phone = ? AND purpose = ?").run(phone, purpose);
      return { ok: true, data: JSON.parse(r.data) };
    }
    const tries = r.tries + 1;
    if (tries >= CODE_TRIES) { db.prepare("UPDATE otp_codes SET expires_at = 0 WHERE phone = ? AND purpose = ?").run(phone, purpose); return { ok: false, left: 0 }; }
    db.prepare("UPDATE otp_codes SET tries = ? WHERE phone = ? AND purpose = ?").run(tries, phone, purpose);
    return { ok: false, left: CODE_TRIES - tries };
  }
  // "Send me a new code": same purpose and data as the code still pending; the throttle and daily limit apply.
  async function resendCode(phone, purpose) {
    const p = pendingCode(phone, purpose);
    return p ? sendCode(phone, purpose, p.data) : { ok: false, reason: "none" };
  }
  // Ends the code's use but keeps the row, so the resend throttle and daily limit still apply.
  const clearCode = (phone, purpose) => db.prepare("UPDATE otp_codes SET expires_at = 0 WHERE phone = ? AND purpose = ?").run(phone, purpose);

  // ---------------------------------------------------------------- registration
  // Creates (or resumes) the phone's account and registers the farmer on-chain from it. idHash = keccak256(National ID),
  // the same hash the portal uses. Safe to call again after a crash: a "pending" row reuses its key.
  async function register(phone, idHash) {
    let r = rowOf(phone);
    if (r && r.status === "active") throw new Error("This number already has an account.");
    if (!r) {
      const owner = ethers.Wallet.createRandom();
      const signer = new SmartAccountSigner(owner, provider, aa, decoders, 0n, transport);
      const account = await signer.getAddress();
      db.prepare("INSERT INTO phone_accounts (phone, account, owner, enc_key, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
        .run(phone, account, owner.address, seal(owner.privateKey, account), new Date(now()).toISOString());
      r = rowOf(phone);
    }
    let tx = null;
    if (!(await ledgerRO.getFarmer(r.account)).exists) {
      const ledger = new ethers.Contract(ledgerAddress, abi.ledger, signerOf(r));
      try {
        tx = (await (await ledger.registerFarmer(idHash, hashOf(phone))).wait()).hash;
      } catch (e) {
        // nothing happened on-chain: forget the key so a later attempt starts clean
        db.prepare("DELETE FROM phone_accounts WHERE phone = ? AND status = 'pending'").run(phone);
        throw e;
      }
    }
    dbm.tx(db, () => {
      db.prepare("UPDATE phone_accounts SET status = 'active' WHERE phone = ?").run(phone);
      db.prepare("DELETE FROM ussd_users WHERE phone = ?").run(phone); // the new account starts with a fresh PIN
    });
    contacts.put(r.account, phone, db);
    return { account: r.account, tx };
  }

  // ---------------------------------------------------------------- number change (recovery)
  const reqRow = (id) => db.prepare("SELECT * FROM recovery_requests WHERE id = ?").get(id) || null;
  const openFor = (account) => db.prepare("SELECT * FROM recovery_requests WHERE account = ? AND status = 'waiting'").get(account) || null;
  const moveTo = (newPhone) => db.prepare("SELECT * FROM recovery_requests WHERE new_phone = ? AND status = 'waiting'").get(newPhone) || null;
  const moveFrom = (oldPhone) => db.prepare("SELECT * FROM recovery_requests WHERE old_phone = ? AND status = 'waiting'").get(oldPhone) || null;

  // Step 1 (from the NEW number). The same answer is given for "no such account" and "wrong ID", so the menu
  // cannot be used to find out which numbers have accounts.
  async function startMove(oldPhone, newPhone, nid) {
    const r = rowOf(oldPhone);
    if (!r || r.status !== "active") return { ok: false, reason: "no-match" };
    if ((await ledgerRO.getFarmer(r.account)).idHash !== hashOf(String(nid))) return { ok: false, reason: "no-match" };
    if (rowOf(newPhone)) return { ok: false, reason: "taken" };
    if (openFor(r.account)) return { ok: false, reason: "pending" };
    const s = await sendCode(newPhone, "move", { oldPhone });
    return s.ok ? { ok: true } : { ok: false, reason: s.reason, waitS: s.waitS };
  }

  // Step 2: the code from the new number. Opens the request; the old number is told and may cancel.
  async function confirmMove(newPhone, code) {
    const c = checkCode(newPhone, "move", code);
    if (!c.ok) return { ok: false, left: c.left };
    clearCode(newPhone, "move");
    const r = rowOf(c.data.oldPhone);
    if (!r || r.status !== "active" || openFor(r.account)) return { ok: false, left: 0 };
    const t = now();
    const id = Number(db.prepare("INSERT INTO recovery_requests (old_phone, new_phone, account, status, created_at, ready_at) VALUES (?, ?, ?, 'waiting', ?, ?)")
      .run(r.phone, newPhone, r.account, t, t + recoveryDelayMs).lastInsertRowid);
    const when = new Date(t + recoveryDelayMs).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
    await sendSms(r.phone, `FarmLedger: request to move your account to ${maskPhone(newPhone)}. Not you? Dial ${DIAL()} and choose 5 to cancel, before ${when}.`);
    if (recoveryDelayMs <= 0) await completeMove(id);
    return { ok: true, request: reqRow(id) };
  }

  async function cancelMove(id, by) {
    const q = reqRow(id);
    if (!q || q.status !== "waiting") return false;
    db.prepare("UPDATE recovery_requests SET status = 'cancelled', done_at = ?, note = ? WHERE id = ?").run(now(), `cancelled by ${by}`, id);
    await sendSms(q.new_phone, "FarmLedger: the request to move an account to this number was cancelled.");
    return true;
  }

  // Operator: release a request before the waiting period ends (after checking the farmer in person, say).
  function releaseNow(id) {
    const q = reqRow(id);
    if (!q || q.status !== "waiting") return false;
    db.prepare("UPDATE recovery_requests SET ready_at = ?, note = 'released early by operator' WHERE id = ?").run(now(), id);
    return true;
  }

  // Step 3, once the waiting period is over: record the new number on-chain from the account itself, then re-bind it.
  async function completeMove(id) {
    const q = reqRow(id);
    if (!q || q.status !== "waiting") throw new Error("No waiting number change with that id.");
    if (now() < q.ready_at) throw new Error("The waiting period for this number change has not ended.");
    const r = rowOf(q.old_phone);
    const ledger = new ethers.Contract(ledgerAddress, abi.ledger, signerOf(r));
    await (await ledger.updatePhone(hashOf(q.new_phone))).wait();
    dbm.tx(db, () => {
      db.prepare("UPDATE phone_accounts SET phone = ? WHERE phone = ?").run(q.new_phone, q.old_phone);
      db.prepare("DELETE FROM ussd_users WHERE phone IN (?, ?)").run(q.old_phone, q.new_phone); // fresh PIN on the new number
      db.prepare("UPDATE recovery_requests SET status = 'done', done_at = ? WHERE id = ?").run(now(), id);
    });
    contacts.put(q.account, q.new_phone, db);
    await sendSms(q.new_phone, `FarmLedger: your account is now on this number. Dial ${DIAL()} to choose a new PIN.`);
    return reqRow(id);
  }

  const requests = (status = null) => (status
    ? db.prepare("SELECT * FROM recovery_requests WHERE status = ? ORDER BY id").all(status)
    : db.prepare("SELECT * FROM recovery_requests ORDER BY id").all());

  return {
    accountOf, signerFor, register, notify: sendSms,
    sendCode, resendCode, pendingCode, verifiedCode, checkCode, clearCode,
    startMove, confirmMove, cancelMove, releaseNow, completeMove, moveTo, moveFrom, requests,
    recoveryDelayMs, now,
  };
}

module.exports = { createPhoneAccounts, loadSecret, hashOf, CODE_TTL_MS, CODE_TRIES, SENDS_PER_DAY };
