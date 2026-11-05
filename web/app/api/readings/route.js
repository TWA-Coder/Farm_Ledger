// Where each oracle reading came from (real satellite data or a simulated scenario), keyed by transaction hash.
// Written by services/oracle.js (services/readings-log.js) into the off-chain database; this route only reads it.
// Not secret: the readings themselves are public on-chain.
import dbm from "../../../server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sources = {};
  for (const r of dbm.get().prepare("SELECT tx, source FROM readings").all()) sources[r.tx] = r.source === "nasa-power" ? "nasa-power" : "sample";
  return Response.json({ sources }, { headers: { "Cache-Control": "no-store" } });
}
