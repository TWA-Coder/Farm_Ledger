"use client";
import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import requirements from "../shared/requirements";
import validation from "../shared/validation";
import { Badge, Box, DataTable, Dialog, KV, Quorum, Stepper, Timeline } from "../components/ui";
import { UploadField } from "../components/upload";
import { POLICY_STATUS, b32, hashOf, fmt, fmtDate, fromB32, short } from "../lib/chain";
import { COVER_PLAIN, DAY, SOURCE_LABEL, cond, dateTime, farmerEventText, relevantEvents, sortedEvents, unit } from "../lib/format";
import { saveContact, uploadClaimEvidence, validateFile } from "../lib/documents";
import { ClaimDialog, claimBadge } from "./shared";

const POLICY_TONE = ["g", "a", "i", "n"]; // Active, ClaimPending, PaidOut, Expired
const TEST_FUNDS = 100000;

// District centres (approximate) so farmers do not have to type GPS coordinates. Exact GPS can still be entered.
const DISTRICTS = [
  ["Bugesera", -2.15, 30.15], ["Gatsibo", -1.58, 30.42], ["Huye", -2.6, 29.74], ["Kayonza", -1.9, 30.5],
  ["Kirehe", -2.27, 30.65], ["Muhanga", -2.08, 29.75], ["Musanze", -1.5, 29.63], ["Ngoma", -2.16, 30.47],
  ["Nyagatare", -1.3, 30.33], ["Nyanza", -2.35, 29.75], ["Rubavu", -1.7, 29.35], ["Rwamagana", -1.95, 30.43],
];
const CROPS = [["MAIZE", "Maize"], ["BEANS", "Beans"], ["RICE", "Rice"], ["IRISH_POTATO", "Irish potato"], ["CASSAVA", "Cassava"], ["SORGHUM", "Sorghum"], ["PASTURE", "Pasture"]];
const BREEDS = [["FRIESIAN", "Friesian"], ["JERSEY", "Jersey"], ["ANKOLE", "Ankole"], ["CROSSBREED", "Crossbreed"], ["OTHER", "Other"]];

const cropName = (b) => { const c = fromB32(b); return (CROPS.find((x) => x[0] === c) || [c, c.charAt(0) + c.slice(1).toLowerCase()])[1]; };
const ha = (m2) => (Number(m2) / 10000).toLocaleString("en-US", { maximumFractionDigits: 2 });
const nearestDistrict = (p) => {
  const lat = Number(p.latE6) / 1e6, lon = Number(p.lonE6) / 1e6;
  return DISTRICTS.reduce((best, d) => (Math.hypot(d[1] - lat, d[2] - lon) < Math.hypot(best[1] - lat, best[2] - lon) ? d : best))[0];
};
const plotLabel = (p) => `Plot #${p.id} · ${cropName(p.crop)}, ${ha(p.areaM2)} ha near ${nearestDistrict(p)}`;
const testFunds = (ctx, address, run) => run("Adding test money", async () => (await ctx.token.mint(address, TEST_FUNDS)).wait());

// ---------------------------------------------------------------- registration

