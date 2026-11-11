"use client";
// Sign-in screens. Farmers: phone number + PIN (the same account and PIN as on USSD). Staff: username + password.
// New farmers register here: name, National ID, phone and farm district, then a code by SMS and a PIN.
import { useState } from "react";
import { api } from "../lib/remote-signer";
import { Box } from "../components/ui";
import districts from "../shared/districts";

const ROLE = { admin: "Administrator", underwriter: "Underwriter", vet: "Veterinarian", agent: "Insurance agent", farmer: "Farmer" };

function Field({ label, children, hint }) {
  return <div className="fld"><label>{label}</label>{children}{hint && <div className="muted small">{hint}</div>}</div>;
}

function useSubmit(onDone) {
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (fn) => {
    setErr(null); setBusy(true);
    try { const r = await fn(); if (r !== false) await onDone(r); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return { err, setErr, busy, submit };
}

function FarmerLogin({ onDone }) {
  const [f, setF] = useState({ phone: "", pin: "" });
  const { err, busy, submit } = useSubmit(onDone);
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(() => api("/api/auth", { action: "farmer", ...f })); }}>
      <Field label="Phone number"><input inputMode="tel" autoComplete="username" placeholder="0788123456" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
      <Field label="PIN" hint="The 4-digit PIN you also use on the USSD menu."><input type="password" inputMode="numeric" autoComplete="current-password" maxLength={4} value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, "") })} /></Field>
      {err && <div className="callout err">{err}</div>}
      <button className="btn wide" disabled={busy || !f.phone || f.pin.length !== 4}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}

function StaffLogin({ onDone }) {
  const [f, setF] = useState({ username: "", password: "" });
  const { err, busy, submit } = useSubmit(onDone);
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(() => api("/api/auth", { action: "staff", ...f })); }}>
      <Field label="Username"><input autoComplete="username" autoCapitalize="none" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.trim().toLowerCase() })} /></Field>
      <Field label="Password"><input type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
      {err && <div className="callout err">{err}</div>}
      <button className="btn wide" disabled={busy || !f.username || !f.password}>{busy ? "Signing in…" : "Sign in"}</button>
      <p className="muted small">Staff logins are created by the FarmLedger administrator (agents: by their insurer). Forgot your password? Ask them to reset it.</p>
    </form>
  );
}

function Register({ onDone }) {
  const [step, setStep] = useState(1);
  const [f, setF] = useState({ name: "", nid: "", phone: "", province: "", district: "", code: "", pin: "", pin2: "" });
  const [sent, setSent] = useState(null); // { phone, testCode }
  const { err, setErr, busy, submit } = useSubmit(async (r) => { if (r && r.phone && step === 1) { setSent(r); setStep(2); } else await onDone(r); });
  const set = (k, clean = (v) => v) => (e) => setF({ ...f, [k]: clean(e.target.value) });
  const prov = districts.PROVINCES.find((p) => p[0] === f.province);
  if (step === 1) return (
    <form onSubmit={(e) => { e.preventDefault(); submit(() => api("/api/auth/register", { step: "start", name: f.name, nid: f.nid, phone: f.phone, district: f.district })); }}>
      <Field label="Full name" hint="As on your National ID. Only FarmLedger staff see it; it is never put on the ledger."><input autoComplete="name" value={f.name} onChange={set("name")} /></Field>
      <Field label="National ID number" hint="16 digits. Only a fingerprint (hash) of it is stored."><input inputMode="numeric" maxLength={16} value={f.nid} onChange={set("nid", (v) => v.replace(/\D/g, ""))} /></Field>
      <Field label="Phone number" hint="We send a code to it, and payment news later."><input inputMode="tel" placeholder="0788123456" value={f.phone} onChange={set("phone")} /></Field>
      <div className="row">
        <Field label="Province of your farm"><select value={f.province} onChange={(e) => setF({ ...f, province: e.target.value, district: "" })}><option value="">Choose…</option>{districts.PROVINCES.map((p) => <option key={p[0]}>{p[0]}</option>)}</select></Field>
        <Field label="District"><select value={f.district} disabled={!prov} onChange={set("district")}><option value="">Choose…</option>{prov?.[1].map((d) => <option key={d}>{d}</option>)}</select></Field>
      </div>
      {err && <div className="callout err">{err}</div>}
      <button className="btn wide" disabled={busy || f.name.trim().length < 2 || f.nid.length !== 16 || !f.phone || !f.district}>{busy ? "Sending the code…" : "Send me a code"}</button>
    </form>
  );
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      if (f.pin !== f.pin2) { setErr("The two PINs are not the same."); return; }
      submit(() => api("/api/auth/register", { step: "finish", phone: sent.phone, code: f.code, pin: f.pin }));
    }}>
      <p>We sent a 6-digit code by SMS to <b>+{sent.phone}</b>. It is valid for 10 minutes.</p>
      {sent.testCode && <div className="callout"><b>Test network:</b> no SMS service is set up for this number, so here is the code: <b className="mono">{sent.testCode}</b></div>}
      <Field label="Code from the SMS"><input inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={f.code} onChange={set("code", (v) => v.replace(/\D/g, ""))} /></Field>
      <div className="row">
        <Field label="Choose a 4-digit PIN" hint="You will use it here and on the USSD menu."><input type="password" inputMode="numeric" maxLength={4} value={f.pin} onChange={set("pin", (v) => v.replace(/\D/g, ""))} /></Field>
        <Field label="Repeat the PIN"><input type="password" inputMode="numeric" maxLength={4} value={f.pin2} onChange={set("pin2", (v) => v.replace(/\D/g, ""))} /></Field>
      </div>
      {err && <div className="callout err">{err}</div>}
      <button className="btn wide" disabled={busy || f.code.length !== 6 || f.pin.length !== 4 || f.pin2.length !== 4}>{busy ? "Creating your account (about 10 seconds)…" : "Create my account"}</button>
      <p><button type="button" className="link" onClick={() => { setStep(1); setErr(null); }}>Back</button></p>
    </form>
  );
}

