"use client";
import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { Badge, Box, DataTable, Dialog, KV, Quorum, Stat, Stepper, Timeline } from "../components/ui";
import { COVER, POLICY_STATUS, b32, hashOf, fmt, fmtDate, fromB32 } from "../lib/chain";
import { DAY, cond, eventText, relevantEvents, sortedEvents } from "../lib/format";
import { ClaimDialog, claimBadge } from "./shared";

const POLICY_TONE = ["g", "a", "i", "n"]; // Active, ClaimPending, PaidOut, Expired

function Register({ ctx, address, account, run, busy }) {
  const { ledger, token } = ctx;
  const [nid, setNid] = useState(account.nid || "");
  const [phone, setPhone] = useState(account.phone || "");
  useEffect(() => { setNid(account.nid || ""); setPhone(account.phone || ""); }, [account]);
  return (
    <Box title="Register as a farmer" sub="Your National ID and phone number are hashed in this browser; only the hashes go on-chain.">
      <div className="row">
        <div><label>National ID</label><input value={nid} onChange={(e) => setNid(e.target.value)} inputMode="numeric" /></div>
        <div><label>Mobile Money phone (250…)</label><input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="numeric" /></div>
      </div>
      <p>
        <button className="btn" disabled={busy || !nid || !phone} onClick={() => run("Registration", async () => (await ledger.registerFarmer(hashOf(nid), hashOf(phone))).wait())}>Register</button>{" "}
        <button className="btn sec" disabled={busy} onClick={() => run("Faucet", async () => (await token.mint(address, 100000)).wait())}>Add 100,000 test funds</button>
      </p>
    </Box>
  );
}

export function Overview(p) {
  const { snap, address, account, go, ctx, run, busy } = p;
  if (!snap.farmer.exists) return <Register {...p} />;
  const active = snap.policies.filter((x) => Number(x.status) === 0);
  const pending = snap.policies.filter((x) => Number(x.status) === 1);
  const paid = snap.policies.filter((x) => Number(x.status) === 2).reduce((a, x) => a + Number(x.sumInsured), 0);
  const recent = relevantEvents(snap, account, address).slice(0, 6);
  return (
    <>
      <div className="strip">
        <Stat tone="hi" value={`${fmt(snap.balance)} RWF`} label="Wallet balance" />
        <Stat value={active.length} label="Active policies" />
        <Stat tone={pending.length ? "warn" : ""} value={pending.length} label="Claims in review" />
        <Stat value={`${fmt(paid)} RWF`} label="Paid out to you" />
      </div>
      <div className="two">
        <Box title="Getting started" sub="Register what you want to protect, apply for cover, and payouts follow the policy terms.">
          <Stepper steps={[
            { label: "Register", state: "done" },
            { label: "Add plot / cow", state: snap.plots.length + snap.animals.length ? "done" : "cur" },
            { label: "Apply for cover", state: snap.policies.length ? "done" : snap.plots.length + snap.animals.length ? "cur" : "" },
            { label: "Get paid", state: paid ? "done" : "" },
          ]} />
          <div className="row">
            <button className="btn sec" onClick={() => go("assets")}>Plots and cattle</button>
            <button className="btn" onClick={() => go("buy")}>New application</button>
            <button className="btn sec" disabled={busy} onClick={() => run("Faucet", async () => (await ctx.token.mint(address, 100000)).wait())}>Add test funds</button>
          </div>
        </Box>
        <Box title="Recent activity">
          {recent.length === 0 ? <p className="muted">Nothing yet.</p> : <Timeline items={recent.map((e) => ({ text: eventText(e), meta: "block " + e.block }))} />}
        </Box>
      </div>
    </>
  );
}

