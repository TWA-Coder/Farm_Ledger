// Blockchain keys of portal staff (admins, underwriters, vets, agents), held for them by the server.
//
// Staff sign in with a username and password (web/server/auth.js). Each of them still acts on-chain from their own
// address, because the contracts check roles per address and vets' claim decisions are ECDSA signatures. The key
// behind that address is generated here, stored ENCRYPTED in staff_users.enc_key (AES-256-GCM, key derived from
// PHONE_KEY_SECRET with HKDF under its own label, bound to the address), and decrypted only inside the custody
// service (services/custody.js) to sign one transaction or message. The portal server never sees it.
//
// Staff keys are ordinary accounts (not smart accounts), so they pay gas: custody tops them up from the funder key
// (FUNDER_PRIVATE_KEY, else PRIVATE_KEY, else the local chain's account #0) when they run low.
const crypto = require("crypto");
const { ethers } = require("ethers");
const dbm = require("../web/server/db");
const profiles = require("../web/server/profiles");

const ROLES = ["admin", "underwriter", "vet", "agent"];
const USERNAME_RE = /^[a-z][a-z0-9._-]{2,31}$/;

function wrapKeyOf(secret) {
  if (!secret || secret.length !== 32) throw new Error("staff keys need the 32-byte key secret (PHONE_KEY_SECRET)");
  return Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.alloc(0), "farmledger/staff-key/v1", 32));
}

function seal(wrapKey, privateKey, address) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", wrapKey, iv);
  c.setAAD(Buffer.from(address.toLowerCase()));
  const ct = Buffer.concat([c.update(Buffer.from(privateKey.slice(2), "hex")), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") });
}

function unseal(wrapKey, row) {
  const e = JSON.parse(row.enc_key);
  const d = crypto.createDecipheriv("aes-256-gcm", wrapKey, Buffer.from(e.iv, "base64"));
  d.setAAD(Buffer.from(row.address.toLowerCase()));
  d.setAuthTag(Buffer.from(e.tag, "base64"));
  return "0x" + Buffer.concat([d.update(Buffer.from(e.ct, "base64")), d.final()]).toString("hex");
}

function createStaffKeys({ db = dbm.get(), secret, now = () => Date.now() }) {
  const wrapKey = wrapKeyOf(secret);
  const rowOf = (username) => db.prepare("SELECT * FROM staff_users WHERE username = ?").get(String(username || "").toLowerCase()) || null;

  // A new staff member: a fresh key, or `privateKey` to sign in as an address that already holds a role (the deployer,
  // the seeded demo accounts, the role keys in .env). No password yet: the portal sets one (web/server/auth.js).
  function create({ username, name, role, phone = null, createdBy = null, privateKey = null }) {
    const u = String(username || "").toLowerCase();
    if (!USERNAME_RE.test(u)) throw new Error("A username has 3 to 32 characters: lower-case letters, digits, '.', '_' or '-', starting with a letter.");
    if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(", ")}.`);
    if (phone !== null && !/^2507\d{8}$/.test(phone)) throw new Error("Phone numbers look like 2507XXXXXXXX.");
    if (rowOf(u)) throw new Error("That username is already taken.");
    const wallet = privateKey ? new ethers.Wallet(privateKey) : ethers.Wallet.createRandom();
    if (db.prepare("SELECT 1 FROM staff_users WHERE lower(address) = lower(?)").get(wallet.address)) throw new Error("That account already has a login.");
    const clean = profiles.cleanName(name);
    dbm.tx(db, () => {
      db.prepare(`INSERT INTO staff_users (username, address, name, role, phone, enc_key, must_change, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(u, wallet.address, clean, role, phone, seal(wrapKey, wallet.privateKey, wallet.address), createdBy, new Date(now()).toISOString());
      profiles.put(wallet.address, clean, db);
    });
    return { username: u, address: wallet.address };
  }

  // A signer for an enabled staff member. Only custody (and operator tools on the server) may call this.
  function walletFor(username, provider) {
    const r = rowOf(username);
    if (!r || r.disabled) throw new Error("No active staff account with that username.");
    return new ethers.Wallet(unseal(wrapKey, r), provider);
  }

  return { create, walletFor, rowOf };
}

module.exports = { createStaffKeys, ROLES, USERNAME_RE };
