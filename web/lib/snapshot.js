"use client";
import { ethers } from "ethers";
import { fromB32 } from "./chain";
import { setNames } from "./format";
import { reviveArgs } from "../shared/event-json";

export function pick(r) { // ethers Result -> plain object (named fields only)
  const o = {};
  r.toObject ? Object.assign(o, r.toObject()) : Object.assign(o, r);
  return o;
}

// One read of everything the screens need. Kept in one place so every view shows the same numbers.
export async function loadSnapshot({ ctx, provider, cfg, address, account }) {
  const { ledger, token } = ctx;
  // names first: every screen built from this snapshot shows people by name (off-chain, server/profiles.js)
  let names = {};
  try { names = (await (await fetch("/api/names", { cache: "no-store" })).json()).names || {}; } catch { /* shown as addresses */ }
  setNames(names);
  const nameOrNull = (a) => names[String(a).toLowerCase()] || null;
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

  // Contract events come from the portal's event index (/api/events), not from a scan of the chain since block 0.
  const res = await fetch("/api/events", { cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "The portal server could not load the activity history.");
  const events = body.events.map((e) => ({ ...e, args: reviveArgs(e.args) }));

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
    return { address: a, ...p, certified, name: nameOrNull(a) };
  }));
  const vetQuorum = Number(await ledger.vetQuorum());
  const myVet = vets.find((v) => v.address.toLowerCase() === address.toLowerCase()) || null;

  // the pool shown to others is the deployment's underwriter (the insurer the portal is set up for)
  const poolOwner = account.role === "underwriter" ? address : (cfg.dep.roles?.underwriter || address);
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
  const desk = ctx.desk ? await loadDesk({ ctx, events, address, account, nameOrNull }) : null;
  return {
    now: Number(latest.timestamp), farmer, balance, products, plots, animals, policies, events, claims, vets, vetQuorum, myVet,
    pool, plotCount: Number(plotCount), allowance, paused, waiting, names,
    applications: desk?.applications || [], myAgent: desk?.myAgent || null, agent: desk?.agent || null,
  };
}

// PolicyDesk: every application with its current status, and for each role what it needs:
//   farmer: its agent; agent: its insurer and farmers (with their plots and animals); underwriter: its applications.
const APP_STATUS = ["None", "Submitted", "Offered", "Rejected", "Declined", "Issued"];
async function loadDesk({ ctx, events, address, account, nameOrNull }) {
  const { desk, ledger } = ctx;
  const me = address.toLowerCase();
  const ids = events.filter((e) => e.name === "ApplicationSubmitted").map((e) => Number(e.args.applicationId));
  const applications = (await Promise.all(ids.map(async (id) => {
    const a = pick(await desk.getApplication(id));
    const submitted = events.find((e) => e.name === "ApplicationSubmitted" && Number(e.args.applicationId) === id);
    return { id, ...a, statusName: APP_STATUS[Number(a.status)], status: Number(a.status), submittedBlock: submitted?.block };
  }))).filter((a) => [a.farmer, a.agent, a.underwriter].some((x) => x.toLowerCase() === me) || account.role === "admin");
  applications.sort((x, y) => y.id - x.id);

  let myAgent = null, agent = null;
  if (account.role === "farmer") {
    const ag = await desk.agentOf(address);
    myAgent = ag === ethers.ZeroAddress ? null : { address: ag, label: nameOrNull(ag) || `Agent ${ag.slice(0, 6)}…${ag.slice(-4)}`, district: fromB32(await desk.districtOf(address)) };
  }
  const info = pick(await desk.getAgent(address));
  if (info.underwriter !== ethers.ZeroAddress) {
    const assigned = [...new Set(events.filter((e) => e.name === "FarmerAssigned" && e.args.agent.toLowerCase() === me).map((e) => e.args.farmer))];
    const farmers = [];
    for (const f of assigned) {
      if ((await desk.agentOf(f)).toLowerCase() !== me) continue; // reassigned since
      const [plotIds, animalIds] = await Promise.all([ledger.plotsOf(f), ledger.animalsOf(f)]);
      const plots = await Promise.all(plotIds.map(async (id) => ({ id: Number(id), ...pick(await ledger.getPlot(id)) })));
      const animals = await Promise.all(animalIds.map(async (id) => ({ id: Number(id), ...pick(await ledger.getAnimal(id)) })));
      farmers.push({ address: f, label: nameOrNull(f) || `Farmer ${f.slice(0, 6)}…${f.slice(-4)}`, district: fromB32(await desk.districtOf(f)), plots, animals });
    }
    agent = { underwriter: info.underwriter, active: info.active, districts: (await desk.districtsOfAgent(address)).map(fromB32), farmers };
  }
  return { applications, myAgent, agent };
}

export { ethers };