export function Assets({ ctx, snap, run, busy }) {
  const { ledger } = ctx;
  const [f, setF] = useState({ lat: "-2.15", lon: "30.15", area: "5000", crop: "MAIZE", tag: "", breed: "FRIESIAN", year: "2022" });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  if (!snap.farmer.exists) return <div className="callout">Register first (Overview).</div>;
  return (
    <div className="two">
      <Box title="My plots" sub="Crop cover is checked against satellite rainfall and vegetation data for the plot's location.">
        <DataTable rows={snap.plots} pageSize={5} empty="No plots yet." columns={[
          { key: "id", label: "#", render: (p) => `#${p.id}` },
          { key: "crop", label: "Crop", render: (p) => fromB32(p.crop), text: (p) => fromB32(p.crop), sort: (p) => fromB32(p.crop) },
          { key: "areaM2", label: "Area", render: (p) => `${fmt(p.areaM2)} m²`, sort: (p) => Number(p.areaM2) },
          { key: "loc", label: "Location", render: (p) => <span className="muted">{(Number(p.latE6) / 1e6).toFixed(3)}, {(Number(p.lonE6) / 1e6).toFixed(3)}</span>, text: () => "" },
        ]} />
        <h2 style={{ fontSize: 14, marginTop: 14 }}>Add a plot</h2>
        <div className="row"><div><label>Latitude</label><input value={f.lat} onChange={set("lat")} /></div><div><label>Longitude</label><input value={f.lon} onChange={set("lon")} /></div></div>
        <div className="row"><div><label>Area (m²)</label><input type="number" value={f.area} onChange={set("area")} /></div>
          <div><label>Crop</label><select value={f.crop} onChange={set("crop")}><option>MAIZE</option><option>BEANS</option><option>PASTURE</option></select></div></div>
        <p><button className="btn" disabled={busy} onClick={() => run("Plot registration", async () =>
          (await ledger.registerPlot(Math.round(Number(f.lat) * 1e6), Math.round(Number(f.lon) * 1e6), Number(f.area), b32(f.crop), hashOf(`geojson:${f.lat},${f.lon}:${Date.now()}`))).wait())}>Add plot</button></p>
      </Box>
      <Box title="My cattle" sub="Each ear tag can be registered once in the whole system, which stops double-insuring the same cow.">
        <DataTable rows={snap.animals} pageSize={5} empty="No animals yet." columns={[
          { key: "tag", label: "Ear tag", render: (a) => fromB32(a.tagId), text: (a) => fromB32(a.tagId), sort: (a) => fromB32(a.tagId) },
          { key: "breed", label: "Breed", render: (a) => fromB32(a.breed), text: (a) => fromB32(a.breed) },
          { key: "birthYear", label: "Born", render: (a) => Number(a.birthYear) },
          { key: "deceased", label: "Status", render: (a) => (a.deceased ? <Badge tone="r">Deceased</Badge> : <Badge tone="g">Alive</Badge>), text: (a) => (a.deceased ? "deceased" : "alive") },
        ]} />
        <h2 style={{ fontSize: 14, marginTop: 14 }}>Add an animal</h2>
        <label>Ear-tag ID (RFID)</label><input value={f.tag} onChange={set("tag")} placeholder="RW-TAG-0100" />
        <div className="row"><div><label>Breed</label><input value={f.breed} onChange={set("breed")} /></div><div><label>Birth year</label><input type="number" value={f.year} onChange={set("year")} /></div></div>
        <p><button className="btn" disabled={busy || !f.tag} onClick={() => run("Animal registration", async () =>
          (await ledger.registerAnimal(b32(f.tag), b32(f.breed), Number(f.year), hashOf(`photo:${f.tag}`))).wait())}>Add animal</button></p>
      </Box>
    </div>
  );
}

function policySteps(p, claim, prod) {
  const st = Number(p.status);
  const live = prod && Number(prod.cover) === 3;
  return [
    { label: "Bought", state: "done" },
    { label: "Cover active", state: st === 0 ? "cur" : "done" },
    { label: live ? (claim ? `Vet signatures ${claim.approvals}/${claim.quorum}` : "Claim") : "Trigger", state: st === 1 ? "cur" : st === 2 ? "done" : "" },
    { label: st === 3 ? "Expired" : "Paid out", state: st === 2 ? "done" : st === 3 ? "bad" : "" },
  ];
}

