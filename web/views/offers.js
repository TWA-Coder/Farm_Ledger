"use client";
// The farmer's side of an application: what their agent submitted, and the contracts the underwriter drafted, to
// accept (paying the premium) or decline. Farmers on a basic phone do the same with USSD option 6 and Mobile Money.
import { useEffect, useState } from "react";
import { Box, DataTable } from "../components/ui";
import { fmt } from "../lib/chain";
import { COVER_PLAIN } from "../lib/format";
import { DecisionView, appBadge } from "./desk";

const OFFERED = 2;

export function FarmerOffers({ ctx, snap, run, busy, address }) {
  const [open, setOpen] = useState(null);
  const app = snap.applications.find((a) => a.id === open);
  const ag = snap.myAgent;
  return (
    <>
      <Box title="My agent" sub="Your insurance agent collects your details and applies for cover for you.">
        {ag ? <p><b>{ag.label}</b> · {ag.district}</p> : <p className="muted">No agent is assigned to you yet. FarmLedger assigns one by district when you register.</p>}
      </Box>
      <Box title="Applications and contracts" sub="When the insurer drafts your contract you get an SMS. Review it here, then accept and pay, or decline.">
        <DataTable rows={snap.applications} pageSize={8} empty="No applications yet. Ask your agent to apply for cover." onRow={(a) => setOpen(a.id)} initialSort={{ key: "id", dir: "desc" }} columns={[
          { key: "id", label: "#", render: (a) => `#${a.id}` },
          { key: "cover", label: "Cover", render: (a) => COVER_PLAIN[Number(snap.products.find((p) => p.id === Number(a.productId))?.cover ?? 0)].name },
          { key: "sum", label: "Sum insured", render: (a) => `${fmt(a.sumInsured)} RWF`, sort: (a) => Number(a.sumInsured) },
          { key: "status", label: "Status", render: (a) => appBadge(a, snap.now), text: (a) => a.statusName },
        ]} />
      </Box>
      {app && (
        <DecisionView app={app} ctx={ctx} snap={snap} onClose={() => setOpen(null)} title={app.status === OFFERED ? `Contract #${app.id}` : `Application #${app.id}`}>
          {app.status === OFFERED && Number(app.offerExpires) >= snap.now && <Accept app={app} ctx={ctx} snap={snap} run={run} busy={busy} address={address} onDone={() => setOpen(null)} />}
        </DecisionView>
      )}
    </>
  );
}

function Accept({ app, ctx, snap, run, busy, address, onDone }) {
  const { desk, ledger, token, signer } = ctx;
  const [quote, setQuote] = useState(null);
  useEffect(() => {
    let live = true;
    ledger.subsidyFor(address, app.productId, app.premium).catch(() => 0n).then((s) => live && setQuote({ subsidy: s, pays: BigInt(app.premium) - s }));
    return () => { live = false; };
  }, [ledger, address, app.productId, app.premium]);
  const accept = () => run(`Accepting contract #${app.id}`, async () => {
    const pays = quote.pays;
    if (snap.balance < pays) throw new Error(`Your balance (${fmt(snap.balance)} RWF) is lower than the premium (${fmt(pays)} RWF).`);
    let rc;
    if (signer.sendCalls) { // smart account: approve and accept in ONE operation
      rc = await (await signer.sendCalls([
        { to: token.target, data: token.interface.encodeFunctionData("approve", [ledger.target, pays]) },
        { to: desk.target, data: desk.interface.encodeFunctionData("acceptOffer", [app.id]) },
      ])).wait();
    } else {
      if (snap.allowance < pays) await (await token.approve(ledger.target, pays)).wait();
      rc = await (await desk.acceptOffer(app.id)).wait();
    }
    onDone();
    return rc;
  });
  const decline = () => run(`Declining contract #${app.id}`, async () => { const rc = await (await desk.declineOffer(app.id)).wait(); onDone(); return rc; });
  return (
    <>
      <h3 className="formhead">Your decision</h3>
      {quote && <div className="quote"><span className="muted">You pay now</span><b>{fmt(quote.pays)} RWF</b><span className="muted">{quote.subsidy > 0n ? `Premium ${fmt(app.premium)} RWF minus a government subsidy of ${fmt(quote.subsidy)} RWF.` : "The full premium."} Your policy is issued as soon as you pay.</span></div>}
      <div className="row">
        <button className="btn" disabled={busy || !quote} onClick={accept}>Accept and pay</button>
        <button className="btn sec" disabled={busy} onClick={decline}>Decline</button>
      </div>
    </>
  );
}
