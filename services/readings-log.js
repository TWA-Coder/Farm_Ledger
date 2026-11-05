// Records where every oracle reading came from, keyed by transaction hash.
// The contract stores the value only, so without this log the portal could not tell a farmer whether a reading was
// real satellite data or a simulated test scenario. The oracle service appends; the web portal only reads.
//
//   source "nasa-power" : real daily rainfall from NASA POWER (DATA_SOURCE=nasa)
//   source "sample"     : simulated scenario value (DATA_SOURCE=mock, and NDVI always - no live NDVI feed yet)
// A reading that is not in this log was posted some other way (e.g. the portal's test tools) and is shown as a test
// reading.
// Stored in the off-chain database (web/server/db.js, table "readings").
const dbm = require("../web/server/db");

const SOURCES = ["nasa-power", "sample"];

function sourceFor(adapterName, metric) {
  // metric 0 = rainfall, 1 = NDVI. NDVI comes from the mock adapter even in "nasa" mode (see adapters.js).
  return adapterName === "nasa" && Number(metric) === 0 ? "nasa-power" : "sample";
}

function read(db = dbm.get()) {
  return db.prepare("SELECT * FROM readings ORDER BY logged_at, tx").all().map((r) => ({
    tx: r.tx, plotId: r.plot_id, metric: r.metric, value: r.value, observedAt: r.observed_at, source: r.source, adapter: r.adapter, loggedAt: r.logged_at,
  }));
}

// { [tx lowercased]: "nasa-power" | "sample" }
function sources(db = dbm.get()) {
  const out = {};
  for (const r of db.prepare("SELECT tx, source FROM readings").all()) out[r.tx] = r.source;
  return out;
}

function append(entry, db = dbm.get()) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(entry.tx || "")) throw new Error("readings-log: entry needs a transaction hash");
  if (!SOURCES.includes(entry.source)) throw new Error(`readings-log: unknown source ${entry.source}`);
  // INSERT OR IGNORE: the same transaction is recorded once, whatever the letter case of its hash (idempotent)
  db.prepare("INSERT OR IGNORE INTO readings (tx, plot_id, metric, value, observed_at, source, adapter, logged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(entry.tx.toLowerCase(), entry.plotId ?? null, entry.metric ?? null, entry.value ?? null, entry.observedAt ?? null, entry.source, entry.adapter ?? null, new Date().toISOString());
}

module.exports = { SOURCES, sourceFor, read, sources, append };