function Register({ ctx, account, run, busy }) {
  const { ledger } = ctx;
  const [nid, setNid] = useState(account.nid || "");
  const [phone, setPhone] = useState(account.phone || "");
  const [errors, setErrors] = useState({});
  useEffect(() => { setNid(account.nid || ""); setPhone(account.phone || ""); setErrors({}); }, [account]);
  const submit = () => {
    const e = validation.validateRegistration(nid.trim(), phone.trim());
    setErrors(e);
    if (Object.keys(e).length) return;
    run("Registration", async () => {
      const rc = await (await ledger.registerFarmer(hashOf(nid.trim()), hashOf(phone.trim()))).wait();
      // SMS needs the plain number, which never goes on-chain. If this fails the registration still stands.
      try { await saveContact(ctx.signer, account.addr, phone.trim()); } catch (err) { return { receipt: rc, warning: `SMS notifications could not be set up: ${err.message}` }; }
      return rc;
    });
  };
  return (
    <Box title="Register with FarmLedger" sub="Step 1 of 4. We only need two things.">
      <div className="row">
        <div>
          <label htmlFor="nid">National ID number</label>
          <input id="nid" value={nid} onChange={(e) => setNid(e.target.value.replace(/\D/g, ""))} inputMode="numeric" maxLength={16} aria-invalid={Boolean(errors.nid)} />
          {errors.nid && <p className="upl-err" role="alert">{errors.nid}</p>}
        </div>
        <div>
          <label htmlFor="phone">Phone number for SMS and Mobile Money</label>
          <input id="phone" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} inputMode="numeric" maxLength={12} placeholder="250788123456" aria-invalid={Boolean(errors.phone)} />
          {errors.phone && <p className="upl-err" role="alert">{errors.phone}</p>}
        </div>
      </div>
      <p className="muted">Your ID and phone number are not stored on the public ledger. Only a coded fingerprint of each is recorded, so nobody can read them, but we can check them. One ID can register only once.</p>
      <button className="btn" disabled={busy} onClick={submit}>Register</button>
    </Box>
  );
}

// ---------------------------------------------------------------- home

export function Overview(p) {
  const { snap, address, account, go, ctx, run, busy } = p;
  if (!snap.farmer.exists) return <Register {...p} />;
  const assets = snap.plots.length + snap.animals.length;
  const active = snap.policies.filter((x) => Number(x.status) === 0);
  const pending = snap.policies.filter((x) => Number(x.status) === 1);
  const paid = snap.policies.filter((x) => Number(x.status) === 2);
  const recent = relevantEvents(snap, account, address).slice(0, 6);

  let next;
  if (!assets) next = { text: "Add the plot or animal you want to protect.", btn: "Add to my farm", to: "assets" };
  else if (!snap.policies.length) next = { text: "See which cover fits your farm and what it costs.", btn: "See cover options", to: "products" };
  else if (pending.length) next = { text: `Your claim on policy #${pending[0].id} is being checked by veterinarians.`, btn: "Track my claim", to: "policies" };
  else if (!active.length) next = { text: "You have no active cover at the moment. Choose new cover to keep your farm protected.", btn: "See cover options", to: "products" };
  else next = { text: `You have ${active.length} active polic${active.length === 1 ? "y" : "ies"}. You can check readings and status at any time.`, btn: "Policies and claims", to: "policies" };

  return (
    <>
      <div className="two">
        <Box title="Next step">
          <Stepper steps={[
            { label: "Register", state: "done" },
            { label: "Add farm", state: assets ? "done" : "cur" },
            { label: "Get cover", state: snap.policies.length ? "done" : assets ? "cur" : "" },
            { label: "Paid if loss", state: paid.length ? "done" : "" },
          ]} />
          <p>{next.text}</p>
          <button className="btn" onClick={() => go(next.to)}>{next.btn}</button>
        </Box>
        <Box title="Your account">
          <KV rows={[
            ["Balance", <b>{fmt(snap.balance)} RWF</b>],
            ["Active cover", `${active.length} polic${active.length === 1 ? "y" : "ies"}`],
            ["Claims being checked", pending.length],
            ["Payouts received", paid.length ? `${paid.length} · ${fmt(paid.reduce((a, x) => a + Number(x.sumInsured), 0))} RWF` : "None"],
          ]} />
          <p className="muted">This test version uses test money. You can add some to try the full journey.</p>
          <button className="btn sec sm" disabled={busy} onClick={() => testFunds(ctx, address, run)}>Add {fmt(TEST_FUNDS)} RWF test money</button>
        </Box>
      </div>
      <Box title="Recent activity">
        {recent.length === 0 ? <p className="muted">Nothing yet.</p> : <Timeline items={recent.map((e) => ({ text: farmerEventText(e) }))} />}
      </Box>
    </>
  );
}

// ---------------------------------------------------------------- farm (plots and animals)

