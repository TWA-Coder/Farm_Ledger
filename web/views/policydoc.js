"use client";
// Underwriter: every policy on their products, and the policy document (schedule) in the layout of the standard
// NAIS policy schedules: header, insured, premiums, risk details, sections covered, clauses, exclusions, schedule.
// Sources: the contract (terms, money, status) and the farmer's signed application (details, documents), which
// the server returns only to the policy's underwriter and checks against the hash anchored on-chain.
import { useCallback, useEffect, useState } from "react";
import signing from "../shared/signing";
import requirements from "../shared/requirements";
import { Badge, Box, DataTable } from "../components/ui";
import { POLICY_STATUS, fmt, fromB32, short } from "../lib/chain";
import { COVER_PLAIN, cond, nameOf } from "../lib/format";
import { pick } from "../lib/snapshot";
import { fetchStored } from "../lib/documents";

const DAY = 86400;
const TONE = ["g", "a", "i", "n"];
const d = (ts) => new Date(Number(ts) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
export const policyNumber = (p, cover) => `FL/${Number(cover) === 3 ? "LVS" : "CRP"}/${new Date(Number(p.start) * 1000).getFullYear()}/${String(p.id).padStart(6, "0")}`;
const notGiven = <span className="muted">Not provided</span>;
const val = (a, k) => (a && a[k] !== undefined && a[k] !== "" && a[k] !== null ? String(a[k]) : null);

async function loadPolicies(ledger, address) {
  const n = Number(await ledger.policyCount());
  const out = [];
  for (let id = 1; id <= n; id++) {
    const p = { id, ...pick(await ledger.getPolicy(id)) };
    const prod = { id: Number(p.productId), ...pick(await ledger.getProduct(p.productId)) };
    if (prod.underwriter.toLowerCase() !== address.toLowerCase()) continue;
    const live = Number(prod.cover) === 3;
    const asset = live ? pick(await ledger.getAnimal(p.assetId)) : pick(await ledger.getPlot(p.assetId));
    out.push({ ...p, prod, asset, live, status: Number(p.status) });
  }
  return out.reverse();
}

export function UwPolicies({ ctx, snap, address, cfg }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null);
  const n = snap.events.filter((e) => e.name === "PolicyPurchased" || e.name === "PayoutExecuted").length;
  useEffect(() => { loadPolicies(ctx.ledger, address).then(setRows).catch((e) => setErr(e.message)); }, [ctx.ledger, address, n]);
  if (open) return <PolicyDocument policy={rows.find((r) => r.id === open)} ctx={ctx} snap={snap} address={address} cfg={cfg} onBack={() => setOpen(null)} />;
  return (
    <Box title="Policies on my products" sub="Open a policy to see and print its policy document (schedule).">
      {err && <div className="callout err">{err}</div>}
      {!rows ? <p className="muted">Loading policies…</p> : (
        <DataTable rows={rows} empty="No policies sold yet." onRow={(r) => setOpen(r.id)} initialSort={{ key: "no", dir: "desc" }}
          filters={POLICY_STATUS.map((l, i) => ({ value: String(i), label: l }))} filterFn={(r, f) => String(r.status) === f}
          columns={[
            { key: "no", label: "Policy no.", render: (r) => policyNumber(r, r.prod.cover), text: (r) => policyNumber(r, r.prod.cover), sort: (r) => r.id },
            { key: "holder", label: "Insured", render: (r) => nameOf(r.holder), text: (r) => nameOf(r.holder) + " " + r.holder },
            { key: "cover", label: "Cover", render: (r) => COVER_PLAIN[Number(r.prod.cover)].name, text: (r) => COVER_PLAIN[Number(r.prod.cover)].name },
            { key: "sum", label: "Sum insured", render: (r) => `${fmt(r.sumInsured)} RWF`, sort: (r) => Number(r.sumInsured) },
            { key: "period", label: "Period", render: (r) => `${d(r.start)} – ${d(r.end)}`, sort: (r) => Number(r.start), text: () => "" },
            { key: "status", label: "Status", render: (r) => <Badge tone={TONE[r.status]}>{POLICY_STATUS[r.status]}</Badge>, sort: (r) => r.status, text: (r) => POLICY_STATUS[r.status] },
          ]} />
      )}
    </Box>
  );
}

