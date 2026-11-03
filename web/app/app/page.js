"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import { DEMO_ACCOUNTS, loadConfig, makeProvider, contractsFor, short, fmt, errMsg } from "../lib/chain";
import { loadSnapshot } from "../lib/snapshot";
import { relevantEvents, eventText } from "../lib/format";
import { Toasts, Box, Icon } from "../components/ui";
import { Overview as FarmerOverview, Assets, Policies } from "../views/farmer";
import { BuyCover } from "../views/booking";
import { VetOverview, VetClaims, VetProfile } from "../views/vet";
import { UwOverview, UwProducts } from "../views/underwriter";
import { AdminOverview, AdminVets, AdminAccess, AdminGov } from "../views/admin";
import { AuditView, DemoView } from "../views/shared";

const NAV = {
  farmer: [["overview", "Overview", "home"], ["buy", "New application", "shield"], ["assets", "Plots and cattle", "grid"], ["policies", "My policies", "file"]],
  vet: [["overview", "Overview", "home"], ["claims", "Claims queue", "pulse"], ["profile", "My certification", "user"]],
  underwriter: [["overview", "Portfolio", "home"], ["products", "Products", "box"]],
  admin: [["overview", "Overview", "home"], ["vets", "Veterinarians", "pulse"], ["access", "Access control", "lock"], ["gov", "Governance", "sliders"]],
  oracle: [],
};
const SHARED = [["audit", "Audit trail", "search"], ["demo", "Test tools", "flask"]];
const SUBTITLE = {
  overview: "Summary of your account", buy: "Apply for cover and upload supporting documents", assets: "Land and animals you can insure", policies: "Your cover and claims",
  claims: "Livestock claims awaiting verification", profile: "Your veterinary licence on record", products: "Cover products and pricing",
  vets: "Certification, licences and claim quorum", access: "Who can do what on the platform", gov: "Platform controls", audit: "Every action recorded on the ledger",
  demo: "Simulate weather data and the passing of time on the test network",
};
const ROLE_LABEL = { farmer: "Farmer", vet: "Veterinarian", underwriter: "Underwriter", admin: "Administrator", oracle: "Oracle" };

