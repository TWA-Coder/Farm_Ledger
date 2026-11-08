// Plain phone numbers for SMS, kept OFF-chain (the ledger only stores keccak256(phone)).
// A farmer submits their number signed with their own key; it is accepted only if it hashes to the phoneHash
// recorded for that farmer on-chain, so nobody can attach a number to someone else's account.
// Stored in the off-chain database (db.js, table "contacts"). Read by services/notifier.js.
const dbm = require("./db");
const { DocError, message, verifyAccountSigner, checkIssued } = require("./documents-core");

const PHONE_RE = /^2507\d{8}$/;

const contactMessage = ({ address, phone, issued }) =>
  message({ action: "contact", applicant: address, application: "contact-details", document: phone, issued });

// { [address lowercased]: { phone, savedAt } }
async function read(db = dbm.get()) {
  const out = {};
  for (const r of await db.all("SELECT address, phone, saved_at FROM contacts")) out[r.address] = { phone: r.phone, savedAt: r.saved_at };
  return out;
}

// The plain number whose keccak256 is `phoneHash`, or null. Used by the notifier (the chain only has the hash).
async function phoneForHash(phoneHash, db = dbm.get()) {
  const { ethers } = require("ethers");
  const want = String(phoneHash || "").toLowerCase();
  for (const r of await db.all("SELECT DISTINCT phone FROM contacts")) {
    if (ethers.keccak256(ethers.toUtf8Bytes(r.phone)).toLowerCase() === want) return r.phone;
  }
  return null;
}

// phoneHashOf(address) -> the farmer's on-chain phoneHash (injected so this can be tested without a chain)
async function save({ address, phone, issued, signature }, { phoneHashOf, ownerOf = null, db = dbm.get() }) {
  const { ethers } = require("ethers");
  if (!ethers.isAddress(address || "")) throw new DocError(400, "Invalid address.");
  if (!PHONE_RE.test(phone || "")) throw new DocError(400, "Invalid phone number.");
  checkIssued(issued);
  await verifyAccountSigner(contactMessage({ address, phone, issued }), signature, address, ownerOf);
  const onChain = await phoneHashOf(address);
  if (!onChain || onChain === ethers.ZeroHash) throw new DocError(404, "This account is not registered.");
  if (ethers.keccak256(ethers.toUtf8Bytes(phone)).toLowerCase() !== String(onChain).toLowerCase()) throw new DocError(403, "This phone number does not match the one registered for this account.");
  await upsert(db, address, phone);
  return { saved: true };
}

// Seeded demo farmers (scripts/seed-demo.js) and other trusted server-side callers: no signature involved.
async function put(address, phone, db = dbm.get()) {
  if (!PHONE_RE.test(phone || "")) throw new DocError(400, "Invalid phone number.");
  await upsert(db, address, phone);
}

const upsert = (db, address, phone) => db.run("INSERT INTO contacts (address, phone, saved_at) VALUES (?, ?, ?) ON CONFLICT (address) DO UPDATE SET phone = excluded.phone, saved_at = excluded.saved_at",
  [address.toLowerCase(), phone, new Date().toISOString()]);

module.exports = { contactMessage, read, save, put, phoneForHash };
