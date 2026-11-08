// Farmers' 4-digit PINs (table ussd_users), shared by the USSD menu and the portal's phone + PIN sign-in, so a farmer
// has ONE PIN and one lock: 3 wrong tries (PINs, or National IDs in the USSD menu) lock the number for 30 minutes,
// whichever channel they came from.
const crypto = require("crypto");
const dbm = require("../web/server/db");

const LOCK_MS = 30 * 60 * 1000;
const MAX_TRIES = 3;

function createPinStore({ db = dbm.get(), now = () => Date.now() } = {}) {
  const getUser = async (phone) => {
    const r = await db.one("SELECT * FROM ussd_users WHERE phone = ?", [phone]);
    return r ? { salt: r.salt, pinHash: r.pin_hash, tries: r.tries, lockedUntil: r.locked_until, pinSetAt: r.pin_set_at } : {};
  };
  const putUser = async (phone, patch) => {
    const u = { tries: 0, lockedUntil: 0, ...(await getUser(phone)), ...patch };
    await db.run(`INSERT INTO ussd_users (phone, salt, pin_hash, tries, locked_until, pin_set_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (phone) DO UPDATE SET salt = excluded.salt, pin_hash = excluded.pin_hash, tries = excluded.tries,
      locked_until = excluded.locked_until, pin_set_at = excluded.pin_set_at`,
    [phone, u.salt ?? null, u.pinHash ?? null, u.tries, u.lockedUntil, u.pinSetAt ?? null]);
  };
  const hashPin = (pin, salt) => crypto.createHash("sha256").update(salt + ":" + pin).digest("hex");

  async function setPin(phone, pin) {
    if (!/^\d{4}$/.test(String(pin))) throw new Error("A PIN has 4 digits.");
    const salt = crypto.randomBytes(8).toString("hex");
    await putUser(phone, { salt, pinHash: hashPin(String(pin), salt), tries: 0, lockedUntil: 0, pinSetAt: new Date(now()).toISOString() });
  }
  const hasPin = async (phone) => Boolean((await getUser(phone)).pinHash);
  const isLocked = async (phone) => { const u = await getUser(phone); return Boolean(u.lockedUntil && now() < u.lockedUntil); };

  // A wrong answer of any kind (PIN, National ID): returns true when it locks the number.
  async function failAttempt(phone) {
    const tries = ((await getUser(phone)).tries || 0) + 1;
    await putUser(phone, tries >= MAX_TRIES ? { tries: 0, lockedUntil: now() + LOCK_MS } : { tries });
    return tries >= MAX_TRIES;
  }

  // {ok:true} | {ok:false, locked}
  async function checkPin(phone, pin) {
    const u = await getUser(phone);
    if (u.lockedUntil && now() < u.lockedUntil) return { ok: false, locked: true };
    if (u.pinHash && crypto.timingSafeEqual(Buffer.from(hashPin(String(pin), u.salt)), Buffer.from(u.pinHash))) {
      await putUser(phone, { tries: 0 });
      return { ok: true };
    }
    return { ok: false, locked: await failAttempt(phone) };
  }

  return { getUser, putUser, setPin, hasPin, checkPin, isLocked, failAttempt };
}

module.exports = { createPinStore, LOCK_MS };
