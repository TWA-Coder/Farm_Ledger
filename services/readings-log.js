// Records where every oracle reading came from, keyed by transaction hash.
// The contract stores the value only, so without this log the portal could not tell a farmer whether a reading was
// real satellite data or a simulated test scenario. The oracle service appends; the web portal only reads.
//
//   source "nasa-power" : real daily rainfall from NASA POWER (DATA_SOURCE=nasa)
//   source "sample"     : simulated scenario value (DATA_SOURCE=mock, and NDVI always - no live NDVI feed yet)
// A reading that is not in this log was posted some other way (e.g. the portal's test tools) and is shown as a test
// reading.
const fs = require("fs");
const path = require("path");

const DEFAULT_FILE = path.join(__dirname, "out", "readings.json");
const SOURCES = ["nasa-power", "sample"];

function sourceFor(adapterName, metric) {
  // metric 0 = rainfall, 1 = NDVI. NDVI comes from the mock adapter even in "nasa" mode (see adapters.js).
  return adapterName === "nasa" && Number(metric) === 0 ? "nasa-power" : "sample";
}

function read(file = DEFAULT_FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function append(entry, file = DEFAULT_FILE) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(entry.tx || "")) throw new Error("readings-log: entry needs a transaction hash");
  if (!SOURCES.includes(entry.source)) throw new Error(`readings-log: unknown source ${entry.source}`);
  const all = read(file);
  if (all.some((e) => e.tx.toLowerCase() === entry.tx.toLowerCase())) return all; // idempotent
  all.push({ ...entry, tx: entry.tx.toLowerCase(), loggedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
  return all;
}

module.exports = { DEFAULT_FILE, SOURCES, sourceFor, read, append };
