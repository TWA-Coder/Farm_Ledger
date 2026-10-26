// FarmLedger oracle service (FR-05): reads rainfall / NDVI for each registered plot and posts it on-chain.
// The contract then evaluates every active policy on that plot and pays automatically (FR-06).
//
//   node services/oracle.js scenario drought 1     one-off reading for plot 1 (drought | flood | normal | lowndvi)
//   node services/oracle.js run                    one pass over every plot using the current data source
//   node services/oracle.js watch [seconds]        repeat forever (default every 60 s)
//
// Env: DATA_SOURCE=mock|nasa  RPC_URL  ORACLE_PRIVATE_KEY  NETWORK
const { connect } = require("./common");
const { getAdapter } = require("./adapters");

const METRIC = { Rainfall: 0, NDVI: 1 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postFor(ctx, plotId, override) {
  const { ledger } = ctx;
  const adapter = getAdapter();
  const plot = await ledger.getPlot(plotId);
  if (!plot.exists) { console.log(`plot ${plotId}: not registered, skipping`); return; }

  const rain = await adapter.rainfall(plot, plotId, override);
  const ndvi = await adapter.ndvi(plot, plotId, override);
  const now = Math.floor(Date.now() / 1000);

  // The chain may be a local node whose clock differs from wall time: never post a timestamp in its future.
  const block = await ctx.provider.getBlock("latest");
  const observedAt = Math.min(now, Number(block.timestamp));

  for (const [metric, value, label] of [[METRIC.Rainfall, rain, "rainfall(0.1mm)"], [METRIC.NDVI, ndvi, "ndvi(x1e4)"]]) {
    const t0 = Date.now();
    const tx = await ledger.postReading(plotId, metric, value, observedAt);
    const rc = await tx.wait();
    const paid = rc.logs.filter((l) => l.fragment && l.fragment.name === "PayoutExecuted").length;
    console.log(`[${adapter.name}] plot ${plotId} ${label}=${value}  tx ${rc.hash.slice(0, 10)}…  ${Date.now() - t0} ms` +
      (paid ? `  -> ${paid} PAYOUT(S) EXECUTED` : ""));
  }
}

async function allPlots(ctx) {
  const n = Number(await ctx.ledger.plotCount());
  return Array.from({ length: n }, (_, i) => i + 1);
}

async function main() {
  const [cmd = "run", a, b] = process.argv.slice(2);
  const ctx = connect("oracle", "ORACLE_PRIVATE_KEY");
  if (!ctx.signer) throw new Error("Set ORACLE_PRIVATE_KEY for non-local networks.");

  if (cmd === "scenario") {
    if (!["drought", "flood", "normal", "lowndvi"].includes(a)) throw new Error("scenario must be drought|flood|normal|lowndvi");
    const plots = b ? [Number(b)] : await allPlots(ctx);
    for (const id of plots) await postFor(ctx, id, a);
  } else if (cmd === "run") {
    for (const id of await allPlots(ctx)) await postFor(ctx, id);
  } else if (cmd === "watch") {
    const every = Number(a || 60) * 1000;
    console.log(`Oracle watching every ${every / 1000}s (Ctrl+C to stop)`);
    for (;;) {
      try { for (const id of await allPlots(ctx)) await postFor(ctx, id); }
      catch (e) { console.error("oracle pass failed:", e.shortMessage || e.message); }
      await sleep(every);
    }
  } else {
    console.log("usage: node services/oracle.js scenario <drought|flood|normal|lowndvi> [plotId] | run | watch [seconds]");
  }
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
