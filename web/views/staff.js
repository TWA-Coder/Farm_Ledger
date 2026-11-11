"use client";
// Staff logins (server/auth.js) and their roles on the ledger.
//   StaffAdmin   the administrator: admins, underwriters and vets
//   AgentsAdmin  an underwriter: its insurance agents and the districts they cover
// Adding someone is two steps: the login (name, username, one-time password; their key is created and held by the
// custody service), then the on-chain step from YOUR account: grant the role, certify the vet or appoint the agent.
// If the second step fails, the person shows as "role missing" and the step can be repeated.
import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import { Badge, Box, DataTable, Dialog } from "../components/ui";
import { b32, errMsg, hashOf, short } from "../lib/chain";
import { DAY } from "../lib/format";
import { api } from "../lib/remote-signer";
import districts from "../shared/districts";

const ROLE = { admin: "Administrator", underwriter: "Underwriter", vet: "Veterinarian", agent: "Insurance agent" };

async function roleOnChain(ctx, row) {
  const { ledger, desk } = ctx;
  if (row.role === "admin") return ledger.hasRole(ethers.ZeroHash, row.address);
  if (row.role === "underwriter") return ledger.hasRole(await ledger.UNDERWRITER_ROLE(), row.address);
  if (row.role === "vet") return ledger.isCertifiedVet(row.address);
  if (row.role === "agent") return desk ? desk.isAgent(row.address) : false;
  return false;
}

// The on-chain step for a new (or role-less) staff member, sent from the signed-in admin / underwriter.
async function grantRole(ctx, snap, row, extra) {
  const { ledger, desk } = ctx;
  if (row.role === "admin") return (await ledger.grantRole(ethers.ZeroHash, row.address)).wait();
  if (row.role === "underwriter") return (await ledger.grantRole(await ledger.UNDERWRITER_ROLE(), row.address)).wait();
  if (row.role === "vet") {
    const base = Math.max(snap.now, Math.floor(Date.now() / 1000));
    return (await ledger.certifyVet(row.address, hashOf("licence:" + extra.licence.trim()), b32(extra.sector.trim().toUpperCase()), base + Math.round(Number(extra.months) * 30 * DAY))).wait();
  }
  if (row.role === "agent") return (await desk.appointAgent(row.address, extra.districts.map((d) => b32(d.toUpperCase())))).wait();
  throw new Error("Unknown role.");
}

const extraOk = (role, x) => (role === "vet" ? x.licence.trim() && x.sector.trim() && Number(x.months) > 0 : role === "agent" ? x.districts.length > 0 : true);

function ExtraFields({ role, x, setX }) {
  if (role === "vet") return (
    <div className="row">
      <div className="fld"><label>Licence number</label><input value={x.licence} onChange={(e) => setX({ ...x, licence: e.target.value })} placeholder="RVC-LIC-004" /></div>
      <div className="fld"><label>Sector served</label><input value={x.sector} onChange={(e) => setX({ ...x, sector: e.target.value })} placeholder="BUGESERA" /></div>
      <div className="fld"><label>Valid for (months)</label><input type="number" min="1" value={x.months} onChange={(e) => setX({ ...x, months: e.target.value })} /></div>
    </div>
  );
  if (role === "agent") return (
    <>
      <label>Districts this agent covers</label>
      <div className="districts">
        {districts.PROVINCES.map(([p, ds]) => (
          <fieldset key={p}><legend>{p}</legend>
            {ds.map((d) => (
              <label key={d} className="check"><input type="checkbox" checked={x.districts.includes(d)}
                onChange={(e) => setX({ ...x, districts: e.target.checked ? [...x.districts, d] : x.districts.filter((y) => y !== d) })} />{d}</label>
            ))}
          </fieldset>
        ))}
      </div>
    </>
  );
  return null;
}

