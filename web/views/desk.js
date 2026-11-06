"use client";
// The application desk (PolicyDesk):
//   DecisionView  one application: the form and documents the agent submitted, and the underwriter's contract or
//                 reasons. Used by the underwriter, the agent and the farmer (the server decides what each may see).
//   UwDesk        the underwriter's queue: review, draft the contract (terms + conditions), or reject with reasons.
import { useEffect, useState } from "react";
import requirements from "../shared/requirements";
import { Badge, Box, DataTable, Dialog, KV } from "../components/ui";
import { fmt, fromB32, short } from "../lib/chain";
import { COVER_PLAIN, cond } from "../lib/format";
import { fetchDeskRecord, fetchStored, postDecision } from "../lib/documents";

const DAY = 86400;
const longDate = (ts) => new Date(Number(ts) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
const OFFERED = 2;
const fieldLabel = (id) => {
  const f = requirements.FIELDS;
  return (Array.isArray(f) ? f.find((x) => x.id === id) : f?.[id])?.label || id;
};

export function appBadge(a, now) {
  if (a.status === OFFERED && Number(a.offerExpires) < now) return <Badge tone="n">Offer expired</Badge>;
  const m = { 1: ["a", "With the underwriter"], 2: ["b", "Contract ready"], 3: ["r", "Rejected"], 4: ["n", "Declined"], 5: ["g", "Policy issued"] }[a.status];
  return m ? <Badge tone={m[0]}>{m[1]}</Badge> : <Badge tone="n">{a.statusName}</Badge>;
}

const productOf = (snap, a) => snap.products.find((p) => p.id === Number(a.productId));
const termsRows = (snap, a) => {
  const p = productOf(snap, a);
  const lvl = p?.levels?.[Number(a.level)];
  return [
    ["Cover", p ? COVER_PLAIN[Number(p.cover)].name : `Product #${a.productId}`],
    ["Insured", `${Number(p?.cover) === 3 ? "Animal" : "Plot"} #${a.assetId}`],
    ...(p && Number(p.cover) !== 3 ? [["Pays when", cond(p.cover, lvl?.threshold ?? p.threshold)]] : []),
    ["Sum insured", `${fmt(a.sumInsured)} RWF`],
    ["Cover period", `${Number(a.coverDays)} days ${Number(a.startAt) ? `from ${longDate(a.startAt)}` : "from acceptance and payment"}`],
  ];
};

// Form + documents + decision for one application, loaded with the viewer's own signature.
export function DecisionView({ app, ctx, snap, onClose, children, title }) {
  const [rec, setRec] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    fetchDeskRecord(ctx.signer, app.farmer, app.id).then((r) => live && setRec(r)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [app.id, app.farmer, ctx.signer]);
  const open = async (doc) => {
    try { window.open(URL.createObjectURL(await fetchStored(ctx.signer, app.farmer, rec.application, doc)), "_blank", "noopener"); } catch (e) { setErr(e.message); }
  };
  const contract = rec?.contract?.content;
  return (
    <Dialog title={title || `Application #${app.id}`} sub={`Farmer ${short(app.farmer)} · agent ${short(app.agent)}`} onClose={onClose}
      actions={<button className="btn sec" onClick={onClose}>Close</button>}>
      <p>{appBadge(app, snap.now)}</p>
      <h3 className="formhead">{app.status >= OFFERED && app.status !== 3 ? "Contract terms" : "Requested terms"}</h3>
      <KV rows={[...termsRows(snap, app), ...(app.status >= OFFERED && app.status !== 3 ? [["Premium", `${fmt(app.premium)} RWF (before any subsidy)`], ["Offer valid until", longDate(app.offerExpires)]] : [])]} />
      {contract?.conditions && <><h3 className="formhead">Special conditions</h3><p style={{ whiteSpace: "pre-wrap" }}>{contract.conditions}</p></>}
      {rec?.rejection && <div className="callout err"><b>Rejected.</b> {rec.rejection.content.reasons}</div>}
      <h3 className="formhead">Application form</h3>
      {err && <div className="callout err" role="alert">{err}</div>}
      {!rec && !err && <p className="muted">Loading…</p>}
      {rec && !rec.record && <p className="muted">The form record is not on this server.</p>}
      {rec?.record && (
        <>
          {rec.matchesLedger === false && <div className="callout err">The stored form does NOT match the fingerprint recorded on the ledger.</div>}
          {rec.matchesLedger && <p className="muted">Form and documents match the fingerprint recorded on the ledger.</p>}
          <KV rows={Object.entries(rec.record.answers || {}).filter(([k]) => !k.startsWith("_")).map(([k, v]) => [fieldLabel(k), String(v)])} />
          <div className="tbl"><table>
            <thead><tr><th>Document</th><th>Size</th><th></th></tr></thead>
            <tbody>{rec.record.documents.map((d) => (
              <tr key={d.document}><td>{requirements.DOCUMENTS[d.document]?.label || d.document}</td><td>{Math.round(d.size / 1024)} KB</td>
                <td><button className="btn sec sm" onClick={() => open(d.document)}>Open</button></td></tr>))}</tbody>
          </table></div>
        </>
      )}
      {children}
    </Dialog>
  );
}

export function UwDesk({ ctx, snap, run, busy }) {
  const [open, setOpen] = useState(null);
  const app = snap.applications.find((a) => a.id === open);
  const queue = snap.applications; // already limited to this underwriter's applications (lib/snapshot.js)
  return (
    <>
      <Box title="Application desk" sub="Applications submitted by your agents. Review the form and documents, then draft the contract or reject with reasons. The farmer reviews and pays the contract.">
        <DataTable rows={queue} pageSize={10} empty="No applications yet." onRow={(a) => setOpen(a.id)} initialSort={{ key: "id", dir: "desc" }}
          filters={[{ value: "1", label: "With you" }, { value: "2", label: "Contract ready" }, { value: "5", label: "Policy issued" }, { value: "3", label: "Rejected" }]}
          filterFn={(a, f) => String(a.status) === f}
          columns={[
            { key: "id", label: "#", render: (a) => `#${a.id}` },
            { key: "farmer", label: "Farmer", render: (a) => short(a.farmer), text: (a) => a.farmer },
            { key: "agent", label: "Agent", render: (a) => short(a.agent), text: (a) => a.agent },
            { key: "cover", label: "Cover", render: (a) => COVER_PLAIN[Number(productOf(snap, a)?.cover ?? 0)].name },
            { key: "sum", label: "Sum insured", render: (a) => `${fmt(a.sumInsured)} RWF`, sort: (a) => Number(a.sumInsured) },
            { key: "status", label: "Status", render: (a) => appBadge(a, snap.now), text: (a) => a.statusName },
          ]} />
      </Box>
      {app && (
        <DecisionView app={app} ctx={ctx} snap={snap} onClose={() => setOpen(null)}>
          {(app.status === 1 || app.status === OFFERED) && <Draft app={app} ctx={ctx} snap={snap} run={run} busy={busy} onDone={() => setOpen(null)} />}
        </DecisionView>
      )}
    </>
  );
}

// Draft the contract: terms start from the request; the premium follows the product rate for the chosen terms.
function Draft({ app, ctx, snap, run, busy, onDone }) {
  const { desk, ledger, signer } = ctx;
  const p = productOf(snap, app);
  const [t, setT] = useState({ level: Number(app.level), sum: String(app.sumInsured), startDays: Number(app.startAt) ? Math.max(0, Math.round((Number(app.startAt) - snap.now) / DAY)) : 0, days: Number(app.coverDays), conditions: "" });
  const [premium, setPremium] = useState(null);
  const [reasons, setReasons] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const set = (k) => (e) => setT({ ...t, [k]: e.target.value });
  useEffect(() => {
    let live = true;
    ledger.quoteCover(app.productId, Number(t.level), BigInt(t.sum || 0), Number(t.days)).then((q) => live && setPremium(q)).catch(() => live && setPremium(null));
    return () => { live = false; };
  }, [t.level, t.sum, t.days, app.productId, ledger]);

  const draft = () => run(`Drafting the contract for application #${app.id}`, async () => {
    const startAt = Number(t.startDays) > 0 ? snap.now + Number(t.startDays) * DAY + 120 : 0;
    const lvl = p.levels?.[Number(t.level)];
    const content = {
      deskApplicationId: app.id, productId: Number(app.productId), cover: COVER_PLAIN[Number(p.cover)].name,
      level: Number(t.level), trigger: Number(p.cover) === 3 ? null : cond(p.cover, lvl?.threshold ?? p.threshold),
      sumInsured: String(t.sum), startAt, coverDays: Number(t.days), premium: String(premium),
      conditions: t.conditions.trim(), formHash: app.formHash, draftedAt: snap.now,
    };
    const { hash } = await postDecision(signer, app.farmer, (await fetchDeskRecord(signer, app.farmer, app.id)).application, app.id, "contract", content);
    const rc = await (await desk.draftContract(app.id, Number(t.level), BigInt(t.sum), startAt, Number(t.days), hash)).wait();
    onDone();
    return rc;
  });
  const reject = () => run(`Rejecting application #${app.id}`, async () => {
    const { hash } = await postDecision(signer, app.farmer, (await fetchDeskRecord(signer, app.farmer, app.id)).application, app.id, "rejection", { reasons: reasons.trim(), decidedAt: snap.now });
    const rc = await (await desk.rejectApplication(app.id, hash)).wait();
    onDone();
    return rc;
  });

  return (
    <>
      <h3 className="formhead">{app.status === OFFERED ? "Re-draft the contract" : "Draft the contract"}</h3>
      {p && Number(p.cover) !== 3 && (
        <><label htmlFor="d-level">Trigger level</label>
          <select id="d-level" value={t.level} onChange={set("level")}>{(p.levels || []).map((l) => <option key={l.level} value={l.level}>Pays if {cond(p.cover, l.threshold)} · {Number(l.rateBps) / 100}%</option>)}</select></>
      )}
      <div className="row">
        <div><label htmlFor="d-sum">Sum insured (RWF)</label><input id="d-sum" type="number" min="1000" step="1000" value={t.sum} onChange={set("sum")} /></div>
        <div><label htmlFor="d-start">Starts in (days, 0 = on payment)</label><input id="d-start" type="number" min="0" max="90" value={t.startDays} onChange={set("startDays")} /></div>
        <div><label htmlFor="d-days">Length (days)</label><input id="d-days" type="number" min="1" max={p ? Number(p.durationDays) : 365} value={t.days} onChange={set("days")} /></div>
      </div>
      <label htmlFor="d-cond">Special conditions (optional, part of the contract)</label>
      <textarea id="d-cond" rows={3} value={t.conditions} onChange={set("conditions")} placeholder="e.g. Cover subject to vaccination record being kept up to date." />
      <div className="quote"><span className="muted">Premium (product rate)</span><b>{premium !== null ? `${fmt(premium)} RWF` : "-"}</b><span className="muted">The farmer pays this minus any government subsidy.</span></div>
      <div className="row">
        <button className="btn" disabled={busy || premium === null} onClick={draft}>{app.status === OFFERED ? "Send the new contract" : "Send the contract"}</button>
        <button className="btn sec" disabled={busy} onClick={() => setRejecting(!rejecting)}>Reject…</button>
      </div>
      {rejecting && (
        <>
          <label htmlFor="d-why">Reasons (shown to the agent and the farmer)</label>
          <textarea id="d-why" rows={3} value={reasons} onChange={(e) => setReasons(e.target.value)} />
          <button className="btn danger" disabled={busy || reasons.trim().length < 5} onClick={reject}>Reject the application</button>
        </>
      )}
    </>
  );
}
