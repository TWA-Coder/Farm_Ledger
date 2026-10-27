"use client";
import { useMemo, useState } from "react";
import { Badge, Box, DataTable, Dialog, KV, Quorum, Stepper, Timeline } from "../components/ui";
import { advanceTime, contractsFor, DEMO_ACCOUNTS, fmt, short } from "../lib/chain";
import { DAY, dateTime, eventText, nameOf, sortedEvents } from "../lib/format";

export const CLAIM_BADGE = [["n", "None"], ["a", "Awaiting vets"], ["g", "Approved"], ["r", "Rejected"]];
export const claimBadge = (c) => <Badge tone={CLAIM_BADGE[c.status][0]}>{CLAIM_BADGE[c.status][1]}</Badge>;

export function claimSteps(c) {
  const signed = c.approvals + c.rejections;
  return [
    { label: "Claim filed", state: "done" },
    { label: `Vet signatures ${Math.min(c.approvals, c.quorum)}/${c.quorum}`, state: c.status === 1 ? "cur" : "done" },
    { label: c.status === 3 ? "Rejected" : "Quorum reached", state: c.status === 2 ? "done" : c.status === 3 ? "bad" : "" },
    { label: "Farmer paid", state: c.status === 2 ? "done" : "" },
  ].map((s, i) => (i === 1 && signed === 0 && c.status === 1 ? { ...s, state: "cur" } : s));
}

export function claimTimeline(snap, c) {
  return sortedEvents(snap.events.filter((e) => {
    const a = e.args;
    return (["ClaimFiled", "ClaimAttested", "ClaimSettled"].includes(e.name) && Number(a.claimId) === Number(c.id))
      || (e.name === "PayoutExecuted" && Number(a.policyId) === Number(c.policyId));
  })).reverse().map((e) => ({ text: eventText(e), meta: "block " + e.block, bad: e.name === "ClaimAttested" && !e.args.approved }));
}

// Claim detail with the full signature trail. `actions` lets the vet view add Approve/Reject.
export function ClaimDialog({ snap, claim, onClose, actions }) {
  const c = snap.claims.find((x) => x.id === claim.id) || claim;
  return (
    <Dialog title={`Claim #${c.id} · ${c.tag}`} sub={`Cover ${fmt(c.sum)} RWF · filed ${dateTime(c.filedAt)}`} onClose={onClose}
      actions={<>{actions}<button className="btn sec" onClick={onClose}>Close</button></>}>
      <Stepper steps={claimSteps(c)} />
      <KV rows={[
        ["Status", claimBadge(c)],
        ["Quorum", <Quorum approvals={c.approvals} rejections={c.rejections} needed={c.quorum} />],
        ["Farmer", nameOf(c.holder)],
        ["Evidence hash", c.evidenceHash],
      ]} />
      <h2 style={{ fontSize: 14, margin: "14px 0 4px" }}>Signatures on record</h2>
      {c.attestations.length === 0
        ? <p className="muted">No vet has signed yet. Each decision is an EIP-712 signature checked on-chain.</p>
        : <Timeline items={c.attestations.map((a) => ({ text: `${nameOf(a.vet)}: ${a.approved ? "approved" : "rejected"}`, meta: short(a.vet), bad: !a.approved }))} />}
      <h2 style={{ fontSize: 14, margin: "14px 0 4px" }}>History</h2>
      <Timeline items={claimTimeline(snap, c)} />
    </Dialog>
  );
}

export function AuditView({ snap }) {
  const rows = useMemo(() => sortedEvents(snap.events).map((e, i) => ({ id: i, block: e.block, name: e.name, text: eventText(e) })), [snap.events]);
  const names = [...new Set(rows.map((r) => r.name))].sort();
  return (
    <Box title="Public audit trail" sub="Every registration, signature, reading and payout is an on-chain event anyone can verify.">
      <DataTable rows={rows} pageSize={12} empty="No events yet."
        filters={names.map((n) => ({ value: n, label: n }))} filterFn={(r, f) => r.name === f}
        initialSort={{ key: "block", dir: "desc" }}
        columns={[
          { key: "block", label: "Block", render: (r) => <span className="muted">#{r.block}</span> },
          { key: "name", label: "Event", render: (r) => <Badge tone={r.name === "PayoutExecuted" ? "g" : r.name.startsWith("Vet") || r.name.startsWith("Claim") ? "i" : "n"}>{r.name}</Badge> },
          { key: "text", label: "What happened" },
        ]} />
    </Box>
  );
}

// Local-chain stand-ins for real-world events.
export function DemoView({ snap, cfg, provider, run, busy }) {
  const oracleAcct = DEMO_ACCOUNTS.find((a) => a.role === "oracle");
  const oracle = useMemo(() => contractsFor(cfg, provider, oracleAcct.pk).ledger, [cfg, provider]); // eslint-disable-line
  const [scenario, setScenario] = useState("drought");
  const [plot, setPlot] = useState(1);
  const [days, setDays] = useState(8);
  const RANGES = { normal: [2000, 3000, 5500, 7500], drought: [300, 1200, 1500, 2500], flood: [3800, 5200, 5500, 7500], lowndvi: [2000, 3000, 1500, 2500] };
  const r = (lo, hi) => Math.round(lo + Math.random() * (hi - lo));
  return (
    <Box title="Test network tools" sub="Stand-ins for real-world events. In production the oracle service posts weather readings and time simply passes.">
      <div className="row">
        <div><label>Weather scenario</label><select value={scenario} onChange={(e) => setScenario(e.target.value)}><option value="drought">Drought</option><option value="flood">Flood</option><option value="lowndvi">Crop stress (low NDVI)</option><option value="normal">Normal season</option></select></div>
        <div><label>Plot #</label><input type="number" min="1" max={snap.plotCount || 1} value={plot} onChange={(e) => setPlot(Number(e.target.value))} /></div>
        <button className="btn" disabled={busy || !snap.plotCount} onClick={() => run("Oracle reading", async () => {
          const [a, b, c, d] = RANGES[scenario];
          const t = Number((await provider.getBlock("latest")).timestamp);
          await (await oracle.postReading(plot, 0, r(a, b), t)).wait();
          await (await oracle.postReading(plot, 1, r(c, d), t)).wait();
        })}>Post oracle reading</button>
      </div>
      <div className="row">
        <div><label>Fast-forward chain time (days)</label><input type="number" value={days} onChange={(e) => setDays(Number(e.target.value))} /></div>
        <button className="btn sec" disabled={busy} onClick={() => run("Time advance", async () => advanceTime(provider, days * DAY))}>Advance</button>
      </div>
    </Box>
  );
}
