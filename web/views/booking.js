"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import requirements from "../shared/requirements";
import { Badge, Box, Dialog, KV, Stepper } from "../components/ui";
import { UploadField } from "../components/upload";
import { COVER, fmt, fromB32, short } from "../lib/chain";
import { cond } from "../lib/format";
import {
  finalizeApplication, linkApplication, listDocuments, newApplicationId, removeDocument, sha256Hex,
  uploadDocument, validateFile, viewStored, formatBytes,
} from "../lib/documents";

const MIN_SUM = 1000;
const STEPS = ["Cover", "Supporting documents", "Review and submit"];

// Renders the additional questions registered in shared/requirements.js (empty until the policy contract is supplied).
function ExtraFields({ fields, answers, setAnswers, errors }) {
  if (!fields.length) return null;
  const set = (id, v) => setAnswers((a) => ({ ...a, [id]: v }));
  return (
    <Box title="Additional information" sub="Declarations and details required for this cover.">
      {fields.map((f) => (
        <div key={f.id}>
          {f.type === "checkbox" ? (
            <label style={{ display: "flex", gap: 8, alignItems: "start", color: "var(--tx)", fontSize: 14 }}>
              <input type="checkbox" style={{ width: "auto", minHeight: 0, marginTop: 3 }} checked={Boolean(answers[f.id])} onChange={(e) => set(f.id, e.target.checked)} />
              <span>{f.label}{f.required && " *"}</span>
            </label>
          ) : (
            <>
              <label htmlFor={`x-${f.id}`}>{f.label}{f.required && " *"}</label>
              {f.type === "select" ? (
                <select id={`x-${f.id}`} value={answers[f.id] || ""} onChange={(e) => set(f.id, e.target.value)}>
                  <option value="">Select…</option>{(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : f.type === "textarea" ? (
                <textarea id={`x-${f.id}`} rows={3} value={answers[f.id] || ""} onChange={(e) => set(f.id, e.target.value)} />
              ) : (
                <input id={`x-${f.id}`} type={f.type || "text"} value={answers[f.id] || ""} onChange={(e) => set(f.id, e.target.value)} />
              )}
            </>
          )}
          {f.help && <p className="muted">{f.help}</p>}
          {errors[f.id] && <p className="upl-err" role="alert">{errors[f.id]}</p>}
        </div>
      ))}
    </Box>
  );
}

export function BuyCover({ ctx, snap, address, run, busy, go }) {
  const { ledger, token, signer } = ctx;
  const active = snap.products.filter((p) => p.active);
  const [step, setStep] = useState(0);
  const [pid, setPid] = useState(active[0]?.id || 1);
  const [asset, setAsset] = useState("");
  const [sum, setSum] = useState(200000);
  const [quote, setQuote] = useState(null);
  const [docs, setDocs] = useState({});            // id -> { file, error, uploaded, stored }
  const [answers, setAnswers] = useState({});
  const [errors, setErrors] = useState({});        // step-level and field-level messages
  const [progress, setProgress] = useState(null);
  const [done, setDone] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const appId = useRef(newApplicationId());
  const toDelete = useRef(new Set());

  const prod = snap.products.find((p) => p.id === Number(pid));
  const isLive = prod && Number(prod.cover) === 3;
  const assets = prod ? (isLive ? snap.animals.filter((a) => !a.deceased) : snap.plots) : [];
  const selected = assets.find((a) => a.id === Number(asset));
  const cover = prod ? Number(prod.cover) : 0;
  const docDefs = useMemo(() => requirements.documentsFor({ cover }), [cover]);
  const extraFields = useMemo(() => requirements.fieldsFor({ cover }), [cover]);
  const groups = useMemo(() => {
    const g = new Map();
    for (const d of docDefs) { if (!g.has(d.field)) g.set(d.field, []); g.get(d.field).push(d); }
    return [...g.entries()];
  }, [docDefs]);

  useEffect(() => { if (assets.length && !assets.find((a) => a.id === Number(asset))) setAsset(assets[0].id); }, [pid, assets.length]); // eslint-disable-line
  useEffect(() => { (async () => { try { if (prod && sum > 0) setQuote(await ledger.quotePremium(pid, sum)); } catch { setQuote(null); } })(); }, [pid, sum, prod, ledger]);

  // Documents on file for this applicant (identity is reused across applications).
  useEffect(() => {
    if (!snap.farmer.exists) return;
    let live = true;
    listDocuments(signer, address, appId.current)
      .then((list) => { if (live) setDocs((d) => { const n = { ...d }; for (const s of list) if (s.scope === "applicant" && !n[s.document]?.file) n[s.document] = { ...n[s.document], stored: s }; return n; }); })
      .catch(() => { /* first visit or server unavailable: documents simply show as not on file */ });
    return () => { live = false; };
  }, [address, signer, snap.farmer.exists]);

  // The land / animal documents belong to the chosen asset: changing product or asset starts them afresh.
  const lastKey = useRef(null);
  useEffect(() => {
    const key = `${pid}:${asset}`;
    if (lastKey.current !== null && lastKey.current !== key) {
      setDocs((d) => {
        const n = {};
        for (const [id, v] of Object.entries(d)) if (requirements.DOCUMENTS[id]?.scope === "applicant") n[id] = v; else if (v.uploaded) toDelete.current.add(id);
        return n;
      });
      setErrors({});
    }
    lastKey.current = key;
  }, [pid, asset]);

  if (!snap.farmer.exists) return <Box title="Policy application"><p className="muted">Complete your registration on the Overview page before applying for cover.</p><button className="btn" onClick={() => go("overview")}>Go to registration</button></Box>;
  if (!active.length) return <Box title="Policy application"><p className="empty">No products are available yet.</p></Box>;

  if (done) {
    return (
      <Box title="Application submitted">
        <div className="callout ok"><b>Policy #{done.policyId} is active.</b> Your documents were received and the application is recorded against the policy.</div>
        <KV rows={[["Policy", `#${done.policyId}`], ["Application reference", appRef(done.appId)], ["Application fingerprint", <span title={done.hash}>{short(done.hash)}</span>], ["Documents", `${done.count} on file`]]} />
        <div className="row"><button className="btn" onClick={() => go("policies")}>View my policies</button><button className="btn sec" onClick={() => resetAll(true)}>Start another application</button></div>
      </Box>
    );
  }

  // ------------------------------------------------------------ helpers
  function appRef(id) { return "APP-" + id.replace(/-/g, "").slice(0, 8).toUpperCase(); }
  const have = (id) => Boolean(docs[id]?.file || docs[id]?.stored);
  const missing = requirements.missingDocuments({ cover }, docDefs.filter((d) => have(d.id)).map((d) => d.id));

  async function pick(id, file) {
    const error = await validateFile(file);
    setDocs((d) => ({ ...d, [id]: error ? { ...d[id], error } : { file, error: null, uploaded: false, stored: d[id]?.stored } }));
    if (!error) setErrors((e) => { const n = { ...e }; delete n[id]; return n; });
  }
  function remove(id) {
    setDocs((d) => {
      const n = { ...d };
      if (n[id]?.uploaded) toDelete.current.add(id);
      n[id] = n[id]?.stored ? { stored: n[id].stored } : undefined;
      if (!n[id]) delete n[id];
      return n;
    });
  }

  function validateStep(s) {
    const e = {};
    if (s === 0) {
      if (!asset) e.asset = isLive ? "Register an animal first." : "Register a plot first.";
      if (!Number.isFinite(sum) || sum < MIN_SUM) e.sum = `Enter a sum insured of at least ${fmt(MIN_SUM)} RWF.`;
      if (quote === null) e.sum = e.sum || "The premium could not be calculated for this amount.";
    }
    if (s === 1) {
      for (const id of missing) e[id] = docs[id]?.error || "This document is required.";
      for (const d of docDefs) if (docs[d.id]?.error && !e[d.id]) e[d.id] = docs[d.id].error;
      Object.assign(e, requirements.validateAnswers({ cover }, answers));
      if (missing.length) e._summary = `${missing.length} required document${missing.length > 1 ? "s are" : " is"} missing: ${missing.map((id) => requirements.DOCUMENTS[id].label.toLowerCase()).join("; ")}.`;
    }
    return e;
  }
  function next() {
    const e = validateStep(step);
    setErrors(e);
    if (Object.keys(e).length) {
      const first = Object.keys(e).find((k) => k !== "_summary");
      if (first) setTimeout(() => document.querySelector(`[data-doc="${first}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
      return;
    }
    setStep(step + 1);
  }
  function resetAll() {
    appId.current = newApplicationId(); toDelete.current = new Set();
    setDocs((d) => { const n = {}; for (const [id, v] of Object.entries(d)) if (requirements.DOCUMENTS[id]?.scope === "applicant" && v.stored) n[id] = { stored: v.stored }; return n; });
    setAnswers({}); setErrors({}); setProgress(null); setDone(null); setStep(0);
  }

  async function submit() {
    setConfirm(false);
    // re-check everything: the review step must not be reachable with an incomplete application, but never trust the UI alone
    const e = { ...validateStep(0), ...validateStep(1) };
    if (Object.keys(e).length) { setErrors(e); setStep(Object.keys(validateStep(0)).length ? 0 : 1); return; }
    await run("Application", async () => {
      try {
        const count = docDefs.filter((d) => have(d.id)).length;
        setProgress("Uploading documents");
        for (const id of toDelete.current) { await removeDocument(signer, address, appId.current, id); toDelete.current.delete(id); }
        for (const d of docDefs) {
          const it = docs[d.id];
          if (it?.file && !it.uploaded) {
            await uploadDocument(signer, address, appId.current, d.id, it.file, await sha256Hex(it.file));
            setDocs((p) => ({ ...p, [d.id]: { ...p[d.id], uploaded: true } }));
          }
        }
        setProgress("Checking the application");
        const cctx = { cover, productId: Number(pid), assetId: Number(asset), sumInsured: String(sum) };
        const { applicationHash } = await finalizeApplication(signer, address, appId.current, cctx, answers);

        setProgress("Paying the premium and issuing the policy");
        if (snap.allowance < quote) await (await token.approve(ledger.target, ethers.MaxUint256)).wait();
        const rc = await (await ledger.buyPolicy(pid, asset, sum)).wait();
        const ev = rc.logs.map((l) => { try { return ledger.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "PolicyPurchased");
        const policyId = Number(ev.args.policyId);

        setProgress("Recording the application");
        await (await ledger.recordApplication(policyId, applicationHash)).wait();
        try { await linkApplication(signer, address, appId.current, policyId); } catch { /* the on-chain record is authoritative; the server link can be repaired */ }
        setDone({ policyId, hash: applicationHash, appId: appId.current, count });
      } finally { setProgress(null); }
    });
  }

  // ------------------------------------------------------------ render
  const stepper = STEPS.map((label, i) => ({ label, state: i < step ? "done" : i === step ? "cur" : "" }));
  const errCount = Object.keys(errors).filter((k) => k !== "_summary").length;
  const sumOk = Number.isFinite(sum) && sum >= MIN_SUM;

  return (
    <>
      <Box title="Policy application" sub="Complete the three steps below. Nothing is charged until you confirm on the last step.">
        <Stepper steps={stepper} />
        {errors._summary && <div className="callout err" role="alert">{errors._summary}</div>}
        {step === 0 && errCount > 0 && <div className="callout err" role="alert">Please correct the highlighted fields.</div>}
      </Box>

      {step === 0 && (
        <Box title="Cover details" sub="Choose the product and what it protects.">
          <label htmlFor="prod">Product</label>
          <select id="prod" value={pid} onChange={(e) => setPid(Number(e.target.value))}>
            {active.map((p) => <option key={p.id} value={p.id}>{COVER[Number(p.cover)]} · {Number(p.rateBps) / 100}% premium · {Number(p.durationDays)} days</option>)}
          </select>
          {prod && <p className="muted" style={{ marginTop: 8 }}>Pays when {cond(prod.cover, prod.threshold)}.{isLive && ` A claim needs ${snap.vetQuorum} certified veterinarian signature${snap.vetQuorum > 1 ? "s" : ""}.`}</p>}
          <div className="row">
            <div>
              <label htmlFor="asset">{isLive ? "Animal" : "Plot"}</label>
              <select id="asset" value={asset} onChange={(e) => setAsset(e.target.value)} aria-invalid={Boolean(errors.asset)}>
                {assets.length === 0 && <option value="">None registered</option>}
                {assets.map((a) => <option key={a.id} value={a.id}>{a.tagId ? fromB32(a.tagId) : `Plot #${a.id} · ${fromB32(a.crop)}`}</option>)}
              </select>
              {errors.asset && <p className="upl-err" role="alert">{errors.asset} <button className="link" onClick={() => go("assets")}>Add one</button></p>}
            </div>
            <div>
              <label htmlFor="sum">Sum insured (RWF)</label>
              <input id="sum" type="number" min={MIN_SUM} step="1000" value={sum} onChange={(e) => setSum(Number(e.target.value))} aria-invalid={Boolean(errors.sum)} />
              {errors.sum && <p className="upl-err" role="alert">{errors.sum}</p>}
            </div>
          </div>
          <div className="quote">
            <span className="muted">Premium</span>
            <b>{quote !== null && sumOk ? `${fmt(quote)} RWF` : "-"}</b>
          </div>
        </Box>
      )}

      {step === 1 && (
        <>
          <Box title="Supporting documents" sub={`Each document supports information in your application. Accepted: PDF, JPG or PNG, up to 5 MB each. ${missing.length ? `${missing.length} required document${missing.length > 1 ? "s" : ""} still needed.` : "All required documents are in place."}`}>
            {groups.map(([field, defs]) => (
              <div className="docgroup" key={field}>
                <h3>{field}{field === "Insured plot" && selected ? <span className="muted"> · Plot #{selected.id}, {fromB32(selected.crop)}</span> : null}{field === "Insured animal" && selected ? <span className="muted"> · {fromB32(selected.tagId)}</span> : null}</h3>
                {defs.map((d) => (
                  <UploadField key={d.id} def={d} item={{ ...docs[d.id], error: errors[d.id] || docs[d.id]?.error }} disabled={busy}
                    onPick={(f) => pick(d.id, f)} onRemove={() => remove(d.id)}
                    onViewStored={() => viewStored(signer, address, appId.current, d.id).catch(() => {})} />
                ))}
              </div>
            ))}
          </Box>
          <ExtraFields fields={extraFields} answers={answers} setAnswers={setAnswers} errors={errors} />
        </>
      )}

      {step === 2 && (
        <>
          <Box title="Review your application" sub="Check the details and documents. Use Back to change or replace anything.">
            <KV rows={[
              ["Product", prod && COVER[cover]],
              [isLive ? "Animal" : "Plot", selected ? (selected.tagId ? fromB32(selected.tagId) : `Plot #${selected.id} · ${fromB32(selected.crop)}`) : "-"],
              ["Pays when", prod && cond(prod.cover, prod.threshold)],
              ["Sum insured", `${fmt(sum)} RWF`],
              ["Premium due now", <b>{fmt(quote)} RWF</b>],
              ["Duration", prod && `${Number(prod.durationDays)} days`],
            ]} />
          </Box>
          <Box title="Documents" right={<button className="btn sec sm" onClick={() => setStep(1)}>Change documents</button>}>
            <div className="tbl"><table>
              <thead><tr><th>Document</th><th>File</th><th>Size</th><th>Status</th></tr></thead>
              <tbody>
                {docDefs.map((d) => {
                  const it = docs[d.id]; const f = it?.file || it?.stored;
                  return (
                    <tr key={d.id}>
                      <td>{d.label}</td>
                      <td>{f ? (it.file?.name || it.stored.originalName) : <span className="muted">Not provided</span>}</td>
                      <td>{f ? formatBytes(it.file?.size || it.stored.size) : "-"}</td>
                      <td>{f ? <Badge tone="g">{it.uploaded ? "Uploaded" : it.file ? "Ready" : "On file"}</Badge> : <Badge tone={d.required ? "r" : "n"}>{d.required ? "Missing" : "Optional"}</Badge>}</td>
                    </tr>);
                })}
              </tbody>
            </table></div>
          </Box>
          {progress && <div className="callout" role="status"><b>{progress}…</b> Please keep this page open.</div>}
        </>
      )}

      <div className="wizard-nav">
        <button className="btn sec" disabled={busy || step === 0} onClick={() => { setErrors({}); setStep(step - 1); }}>Back</button>
        {step < 2
          ? <button className="btn" disabled={busy} onClick={next}>Continue</button>
          : <button className="btn" disabled={busy || missing.length > 0 || !asset || !sumOk || quote === null} onClick={() => setConfirm(true)}>Pay {quote !== null ? fmt(quote) : ""} RWF and submit</button>}
      </div>

      {confirm && (
        <Dialog title="Confirm and pay" sub="The premium is paid into the smart-contract escrow and the policy becomes active immediately." onClose={() => setConfirm(false)}
          actions={<><button className="btn sec" onClick={() => setConfirm(false)}>Cancel</button><button className="btn" onClick={submit}>Confirm payment</button></>}>
          <KV rows={[["Product", prod && COVER[cover]], ["Sum insured", `${fmt(sum)} RWF`], ["Premium", `${fmt(quote)} RWF`], ["Documents", `${docDefs.filter((d) => have(d.id)).length} attached`]]} />
        </Dialog>
      )}
    </>
  );
}