function StaffList({ ctx, snap, run, busy, roles, title, sub, addLabel, account }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [adding, setAdding] = useState(false);
  const [granting, setGranting] = useState(null); // row
  const [secret, setSecret] = useState(null);     // { name, username, tempPassword }
  const [x, setX] = useState({ licence: "", sector: "", months: 12, districts: [] });
  const [f, setF] = useState({ name: "", username: "", role: roles[0], phone: "" });

  const load = useCallback(async () => {
    try {
      const { staff } = await api("/api/staff");
      const mine = staff.filter((s) => roles.includes(s.role));
      setRows(await Promise.all(mine.map(async (s) => ({ ...s, id: s.username, onChain: await roleOnChain(ctx, s).catch(() => null),
        districts: s.role === "agent" && ctx.desk ? (await ctx.desk.districtsOfAgent(s.address).catch(() => [])).map((d) => districts.titleOf(ethers.decodeBytes32String(d))) : null }))));
    } catch (e) { setErr(e.message); }
  }, [ctx, roles.join()]); // eslint-disable-line
  useEffect(() => { load(); }, [load, snap.now]);

  const add = () => run(`Adding ${f.name}`, async () => {
    const r = await api("/api/staff", { name: f.name, username: f.username, role: f.role, phone: f.phone || undefined });
    setSecret({ name: f.name, username: r.username, tempPassword: r.tempPassword });
    setAdding(false);
    setF({ name: "", username: "", role: roles[0], phone: "" });
    try {
      const receipt = await grantRole(ctx, snap, { role: f.role, address: r.address }, x);
      return receipt;
    } catch (e) {
      return { warning: `The login was created, but the role was not recorded on the ledger: ${errMsg(e)} Use "Grant role" in the list to try again.` };
    } finally { setX({ licence: "", sector: "", months: 12, districts: [] }); load(); }
  });

  const manage = async (row, action) => {
    try {
      const r = await api(`/api/staff/${encodeURIComponent(row.username)}`, { action });
      if (r.tempPassword) setSecret({ name: row.name, username: row.username, tempPassword: r.tempPassword });
      load();
    } catch (e) { setErr(e.message); }
  };

  const suggest = (name) => name.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).join(".");

  return (
    <>
      {secret && (
        <div className="callout ok">
          <b>Give these sign-in details to {secret.name}</b> (they are shown only once):<br />
          Username <span className="secret">{secret.username}</span> · one-time password <span className="secret">{secret.tempPassword}</span><br />
          <span className="muted">At first sign-in they choose their own password.</span>
          <div><button className="link" onClick={() => setSecret(null)}>Done</button></div>
        </div>
      )}
      {err && <div className="callout err">{err}</div>}
      <Box title={title} sub={sub} right={<button className="btn sm" onClick={() => setAdding(true)}>{addLabel}</button>}>
        {!rows ? <p className="muted">Loading…</p> : (
          <DataTable rows={rows} empty="Nobody yet." pageSize={10} columns={[
            { key: "name", label: "Name", render: (r) => <><b>{r.name}</b><div className="muted mono">{short(r.address)}</div></>, text: (r) => r.name + r.username },
            { key: "username", label: "Username", render: (r) => <span className="mono">{r.username}</span> },
            ...(roles.length > 1 ? [{ key: "role", label: "Role", render: (r) => ROLE[r.role], text: (r) => ROLE[r.role] }] : []),
            ...(roles.includes("agent") ? [{ key: "districts", label: "Districts", render: (r) => (r.districts || []).join(", ") || "-", text: (r) => (r.districts || []).join(" ") }] : []),
            { key: "status", label: "Status", text: () => "", render: (r) => (
              <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {r.disabled ? <Badge tone="r">Disabled</Badge> : r.pending ? <Badge tone="a">Not signed in yet</Badge> : <Badge tone="g">Active</Badge>}
                {r.onChain === false && <Badge tone="r">Role missing</Badge>}
              </span>) },
            { key: "act", label: "", text: () => "", render: (r) => r.username === account.username ? <span className="muted small">you</span> : (
              <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {r.onChain === false && !r.disabled && <button className="btn sm" disabled={busy} onClick={() => (r.role === "vet" || r.role === "agent" ? setGranting(r) : run(`Granting ${ROLE[r.role]} to ${r.name}`, () => grantRole(ctx, snap, r, x)).then(load))}>Grant role</button>}
                <button className="btn sec sm" onClick={() => manage(r, "reset")}>Reset password</button>
                <button className={"btn sm " + (r.disabled ? "sec" : "dng")} onClick={() => manage(r, r.disabled ? "enable" : "disable")}>{r.disabled ? "Enable" : "Disable"}</button>
              </span>) },
          ]} />
        )}
        <p className="muted small">Disabling a login stops that person signing in. Their role on the ledger stays until it is revoked (vets: on the Veterinarians page).</p>
      </Box>

      {adding && (
        <Dialog title={addLabel} sub="They get a one-time password to sign in with. Their account key is created and kept for them by the FarmLedger server." onClose={() => setAdding(false)}
          actions={<><button className="btn sec" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn" disabled={busy || f.name.trim().length < 2 || !f.username || !extraOk(f.role, x)} onClick={add}>Add and record on the ledger</button></>}>
          <div className="fld"><label>Full name</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, username: f.username && f.username !== suggest(f.name) ? f.username : suggest(e.target.value) })} /></div>
          <div className="row">
            <div className="fld"><label>Username</label><input value={f.username} autoCapitalize="none" onChange={(e) => setF({ ...f, username: e.target.value.trim().toLowerCase() })} /></div>
            {roles.length > 1 && <div className="fld"><label>Role</label><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roles.map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}</select></div>}
          </div>
          <div className="fld"><label>Phone number (optional, for SMS notices)</label><input inputMode="tel" placeholder="0788123456" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
          <ExtraFields role={f.role} x={x} setX={setX} />
        </Dialog>
      )}

      {granting && (
        <Dialog title={`Record ${granting.name} on the ledger`} onClose={() => setGranting(null)}
          actions={<><button className="btn sec" onClick={() => setGranting(null)}>Cancel</button>
            <button className="btn" disabled={busy || !extraOk(granting.role, x)} onClick={async () => { const r = granting; setGranting(null); await run(`Recording ${r.name}`, () => grantRole(ctx, snap, r, x)); load(); }}>Record</button></>}>
          <ExtraFields role={granting.role} x={x} setX={setX} />
        </Dialog>
      )}
    </>
  );
}

export function StaffAdmin(props) {
  return <StaffList {...props} roles={["underwriter", "vet", "admin"]} title="Staff logins" addLabel="Add staff member"
    sub="Underwriters, veterinarians and administrators. Agents are added by their underwriter." />;
}

export function AgentsAdmin(props) {
  return <StaffList {...props} roles={["agent"]} title="Your insurance agents" addLabel="Add agent"
    sub="Agents fill in applications for the farmers in their districts. New farmers are assigned to the agent covering their district with the fewest farmers." />;
}
