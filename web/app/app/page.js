"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import { loadConfig, makeProvider, contractsFor, short, fmt, errMsg } from "../../lib/chain";
import { loadSnapshot } from "../../lib/snapshot";
import { RemoteSigner, api } from "../../lib/remote-signer";
import { Login, ChangePassword } from "../../views/login";
import { StaffAdmin, AgentsAdmin } from "../../views/staff";
import { relevantEvents, eventText, farmerEventText } from "../../lib/format";
import { Box, Icon, TxStatus } from "../../components/ui";
import { Overview as FarmerOverview, Assets, Policies } from "../../views/farmer";
import { ApplicationForm } from "../../views/application";
import { AgentFarmers, AgentApplications } from "../../views/agent";
import { UwDesk } from "../../views/desk";
import { FarmerOffers } from "../../views/offers";
import { Products } from "../../views/products";
import { VetOverview, VetClaims, VetProfile } from "../../views/vet";
import { UwOverview, UwProducts } from "../../views/underwriter";
import { UwPolicies } from "../../views/policydoc";
import { AdminOverview, AdminVets, AdminAccess, AdminGov } from "../../views/admin";
import { AuditView, DemoView } from "../../views/shared";

const NAV = {
  farmer: [["overview", "Home", "home"], ["assets", "My farm", "grid"], ["products", "Cover options", "box"], ["offers", "Applications and contracts", "shield"], ["policies", "Policies and claims", "file"]],
  agent: [["overview", "My farmers", "user"], ["apply", "New application", "shield"], ["applications", "Applications", "file"]],
  vet: [["overview", "Overview", "home"], ["claims", "Claims queue", "pulse"], ["profile", "My certification", "user"]],
  underwriter: [["overview", "Portfolio", "home"], ["desk", "Application desk", "shield"], ["products", "Products", "box"], ["policies", "Policies", "file"], ["agents", "Agents", "user"]],
  admin: [["overview", "Overview", "home"], ["staff", "Staff logins", "user"], ["vets", "Veterinarians", "pulse"], ["access", "Access control", "lock"], ["gov", "Governance", "sliders"]],
  oracle: [],
};
const SHARED = [["audit", "Audit trail", "search"], ["demo", "Test tools", "flask"]];
const SUBTITLE = {
  overview: "Your account at a glance", offers: "What your agent applied for, and contracts to accept",
  apply: "Fill in an application with your farmer", applications: "Applications you submitted, and their status", desk: "Review applications and draft contracts", assets: "The plots and animals you can insure", policies: "Track your cover, claims and payments",
  uwPolicies: "Every policy on your products, with its policy document",
  farmerProducts: "What each cover pays for, what it costs and what you need",
  claims: "Livestock claims awaiting verification", profile: "Your veterinary licence on record", products: "Cover products and pricing",
  vets: "Certification, licences and claim quorum", access: "Who can do what on the platform", gov: "Platform controls", audit: "Every action recorded on the ledger",
  demo: "Simulate weather data and the passing of time on the test network",
  staff: "Who can sign in, and their role on the ledger", agents: "Agents who apply for cover on behalf of farmers", password: "Change the password you sign in with",
};
const ROLE_LABEL = { agent: "Insurance agent", farmer: "Farmer", vet: "Veterinarian", underwriter: "Underwriter", admin: "Administrator", oracle: "Oracle" };

