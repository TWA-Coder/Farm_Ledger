// People's names, by account address (table "profiles"). Names are personal data, so they live only in the
// off-chain database, never on the ledger. Farmers give their name when they register (portal or USSD); staff names
// are entered by whoever creates their login.
const dbm = require("./db");

function cleanName(name) {
  const n = String(name || "").trim().replace(/\s+/g, " ");
  if (n.length < 2 || n.length > 60) throw new Error("A name has 2 to 60 characters.");
  if (!/^[\p{L}][\p{L}\p{M} .'-]*$/u.test(n)) throw new Error("A name may contain letters, spaces, apostrophes, dots and hyphens.");
  return n;
}

function put(address, name, db = dbm.get()) {
  db.prepare("INSERT INTO profiles (address, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(address) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at")
    .run(String(address).toLowerCase(), cleanName(name), new Date().toISOString());
}

function get(address, db = dbm.get()) {
  return db.prepare("SELECT name FROM profiles WHERE address = ?").get(String(address).toLowerCase())?.name || null;
}

// { address(lower-case): name } for everyone, or only for `addresses`.
function all(db = dbm.get(), addresses = null) {
  const rows = db.prepare("SELECT address, name FROM profiles").all();
  const want = addresses ? new Set(addresses.map((a) => String(a).toLowerCase())) : null;
  return Object.fromEntries(rows.filter((r) => !want || want.has(r.address)).map((r) => [r.address, r.name]));
}

module.exports = { cleanName, put, get, all };
