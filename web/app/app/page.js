"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import { DEMO_ACCOUNTS, loadConfig, makeProvider, contractsFor, short, fmt, errMsg } from "../../lib/chain";
import { loadSnapshot } from "../../lib/snapshot";
import { SmartAccountSigner, deviceOwner } from "../../lib/smart-account";
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
  underwriter: [["overview", "Portfolio", "home"], ["desk", "Application desk", "shield"], ["products", "Products", "box"], ["policies", "Policies", "file"]],
  admin: [["overview", "Overview", "home"], ["vets", "Veterinarians", "pulse"], ["access", "Access control", "lock"], ["gov", "Governance", "sliders"]],
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
};
const ROLE_LABEL = { agent: "Insurance agent", farmer: "Farmer", vet: "Veterinarian", underwriter: "Underwriter", admin: "Administrator", oracle: "Oracle" };

export default function Home() {
  const [cfg, setCfg] = useState(null);
  const [provider, setProvider] = useState(null);
  const [acct, setAcct] = useState("aline");
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

  // Accounts that belong to the person using the portal (as opposed to the shared test accounts):
  //   smart  - the farmer's ERC-4337 smart account: key on this device, no seed phrase, fees sponsored
  //   wallet - a browser wallet (MetaMask etc.), for vets, underwriters and administrators
  const [own, setOwn] = useState({});
  const chosen = useRef(false);
  const account = DEMO_ACCOUNTS.find((a) => a.key === acct) || own[acct] || DEMO_ACCOUNTS.find((a) => a.key === "aline");
  const address = account.addr;
  const ctx = useMemo(() => (cfg && provider ? contractsFor(cfg, provider, account.signer || account.pk) : null), [cfg, provider, account]);

  useEffect(() => {
    if (!cfg?.dep?.aa || !provider || own.smart) return;
    (async () => {
      try {
        const signer = new SmartAccountSigner(deviceOwner(), provider, cfg.dep.aa, [new ethers.Interface(cfg.abi.ledger), new ethers.Interface(cfg.abi.token)]);
        const addr = await signer.getAddress();
        setOwn((o) => ({ ...o, smart: { key: "smart", label: "My farmer account (no fees)", role: "farmer", kind: "smart", addr, signer } }));
        if (!chosen.current) { setAcct("smart"); setSnap(null); }
      } catch { /* smart accounts unavailable (e.g. contracts not deployed): test accounts still work */ }
    })();
  }, [cfg, provider, own.smart]);

  async function connectWallet() {
    const label = "Connecting a browser wallet";
    const eth = typeof window !== "undefined" ? window.ethereum : null;
    if (!eth) { setStatus({ label, state: "err", detail: "No browser wallet was found. Install MetaMask (or another wallet extension) and try again." }); return; }
    setStatus({ label, state: "pending" });
    try {
      await eth.request({ method: "eth_requestAccounts" });
      const chainHex = "0x" + Number(cfg.dep.chainId).toString(16);
      try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] }); } catch (e) {
        if (e?.code !== 4902 && !/unrecognized|not added|unknown chain/i.test(e?.message || "")) throw e;
        await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: chainHex, chainName: "FarmLedger network", rpcUrls: [cfg.dep.rpcUrl], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }] });
      }
      const signer = await new ethers.BrowserProvider(eth).getSigner();
      const addr = await signer.getAddress();
      const l = new ethers.Contract(cfg.dep.ledger, cfg.abi.ledger, provider);
      const [isAdmin, isUw, vp] = await Promise.all([l.hasRole(await l.DEFAULT_ADMIN_ROLE(), addr), l.hasRole(await l.UNDERWRITER_ROLE(), addr), l.getVetProfile(addr)]);
      const isAgent = cfg.dep.policyDesk ? await new ethers.Contract(cfg.dep.policyDesk, cfg.abi.policyDesk, provider).isAgent(addr) : false;
      const role = isAdmin ? "admin" : isUw ? "underwriter" : Number(vp.certifiedAt) > 0 ? "vet" : isAgent ? "agent" : "farmer";
      setOwn((o) => ({ ...o, wallet: { key: "wallet", label: `Browser wallet ${short(addr)} (${ROLE_LABEL[role]})`, role, kind: "wallet", addr, signer } }));
      switchAccount("wallet");
      setStatus({ label, state: "ok" });
      eth.on?.("accountsChanged", () => { setOwn((o) => { const n = { ...o }; delete n.wallet; return n; }); setAcct("aline"); setSnap(null); });
    } catch (e) { setStatus({ label, state: "err", detail: errMsg(e) }); }
  }

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

  const switchAccount = (key) => { chosen.current = true; setAcct(key); setView("overview"); setBell(false); setMenu(false); setSnap(null); setStatus(null); setIntent(null); };
  const go = (v, data = null) => { setView(v); setIntent(data); setMenu(false); window.scrollTo?.(0, 0); };

  if (fatal) return <div className="content"><Box title="FarmLedger is not deployed yet"><p>{fatal}</p><p className="muted">Start the chain (<code>npm run node</code>), then <code>npm run deploy:local</code> and <code>npm run seed</code>, and reload this page.</p></Box></div>;
  if (!cfg || (!snap && conn)) return <div className="content"><ConnBanner conn={conn} cfg={cfg} /></div>;
  if (!snap) return <div className="content"><Box title="Loading chain data…" /></div>;

  const nav = [...NAV[account.role], ...SHARED];
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
  else if (view === "demo") body = <DemoView {...props} />;
  else if (r === "farmer") body = { overview: <FarmerOverview {...props} />, products: <Products {...props} />, offers: <FarmerOffers {...props} />, assets: <Assets {...props} />, policies: <Policies {...props} /> }[view];
  else if (r === "agent") body = { overview: <AgentFarmers key={intent?.farmer || "f"} {...props} />, apply: <ApplicationForm key={intent?.farmer || "apply"} {...props} />, applications: <AgentApplications {...props} /> }[view];
  else if (r === "vet") body = { overview: <VetOverview {...props} />, claims: <VetClaims {...props} />, profile: <VetProfile {...props} /> }[view];
  else if (r === "underwriter") body = { overview: <UwOverview {...props} />, desk: <UwDesk {...props} />, products: <UwProducts {...props} />, policies: <UwPolicies {...props} /> }[view];
  else if (r === "admin") body = { overview: <AdminOverview {...props} />, vets: <AdminVets {...props} />, access: <AdminAccess {...props} />, gov: <AdminGov {...props} /> }[view];
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
          {SHARED.map(([k, label, icon]) => <button key={k} className={view === k ? "on" : ""} onClick={() => go(k)}><Icon name={icon} />{label}</button>)}
        </nav>
        <div className="foot">
          <a href="/ussd"><Icon name="phone" size={14} /> Basic phone (USSD) simulator</a>
          <div className="env">Test network {cfg.dep.chainId} · test money only{snap.paused ? " · paused" : ""}</div>
        </div>
      </aside>

      <div className="main">
        {conn && <div className="content" style={{ paddingBottom: 0 }}><ConnBanner conn={conn} cfg={cfg} /></div>}
        <header className="hdr">
          <button className="menu-btn" aria-label="Menu" onClick={() => setMenu(!menu)}><Icon name="menu" /></button>
          <div className="ttl"><h1>{current[1]}</h1><p>{SUBTITLE[r === "farmer" && current[0] === "products" ? "farmerProducts" : r === "underwriter" && current[0] === "policies" ? "uwPolicies" : current[0]] || ""}</p></div>
          <span className="envchip" title="Sample data on a local test network. Money is test money.">Test version</span>
          <div className="who">
            <select aria-label="Account" value={acct} onChange={(e) => switchAccount(e.target.value)}>
              {(own.smart || own.wallet) && <optgroup label="Your accounts">
                {own.smart && <option value="smart">{own.smart.label}</option>}
                {own.wallet && <option value="wallet">{own.wallet.label}</option>}
              </optgroup>}
              <optgroup label="Test accounts">{DEMO_ACCOUNTS.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}</optgroup>
            </select>
            <div className="muted">{short(address)} · {fmt(snap.balance)} RWF{account.kind === "smart" ? " · fees paid by FarmLedger" : ""} · <button className="link" onClick={connectWallet}>Connect wallet</button></div>
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
