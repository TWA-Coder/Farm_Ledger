"use client";
import { ethers } from "ethers";
import { DEMO_ACCOUNTS, fromB32 } from "./chain";

export function pick(r) { // ethers Result -> plain object (named fields only)
  const o = {};
  r.toObject ? Object.assign(o, r.toObject()) : Object.assign(o, r);
  return o;
}

// One read of everything the screens need. Kept in one place so every view shows the same numbers.
export async function loadSnapshot({ ctx, provider, cfg, address, account }) {
  const { ledger, token } = ctx;
  const latest = await provider.getBlock("latest");
  const [farmer, balance, productCount, plotCount] = await Promise.all([
    ledger.getFarmer(address), token.balanceOf(address), ledger.productCount(), ledger.plotCount(),
  ]);
  const products = [];
  for (let i = 1; i <= Number(productCount); i++) {
    const levels = (await ledger.getTriggerLevels(i)).map((l, level) => ({ level, threshold: l.threshold, rateBps: l.rateBps }));
    products.push({ id: i, ...pick(await ledger.getProduct(i)), levels });
  }

  const [plotIds, animalIds, policyIds] = await Promise.all([ledger.plotsOf(address), ledger.animalsOf(address), ledger.policiesOf(address)]);
  const plots = await Promise.all(plotIds.map(async (id) => ({ id: Number(id), ...pick(await ledger.getPlot(id)) })));
  const animals = await Promise.all(animalIds.map(async (id) => ({ id: Number(id), ...pick(await ledger.getAnimal(id)) })));
  const policies = await Promise.all(policyIds.map(async (id) => ({ id: Number(id), ...pick(await ledger.getPolicy(id)), appHash: await ledger.applicationHashOf(id) })));

  const logs = await provider.getLogs({ address: cfg.dep.ledger, fromBlock: 0, toBlock: "latest" });
  const events = logs.map((l) => {
    try { const p = ledger.interface.parseLog(l); return { name: p.name, args: p.args, block: l.blockNumber, idx: l.index, tx: l.transactionHash }; } catch { return null; }
  }).filter(Boolean);

  // every livestock claim, with its signature trail
  const claims = [];
  for (const e of events.filter((x) => x.name === "ClaimFiled")) {
    const id = Number(e.args.claimId);
    const c = pick(await ledger.getClaim(id));
    const pol = pick(await ledger.getPolicy(c.policyId));
    const an = pick(await ledger.getAnimal(pol.assetId));
    const attestations = events
      .filter((x) => x.name === "ClaimAttested" && Number(x.args.claimId) === id)
      .map((x) => ({ vet: x.args.vet, approved: x.args.approved, block: x.block }));
    claims.push({
      id, ...c, status: Number(c.status), quorum: Number(c.quorum), approvals: Number(c.approvals), rejections: Number(c.rejections),
      holder: pol.holder, tag: fromB32(an.tagId), tagId: an.tagId, sum: pol.sumInsured, attestations,
      iSigned: attestations.some((a) => a.vet.toLowerCase() === address.toLowerCase()),
      viaUssd: events.some((x) => x.name === "ClaimChannel" && Number(x.args.claimId) === id && x.args.viaAgent),
      settledAt: events.find((x) => x.name === "ClaimSettled" && Number(x.args.claimId) === id)?.block ?? null,
    });
  }
  claims.sort((a, b) => b.id - a.id);

  // vet registry
  const vetAddrs = await ledger.getVets();
  const vets = await Promise.all(vetAddrs.map(async (a) => {
    const p = pick(await ledger.getVetProfile(a));
    const certified = await ledger.isCertifiedVet(a);
    const demo = DEMO_ACCOUNTS.find((d) => d.addr?.toLowerCase() === a.toLowerCase());
    return { address: a, ...p, certified, name: demo?.label || null };
  }));
  const vetQuorum = Number(await ledger.vetQuorum());
  const myVet = vets.find((v) => v.address.toLowerCase() === address.toLowerCase()) || null;

  const uwAcct = DEMO_ACCOUNTS.find((a) => a.role === "underwriter");
  const poolOwner = account.role === "underwriter" ? address : uwAcct.addr;
  const ps = await ledger.poolStats(poolOwner);
  const pool = { balance: ps.balance, reserved: ps.reserved, available: ps.available, premiums: ps.stats.premiums, paidOut: ps.stats.paidOut, sold: ps.stats.policiesSold, payouts: ps.stats.payouts };

  // Latest weather / vegetation reading per plot of this account, with where it came from (see /api/readings).
  let sources = {};
  try { sources = (await (await fetch("/api/readings", { cache: "no-store" })).json()).sources || {}; } catch { /* portal API down: sources unknown */ }
  const readingEvents = events.filter((x) => x.name === "ReadingPosted");
  for (const pl of plots) {
    pl.readings = {};
    for (const metric of [0, 1]) {
      const r = pick(await ledger.getLatestReading(pl.id, metric));
      if (!Number(r.postedAt)) { pl.readings[metric] = null; continue; }
      const ev = [...readingEvents].reverse().find((x) => Number(x.args.plotId) === pl.id && Number(x.args.metric) === metric);
      const tx = ev?.tx?.toLowerCase();
      pl.readings[metric] = { value: Number(r.value), observedAt: Number(r.observedAt), postedAt: Number(r.postedAt), tx, source: (tx && sources[tx]) || "test" };
    }
  }

  const [allowance, paused, waiting] = await Promise.all([token.allowance(address, cfg.dep.ledger), ledger.paused(), ledger.waitingPeriod()]);
  return {
    now: Number(latest.timestamp), farmer, balance, products, plots, animals, policies, events, claims, vets, vetQuorum, myVet,
    pool, plotCount: Number(plotCount), allowance, paused, waiting,
  };
}

export { ethers };
