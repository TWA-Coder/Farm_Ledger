"use client";
// Insurance agent: the farmers assigned to them (by district), recording a farmer's plot or cow, and the applications
// they submitted. The application form itself is views/application.js.
import { useState } from "react";
import validation from "../shared/validation";
import { Badge, Box, DataTable, Dialog, KV } from "../components/ui";
import { b32, hashOf, fmt, fromB32, short } from "../lib/chain";
import { COVER_PLAIN } from "../lib/format";
import { DISTRICTS, CROPS, BREEDS, plotLabel } from "./farmer";
import { appBadge, DecisionView } from "./desk";

export function AgentFarmers({ ctx, snap, run, busy, go, intent }) {
  const ag = snap.agent;
  const [open, setOpen] = useState(intent?.farmer || null);
  if (!ag) return <Box title="My farmers"><p className="muted">This account is not an insurance agent.</p></Box>;
  const farmer = ag.farmers.find((f) => f.address === open);
  return (
    <>
      <Box title="My farmers" sub={`Assigned to you because they registered in your districts: ${ag.districts.join(", ")}.${ag.active ? "" : " Your agent licence is suspended: you cannot submit applications."}`}>
        <DataTable rows={ag.farmers} pageSize={8} empty="No farmers are assigned to you yet." onRow={(f) => setOpen(f.address)} columns={[
          { key: "label", label: "Farmer", render: (f) => <span>{f.label}<br /><span className="muted mono">{short(f.address)}</span></span> },
          { key: "district", label: "District" },
          { key: "plots", label: "Plots", render: (f) => f.plots.length, sort: (f) => f.plots.length },
          { key: "animals", label: "Cattle", render: (f) => f.animals.filter((a) => !a.deceased).length, sort: (f) => f.animals.length },
          { key: "apps", label: "Applications", render: (f) => snap.applications.filter((a) => a.farmer === f.address).length },
        ]} />
      </Box>
      {farmer && <FarmerFile farmer={farmer} ctx={ctx} snap={snap} run={run} busy={busy} go={go} onClose={() => setOpen(null)} />}
    </>
  );
}

