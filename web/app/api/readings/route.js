// Where each oracle reading came from (real satellite data or a simulated scenario), keyed by transaction hash.
// Written by services/oracle.js (services/readings-log.js); this route only reads it. Not secret: the readings
// themselves are public on-chain.
import fs from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILE = process.env.ORACLE_READINGS_LOG || path.join(process.cwd(), "..", "services", "out", "readings.json");

export async function GET() {
  let entries = [];
  try { const d = JSON.parse(fs.readFileSync(FILE, "utf8")); if (Array.isArray(d)) entries = d; } catch { /* no oracle runs yet */ }
  const sources = {};
  for (const e of entries) if (e && typeof e.tx === "string") sources[e.tx.toLowerCase()] = e.source === "nasa-power" ? "nasa-power" : "sample";
  return new Response(JSON.stringify({ sources }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
