// Where the key custody service listens and the token that callers present (X-Custody-Token).
//
// The USSD service, the notifier and the portal server all ask custody to sign; only custody holds PHONE_KEY_SECRET.
// Token: CUSTODY_TOKEN from .env. On the local chain, when it is not set, one is generated once into
// web/.data/custody.token (owner-only), so `npm run phone` and `npm run web` started separately still agree.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dbm = require("../web/server/db");

function custodyConfig({ local }) {
  const url = process.env.CUSTODY_URL || `http://127.0.0.1:${Number(process.env.CUSTODY_PORT || 4100)}`;
  let token = process.env.CUSTODY_TOKEN || "";
  if (!token) {
    if (!local) throw new Error("Set CUSTODY_TOKEN in .env (e.g. `openssl rand -hex 24`): the portal and the phone services use it to reach key custody.");
    const file = path.join(path.dirname(dbm.defaultFile()), "custody.token");
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, crypto.randomBytes(24).toString("hex"), { mode: 0o600 });
    }
    token = fs.readFileSync(file, "utf8").trim();
  }
  return { url, token };
}

// POST to custody; errors carry the contract error name (e.revert.name) when the chain refused the action.
async function custodyCall({ url, token }, route, body) {
  let res;
  try {
    res = await fetch(url.replace(/\/+$/, "") + route, { method: "POST", headers: { "Content-Type": "application/json", "X-Custody-Token": token }, body: JSON.stringify(body) });
  } catch { throw new Error("The key custody service is not reachable. Start it with npm run phone (or npm run custody)."); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(j.error || `custody HTTP ${res.status}`); if (j.revert) err.revert = j.revert; err.status = res.status; throw err; }
  return j;
}

module.exports = { custodyConfig, custodyCall };