export function Policies({ ctx, snap, address, run, busy }) {
  const { ledger } = ctx;
  const [open, setOpen] = useState(null);
  const [claimOpen, setClaimOpen] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const prodOf = (p) => snap.products.find((x) => x.id === Number(p.productId));
  const claimOf = (p) => snap.claims.find((c) => Number(c.policyId) === p.id && c.status !== 3) || snap.claims.find((c) => Number(c.policyId) === p.id);
  const rows = useMemo(() => [...snap.policies].reverse(), [snap.policies]);
  const sel = open && snap.policies.find((p) => p.id === open);
  const selProd = sel && prodOf(sel);
  const selClaim = sel && claimOf(sel);
  const expiredOpen = (p) => Number(p.status) === 0 && snap.now > Number(p.end);

  const timeline = sel && sortedEvents(snap.events.filter((e) => Number(e.args.policyId) === sel.id)).reverse().map((e) => ({ text: eventText(e), meta: "block " + e.block }));
  return (
    <>
      <Box title="My policies" sub="Click a policy to see its progress and history.">
        <DataTable rows={rows} empty="No policies yet. Buy cover to get started." onRow={(p) => setOpen(p.id)}
          filters={POLICY_STATUS.map((l, i) => ({ value: String(i), label: l }))} filterFn={(p, f) => String(Number(p.status)) === f}
          initialSort={{ key: "id", dir: "desc" }}
          columns={[
            { key: "id", label: "Policy", render: (p) => `#${p.id}`, sort: (p) => p.id },
            { key: "cover", label: "Cover", render: (p) => COVER[Number(prodOf(p)?.cover)], text: (p) => COVER[Number(prodOf(p)?.cover)] },
            { key: "sumInsured", label: "Sum insured", render: (p) => `${fmt(p.sumInsured)} RWF`, sort: (p) => Number(p.sumInsured) },
            { key: "end", label: "Valid until", render: (p) => <>{fmtDate(p.end)}{expiredOpen(p) ? <span className="pill u">Overdue</span> : Number(p.status) === 0 && Number(p.end) - snap.now < 14 * DAY ? <span className="pill u">Expiring</span> : null}</>, sort: (p) => Number(p.end), text: (p) => fmtDate(p.end) },
            { key: "status", label: "Status", render: (p) => <Badge tone={POLICY_TONE[Number(p.status)]}>{POLICY_STATUS[Number(p.status)]}</Badge>, sort: (p) => Number(p.status), text: (p) => POLICY_STATUS[Number(p.status)] },
          ]} />
      </Box>

      {sel && (
        <Dialog title={`Policy #${sel.id} · ${COVER[Number(selProd?.cover)]}`} sub={`${fmtDate(sel.start)} → ${fmtDate(sel.end)}`} onClose={() => setOpen(null)}
          actions={<>
            {selProd && Number(selProd.cover) === 3 && Number(sel.status) === 0 && !expiredOpen(sel) && <button className="btn dng" disabled={busy} onClick={() => setConfirm("claim")}>Report animal death</button>}
            {expiredOpen(sel) && <button className="btn sec" disabled={busy} onClick={() => run("Close policy", async () => { await (await ledger.expirePolicy(sel.id)).wait(); setOpen(null); })}>Close expired policy</button>}
            {selClaim && <button className="btn sec" onClick={() => setClaimOpen(selClaim)}>View claim #{selClaim.id}</button>}
            <button className="btn sec" onClick={() => setOpen(null)}>Close</button></>}>
          <Stepper steps={policySteps(sel, selClaim, selProd)} />
          <KV rows={[
            ["Status", <Badge tone={POLICY_TONE[Number(sel.status)]}>{POLICY_STATUS[Number(sel.status)]}</Badge>],
            ["Pays when", selProd && cond(selProd.cover, selProd.threshold)],
            ["Sum insured", `${fmt(sel.sumInsured)} RWF`],
            ["Premium paid", `${fmt(sel.premium)} RWF`],
            ["Application record", sel.appHash && sel.appHash !== ethers.ZeroHash ? <span title={sel.appHash}>Anchored · {sel.appHash.slice(0, 10)}…</span> : <span className="muted">Not recorded</span>],
            ...(selClaim ? [["Claim", <>#{selClaim.id} {claimBadge(selClaim)} <Quorum approvals={selClaim.approvals} rejections={selClaim.rejections} needed={selClaim.quorum} /></>]] : []),
          ]} />
          <h2 style={{ fontSize: 14, margin: "12px 0 4px" }}>History</h2>
          <Timeline items={timeline} />
        </Dialog>
      )}

      {confirm === "claim" && sel && (
        <Dialog title="Report this animal's death?" sub={`Certified vets will each review and sign. ${snap.vetQuorum} signature${snap.vetQuorum > 1 ? "s are" : " is"} needed before you are paid. False reports are visible on the public audit trail.`} onClose={() => setConfirm(null)}
          actions={<>
            <button className="btn sec" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn dng" disabled={busy} onClick={async () => {
              setConfirm(null);
              await run("Claim", async () => (await ledger.fileClaim(sel.id, hashOf(`photo-of-deceased-animal:${sel.assetId}:${Date.now()}`))).wait());
            }}>Yes, file the claim</button></>} />
      )}
      {claimOpen && <ClaimDialog snap={snap} claim={claimOpen} onClose={() => setClaimOpen(null)} />}
    </>
  );
}
