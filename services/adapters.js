// Data adapters for the oracle. Each returns the value the contract expects:
//   rainfall : trailing 30-day total in tenths of a millimetre   (e.g. 2200 = 220.0 mm)
//   ndvi     : vegetation index x 10000                          (e.g. 6500 = 0.65)
//
// "mock"  : deterministic scenarios you can trigger on demand for the demo (default).
// "nasa"  : real daily precipitation from NASA POWER (open, keyless) as a CHIRPS stand-in.
//           NDVI has no keyless public API, so NDVI always comes from the mock/scenario adapter here;
//           swap in Sentinel Hub / MODIS (or Chainlink Functions) behind the same function signature.
const fs = require("fs");
const path = require("path");

const SCENARIO_FILE = path.join(__dirname, "scenario.json");

const RANGES = {
  rainfall: { normal: [2000, 3000], drought: [300, 1200], flood: [3800, 5200] },
  ndvi: { normal: [5500, 7500], drought: [1500, 2500], flood: [5500, 7500] },
};

function readScenarioFile() {
  try { return JSON.parse(fs.readFileSync(SCENARIO_FILE, "utf8")); } catch { return { default: "normal", plots: {} }; }
}

function scenarioFor(plotId, override) {
  if (override) return override;
  const s = readScenarioFile();
  return (s.plots && s.plots[String(plotId)]) || s.default || "normal";
}

function rand([lo, hi]) {
  return Math.round(lo + Math.random() * (hi - lo));
}

const mock = {
  name: "mock",
  async rainfall(plot, plotId, override) {
    const sc = scenarioFor(plotId, override);
    return rand(RANGES.rainfall[sc] || RANGES.rainfall.normal);
  },
  async ndvi(plot, plotId, override) {
    const sc = scenarioFor(plotId, override);
    // "drought" also depresses vegetation, as it would in reality; "lowndvi" is an alias for NDVI-only stress
    const key = sc === "lowndvi" ? "drought" : sc;
    return rand(RANGES.ndvi[key] || RANGES.ndvi.normal);
  },
};

const nasa = {
  name: "nasa",
  async rainfall(plot) {
    const lat = Number(plot.latE6) / 1e6;
    const lon = Number(plot.lonE6) / 1e6;
    const end = new Date(Date.now() - 2 * 86400000); // NASA POWER lags a couple of days
    const start = new Date(end.getTime() - 29 * 86400000);
    const f = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
    const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR&community=AG` +
      `&longitude=${lon}&latitude=${lat}&start=${f(start)}&end=${f(end)}&format=JSON`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`NASA POWER HTTP ${res.status}`);
    const json = await res.json();
    const days = json.properties.parameter.PRECTOTCORR;
    const mm = Object.values(days).filter((v) => v >= 0).reduce((a, b) => a + b, 0); // -999 = missing
    return Math.round(mm * 10);
  },
  ndvi: (...args) => mock.ndvi(...args),
};

function getAdapter(name) {
  return (name || process.env.DATA_SOURCE || "mock") === "nasa" ? nasa : mock;
}

module.exports = { getAdapter, SCENARIO_FILE };
