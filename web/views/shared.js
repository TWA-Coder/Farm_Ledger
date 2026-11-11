"use client";
import { useEffect, useMemo, useState } from "react";
import claims from "../shared/claims";
import { fetchStored, sha256Hex } from "../lib/documents";
import { Badge, Box, DataTable, Dialog, KV, Quorum, Stepper, Timeline } from "../components/ui";
import { advanceTime, contractsFor, LOCAL_ORACLE_KEY, fmt, short } from "../lib/chain";
import { DAY, dateTime, eventText, nameOf, sortedEvents } from "../lib/format";

export const CLAIM_BADGE = [["n", "None"], ["a", "Being checked"], ["g", "Approved and paid"], ["r", "Rejected"]];
export const claimBadge = (c) => <Badge tone={CLAIM_BADGE[c.status][0]}>{CLAIM_BADGE[c.status][1]}</Badge>;

export function claimSteps(c) {
  const signed = c.approvals + c.rejections;
  return [
    { label: "Claim filed", state: "done" },
    { label: `Vets ${Math.min(c.approvals, c.quorum)}/${c.quorum}`, state: c.status === 1 ? "cur" : "done" },
    { label: c.status === 3 ? "Rejected" : "Decided", state: c.status === 2 ? "done" : c.status === 3 ? "bad" : "" },
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

// The claim photo, fetched from document storage and checked against the evidence hash recorded on-chain.
// viewer: { signer, address } of whoever is looking; vets view as reviewers (the server checks their certification).
export function Evidence({ claim: c, viewer }) {
  const [st, setSt] = useState({ state: "idle" });
  useEffect(() => () => { if (st.url) URL.revokeObjectURL(st.url); }, [st.url]);
  if (c.viaUssd) return <p className="muted">Reported by phone (USSD), so no photo is attached. The veterinarian must examine the animal in person.</p>;
  if (!viewer?.signer) return null;
  const load = async () => {
    setSt({ state: "loading" });
    try {
      const own = viewer.address.toLowerCase() === c.holder.toLowerCase();
      const app = claims.claimApplicationId(c.policyId, c.evidenceHash);
      const blob = await fetchStored(viewer.signer, c.holder, app, claims.EVIDENCE_DOCUMENT, { asReviewer: !own });
      const matches = ("0x" + (await sha256Hex(blob))) === String(c.evidenceHash).toLowerCase();
      setSt({ state: matches ? "ok" : "mismatch", url: URL.createObjectURL(blob), pdf: blob.type === "application/pdf" });
    } catch (e) { setSt({ state: "err", msg: e.message }); }
  };
  if (st.state === "idle") return <button className="btn sec sm" onClick={load}>View the claim photo</button>;
  if (st.state === "loading") return <p className="muted">Loading the photo…</p>;
  if (st.state === "err") return <div className="callout err">{st.msg} <button className="link" onClick={load}>Try again</button></div>;
  return (
    <div>
      {st.state === "ok"
        ? <div className="callout ok">This is the exact photo sent with the claim. Its fingerprint matches the one recorded on the ledger.</div>
        : <div className="callout err"><b>Warning:</b> this file does not match the fingerprint recorded with the claim. It may have been changed after the claim was sent.</div>}
      {st.pdf ? <a href={st.url} target="_blank" rel="noopener noreferrer">Open the PDF</a> : <img src={st.url} alt={`Claim #${c.id} evidence for animal ${c.tag}`} className="evidence" />}
    </div>
  );
}

// Claim detail with the full signature trail. `actions` lets the vet view add Approve/Reject.
export function ClaimDialog({ snap, claim, onClose, actions, viewer }) {
  const c = snap.claims.find((x) => x.id === claim.id) || claim;
  return (
    <Dialog title={`Claim #${c.id} · ${c.tag}`} sub={`Cover ${fmt(c.sum)} RWF · filed ${dateTime(c.filedAt)}`} onClose={onClose}
      actions={<>{actions}<button className="btn sec" onClick={onClose}>Close</button></>}>
      <Stepper steps={claimSteps(c)} />
      <KV rows={[
        ["Status", claimBadge(c)],
        ["Quorum", <Quorum approvals={c.approvals} rejections={c.rejections} needed={c.quorum} />],
        ["Farmer", nameOf(c.holder)],
        ["Reported", c.viaUssd ? "By phone (USSD)" : "On the website, with a photo"],
      ]} />
      <h2 style={{ fontSize: 14, margin: "14px 0 4px" }}>Evidence</h2>
      <Evidence claim={c} viewer={viewer} />
      <h2 style={{ fontSize: 14, margin: "14px 0 4px" }}>Veterinarian decisions</h2>
      {c.attestations.length === 0
        ? <p className="muted">No veterinarian has decided yet. Each decision is signed with the vet's own key and checked by the contract.</p>
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
  // local chain only (the menu hides Test tools elsewhere): Hardhat's public oracle key posts the test readings
  const oracle = useMemo(() => contractsFor(cfg, provider, LOCAL_ORACLE_KEY).ledger, [cfg, provider]);
  const [scenario, setScenario] = useState("drought");
  const [plot, setPlot] = useState(1);
  const [days, setDays] = useState(8);
  const RANGES = { normal: [2000, 3000, 5500, 7500], drought: [300, 1200, 1500, 2500], flood: [3800, 5200, 5500, 7500], lowndvi: [2000, 3000, 1500, 2500] };
  const r = (lo, hi) => Math.round(lo + Math.random() * (hi - lo));
  return (
    <Box title="Test tools" sub="Stand-ins for real-world events, for testing only. Readings posted here are labelled as test data everywhere in the portal. In a live system the oracle service posts weather readings and time simply passes.">
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