export default function Home() {
  const [cfg, setCfg] = useState(null);
  const [provider, setProvider] = useState(null);
  const [auth, setAuth] = useState(null); // { viewer, local, demo } from /api/auth
  const [role, setRole] = useState(null); // { role, onChain } for the signed-in person
  const [view, setView] = useState("overview");
  const [snap, setSnap] = useState(null);
  const [status, setStatus] = useState(null); // {label, state: "pending" | "ok" | "err", detail?, tx?}
  const [intent, setIntent] = useState(null); // data handed from one screen to the next (e.g. chosen product)
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState(null);
  const [conn, setConn] = useState(null); // null = healthy; {state: "offline" | "stale" | "error", detail}
  const [menu, setMenu] = useState(false);
  const [bell, setBell] = useState(false);
  const seen = useRef({});
  const [, force] = useState(0);

  // The signed-in person. Their key stays on the server (custody service); RemoteSigner asks the portal server to
  // send each transaction or signature for them (lib/remote-signer.js).
  const viewer = auth?.viewer || null;
  const account = useMemo(() => (viewer && provider && role ? {
    key: viewer.username || viewer.phone, role: role.role, kind: viewer.kind, label: viewer.name || short(viewer.address),
    name: viewer.name, username: viewer.username, phone: viewer.phone, addr: viewer.address, signer: new RemoteSigner(viewer.address, provider),
  } : null), [viewer, provider, role]);
  const acct = account?.key || "-";
  const address = account?.addr;
  const ctx = useMemo(() => (cfg && provider && account ? contractsFor(cfg, provider, account.signer) : null), [cfg, provider, account]);

  const loadAuth = useCallback(async () => {
    try { setAuth(await api("/api/auth")); } catch (e) { setFatal(errMsg(e)); }
    setSnap(null); setRole(null); setView("overview"); setStatus(null); setIntent(null);
  }, []);

  // Staff act in the role they were created for; whether the ledger agrees is checked here and shown if not.
  useEffect(() => {
    if (!viewer || viewer.mustChange || !cfg || !provider) return;
    if (viewer.kind === "farmer") { setRole({ role: "farmer", onChain: true }); return; }
    (async () => {
      const l = new ethers.Contract(cfg.dep.ledger, cfg.abi.ledger, provider);
      const desk = cfg.dep.policyDesk ? new ethers.Contract(cfg.dep.policyDesk, cfg.abi.policyDesk, provider) : null;
      const a = viewer.address;
      const has = {
        admin: () => l.hasRole(ethers.ZeroHash, a),
        underwriter: async () => l.hasRole(await l.UNDERWRITER_ROLE(), a),
        vet: async () => Number((await l.getVetProfile(a)).certifiedAt) > 0,
        agent: async () => (desk ? desk.isAgent(a) : false),
      }[viewer.role];
      let onChain = null;
      try { onChain = has ? Boolean(await has()) : false; } catch { /* chain unreachable: the banner below says so */ }
      setRole({ role: viewer.role, onChain });
    })();
  }, [viewer, cfg, provider]);

  async function signOut() {
    try { await api("/api/auth", { action: "logout" }); } catch { /* the cookie expires anyway */ }
    await loadAuth();
  }

  useEffect(() => {
    (async () => {
      try { const c = await loadConfig(); setCfg(c); setProvider(makeProvider(c.dep)); } catch (e) { setFatal(errMsg(e)); }
      await loadAuth();
      if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    })();
  }, [loadAuth]);

  const refresh = useCallback(async () => {
    if (!ctx) return;
    try {
      setSnap(await loadSnapshot({ ctx, provider, cfg, address, account }));
      setConn(null);
    } catch (e) {
      let state = "offline";
      try { await provider.getBlockNumber(); state = (await provider.getCode(cfg.dep.ledger)) === "0x" ? "stale" : "error"; } catch { /* node unreachable */ }
      setConn({ state, detail: errMsg(e) });
    }
  }, [ctx, provider, address, account, cfg]);

  useEffect(() => { refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t); }, [refresh]);

  // Every write goes through run(): it shows "in progress", then the confirmed transaction or a plain error.
  // fn may return a transaction receipt (or an array of them) so the confirmation can show its reference.
  const run = async (label, fn) => {
    setBusy(true);
    setStatus({ label, state: "pending" });
    let ok = false;
    try {
      const out = await fn();
      // fn may also return { receipt, warning } when the main step worked but a follow-up step did not
      const warning = out && out.warning;
      const rcs = (Array.isArray(out) ? out : [out && out.receipt ? out.receipt : out]).filter((r) => r && typeof r.hash === "string");
      setStatus({ label, state: "ok", warning, tx: rcs.length ? rcs[rcs.length - 1].hash : null, block: rcs.length ? rcs[rcs.length - 1].blockNumber : null });
      ok = true;
    } catch (e) {
      setStatus({ label, state: "err", detail: errMsg(e) });
    }
    setBusy(false);
    refresh();
    return ok;
  };

  const go = (v, data = null) => { setView(v); setIntent(data); setMenu(false); window.scrollTo?.(0, 0); };

  if (fatal) return <div className="content"><Box title="FarmLedger is not deployed yet"><p>{fatal}</p><p className="muted">Start the chain (<code>npm run node</code>), then <code>npm run deploy:local</code> and <code>npm run seed</code>, and reload this page.</p></Box></div>;
  if (!cfg || !auth) return <div className="content"><Box title="Loading…" /></div>;
  if (!viewer) return <Login demo={auth.demo} onDone={loadAuth} />;
  if (viewer.mustChange) return <ChangePassword forced viewer={viewer} onDone={loadAuth} />;
  if (!account || (!snap && conn)) return <div className="content">{conn ? <ConnBanner conn={conn} cfg={cfg} /> : <Box title="Loading your account…" />}</div>;
  if (!snap) return <div className="content"><Box title="Loading chain data…" /></div>;

  const local = ["localhost", "hardhat"].includes(cfg.dep.network);
  const shared = local ? SHARED : SHARED.filter(([k]) => k !== "demo");
  const nav = [...NAV[account.role], ...shared, ...(account.kind === "staff" ? [["password", "Change password", "lock"]] : [])];
  const current = nav.find((n) => n[0] === view) || nav[0];
  const props = { ctx, snap, address, account, run, busy, cfg, provider, go, intent };
  const evText = account.role === "farmer" ? farmerEventText : eventText;

  // notifications: events relevant to this account that the user has not looked at yet
  const mine = relevantEvents(snap, account, address);
  const fresh = mine.filter((e) => e.block > (seen.current[acct] ?? -1));
  const badges = {
    claims: account.role === "vet" ? snap.claims.filter((c) => snap.myVet?.certified && c.status === 1 && !c.iSigned && c.holder.toLowerCase() !== address.toLowerCase()).length : 0,
    policies: account.role === "farmer" ? snap.policies.filter((p) => Number(p.status) === 1).length : 0,
  };

  let body;
  const r = account.role;
  if (view === "audit") body = <AuditView snap={snap} />;
  else if (view === "password") body = <ChangePassword viewer={viewer} onDone={() => { setStatus({ label: "Password changed", state: "ok" }); go("overview"); }} onCancel={() => go("overview")} />;
  else if (view === "demo") body = <DemoView {...props} />;
  else if (r === "farmer") body = { overview: <FarmerOverview {...props} />, products: <Products {...props} />, offers: <FarmerOffers {...props} />, assets: <Assets {...props} />, policies: <Policies {...props} /> }[view];
  else if (r === "agent") body = { overview: <AgentFarmers key={intent?.farmer || "f"} {...props} />, apply: <ApplicationForm key={intent?.farmer || "apply"} {...props} />, applications: <AgentApplications {...props} /> }[view];
  else if (r === "vet") body = { overview: <VetOverview {...props} />, claims: <VetClaims {...props} />, profile: <VetProfile {...props} /> }[view];
  else if (r === "underwriter") body = { overview: <UwOverview {...props} />, desk: <UwDesk {...props} />, products: <UwProducts {...props} />, policies: <UwPolicies {...props} />, agents: <AgentsAdmin {...props} /> }[view];
  else if (r === "admin") body = { overview: <AdminOverview {...props} />, staff: <StaffAdmin {...props} />, vets: <AdminVets {...props} />, access: <AdminAccess {...props} />, gov: <AdminGov {...props} /> }[view];
  else body = <Box title="Oracle account" sub="The oracle posts rainfall / NDVI readings. Use Test tools, or run npm run oracle." />;
  if (!body) body = <Box title="Not available for this role" />;

  return (
    <div className="app">
      <aside className={"side" + (menu ? " open" : "")}>
        <a className="brand" href="/"><i>FL</i><div>FarmLedger<small>Farm insurance for Rwanda</small></div></a>
        <nav className="nav" aria-label="Main">
          <h6>{ROLE_LABEL[r]}</h6>
          {NAV[r].map(([k, label, icon]) => <button key={k} className={view === k ? "on" : ""} onClick={() => go(k)}><Icon name={icon} />{label}{badges[k] ? <span className="cnt">{badges[k]}</span> : null}</button>)}
          <h6>Records</h6>
          {shared.map(([k, label, icon]) => <button key={k} className={view === k ? "on" : ""} onClick={() => go(k)}><Icon name={icon} />{label}</button>)}
        </nav>
        <div className="foot">
          <a href="/ussd"><Icon name="phone" size={14} /> Basic phone (USSD) simulator</a>
          <div className="env">{cfg.dep.chainName || "Test network"} {cfg.dep.chainId} · test money only{snap.paused ? " · paused" : ""}</div>
        </div>
      </aside>

      <div className="main">
        {conn && <div className="content" style={{ paddingBottom: 0 }}><ConnBanner conn={conn} cfg={cfg} /></div>}
        <header className="hdr">
          <button className="menu-btn" aria-label="Menu" onClick={() => setMenu(!menu)}><Icon name="menu" /></button>
          <div className="ttl"><h1>{current[1]}</h1><p>{SUBTITLE[r === "farmer" && current[0] === "products" ? "farmerProducts" : r === "underwriter" && current[0] === "policies" ? "uwPolicies" : current[0]] || ""}</p></div>
          <span className="envchip" title="Sample data on a local test network. Money is test money.">Test version</span>
          <div className="me">
            <b>{account.label}</b>
            <div className="muted">{ROLE_LABEL[r]} · {short(address)}{account.kind === "farmer" ? ` · ${fmt(snap.balance)} RWF · fees paid by FarmLedger` : ""}</div>
            <div className="muted">{account.kind === "staff" && <><button className="link" onClick={() => go("password")}>Change password</button> · </>}<button className="link" onClick={signOut}>Sign out</button></div>
          </div>
          <button className="bell" aria-label="Notifications" onClick={() => { setBell(!bell); if (bell) { seen.current[acct] = Math.max(-1, ...mine.map((e) => e.block)); force((n) => n + 1); } }}>
            <Icon name="bell" />{fresh.length > 0 && <b>{Math.min(fresh.length, 99)}</b>}
          </button>
        </header>
        {bell && (
          <div className="pop" role="dialog" aria-label="Notifications">
            <div>Notifications <button className="btn sec sm" style={{ float: "right" }} onClick={() => { seen.current[acct] = Math.max(-1, ...mine.map((e) => e.block)); setBell(false); force((n) => n + 1); }}>Mark all read</button></div>
            {mine.length === 0 && <div className="muted">Nothing yet.</div>}
            {mine.slice(0, 8).map((e, i) => <div key={i}>{evText(e)}</div>)}
          </div>
        )}
        <main className="content">
          {role && role.onChain === false && <div className="callout err"><b>Your {ROLE_LABEL[r].toLowerCase()} role is not recorded on the ledger yet.</b> Actions that need it will be refused. Ask {r === "agent" ? "your underwriter" : "the administrator"} to use "Grant role" for your login.</div>}
          <TxStatus status={status} onClose={() => setStatus(null)} />
          {body}
        </main>
      </div>
    </div>
  );
}

function ConnBanner({ conn, cfg }) {
  const url = cfg?.dep?.rpcUrl || "http://127.0.0.1:8545";
  const text = {
    offline: [`Cannot reach the chain at ${url}.`, "The 'FarmLedger chain' window is probably closed. Start it with:  npm run node  - then  npm run deploy:local  and  npm run seed.  This page reconnects by itself."],
    stale: ["The chain was restarted, so the contracts are gone.", "Run  npm run deploy:local  then  npm run seed  and reload this page."],
    error: ["The chain answered with an error.", conn?.detail || ""],
  }[conn?.state || "offline"];
  return (
    <div className="callout err" role="alert">
      <b>Connection problem: {text[0]}</b>
      <div>{text[1]}</div>
      <div className="muted">Retrying every few seconds…</div>
    </div>
  );
}
