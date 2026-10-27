"use client";
import { useRef, useState } from "react";
import { Box, Icon } from "../../components/ui";

const PHONES = [
  { n: "250788000001", label: "Aline (registered farmer)" },
  { n: "250788000002", label: "Jean (registered farmer)" },
  { n: "250788000201", label: "Unregistered number" },
];

export default function UssdChannel() {
  const [service, setService] = useState("http://localhost:4000");
  const [phone, setPhone] = useState(PHONES[0].n);
  const [inputs, setInputs] = useState([]);
  const [screen, setScreen] = useState("");
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const [value, setValue] = useState("");
  const sid = useRef("");

  async function send(nextInputs) {
    setBusy(true);
    try {
      const res = await fetch(service.replace(/\/$/, "") + "/ussd", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ sessionId: sid.current, serviceCode: "*384*55#", phoneNumber: "+" + phone, text: nextInputs.join("*") }),
      });
      const raw = await res.text();
      const end = raw.startsWith("END");
      const body = raw.replace(/^(CON|END) /, "");
      setScreen(body);
      setLive(!end);
      setLog((l) => [...l, { me: nextInputs.length ? nextInputs[nextInputs.length - 1] : "*384*55#", reply: body, end }]);
    } catch {
      setScreen("Cannot reach the USSD service.\nStart it with:  npm run ussd");
      setLive(false);
    }
    setBusy(false);
  }

  function dial() {
    sid.current = "sim-" + Date.now();
    setInputs([]); setLog([]); setValue("");
    send([]);
  }
  function submit(e) {
    e.preventDefault();
    if (!live || busy) return;
    const next = [...inputs, value.trim()];
    setInputs(next); setValue("");
    send(next);
  }

  return (
    <div className="plain">
      <header className="plainbar">
        <div className="brand" style={{ padding: 0 }}><i>FL</i><div>FarmLedger<small>USSD channel</small></div></div>
        <a href="/"><Icon name="home" size={15} /> Back to the portal</a>
      </header>
      <main className="content">
        <div className="callout">
          The USSD channel is for <b>checking policies, registering a claim and following its progress</b>. Policies are applied for, paid for and issued on the web portal only.
        </div>
        <div className="two">
          <Box title="Handset simulator" sub="Behaves like a basic phone without internet. Dial, then answer with numbers.">
            <label htmlFor="ph">Phone number</label>
            <select id="ph" value={phone} onChange={(e) => setPhone(e.target.value)}>
              {PHONES.map((p) => <option key={p.n} value={p.n}>{p.label} · +{p.n}</option>)}
            </select>
            <label htmlFor="ph2">Or type any number</label>
            <input id="ph2" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
            <p><button className="btn" onClick={dial} disabled={busy}>Dial *384*55#</button></p>
            <div className="handset" aria-live="polite">
              {screen || "Press Dial to start."}
              {screen && !live && <div style={{ marginTop: 10, opacity: 0.7 }}>Session ended</div>}
            </div>
            <form onSubmit={submit} className="row" style={{ marginTop: 10 }}>
              <input aria-label="Your answer" value={value} onChange={(e) => setValue(e.target.value)} placeholder={live ? "Type your answer" : "Dial first"} disabled={!live || busy} autoComplete="off" />
              <button className="btn" disabled={!live || busy || value.trim() === ""}>Send</button>
            </form>
            <label htmlFor="svc">Service address</label>
            <input id="svc" value={service} onChange={(e) => setService(e.target.value)} />
          </Box>

          <Box title="Available options">
            <table>
              <thead><tr><th>Option</th><th>What it does</th></tr></thead>
              <tbody>
                <tr><td><b>1</b> My policies</td><td>Lists your policies, then shows cover, premium, dates and status for the one you choose.</td></tr>
                <tr><td><b>2</b> Report a claim</td><td>Registers a cattle death claim on an active policy. Needs your PIN. Crop cover pays automatically and needs no claim.</td></tr>
                <tr><td><b>3</b> Claim status</td><td>Shows whether a claim is awaiting veterinarians, approved and paid, or rejected.</td></tr>
              </tbody>
            </table>
            <p className="muted" style={{ marginTop: 10 }}>First call: you will be asked to choose a 4-digit PIN. A number that is not registered on the portal receives an instruction to register there.</p>
            <h2 style={{ marginTop: 16 }}>Conversation</h2>
            <div className="feed" style={{ maxHeight: 260 }}>
              {log.map((l, i) => (
                <div key={i} style={{ padding: "6px 0", borderTop: i ? "1px solid var(--bd)" : 0 }}><b>You:</b> {l.me}<br /><span className="muted">{l.reply.replace(/\n/g, " / ")}</span></div>
              ))}
              {log.length === 0 && <span className="muted">Nothing yet.</span>}
            </div>
          </Box>
        </div>
      </main>
    </div>
  );
}
