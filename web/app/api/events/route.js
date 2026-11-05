// Every FarmLedger (and CropClaims) contract event, in chain order, from the off-chain index (server/indexer.js).
// The index is brought up to date on each request, so a screen refreshed right after a transaction sees it.
// Not secret: the same events are public on-chain.
import indexer from "../../../server/indexer";
import chain from "../../../server/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ledger = chain.ledger();
    const claims = chain.cropClaims();
    const { block } = await indexer.sync({ provider: ledger.runner.provider, ledger, others: claims ? [claims] : [] });
    return Response.json({ block, events: indexer.events(undefined, { raw: true }) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[api/events]", e.shortMessage || e.message);
    return Response.json({ error: "The event index could not be updated. Is the local chain running?" }, { status: 503 });
  }
}
