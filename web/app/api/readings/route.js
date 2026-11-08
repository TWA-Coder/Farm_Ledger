// Where each oracle reading came from (real satellite data or a simulated scenario), keyed by transaction hash.
// Written by services/oracle.js (services/readings-log.js) into the off-chain database; this route only reads it.
// Not secret: the readings themselves are public on-chain.
import dbm from "../../../server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sources = {};
  try {
    for (const r of await dbm.get().all("SELECT tx, source FROM readings")) sources[r.tx] = r.source === "nasa-power" ? "nasa-power" : "sample";
  } catch (e) { console.error("[api/readings]", e.message); } // sources unknown: readings show as test readings
  return Response.json({ sources }, { headers: { "Cache-Control": "no-store" } });
}
