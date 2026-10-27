"use client";
import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { Badge, Box, DataTable, Dialog, KV, Stat, Timeline } from "../components/ui";
import { DEMO_ACCOUNTS, b32, fmt, fromB32, hashOf, short } from "../lib/chain";
import { DAY, dateTime, eventText, nameOf, relevantEvents } from "../lib/format";

const vetState = (v) => (v.certified ? ["g", "Certified"] : v.active ? ["a", "Expired"] : ["r", "Revoked"]);

export function AdminOverview({ snap, account, address, go }) {
  const certified = snap.vets.filter((v) => v.certified).length;
  const recent = relevantEvents(snap, account, address).slice(0, 6);
  return (
    <>
      {snap.vetQuorum > certified && <div className="callout err"><b>Quorum cannot be reached.</b> {snap.vetQuorum} signatures are required but only {certified} vet{certified === 1 ? " is" : "s are"} certified. New livestock claims would stay pending.</div>}
      <div className="strip">
        <Stat tone="hi" value={certified} label="Certified vets" />
        <Stat value={`${snap.vetQuorum}-of-${certified}`} label="Claim quorum" />
        <Stat tone={snap.paused ? "warn" : ""} value={snap.paused ? "Paused" : "Running"} label="System state" />
        <Stat value={snap.claims.filter((c) => c.status === 1).length} label="Open livestock claims" />
      </div>
      <div className="two">
        <Box title="Administration"><div className="row"><button className="btn" onClick={() => go("vets")}>Manage vets</button><button className="btn sec" onClick={() => go("access")}>Access control</button><button className="btn sec" onClick={() => go("gov")}>Governance</button></div></Box>
        <Box title="Recent activity">{recent.length === 0 ? <p className="muted">Nothing yet.</p> : <Timeline items={recent.map((e) => ({ text: eventText(e), meta: "block " + e.block }))} />}</Box>
      </div>
    </>
  );
}

export function AdminVets({ ctx, snap, run, busy }) {
  const { ledger } = ctx;
  const [f, setF] = useState({ addr: "", lic: "", sector: "BUGESERA", months: 12 });
  const [target, setTarget] = useState(null); // {vet, action}
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  // validUntil is measured from the later of chain time and browser time (demo time-travel moves the chain ahead)
  const certifyRaw = (addr, licenseHash, sector32, months) => run("Vet certified", async () => {
    const base = Math.max(snap.now, Math.floor(Date.now() / 1000));
    await (await ledger.certifyVet(addr, licenseHash, sector32, base + Math.round(Number(months) * 30 * DAY))).wait();
  });
  const certify = (addr, lic, sector, months) => certifyRaw(addr, hashOf("licence:" + lic), b32(sector.toUpperCase()), months);
  return (
    <>
      <Box title="Certified veterinarians" sub="A vet's signature counts only while the record below is active and unexpired. Revoking takes effect immediately.">
        <DataTable rows={snap.vets.map((v) => ({ ...v, id: v.address }))} empty="No vets certified yet." pageSize={6} initialSort={{ key: "validUntil", dir: "asc" }}
          filters={[{ value: "g", label: "Certified" }, { value: "a", label: "Expired" }, { value: "r", label: "Revoked" }]} filterFn={(v, f2) => vetState(v)[0] === f2}
          columns={[
            { key: "name", label: "Vet", render: (v) => <><b>{nameOf(v.address)}</b><div className="muted">{short(v.address)}</div></>, text: (v) => nameOf(v.address) + v.address },
            { key: "sector", label: "Sector", render: (v) => fromB32(v.sector), text: (v) => fromB32(v.sector) },
            { key: "licenseHash", label: "Licence hash", render: (v) => <span className="muted">{short(v.licenseHash)}</span>, text: () => "" },
            { key: "validUntil", label: "Valid until", render: (v) => dateTime(v.validUntil), sort: (v) => Number(v.validUntil), text: (v) => dateTime(v.validUntil) },
            { key: "state", label: "Status", render: (v) => <Badge tone={vetState(v)[0]}>{vetState(v)[1]}</Badge>, text: (v) => vetState(v)[1] },
            { key: "act", label: "", text: () => "", render: (v) => (
              <span style={{ display: "flex", gap: 6 }}>
                <button className="btn sec sm" disabled={busy} onClick={() => certifyRaw(v.address, v.licenseHash, v.sector, 12)}>Renew</button>
                {v.active && <button className="btn dng sm" disabled={busy} onClick={() => setTarget({ vet: v })}>Revoke</button>}
              </span>) },
          ]} />
      </Box>
      <div className="two">
        <Box title="Certify a veterinarian" sub="Records the licence and grants the vet role in one transaction. The licence number is hashed in your browser; only the hash is stored.">
          <label>Wallet address</label>
          <input value={f.addr} onChange={set("addr")} placeholder="0x…" list="demo-addrs" />
          <datalist id="demo-addrs">{DEMO_ACCOUNTS.map((a) => <option key={a.key} value={a.addr}>{a.label}</option>)}</datalist>
          <div className="row">
            <div><label>Licence number</label><input value={f.lic} onChange={set("lic")} placeholder="RVC-LIC-004" /></div>
            <div><label>Sector served</label><input value={f.sector} onChange={set("sector")} /></div>
            <div><label>Valid for (months)</label><input type="number" min="1" value={f.months} onChange={set("months")} /></div>
          </div>
          <p><button className="btn" disabled={busy || !ethers.isAddress(f.addr) || !f.lic || !f.sector} onClick={() => certify(f.addr, f.lic, f.sector, f.months)}>Certify</button></p>
        </Box>
        <QuorumBox ctx={ctx} snap={snap} run={run} busy={busy} />
      </div>
      {target && (
        <Dialog title={`Revoke ${nameOf(target.vet.address)}?`} sub="Their signatures stop counting immediately. Signatures already recorded on open claims stay on the record." onClose={() => setTarget(null)}
          actions={<><button className="btn sec" onClick={() => setTarget(null)}>Cancel</button>
            <button className="btn dng" onClick={async () => { const a = target.vet.address; setTarget(null); await run("Vet revoked", async () => (await ledger.revokeVet(a)).wait()); }}>Revoke</button></>} />
      )}
    </>
  );
}