export default function Home() {
  const [cfg, setCfg] = useState(null);
  const [provider, setProvider] = useState(null);
  const [acct, setAcct] = useState("aline");
  const [view, setView] = useState("overview");
  const [snap, setSnap] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState(null);
  const [conn, setConn] = useState(null); // null = healthy; {state: "offline" | "stale" | "error", detail}
  const [menu, setMenu] = useState(false);
  const [bell, setBell] = useState(false);
  const seen = useRef({});
  const [, force] = useState(0);

  const account = DEMO_ACCOUNTS.find((a) => a.key === acct);
  const address = account.addr;
  const ctx = useMemo(() => (cfg && provider ? contractsFor(cfg, provider, account.pk) : null), [cfg, provider, account]);

  useEffect(() => {
    (async () => {
      try { const c = await loadConfig(); setCfg(c); setProvider(makeProvider(c.dep)); } catch (e) { setFatal(errMsg(e)); }
      if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    })();
  }, []);

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

  const toast = (msg, err) => {
    const id = Math.random();
    setToasts((t) => [...t, { id, msg, err }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), err ? 8000 : 4500);
  };
  const run = async (label, fn) => {
    setBusy(true);
    try { await fn(); toast(label + " completed"); } catch (e) { toast(label + " failed: " + errMsg(e), true); }
    setBusy(false);
    refresh();
  };

  const switchAccount = (key) => { setAcct(key); setView("overview"); setBell(false); setMenu(false); setSnap(null); };
  const go = (v) => { setView(v); setMenu(false); window.scrollTo?.(0, 0); };

  if (fatal) return <div className="content"><Box title="FarmLedger is not deployed yet"><p>{fatal}</p><p className="muted">Start the chain (<code>npm run node</code>), then <code>npm run deploy:local</code> and <code>npm run seed</code>, and reload this page.</p></Box></div>;
  if (!cfg || (!snap && conn)) return <div className="content"><ConnBanner conn={conn} cfg={cfg} /></div>;
  if (!snap) return <div className="content"><Box title="Loading chain data…" /></div>;

  const nav = [...NAV[account.role], ...SHARED];
  const current = nav.find((n) => n[0] === view) || nav[0];
  const props = { ctx, snap, address, account, run, busy, cfg, provider, go };

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
  else if (view === "demo") body = <DemoView {...props} />;
  else if (r === "farmer") body = { overview: <FarmerOverview {...props} />, buy: <BuyCover {...props} />, assets: <Assets {...props} />, policies: <Policies {...props} /> }[view];
  else if (r === "vet") body = { overview: <VetOverview {...props} />, claims: <VetClaims {...props} />, profile: <VetProfile {...props} /> }[view];
  else if (r === "underwriter") body = { overview: <UwOverview {...props} />, products: <UwProducts {...props} /> }[view];
  else if (r === "admin") body = { overview: <AdminOverview {...props} />, vets: <AdminVets {...props} />, access: <AdminAccess {...props} />, gov: <AdminGov {...props} /> }[view];
  else body = <Box title="Oracle account" sub="The oracle posts rainfall / NDVI readings. Use Test tools, or run npm run oracle." />;
  if (!body) body = <Box title="Not available for this role" />;

  return (
    <div className="app">
      <aside className={"side" + (menu ? " open" : "")}>
        <div className="brand"><i>FL</i><div>FarmLedger<small>Agricultural insurance</small></div></div>
        <nav className="nav" aria-label="Main">
          <h6>{ROLE_LABEL[r]}</h6>
          {NAV[r].map(([k, label, icon]) => <button key={k} className={view === k ? "on" : ""} onClick={() => go(k)}><Icon name={icon} />{label}{badges[k] ? <span className="cnt">{badges[k]}</span> : null}</button>)}
          <h6>Records</h6>
          {SHARED.map(([k, label, icon]) => <button key={k} className={view === k ? "on" : ""} onClick={() => go(k)}><Icon name={icon} />{label}</button>)}
        </nav>
        <div className="foot">
          <a href="/ussd"><Icon name="phone" size={14} /> USSD channel simulator</a>
          <div className="env">Test network {cfg.dep.chainId}{snap.paused ? " · paused" : ""}</div>
        </div>
      </aside>

      <div className="main">
        {conn && <div className="content" style={{ paddingBottom: 0 }}><ConnBanner conn={conn} cfg={cfg} /></div>}
        <header className="hdr">
          <button className="menu-btn" aria-label="Menu" onClick={() => setMenu(!menu)}><Icon name="menu" /></button>
          <div className="ttl"><h1>{current[1]}</h1><p>{SUBTITLE[current[0]] || ""}</p></div>
          <span className="envchip" title="Sample data on a local test network. Money is test money.">Test environment</span>
          <div className="who">
            <select aria-label="Signed in as" value={acct} onChange={(e) => switchAccount(e.target.value)}>
              {DEMO_ACCOUNTS.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
            </select>
            <div className="muted">{short(address)} · {fmt(snap.balance)} RWF</div>
          </div>
          <button className="bell" aria-label="Notifications" onClick={() => { setBell(!bell); if (bell) { seen.current[acct] = Math.max(-1, ...mine.map((e) => e.block)); force((n) => n + 1); } }}>
            <Icon name="bell" />{fresh.length > 0 && <b>{Math.min(fresh.length, 99)}</b>}
          </button>
        </header>
        {bell && (
          <div className="pop" role="dialog" aria-label="Notifications">
            <div>Notifications <button className="btn sec sm" style={{ float: "right" }} onClick={() => { seen.current[acct] = Math.max(-1, ...mine.map((e) => e.block)); setBell(false); force((n) => n + 1); }}>Mark all read</button></div>
            {mine.length === 0 && <div className="muted">Nothing yet.</div>}
            {mine.slice(0, 8).map((e, i) => <div key={i}>{eventText(e)} <span className="muted">· block {e.block}</span></div>)}
          </div>
        )}
        <main className="content">{body}</main>
      </div>
      <Toasts items={toasts} />
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
