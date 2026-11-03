// Plain phone numbers for SMS, kept OFF-chain (the ledger only stores keccak256(phone)).
// A farmer submits their number signed with their own key; it is accepted only if it hashes to the phoneHash
// recorded for that farmer on-chain, so nobody can attach a number to someone else's account.
// Stored in web/.data/contacts.json (git-ignored, owner-only permissions). Read by services/notifier.js.
const fs = require("fs");
const path = require("path");
const { DocError, message, verifyAccountSigner, checkIssued } = require("./documents-core");

const FILE = () => process.env.CONTACTS_FILE || path.join(process.cwd(), ".data", "contacts.json");
const PHONE_RE = /^2507\d{8}$/;

const contactMessage = ({ address, phone, issued }) =>
  message({ action: "contact", applicant: address, application: "contact-details", document: phone, issued });

function read(file = FILE()) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

// phoneHashOf(address) -> the farmer's on-chain phoneHash (injected so this can be tested without a chain)
async function save({ address, phone, issued, signature }, { phoneHashOf, ownerOf = null, file = FILE() }) {
  const { ethers } = require("ethers");
  if (!ethers.isAddress(address || "")) throw new DocError(400, "Invalid address.");
  if (!PHONE_RE.test(phone || "")) throw new DocError(400, "Invalid phone number.");
  checkIssued(issued);
  await verifyAccountSigner(contactMessage({ address, phone, issued }), signature, address, ownerOf);
  const onChain = await phoneHashOf(address);
  if (!onChain || onChain === ethers.ZeroHash) throw new DocError(404, "This account is not registered.");
  if (ethers.keccak256(ethers.toUtf8Bytes(phone)).toLowerCase() !== String(onChain).toLowerCase()) throw new DocError(403, "This phone number does not match the one registered for this account.");
  const all = read(file);
  all[address.toLowerCase()] = { phone, savedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
  return { saved: true };
}

module.exports = { contactMessage, read, save, FILE };