function PolicyDocument({ policy: p, ctx, snap, address, onBack }) {
  const [rec, setRec] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(async () => {
    setErr(null);
    try {
      const issued = Math.floor(Date.now() / 1000);
      const signature = await ctx.signer.signMessage(signing.message({ action: "policy-record", applicant: address, application: `policy-${p.id}`, issued }));
      const q = new URLSearchParams({ signer: address, issued: String(issued), signature });
      const res = await fetch(`/api/policies/${p.id}?${q}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not load the policy record.");
      setRec(body);
    } catch (e) { setErr(e.message); }
  }, [ctx.signer, address, p.id]);
  useEffect(() => { load(); }, [load]);

  const cover = Number(p.prod.cover);
  const live = cover === 3;
  const a = rec?.record?.answers || null;
  const purchase = snap.events.find((e) => e.name === "PolicyPurchased" && Number(e.args.policyId) === p.id);
  const payout = snap.events.find((e) => e.name === "PayoutExecuted" && Number(e.args.policyId) === p.id);
  const claims = snap.claims.filter((c) => Number(c.policyId) === p.id);
  const ha = !live ? Number(p.asset.areaM2) / 10000 : 0;
  const coverDays = Math.round((Number(p.end) - Number(p.start)) / DAY);
  const docs = rec?.record?.documents || [];
  const openDoc = async (doc) => {
    try { window.open(URL.createObjectURL(await fetchStored(ctx.signer, p.holder, rec.record.application, doc, { asReviewer: true })), "_blank", "noopener"); }
    catch (e) { setErr(e.message); }
  };

  return (
    <>
      <div className="row no-print" style={{ marginBottom: 12 }}>
        <button className="btn sec" onClick={onBack}>Back to policies</button>
        <button className="btn" onClick={() => window.print()}>Print or save as PDF</button>
      </div>
      {err && <div className="callout err no-print">{err} <button className="link" onClick={load}>Try again</button></div>}
      {rec && !rec.record && <div className="callout no-print">No application record is linked to this policy (for example policies created by the demo seed script). Details from the application are shown as not provided.</div>}
      {rec?.record && rec.matchesLedger === false && <div className="callout err">Warning: the stored application does not match the fingerprint recorded on the ledger for this policy. It may have been changed after the policy was issued.</div>}

      <article className="policydoc">
        <header className="pd-head">
          <div><b className="pd-brand">FarmLedger</b><div className="muted">Policy schedule</div></div>
          <dl className="pd-meta">
            <dt>Policy no.</dt><dd>{policyNumber(p, cover)}</dd>
            <dt>Type</dt><dd>{COVER_PLAIN[cover].name}{!live ? ` · ${fromB32(p.asset.crop)}` : ""}</dd>
            <dt>Insurance period</dt><dd>{d(p.start)} to {d(p.end)} ({coverDays} days)</dd>
            <dt>Status</dt><dd>{POLICY_STATUS[p.status]}</dd>
          </dl>
        </header>

        <section className="pd-grid">
          <div>
            <h3>Insured</h3>
            <dl className="kv">
              <dt>Name</dt><dd>{val(a, "full_name") || notGiven}</dd>
              <dt>ID / registration no.</dt><dd>{val(a, "id_number") || notGiven}</dd>
              <dt>Mobile</dt><dd>{rec?.phone ? `+${rec.phone}` : notGiven}</dd>
              <dt>Email</dt><dd>{val(a, "email") || notGiven}</dd>
              <dt>Postal address</dt><dd>{val(a, "postal_address") || notGiven}</dd>
              <dt>Occupation</dt><dd>{val(a, "occupation") || notGiven}</dd>
              <dt>TIN</dt><dd>{val(a, "tin") || notGiven}</dd>
              <dt>Account</dt><dd className="mono">{p.holder}</dd>
            </dl>
          </div>
          <div>
            <h3>Policy premiums</h3>
            <table className="pd-table"><tbody>
              <tr><th>Premium paid by the insured</th><td className="num">{fmt(p.premium)}</td></tr>
              <tr><th>Government share (NAIS 40%)</th><td className="num muted">Not applied in this version</td></tr>
              <tr><th>Total premium</th><td className="num"><b>{fmt(p.premium)}</b></td></tr>
              <tr><th>Currency</th><td className="num">Rwandan francs</td></tr>
              <tr><th>Effective sum insured</th><td className="num"><b>RWF {fmt(p.sumInsured)}</b></td></tr>
            </tbody></table>
          </div>
        </section>

        <section>
          <h3>Risk details</h3>
          <dl className="kv">
            <dt>Location</dt><dd>{val(a, "district_sector") || notGiven}</dd>
            {!live && <><dt>GPS</dt><dd>{(Number(p.asset.latE6) / 1e6).toFixed(5)}, {(Number(p.asset.lonE6) / 1e6).toFixed(5)}</dd></>}
            <dt>Description</dt><dd>{live ? `Livestock: ${fromB32(p.asset.breed)}, ear tag ${fromB32(p.asset.tagId)}` : `${fromB32(p.asset.crop)} on ${ha.toLocaleString("en-US", { maximumFractionDigits: 2 })} ha`}</dd>
          </dl>
        </section>

        <section>
          <h3>Sections covered</h3>
          <table className="pd-table"><thead><tr><th>Section</th><th>Details</th><th className="num">Sum insured</th></tr></thead><tbody>
            <tr>
              <td>{live ? "1. Cattle" : `1. ${fromB32(p.asset.crop)}`}</td>
              <td>{live
                ? `Ear tag ${fromB32(p.asset.tagId)}${val(a, "animal_name") ? ` · ${a.animal_name}` : ""}`
                : <>Variety: {val(a, "crop_variety") || "not provided"} · Insured area: {ha.toLocaleString("en-US", { maximumFractionDigits: 2 })} ha · Sum insured per ha: {ha ? fmt(Math.round(Number(p.sumInsured) / ha)) : "-"} · Expected yield: {val(a, "expected_yield") ? `${a.expected_yield} t/ha` : "not provided"}</>}</td>
              <td className="num">{fmt(p.sumInsured)}</td>
            </tr>
          </tbody></table>
        </section>

        <section>
          <h3>Clauses attached and forming part of this policy</h3>
          <ul className="plainlist">
            <li><b>Payout trigger:</b> pays the full sum insured when {cond(cover, p.threshold)}.</li>
            {!live && <li><b>Measurement:</b> {cover === 2 ? "NDVI vegetation index for the plot location (0 to 1), from satellite data." : "total rainfall in mm at the plot location over the previous 30 days."} Only readings taken during the insurance period count; the payout is made automatically when a reading meets the trigger.</li>}
            {live && <li><b>Claim verification:</b> death confirmed by {claims[0]?.quorum || snap.vetQuorum} certified veterinarian{(claims[0]?.quorum || snap.vetQuorum) > 1 ? "s" : ""}, none of whom may be the insured. Waiting period {Math.round(Number(snap.waiting) / DAY)} day(s) from the start of cover.</li>}
            <li><b>Excess:</b> none in this version.</li>
            <li><b>Funds:</b> the full sum insured was reserved from the underwriter's pool when the policy was issued.</li>
          </ul>
        </section>

        <section>
          <h3>Exclusions</h3>
          <ul className="plainlist">
            <li>Any loss before the start of the insurance period.</li>
            {live ? <><li>An animal that already has active cover, is not registered to the insured, or has died before cover.</li><li>Claims not confirmed by the required number of certified veterinarians.</li></>
              : <li>Losses not shown by the weather or vegetation reading for the plot (the policy pays on the reading, not on a field assessment).</li>}
            <li>Cause-of-death, vaccination and farming-practice exclusions of the standard NAIS contract are not applied automatically in this version.</li>
          </ul>
        </section>

        <section>
          <h3>{live ? "Schedule of livestock" : "Schedule of items"}</h3>
          <table className="pd-table"><thead><tr>{live
            ? <><th>Location</th><th>Tag number</th><th>Breed</th><th>Period from</th><th>Period to</th><th className="num">Sum insured</th></>
            : <><th>Crop</th><th>Variety</th><th>Insured area (ha)</th><th>Expected yield (t/ha)</th><th className="num">Premium</th><th className="num">Sum insured</th></>}</tr></thead>
            <tbody><tr>{live
              ? <><td>{val(a, "district_sector") || "-"}</td><td className="mono">{fromB32(p.asset.tagId)}</td><td>{fromB32(p.asset.breed)}</td><td>{d(p.start)}</td><td>{d(p.end)}</td><td className="num">{fmt(p.sumInsured)}</td></>
              : <><td>{fromB32(p.asset.crop)}</td><td>{val(a, "crop_variety") || "-"}</td><td>{ha.toLocaleString("en-US", { maximumFractionDigits: 2 })}</td><td>{val(a, "expected_yield") || "-"}</td><td className="num">{fmt(p.premium)}</td><td className="num">{fmt(p.sumInsured)}</td></>}</tr></tbody>
          </table>
        </section>

        <section>
          <h3>Claims and payouts</h3>
          {claims.length === 0 && !payout && <p className="muted">None.</p>}
          {claims.map((c) => <p key={c.id}>Claim #{c.id}: {["", "being checked", "approved", "rejected"][c.status]} ({c.approvals} of {c.quorum} confirmations){c.viaUssd ? ", reported by phone" : ""}.</p>)}
          {payout && <p>Paid RWF {fmt(payout.args.amount)} ({payout.args.automatic ? "automatic, weather trigger" : "veterinarian quorum"}) · ledger reference <span className="mono">{short(payout.tx)}</span>, block {payout.block}.</p>}
        </section>

        <section>
          <h3>Application and records</h3>
          <dl className="kv">
            <dt>Issued on the ledger</dt><dd>{purchase ? <>block {purchase.block} · reference <span className="mono">{short(purchase.tx)}</span></> : "-"}</dd>
            <dt>Application fingerprint</dt><dd className="mono">{rec?.anchoredHash && !/^0x0+$/.test(rec.anchoredHash) ? rec.anchoredHash : "Not recorded"}</dd>
            <dt>Record check</dt><dd>{rec?.record ? (rec.matchesLedger ? "Stored application matches the ledger" : "Does not match the ledger") : "No stored application"}</dd>
          </dl>
          {docs.length > 0 && (
            <table className="pd-table"><thead><tr><th>Document</th><th>Type</th><th>SHA-256</th><th className="no-print"></th></tr></thead><tbody>
              {docs.map((x) => <tr key={x.document}><td>{requirements.DOCUMENTS[x.document]?.label || x.document}</td><td>{x.mime}</td><td className="mono">{x.sha256.slice(0, 16)}…</td>
                <td className="no-print"><button className="btn sec sm" onClick={() => openDoc(x.document)}>Open</button></td></tr>)}
            </tbody></table>
          )}
        </section>
      </article>
    </>
  );
}
