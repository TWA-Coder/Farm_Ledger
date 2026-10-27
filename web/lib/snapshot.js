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
  for (let i = 1; i <= Number(productCount); i++) products.push({ id: i, ...pick(await ledger.getProduct(i)) });

  const [plotIds, animalIds, policyIds] = await Promise.all([ledger.plotsOf(address), ledger.animalsOf(address), ledger.policiesOf(address)]);
  const plots = await Promise.all(plotIds.map(async (id) => ({ id: Number(id), ...pick(await ledger.getPlot(id)) })));
  const animals = await Promise.all(animalIds.map(async (id) => ({ id: Number(id), ...pick(await ledger.getAnimal(id)) })));
  const policies = await Promise.all(policyIds.map(async (id) => ({ id: Number(id), ...pick(await ledger.getPolicy(id)), appHash: await ledger.applicationHashOf(id) })));

  const logs = await provider.getLogs({ address: cfg.dep.ledger, fromBlock: 0, toBlock: "latest" });
  const events = logs.map((l) => {
    try { const p = ledger.interface.parseLog(l); return { name: p.name, args: p.args, block: l.blockNumber, idx: l.index }; } catch { return null; }
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

  const [allowance, paused, waiting] = await Promise.all([token.allowance(address, cfg.dep.ledger), ledger.paused(), ledger.waitingPeriod()]);
  return {
    now: Number(latest.timestamp), farmer, balance, products, plots, animals, policies, events, claims, vets, vetQuorum, myVet,
    pool, plotCount: Number(plotCount), allowance, paused, waiting,
  };
}

export { ethers };