// One farmer: their plots and cattle, and recording new ones for them (signed by the agent through PolicyDesk).
function FarmerFile({ farmer, ctx, snap, run, busy, go, onClose }) {
  const { desk, ledger } = ctx;
  const [f, setF] = useState({ district: "Bugesera", lat: "-2.15", lon: "30.15", ha: "0.5", crop: "MAIZE", tag: "", breed: "FRIESIAN", year: String(new Date().getFullYear() - 3) });
  const [pe, setPe] = useState({});
  const [ae, setAe] = useState({});
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const pickDistrict = (name) => { const d = DISTRICTS.find((x) => x[0] === name); setF({ ...f, district: name, lat: String(d[1]), lon: String(d[2]) }); };
  const addPlot = () => {
    const e = validation.validatePlot(f); setPe(e);
    if (Object.keys(e).length) return;
    run(`Recording a plot for ${farmer.label}`, async () => (await desk.registerPlotFor(farmer.address, Math.round(Number(f.lat) * 1e6), Math.round(Number(f.lon) * 1e6), Math.round(Number(f.ha) * 10000), b32(f.crop), hashOf(`plot:${farmer.address}:${f.lat},${f.lon}:${f.ha}:${f.crop}`))).wait());
  };
  const addAnimal = async () => {
    const e = validation.validateAnimal(f); setAe(e);
    if (Object.keys(e).length) return;
    const tag = f.tag.trim().toUpperCase();
    if (Number(await ledger.animalIdByTag(b32(tag))) !== 0) { setAe({ tag: "This ear tag is already registered." }); return; }
    const ok = await run(`Recording a cow for ${farmer.label}`, async () => (await desk.registerAnimalFor(farmer.address, b32(tag), b32(f.breed), Number(f.year), hashOf(`animal:${tag}`))).wait());
    if (ok) setF((x) => ({ ...x, tag: "" }));
  };
  return (
    <Dialog title={farmer.label} sub={`${farmer.district} · ${farmer.address}`} onClose={onClose}
      actions={<><button className="btn sec" onClick={onClose}>Close</button><button className="btn" onClick={() => go("apply", { farmer: farmer.address })}>New application</button></>}>
      <h3 className="formhead">Plots</h3>
      {farmer.plots.length ? farmer.plots.map((p) => <div className="item" key={p.id}>{plotLabel(p)}</div>) : <p className="muted">None recorded.</p>}
      <div className="row">
        <div><label htmlFor="a-district">District</label><select id="a-district" value={f.district} onChange={(e) => pickDistrict(e.target.value)}>{DISTRICTS.map((d) => <option key={d[0]}>{d[0]}</option>)}</select></div>
        <div><label htmlFor="a-crop">Crop</label><select id="a-crop" value={f.crop} onChange={set("crop")}>{CROPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div><label htmlFor="a-ha">Size (ha)</label><input id="a-ha" type="number" min="0.01" step="0.01" value={f.ha} onChange={set("ha")} aria-invalid={Boolean(pe.ha)} /></div>
      </div>
      {(pe.ha || pe.lat || pe.lon) && <p className="upl-err" role="alert">{pe.ha || pe.lat || pe.lon}</p>}
      <button className="btn sm" disabled={busy} onClick={addPlot}>Record plot</button>
      <h3 className="formhead">Cattle</h3>
      {farmer.animals.length ? farmer.animals.map((a) => <div className="item" key={a.id}>{fromB32(a.tagId)} · {fromB32(a.breed)} · born {Number(a.birthYear)}{a.deceased ? " · died" : ""}</div>) : <p className="muted">None recorded.</p>}
      <div className="row">
        <div><label htmlFor="a-tag">Ear tag</label><input id="a-tag" value={f.tag} onChange={set("tag")} aria-invalid={Boolean(ae.tag)} /></div>
        <div><label htmlFor="a-breed">Breed</label><select id="a-breed" value={f.breed} onChange={set("breed")}>{BREEDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div><label htmlFor="a-year">Born</label><input id="a-year" type="number" value={f.year} onChange={set("year")} aria-invalid={Boolean(ae.year)} /></div>
      </div>
      {(ae.tag || ae.year) && <p className="upl-err" role="alert">{ae.tag || ae.year}</p>}
      <button className="btn sm" disabled={busy} onClick={addAnimal}>Record cow</button>
    </Dialog>
  );
}

export function AgentApplications({ ctx, snap, go }) {
  const [open, setOpen] = useState(null);
  const label = (addr) => snap.agent?.farmers.find((f) => f.address === addr)?.label || short(addr);
  const app = snap.applications.find((a) => a.id === open);
  return (
    <>
      <Box title="Applications" sub="Everything you submitted, and where it stands. You and the farmer get an SMS at each step." right={<button className="btn sm" onClick={() => go("apply")}>New application</button>}>
        <DataTable rows={snap.applications} pageSize={10} empty="No applications yet." onRow={(a) => setOpen(a.id)} initialSort={{ key: "id", dir: "desc" }} columns={[
          { key: "id", label: "#", render: (a) => `#${a.id}` },
          { key: "farmer", label: "Farmer", render: (a) => label(a.farmer), text: (a) => label(a.farmer) },
          { key: "cover", label: "Cover", render: (a) => COVER_PLAIN[Number(snap.products.find((p) => p.id === Number(a.productId))?.cover ?? 0)].name },
          { key: "sum", label: "Sum insured", render: (a) => `${fmt(a.sumInsured)} RWF`, sort: (a) => Number(a.sumInsured) },
          { key: "status", label: "Status", render: (a) => appBadge(a, snap.now), text: (a) => a.statusName },
        ]} />
      </Box>
      {app && <DecisionView app={app} ctx={ctx} snap={snap} onClose={() => setOpen(null)} />}
    </>
  );
}