// Local chain only: the seeded demo people, with one-click sign-in.
function DemoLogins({ demo, onDone }) {
  const { err, busy, submit } = useSubmit(onDone);
  if (!demo) return null;
  const go = (d) => submit(() => api("/api/auth", d.kind === "farmer" ? { action: "farmer", phone: d.phone, pin: d.pin } : { action: "staff", username: d.username, password: d.password }));
  return (
    <Box title="Demo sign-ins" sub="Local test network only. These people were created by the seed script; the same details work in the form above.">
      {err && <div className="callout err">{err}</div>}
      <table className="tbl"><tbody>
        {demo.map((d) => (
          <tr key={d.username || d.phone}>
            <td><b>{d.name}</b><div className="muted small">{ROLE[d.role] || d.role}</div></td>
            <td className="mono small">{d.kind === "farmer" ? `${d.phone.replace(/^250/, "0")} · PIN ${d.pin}` : `${d.username} · ${d.password}`}</td>
            <td><button className="btn sec sm" disabled={busy} onClick={() => go(d)}>Sign in</button></td>
          </tr>
        ))}
      </tbody></table>
    </Box>
  );
}

export function Login({ demo, onDone }) {
  const [tab, setTab] = useState("farmer");
  const tabs = [["farmer", "Farmer"], ["staff", "Staff"], ["register", "New farmer? Register"]];
  return (
    <div className="login">
      <a className="login-brand" href="/"><i>FL</i><div>FarmLedger<small>Farm insurance for Rwanda</small></div></a>
      <Box title={tab === "register" ? "Register as a farmer" : "Sign in"}>
        <div className="tabs" role="tablist">
          {tabs.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>)}
        </div>
        {tab === "farmer" && <FarmerLogin onDone={onDone} />}
        {tab === "staff" && <StaffLogin onDone={onDone} />}
        {tab === "register" && <Register onDone={onDone} />}
      </Box>
      <DemoLogins demo={demo} onDone={onDone} />
      <p className="muted small center"><a href="/ussd">Basic phone? Try the USSD simulator</a></p>
    </div>
  );
}

// Staff: change password. `forced` after a one-time password (new login or reset).
export function ChangePassword({ forced, viewer, onDone, onCancel }) {
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const { err, setErr, busy, submit } = useSubmit(onDone);
  const body = (
    <form onSubmit={(e) => {
      e.preventDefault();
      if (f.next !== f.again) { setErr("The two new passwords are not the same."); return; }
      submit(() => api("/api/auth", { action: "password", current: f.current, next: f.next }));
    }}>
      {forced && <p>Welcome, <b>{viewer.name}</b>. You signed in with a one-time password: choose your own to continue.</p>}
      <Field label={forced ? "One-time password" : "Current password"}><input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
      <Field label="New password" hint="At least 8 characters."><input type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
      <Field label="Repeat the new password"><input type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></Field>
      {err && <div className="callout err">{err}</div>}
      <div className="row">
        <button className="btn" disabled={busy || !f.current || f.next.length < 8}>{busy ? "Saving…" : "Save password"}</button>
        {onCancel && <button type="button" className="btn sec" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
  if (!forced) return <Box title="Change your password">{body}</Box>;
  return <div className="login"><Box title="Choose your password">{body}</Box></div>;
}