function QuorumBox({ ctx, snap, run, busy }) {
  const [q, setQ] = useState(snap.vetQuorum);
  useEffect(() => setQ(snap.vetQuorum), [snap.vetQuorum]);
  const certified = snap.vets.filter((v) => v.certified).length;
  return (
    <Box title="Signature quorum" sub="How many different certified vets must agree before a livestock claim settles. It is fixed per claim at the moment the claim is filed.">
      <div className="row">
        <div><label>Required signatures (1 to 5)</label><input type="number" min="1" max="5" value={q} onChange={(e) => setQ(Number(e.target.value))} /></div>
        <button className="btn" disabled={busy || q === snap.vetQuorum} onClick={() => run("Quorum updated", async () => (await ctx.ledger.setVetQuorum(q)).wait())}>Save</button>
      </div>
      <p className="muted">{certified} certified vet{certified === 1 ? "" : "s"} available.{q > certified && " The quorum is higher than the number of certified vets, so claims could not settle."}</p>
    </Box>
  );
}

const ROLE_DOC = [
  ["ADMIN", "DEFAULT_ADMIN_ROLE", "Certifies / revokes vets, sets the quorum and waiting period, pauses the system. Cannot touch anyone's funds."],
  ["UNDERWRITER", "UNDERWRITER_ROLE", "Creates products and supplies the liquidity that backs them."],
  ["ORACLE", "ORACLE_ROLE", "Posts rainfall and vegetation readings that trigger crop payouts."],
  ["VET", "VET_ROLE", "Signs claim decisions, but only counts while certified (active, unexpired licence record)."],
];

export function AdminAccess({ ctx, snap }) {
  const { ledger } = ctx;
  const [grid, setGrid] = useState(null);
  useEffect(() => {
    (async () => {
      const roles = await Promise.all(ROLE_DOC.map(async ([k, fn]) => [k, fn === "DEFAULT_ADMIN_ROLE" ? ethers.ZeroHash : await ledger[fn]()]));
      const rows = [];
      for (const a of DEMO_ACCOUNTS) {
        const has = {};
        for (const [k, h] of roles) has[k] = await ledger.hasRole(h, a.addr);
        has.CERT = (await ledger.isCertifiedVet(a.addr));
        rows.push({ id: a.key, a, has });
      }
      setGrid(rows);
    })().catch(() => setGrid([]));
  }, [ledger, snap.vets.length, snap.now]);
  return (
    <>
      <Box title="Roles" sub="Permissions are enforced by the contract itself. Nobody, including the operator, can act outside their role.">
        <DataTable rows={ROLE_DOC.map(([k, fn, d]) => ({ id: k, k, fn, d }))} pageSize={6} columns={[
          { key: "k", label: "Role", render: (r) => <b>{r.k}</b> }, { key: "fn", label: "On-chain id", render: (r) => <code>{r.fn}</code> }, { key: "d", label: "What it can do" },
        ]} />
      </Box>
      <Box title="Who holds what (live from the chain)" sub="Each cell is a call to hasRole() / isCertifiedVet() on the deployed contract.">
        {!grid ? <p className="muted">Reading roles…</p> : (
          <DataTable rows={grid} pageSize={10} columns={[
            { key: "who", label: "Account", render: (r) => <><b>{r.a.label}</b><div className="muted">{short(r.a.addr)}</div></>, text: (r) => r.a.label },
            ...ROLE_DOC.map(([k]) => ({ key: k, label: k, render: (r) => (r.has[k] ? <Badge tone="g">Yes</Badge> : <span className="muted">-</span>), text: () => "" })),
            { key: "CERT", label: "Licence valid", render: (r) => (r.has.CERT ? <Badge tone="g">Yes</Badge> : <span className="muted">-</span>), text: () => "" },
          ]} />
        )}
      </Box>
    </>
  );
}

export function AdminGov({ ctx, snap, run, busy }) {
  const { ledger } = ctx;
  const [wp, setWp] = useState(Number(snap.waiting) / DAY);
  return (
    <Box title="Governance">
      <KV rows={[["System", <Badge tone={snap.paused ? "r" : "g"}>{snap.paused ? "PAUSED" : "Running"}</Badge>]]} />
      <p><button className={"btn" + (snap.paused ? "" : " dng")} disabled={busy} onClick={() => run(snap.paused ? "Unpause" : "Pause", async () => (await (snap.paused ? ledger.unpause() : ledger.pause())).wait())}>{snap.paused ? "Resume system" : "Pause system (emergency)"}</button></p>
      <div className="row"><div><label>Livestock waiting period (days, max 30)</label><input type="number" value={wp} onChange={(e) => setWp(Number(e.target.value))} /></div>
        <button className="btn" disabled={busy} onClick={() => run("Waiting period", async () => (await ledger.setWaitingPeriod(wp * DAY)).wait())}>Set</button></div>
    </Box>
  );
}