function Readings({ plot, compact }) {
  const rows = [[0, "Rain, last 30 days"], [1, "Crop health (NDVI)"]].map(([m, label]) => {
    const r = plot.readings?.[m];
    if (!r) return [label, <span className="muted">No reading yet</span>];
    const src = SOURCE_LABEL[r.source] || SOURCE_LABEL.test;
    return [label, <>
      <b>{unit(m === 1 ? 2 : 0, r.value)}</b> <span className="muted">· {dateTime(r.observedAt)}</span>{" "}
      <Badge tone={src.real ? "g" : "a"}>{src.real ? "Real data" : "Sample data"}</Badge>
      {!compact && <div className="muted">{src.text}</div>}
    </>];
  });
  return <KV rows={rows} />;
}

export function Assets({ ctx, snap, run, busy }) {
  const { ledger } = ctx;
  const [f, setF] = useState({ district: "Bugesera", lat: "-2.15", lon: "30.15", exact: false, ha: "0.5", crop: "MAIZE", tag: "", breed: "FRIESIAN", year: String(new Date().getFullYear() - 3) });
  const [pe, setPe] = useState({});
  const [ae, setAe] = useState({});
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const pickDistrict = (name) => { const d = DISTRICTS.find((x) => x[0] === name); setF({ ...f, district: name, lat: String(d[1]), lon: String(d[2]) }); };
  if (!snap.farmer.exists) return <div className="callout">Register first on the Home page.</div>;

  const addPlot = () => {
    const e = validation.validatePlot(f); setPe(e);
    if (Object.keys(e).length) return;
    run("Adding the plot", async () => (await ledger.registerPlot(Math.round(Number(f.lat) * 1e6), Math.round(Number(f.lon) * 1e6), Math.round(Number(f.ha) * 10000), b32(f.crop), hashOf(`plot:${f.lat},${f.lon}:${f.ha}:${f.crop}`))).wait());
  };
  const addAnimal = async () => {
    const e = validation.validateAnimal(f); setAe(e);
    if (Object.keys(e).length) return;
    const tag = f.tag.trim().toUpperCase();
    if (Number(await ledger.animalIdByTag(b32(tag))) !== 0) { setAe({ tag: "This ear tag is already registered. Each animal can be registered only once." }); return; }
    const ok = await run("Adding the animal", async () => (await ledger.registerAnimal(b32(tag), b32(f.breed), Number(f.year), hashOf(`animal:${tag}`))).wait());
    if (ok) setF((x) => ({ ...x, tag: "" }));
  };

  return (
    <div className="two">
      <Box title="My plots" sub="Crop cover uses weather and satellite readings for the plot's location.">
        {snap.plots.length === 0 && <p className="muted">No plots yet.</p>}
        {snap.plots.map((p) => (
          <div className="item" key={p.id}>
            <b>{plotLabel(p)}</b>
            <Readings plot={p} compact />
          </div>
        ))}
        <h3 className="formhead">Add a plot</h3>
        <div className="row">
          <div><label htmlFor="district">District</label>
            <select id="district" value={f.district} onChange={(e) => pickDistrict(e.target.value)} disabled={f.exact}>{DISTRICTS.map((d) => <option key={d[0]}>{d[0]}</option>)}</select></div>
          <div><label htmlFor="crop">Crop</label>
            <select id="crop" value={f.crop} onChange={set("crop")}>{CROPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          <div><label htmlFor="ha">Size (hectares)</label>
            <input id="ha" type="number" min="0.01" step="0.01" inputMode="decimal" value={f.ha} onChange={set("ha")} aria-invalid={Boolean(pe.ha)} /></div>
        </div>
        {pe.ha && <p className="upl-err" role="alert">{pe.ha}</p>}
        <label className="check"><input type="checkbox" checked={f.exact} onChange={(e) => setF({ ...f, exact: e.target.checked })} /> I know the exact GPS location of the plot</label>
        {f.exact
          ? <div className="row">
            <div><label htmlFor="lat">Latitude</label><input id="lat" inputMode="decimal" value={f.lat} onChange={set("lat")} aria-invalid={Boolean(pe.lat)} /></div>
            <div><label htmlFor="lon">Longitude</label><input id="lon" inputMode="decimal" value={f.lon} onChange={set("lon")} aria-invalid={Boolean(pe.lon)} /></div>
          </div>
          : <p className="muted">The plot will use the centre of {f.district} district for weather readings. An exact location gives more accurate readings.</p>}
        {(pe.lat || pe.lon) && <p className="upl-err" role="alert">{pe.lat || pe.lon}</p>}
        <button className="btn" disabled={busy} onClick={addPlot}>Add plot</button>
      </Box>

      <Box title="My cattle" sub="Each ear tag can be registered only once, so the same cow cannot be insured twice.">
        <DataTable rows={snap.animals} pageSize={5} empty="No animals yet." columns={[
          { key: "tag", label: "Ear tag", render: (a) => fromB32(a.tagId), text: (a) => fromB32(a.tagId), sort: (a) => fromB32(a.tagId) },
          { key: "breed", label: "Breed", render: (a) => (BREEDS.find((b) => b[0] === fromB32(a.breed)) || [0, fromB32(a.breed)])[1], text: (a) => fromB32(a.breed) },
          { key: "birthYear", label: "Born", render: (a) => Number(a.birthYear) },
          { key: "deceased", label: "Status", render: (a) => (a.deceased ? <Badge tone="r">Died</Badge> : <Badge tone="g">Alive</Badge>), text: (a) => (a.deceased ? "died" : "alive") },
        ]} />
        <h3 className="formhead">Add an animal</h3>
        <label htmlFor="tag">Ear tag (RFID) number</label>
        <input id="tag" value={f.tag} onChange={set("tag")} placeholder="e.g. 990000015066386" aria-invalid={Boolean(ae.tag)} />
        {ae.tag && <p className="upl-err" role="alert">{ae.tag}</p>}
        <div className="row">
          <div><label htmlFor="breed">Breed</label><select id="breed" value={f.breed} onChange={set("breed")}>{BREEDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          <div><label htmlFor="year">Year of birth</label><input id="year" type="number" inputMode="numeric" value={f.year} onChange={set("year")} aria-invalid={Boolean(ae.year)} /></div>
        </div>
        {ae.year && <p className="upl-err" role="alert">{ae.year}</p>}
        <p><button className="btn" disabled={busy} onClick={addAnimal}>Add animal</button></p>
      </Box>
    </div>
  );
}

// ---------------------------------------------------------------- policies, monitoring, claims, payouts

function policySteps(p, claim, prod) {
  const st = Number(p.status);
  const live = prod && Number(prod.cover) === 3;
  return [
    { label: "Paid", state: "done" },
    { label: "Covered", state: st === 0 ? "cur" : "done" },
    { label: live ? (claim && claim.status !== 3 ? `Vets ${claim.approvals}/${claim.quorum}` : "Claim") : "Weather check", state: st === 1 ? "cur" : st === 2 ? "done" : "" },
    { label: st === 3 ? "Ended" : "Paid out", state: st === 2 ? "done" : st === 3 ? "bad" : "" },
  ];
}

function nextLine(p, prod, claim, snap) {
  const st = Number(p.status);
  const live = Number(prod?.cover) === 3;
  if (st === 2) return "This policy has paid out. It is now closed.";
  if (st === 3) return "This policy ended without a payout.";
  if (st === 1) return `Certified veterinarians are checking your claim: ${claim?.approvals || 0} of ${claim?.quorum || snap.vetQuorum} confirmations so far. You will get an SMS when it is decided.`;
  if (snap.now > Number(p.end)) return "The cover period is over. You can close the policy.";
  return live
    ? "You are covered. If the animal dies, report it here with a photo, or by phone (USSD)."
    : "You are covered. You do not need to do anything: if a weather reading meets the terms, you are paid automatically.";
}

function ReportDeath({ ctx, snap, address, policy, run, busy, onClose }) {
  const [file, setFile] = useState(null);
  const [err, setErr] = useState(null);
  const [sure, setSure] = useState(false);
  const def = { id: "claim_photo", ...requirements.DOCUMENTS.claim_photo };
  const pick = async (f) => { const e = await validateFile(f); setErr(e); setFile(e ? null : f); };
  const submit = async () => {
    if (!file) { setErr("A photo is required."); return; }
    if (!sure) { setErr("Please confirm the statement below."); return; }
    const ok = await run("Reporting the death", async () => {
      const evidenceHash = await uploadClaimEvidence(ctx.signer, address, policy.id, file);
      return (await ctx.ledger.fileClaim(policy.id, evidenceHash)).wait();
    });
    if (ok) onClose();
  };
  return (
    <Dialog title="Report the death of an insured animal" sub={`${snap.vetQuorum} certified veterinarian${snap.vetQuorum > 1 ? "s" : ""} will check the claim. When enough of them confirm, you are paid ${fmt(policy.sumInsured)} RWF.`} onClose={onClose}
      actions={<><button className="btn sec" onClick={onClose}>Cancel</button><button className="btn dng" disabled={busy} onClick={submit}>Send the claim</button></>}>
      <UploadField def={def} item={{ file, error: err }} disabled={busy} onPick={pick} onRemove={() => setFile(null)} onViewStored={() => {}} />
      <label className="check"><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> The information is true. I understand that false claims are a crime under Rwandan law and are visible on the public record.</label>
    </Dialog>
  );
}

function PayoutInfo({ snap, policy }) {
  const ev = snap.events.find((e) => e.name === "PayoutExecuted" && Number(e.args.policyId) === policy.id);
  if (!ev) return null;
  return (
    <div className="callout ok">
      <b>Paid {fmt(ev.args.amount)} RWF</b> to your FarmLedger balance, because {ev.args.automatic ? "a weather reading met the policy terms" : "the veterinarians confirmed the claim"}.
      <div className="muted">Reference <span className="mono" title={ev.tx}>{short(ev.tx)}</span> · block {ev.block}. In this test version the Mobile Money transfer and the SMS are simulated by the notifier service; no real money moves.</div>
    </div>
  );
}

export function Policies(p) {
  const { ctx, snap, run, busy, go } = p;
  const { ledger } = ctx;
  const [open, setOpen] = useState(null);
  const [claimOpen, setClaimOpen] = useState(null);
  const [report, setReport] = useState(false);
  const prodOf = (x) => snap.products.find((y) => y.id === Number(x.productId));
  const claimOf = (x) => snap.claims.find((c) => Number(c.policyId) === x.id && c.status !== 3) || snap.claims.find((c) => Number(c.policyId) === x.id);
  const rows = useMemo(() => [...snap.policies].reverse(), [snap.policies]);
  const sel = open && snap.policies.find((x) => x.id === open);
  const selProd = sel && prodOf(sel);
  const selClaim = sel && claimOf(sel);
  const ended = (x) => Number(x.status) === 0 && snap.now > Number(x.end);
  const isLive = selProd && Number(selProd.cover) === 3;
  const waitUntil = sel ? Number(sel.start) + Number(snap.waiting) : 0;
  const plot = sel && !isLive && snap.plots.find((x) => x.id === Number(sel.assetId));
  const animal = sel && isLive && snap.animals.find((x) => x.id === Number(sel.assetId));

  const timeline = sel && sortedEvents(snap.events.filter((e) => Number(e.args.policyId) === sel.id || (selClaim && Number(e.args.claimId) === selClaim.id && ["ClaimAttested", "ClaimSettled", "ClaimChannel"].includes(e.name))))
    .reverse().map((e) => ({ text: farmerEventText(e), meta: dateTimeOfBlock(e, snap), bad: (e.name === "ClaimAttested" && !e.args.approved) || (e.name === "ClaimSettled" && !e.args.approved) }));

  return (
    <>
      <Box title="Policies and claims" sub="Choose a policy to see its status, the latest readings and its history.">
        {snap.policies.length === 0 && <p><button className="btn" onClick={() => go("products")}>See cover options</button></p>}
        <DataTable rows={rows} empty="You have no policies yet." onRow={(x) => setOpen(x.id)}
          filters={POLICY_STATUS.map((l, i) => ({ value: String(i), label: l }))} filterFn={(x, f) => String(Number(x.status)) === f}
          initialSort={{ key: "id", dir: "desc" }}
          columns={[
            { key: "id", label: "Policy", render: (x) => `#${x.id}`, sort: (x) => x.id },
            { key: "cover", label: "Cover", render: (x) => COVER_PLAIN[Number(prodOf(x)?.cover)]?.name, text: (x) => COVER_PLAIN[Number(prodOf(x)?.cover)]?.name },
            { key: "sumInsured", label: "Amount insured", render: (x) => `${fmt(x.sumInsured)} RWF`, sort: (x) => Number(x.sumInsured) },
            { key: "end", label: "Covered until", render: (x) => <>{fmtDate(x.end)}{ended(x) ? <span className="pill u">Ended</span> : Number(x.status) === 0 && Number(x.end) - snap.now < 14 * DAY ? <span className="pill u">Ends soon</span> : null}</>, sort: (x) => Number(x.end), text: (x) => fmtDate(x.end) },
            { key: "status", label: "Status", render: (x) => <Badge tone={POLICY_TONE[Number(x.status)]}>{POLICY_STATUS[Number(x.status)]}</Badge>, sort: (x) => Number(x.status), text: (x) => POLICY_STATUS[Number(x.status)] },
          ]} />
      </Box>

      {sel && !report && (
        <Dialog title={`Policy #${sel.id} · ${COVER_PLAIN[Number(selProd?.cover)]?.name}`} sub={`Covered ${fmtDate(sel.start)} to ${fmtDate(sel.end)}`} onClose={() => setOpen(null)}
          actions={<>
            {isLive && Number(sel.status) === 0 && !ended(sel) && snap.now >= waitUntil && <button className="btn dng" disabled={busy} onClick={() => setReport(true)}>Report a death</button>}
            {ended(sel) && <button className="btn sec" disabled={busy} onClick={() => run("Closing the policy", async () => { const rc = await (await ledger.expirePolicy(sel.id)).wait(); setOpen(null); return rc; })}>Close ended policy</button>}
            {selClaim && <button className="btn sec" onClick={() => setClaimOpen(selClaim)}>Claim #{selClaim.id} details</button>}
            <button className="btn sec" onClick={() => setOpen(null)}>Close</button></>}>
          <Stepper steps={policySteps(sel, selClaim, selProd)} />
          <p>{nextLine(sel, selProd, selClaim, snap)}</p>
          {isLive && Number(sel.status) === 0 && snap.now < waitUntil && <div className="callout">You can report a death from {dateTime(waitUntil)} (waiting period after buying cover).</div>}
          <PayoutInfo snap={snap} policy={sel} />
          <KV rows={[
            ["Insured", plot ? plotLabel(plot) : animal ? `Animal ${fromB32(animal.tagId)}` : `#${sel.assetId}`],
            ["Pays when", selProd && cond(selProd.cover, sel.threshold ?? selProd.threshold)],
            ["Amount insured", `${fmt(sel.sumInsured)} RWF`],
            ["Premium paid", `${fmt(sel.premium)} RWF`],
            ["Application", sel.appHash && sel.appHash !== ethers.ZeroHash ? "Documents on file, fingerprint recorded with the policy" : <span className="muted">No application record</span>],
            ...(selClaim ? [["Claim", <>#{selClaim.id} {claimBadge(selClaim)} <Quorum approvals={selClaim.approvals} rejections={selClaim.rejections} needed={selClaim.quorum} /></>]] : []),
          ]} />
          {plot && <><h2 className="formhead">Latest readings for this plot</h2><Readings plot={plot} /></>}
          <h2 className="formhead">History</h2>
          <Timeline items={timeline} />
        </Dialog>
      )}

      {report && sel && <ReportDeath {...p} policy={sel} onClose={() => setReport(false)} />}
      {claimOpen && <ClaimDialog snap={snap} claim={claimOpen} viewer={{ signer: ctx.signer, address: p.address }} onClose={() => setClaimOpen(null)} />}
    </>
  );
}

// Events carry block numbers only; show the reading time when the event has one.
function dateTimeOfBlock(e, snap) {
  if (e.name === "PolicyPurchased") return dateTime(e.args.start);
  return "block " + e.block;
}
