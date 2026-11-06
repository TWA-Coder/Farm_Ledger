"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import requirements from "../shared/requirements";
import { Badge, Box, Dialog, KV, Stepper } from "../components/ui";
import { UploadField } from "../components/upload";
import { COVER, errMsg, fmt, fromB32, short } from "../lib/chain";
import { COVER_PLAIN, cond } from "../lib/format";
import {
  finalizeApplication, linkDeskApplication, listDocuments, newApplicationId, removeDocument, sha256Hex,
  uploadDocument, validateFile, viewStored, formatBytes,
} from "../lib/documents";

const MIN_SUM = 1000;
const DAY = 86400;
const MAX_START_DAYS = 90; // contract: MAX_START_DELAY
const MIN_COVER_DAYS = 30; // contract: MIN_COVER_DAYS

// Dates are counted from the chain's "today" (the test tools can move chain time), in the viewer's time zone.
const isoDate = (ts) => { const d = new Date(Number(ts) * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const dayIndex = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / (DAY * 1000)); };
const longDate = (ts) => new Date(Number(ts) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
const UNITS = {
  rain: "Rain is measured as the total millimetres (mm) of rain that fell on your plot during the previous 30 days, from weather and satellite data.",
  ndvi: "Crop health is measured with NDVI, a satellite index from 0 (bare soil) to 1 (dense, healthy green crop). Healthy maize is usually above 0.5.",
};
const STEPS = ["Farmer and cover", "Supporting documents", "Review and submit"];

// Renders the additional questions registered in shared/requirements.js (empty until the policy contract is supplied).
function ExtraFields({ fields, answers, setAnswers, errors }) {
  if (!fields.length) return null;
  const set = (id, v) => setAnswers((a) => ({ ...a, [id]: v }));
  return (
    <Box title="Details for the policy schedule" sub="These appear on the farmer's policy document. They are kept with the application, not on the public ledger.">
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

// The insurance agent fills in the application for one of their farmers and submits it to the underwriter
// (PolicyDesk.submitApplication with the hash of the form and documents). Nothing is paid here: the underwriter drafts
// the contract, and the farmer reviews and pays it (USSD "My offers" or the portal).
export function ApplicationForm({ ctx, snap, address, run, busy, go, intent }) {
  const { ledger, desk, signer } = ctx;
  const farmers = snap.agent?.farmers || [];
  const [farmerAddr, setFarmerAddr] = useState(intent?.farmer && farmers.some((f) => f.address === intent.farmer) ? intent.farmer : farmers[0]?.address || "");
  const farmer = farmers.find((f) => f.address === farmerAddr);
  const active = snap.products.filter((p) => p.active && p.underwriter.toLowerCase() === (snap.agent?.underwriter || "").toLowerCase());
  const [step, setStep] = useState(0);
  const [pid, setPid] = useState(intent?.pid && active.some((p) => p.id === intent.pid) ? intent.pid : active[0]?.id || 1);
  const [asset, setAsset] = useState("");
  const [sum, setSum] = useState(200000);
  const [quote, setQuote] = useState(null);     // what the farmer pays: premium minus the government subsidy
  const [subsidy, setSubsidy] = useState(0n);  // paid by the subsidy programme (0 when none applies)
  const [level, setLevel] = useState(0);
  const [startOffset, setStartOffset] = useState(0); // days after today (0 = as soon as the premium is paid)
  const [days, setDays] = useState(null);             // cover length; null = product's full length
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
  const assets = prod && farmer ? (isLive ? farmer.animals.filter((a) => !a.deceased) : farmer.plots) : [];
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
  const maxDays = prod ? Number(prod.durationDays) : 0;
  const minDays = Math.min(MIN_COVER_DAYS, maxDays);
  const coverDays = days ?? maxDays;
  const lvl = prod?.levels?.[level] || prod?.levels?.[0];
  useEffect(() => { setLevel(0); setDays(null); }, [pid]);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        if (prod && sum > 0 && coverDays >= 1 && coverDays <= maxDays) {
          const q = await ledger.quoteCover(pid, level, sum, coverDays);
          const s = farmerAddr ? await ledger.subsidyFor(farmerAddr, pid, q).catch(() => 0n) : 0n; // estimate for this farmer
          if (live) { setQuote(q - s); setSubsidy(s); }
        } else if (live) { setQuote(null); setSubsidy(0n); }
      }
      catch { if (live) { setQuote(null); setSubsidy(0n); } }
    })();
    return () => { live = false; };
  }, [pid, sum, prod, ledger, level, coverDays, maxDays, farmerAddr]);
  const startTs = snap.now + startOffset * DAY;
  const endTs = startTs + coverDays * DAY;

  // Documents already on file for this farmer (identity is reused across applications). The agent signs the request;
  // the server checks on-chain that this agent is assigned to the farmer.
  useEffect(() => {
    if (!farmerAddr) return;
    let live = true;
    listDocuments(signer, farmerAddr, appId.current)
      .then((list) => { if (live) setDocs((d) => { const n = { ...d }; for (const s of list) if (s.scope === "applicant" && !n[s.document]?.file) n[s.document] = { ...n[s.document], stored: s }; return n; }); })
      .catch(() => { /* first visit or server unavailable: documents simply show as not on file */ });
    return () => { live = false; };
  }, [farmerAddr, signer]);

  // Another farmer: a new application, nothing carried over.
  const lastFarmer = useRef(farmerAddr);
  useEffect(() => {
    if (lastFarmer.current === farmerAddr) return;
    lastFarmer.current = farmerAddr;
    appId.current = newApplicationId(); toDelete.current = new Set();
    setDocs({}); setAnswers({}); setErrors({}); setAsset("");
  }, [farmerAddr]);

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

  if (!snap.agent) return <Box title="New application"><p className="muted">This account is not an insurance agent.</p></Box>;
  if (!farmers.length) return <Box title="New application"><p className="empty">No farmers are assigned to you yet. Farmers are assigned when they register in one of your districts.</p></Box>;
  if (!active.length) return <Box title="New application"><p className="empty">Your insurer has no product on sale at the moment.</p></Box>;

  if (done) {
    return (
      <Box title="Application submitted">
        <div className="callout ok"><b>Application #{done.deskId} is with the underwriter.</b> {done.linked ? "" : "The record link will be repaired on the next save."}</div>
        <KV rows={[
          ["Farmer", done.farmerLabel],
          ["Cover asked", `${done.cover} · ${fmt(done.sum)} RWF`],
          ["Application reference", appRef(done.appId)],
          ["Documents", `${done.count} on file, fingerprint recorded on the ledger`],
        ]} />
        <h2 style={{ fontSize: 14, margin: "12px 0 4px" }}>What happens next</h2>
        <p className="muted">The underwriter reviews the form and documents and drafts the contract (or explains a rejection). You and the farmer both get an SMS. The farmer then reviews the contract and pays it by Mobile Money (USSD, option 6) or on the portal.</p>
        <div className="row"><button className="btn" onClick={() => go("applications")}>Track applications</button><button className="btn sec" onClick={() => resetAll()}>New application</button></div>
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
      if (!farmer) e.farmer = "Choose the farmer.";
      if (!asset) e.asset = isLive ? "Record the farmer's animal first." : "Record the farmer's plot first.";
      if (!Number.isFinite(sum) || sum < MIN_SUM) e.sum = `Enter a sum insured of at least ${fmt(MIN_SUM)} RWF.`;
      if (quote === null) e.sum = e.sum || "The premium could not be calculated for this amount.";
      if (!Number.isInteger(startOffset) || startOffset < 0 || startOffset > MAX_START_DAYS) e.start = `Choose a start date from today up to ${MAX_START_DAYS} days ahead.`;
      if (!Number.isInteger(coverDays) || coverDays < minDays || coverDays > maxDays) e.end = `The cover must last between ${minDays} and ${maxDays} days.`;
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
    await run("Submitting the application", async () => {
      try {
        const count = docDefs.filter((d) => have(d.id)).length;
        setProgress("Uploading documents");
        for (const id of toDelete.current) { await removeDocument(signer, farmerAddr, appId.current, id); toDelete.current.delete(id); }
        for (const d of docDefs) {
          const it = docs[d.id];
          if (it?.file && !it.uploaded) {
            await uploadDocument(signer, farmerAddr, appId.current, d.id, it.file, await sha256Hex(it.file));
            setDocs((p) => ({ ...p, [d.id]: { ...p[d.id], uploaded: true } }));
          }
        }
        setProgress("Checking the application");
        const cctx = { cover, productId: Number(pid), assetId: Number(asset), sumInsured: String(sum) };
        const terms = { triggerLevel: level, startOffsetDays: startOffset, coverDays };
        const { applicationHash } = await finalizeApplication(signer, farmerAddr, appId.current, cctx, { ...answers, _terms: terms });

        setProgress("Sending it to the underwriter");
        // startAt 0 = when the farmer accepts; a later date starts at the same time of day, counted on chain time
        const startAt = startOffset === 0 ? 0 : snap.now + startOffset * DAY + 120;
        const rc = await (await desk.submitApplication(farmerAddr, pid, asset, sum, level, startAt, coverDays, applicationHash)).wait();
        const ev = rc.logs.map((l) => { try { return desk.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "ApplicationSubmitted");
        const deskId = Number(ev.args.applicationId);
        let linked = true;
        try { await linkDeskApplication(signer, farmerAddr, appId.current, deskId); } catch { linked = false; }
        setDone({ deskId, appId: appId.current, count, linked, sum, cover: COVER_PLAIN[cover].name, farmerLabel: farmer.label });
        return rc;
      } finally { setProgress(null); }
    });
  }

  // ------------------------------------------------------------ render
  const stepper = STEPS.map((label, i) => ({ label, state: i < step ? "done" : i === step ? "cur" : "" }));
  const errCount = Object.keys(errors).filter((k) => k !== "_summary").length;
  const sumOk = Number.isFinite(sum) && sum >= MIN_SUM;

  return (
    <>
      <Box title="New application" sub="Fill this in with the farmer: cover, documents, details. It goes to the underwriter, who drafts the contract. Nothing is paid now.">
        <Stepper steps={stepper} />
        {errors._summary && <div className="callout err" role="alert">{errors._summary}</div>}
        {step === 0 && errCount > 0 && <div className="callout err" role="alert">Please correct the highlighted fields.</div>}
      </Box>

      {step === 0 && (
        <Box title="Farmer and cover" sub="Choose the farmer, the product and what it protects.">
          <label htmlFor="farmer">Farmer</label>
          <select id="farmer" value={farmerAddr} onChange={(e) => setFarmerAddr(e.target.value)} aria-invalid={Boolean(errors.farmer)}>
            {farmers.map((f) => <option key={f.address} value={f.address}>{f.label}</option>)}
          </select>
          {errors.farmer && <p className="upl-err" role="alert">{errors.farmer}</p>}
          <label htmlFor="prod">Product</label>
          <select id="prod" value={pid} onChange={(e) => setPid(Number(e.target.value))}>
            {active.map((p) => <option key={p.id} value={p.id}>{COVER_PLAIN[Number(p.cover)].name} · up to {Number(p.durationDays)} days</option>)}
          </select>
          {prod && !isLive && (
            <>
              <label htmlFor="level">When should it pay?</label>
              <select id="level" value={level} onChange={(e) => setLevel(Number(e.target.value))}>
                {(prod.levels || []).map((l) => <option key={l.level} value={l.level}>Pays if {cond(prod.cover, l.threshold)} · {Number(l.rateBps) / 100}% for {Number(prod.durationDays)} days</option>)}
              </select>
              <p className="muted" style={{ marginTop: 6 }}>{Number(prod.cover) === 2 ? UNITS.ndvi : UNITS.rain} A level that pays more easily costs more.</p>
            </>
          )}
          {prod && isLive && <p className="muted" style={{ marginTop: 8 }}>Pays when {cond(prod.cover, prod.threshold)}. A claim needs {snap.vetQuorum} certified veterinarian signature{snap.vetQuorum > 1 ? "s" : ""}.</p>}
          <div className="row">
            <div>
              <label htmlFor="start">Cover starts</label>
              <input id="start" type="date" value={isoDate(startTs)} min={isoDate(snap.now)} max={isoDate(snap.now + MAX_START_DAYS * DAY)} aria-invalid={Boolean(errors.start)}
                onChange={(e) => { if (!e.target.value) return; setStartOffset(dayIndex(e.target.value) - dayIndex(isoDate(snap.now))); }} />
              <p className="muted">{startOffset === 0 ? "As soon as the farmer accepts and pays the contract." : `In ${startOffset} day${startOffset === 1 ? "" : "s"}. Losses before this date are not covered.`}</p>
              {errors.start && <p className="upl-err" role="alert">{errors.start}</p>}
            </div>
            <div>
              <label htmlFor="end">Cover ends</label>
              <input id="end" type="date" value={isoDate(endTs)} min={isoDate(startTs + minDays * DAY)} max={isoDate(startTs + maxDays * DAY)} aria-invalid={Boolean(errors.end)}
                onChange={(e) => { if (!e.target.value) return; setDays(dayIndex(e.target.value) - dayIndex(isoDate(startTs))); }} />
              <p className="muted">{coverDays} days (between {minDays} and {maxDays}). The premium is for the days you choose.</p>
              {errors.end && <p className="upl-err" role="alert">{errors.end}</p>}
            </div>
          </div>
          <div className="row">
            <div>
              <label htmlFor="asset">{isLive ? "Animal" : "Plot"}</label>
              <select id="asset" value={asset} onChange={(e) => setAsset(e.target.value)} aria-invalid={Boolean(errors.asset)}>
                {assets.length === 0 && <option value="">None registered</option>}
                {assets.map((a) => <option key={a.id} value={a.id}>{a.tagId ? fromB32(a.tagId) : `Plot #${a.id} · ${fromB32(a.crop)}`}</option>)}
              </select>
              {errors.asset && <p className="upl-err" role="alert">{errors.asset} <button className="link" onClick={() => go("overview", { farmer: farmerAddr })}>Record one</button></p>}
            </div>
            <div>
              <label htmlFor="sum">Sum insured (RWF)</label>
              <p className="muted" style={{ margin: "0 0 4px" }}>The amount paid to the farmer if the cover pays out. {isLive ? "Usually the value of the animal." : "Usually what they invest in the plot (seed, fertiliser, labour)."}</p>
              <input id="sum" type="number" min={MIN_SUM} step="1000" value={sum} onChange={(e) => setSum(Number(e.target.value))} aria-invalid={Boolean(errors.sum)} />
              {errors.sum && <p className="upl-err" role="alert">{errors.sum}</p>}
            </div>
          </div>
          <div className="quote">
            <span className="muted">Estimated premium for the farmer</span>
            <b>{quote !== null && sumOk ? `${fmt(quote)} RWF` : "-"}</b>
            <span className="muted">{subsidy > 0n && quote !== null && sumOk ? `After a government subsidy of ${fmt(subsidy)} RWF. ` : ""}The underwriter sets the final terms in the contract.</span>
          </div>
        </Box>
      )}

      {step === 1 && (
        <>
          <Box title="Supporting documents" sub={`Each document supports information in the application. Accepted: PDF, JPG or PNG, up to 5 MB each. ${missing.length ? `${missing.length} required document${missing.length > 1 ? "s" : ""} still needed.` : "All required documents are in place."}`}>
            {groups.map(([field, defs]) => (
              <div className="docgroup" key={field}>
                <h3>{field}{field === "Insured plot" && selected ? <span className="muted"> · Plot #{selected.id}, {fromB32(selected.crop)}</span> : null}{field === "Insured animal" && selected ? <span className="muted"> · {fromB32(selected.tagId)}</span> : null}</h3>
                {defs.map((d) => (
                  <UploadField key={d.id} def={d} item={{ ...docs[d.id], error: errors[d.id] || docs[d.id]?.error }} disabled={busy}
                    onPick={(f) => pick(d.id, f)} onRemove={() => remove(d.id)}
                    onViewStored={() => viewStored(signer, farmerAddr, appId.current, d.id).catch(() => {})} />
                ))}
              </div>
            ))}
          </Box>
          <ExtraFields fields={extraFields} answers={answers} setAnswers={setAnswers} errors={errors} />
        </>
      )}

      {step === 2 && (
        <>
          <Box title="Review the application" sub="Check the details and documents with the farmer. Use Back to change or replace anything.">
            <KV rows={[
              ["Farmer", farmer?.label],
              ["Cover", prod && COVER_PLAIN[cover].name],
              [isLive ? "Animal" : "Plot", selected ? (selected.tagId ? fromB32(selected.tagId) : `Plot #${selected.id} · ${fromB32(selected.crop)}`) : "-"],
              ["Pays when", prod && cond(prod.cover, lvl?.threshold ?? prod.threshold)],
              ["Sum insured", `${fmt(sum)} RWF`],
              ["Cover period", `${longDate(startTs)} to ${longDate(endTs)}${startOffset === 0 ? " (starts when the farmer pays)" : ""}`],
              ["Estimated premium", `${fmt(quote)} RWF${subsidy > 0n ? ` after a ${fmt(subsidy)} RWF subsidy` : ""} (final amount in the contract)`],
              ["Length", `${coverDays} days`],
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
          : <button className="btn" disabled={busy || missing.length > 0 || !asset || !sumOk || quote === null} onClick={() => setConfirm(true)}>Submit to the underwriter</button>}
      </div>

      {confirm && (
        <Dialog title="Submit to the underwriter" sub="The form and documents are sealed with a fingerprint recorded on the ledger, so they cannot be changed afterwards. Nothing is charged to the farmer now." onClose={() => setConfirm(false)}
          actions={<><button className="btn sec" onClick={() => setConfirm(false)}>Cancel</button><button className="btn" onClick={submit}>Submit</button></>}>
          <KV rows={[["Farmer", farmer?.label], ["Cover", prod && COVER_PLAIN[cover].name], ["Sum insured", `${fmt(sum)} RWF`], ["Pays when", prod && cond(prod.cover, lvl?.threshold ?? prod.threshold)], ["Cover period", `${longDate(startTs)} to ${longDate(endTs)}`], ["Documents", `${docDefs.filter((d) => have(d.id)).length} attached`]]} />
        </Dialog>
      )}
    </>
  );
}
