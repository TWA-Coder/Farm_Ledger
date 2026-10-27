"use client";
import { useState } from "react";
import { ethers } from "ethers";
import { Badge, Box, DataTable, Stat, Timeline } from "../components/ui";
import { COVER, fmt } from "../lib/chain";
import { cond, eventText, relevantEvents } from "../lib/format";

export function UwOverview({ ctx, snap, address, account, run, busy }) {
  const { ledger, token } = ctx;
  const [amt, setAmt] = useState(1000000);
  const p = snap.pool;
  const lossRatio = Number(p.premiums) > 0 ? ((Number(p.paidOut) / Number(p.premiums)) * 100).toFixed(1) : "0.0";
  const util = Number(p.balance) > 0 ? ((Number(p.reserved) / Number(p.balance)) * 100).toFixed(0) : "0";
  const recent = relevantEvents(snap, account, address).slice(0, 6);
  return (
    <>
      <div className="strip">
        <Stat tone="hi" value={fmt(p.balance)} label="Escrow balance (RWF)" />
        <Stat value={fmt(p.reserved)} label={`Reserved for open policies (${util}%)`} />
        <Stat value={fmt(p.available)} label="Available to underwrite / withdraw" />
        <Stat value={p.sold} label="Policies sold" />
        <Stat value={fmt(p.premiums)} label="Premiums collected" />
        <Stat value={fmt(p.paidOut)} label={`Claims paid (${p.payouts})`} />
        <Stat tone={Number(lossRatio) > 80 ? "warn" : ""} value={`${lossRatio}%`} label="Loss ratio" />
      </div>
      <div className="two">
        <Box title="Liquidity" sub="Money in escrow backs every policy. The full sum insured is reserved when a policy is sold, so a payout can never fail for lack of funds.">
          <div className="row">
            <div><label>Amount (RWF)</label><input type="number" value={amt} onChange={(e) => setAmt(Number(e.target.value))} /></div>
            <button className="btn" disabled={busy} onClick={() => run("Deposit", async () => {
              if (snap.allowance < amt) await (await token.approve(ctx.ledger.target, ethers.MaxUint256)).wait();
              await (await token.mint(address, amt)).wait(); // demo faucet so the deposit always succeeds
              await (await ledger.depositLiquidity(amt)).wait();
            })}>Deposit</button>
            <button className="btn sec" disabled={busy} onClick={() => run("Withdraw", async () => (await ledger.withdrawLiquidity(amt)).wait())}>Withdraw</button>
          </div>
        </Box>
        <Box title="Recent activity">
          {recent.length === 0 ? <p className="muted">Nothing yet.</p> : <Timeline items={recent.map((e) => ({ text: eventText(e), meta: "block " + e.block }))} />}
        </Box>
      </div>
    </>
  );
}

export function UwProducts({ ctx, snap, address, run, busy }) {
  const { ledger } = ctx;
  const [np, setNp] = useState({ cover: 0, threshold: 150, rate: 10, days: 120 });
  const mine = snap.products.filter((x) => x.underwriter.toLowerCase() === address.toLowerCase());
  return (
    <>
      <Box title="My products">
        <DataTable rows={mine} empty="No products yet." pageSize={6}
          filters={[{ value: "on", label: "Active" }, { value: "off", label: "Switched off" }]} filterFn={(x, f) => (f === "on") === x.active}
          columns={[
            { key: "id", label: "#", render: (x) => `#${x.id}` },
            { key: "cover", label: "Cover", render: (x) => COVER[Number(x.cover)], text: (x) => COVER[Number(x.cover)] },
            { key: "cond", label: "Pays when", render: (x) => cond(x.cover, x.threshold), text: (x) => cond(x.cover, x.threshold) },
            { key: "rateBps", label: "Rate", render: (x) => `${Number(x.rateBps) / 100}%`, sort: (x) => Number(x.rateBps) },
            { key: "durationDays", label: "Days", render: (x) => Number(x.durationDays), sort: (x) => Number(x.durationDays) },
            { key: "active", label: "Status", render: (x) => <Badge tone={x.active ? "g" : "n"}>{x.active ? "Active" : "Off"}</Badge>, text: (x) => (x.active ? "active" : "off") },
            { key: "act", label: "", render: (x) => <button className="btn sec sm" disabled={busy} onClick={(e) => { e.stopPropagation(); run(x.active ? "Deactivate" : "Activate", async () => (await ledger.setProductActive(x.id, !x.active)).wait()); }}>{x.active ? "Switch off" : "Switch on"}</button>, text: () => "" },
          ]} />
      </Box>
      <Box title="New product">
        <div className="row">
          <div><label>Cover</label><select value={np.cover} onChange={(e) => setNp({ ...np, cover: Number(e.target.value) })}>{COVER.map((c, i) => <option key={i} value={i}>{c}</option>)}</select></div>
          <div><label>{np.cover === 2 ? "Trigger NDVI (e.g. 0.30)" : "Trigger rainfall (mm / 30 days)"}</label><input type="number" disabled={np.cover === 3} value={np.threshold} onChange={(e) => setNp({ ...np, threshold: Number(e.target.value) })} /></div>
          <div><label>Premium rate (%)</label><input type="number" step="0.5" value={np.rate} onChange={(e) => setNp({ ...np, rate: Number(e.target.value) })} /></div>
          <div><label>Duration (days)</label><input type="number" value={np.days} onChange={(e) => setNp({ ...np, days: Number(e.target.value) })} /></div>
        </div>
        <p><button className="btn" disabled={busy} onClick={() => run("Create product", async () => {
          const scaled = np.cover === 2 ? Math.round(Number(np.threshold) * 10000) : Math.round(Number(np.threshold) * 10);
          await (await ledger.createProduct(np.cover, np.cover === 3 ? 0 : scaled, Math.round(np.rate * 100), np.days)).wait();
        })}>Create product</button></p>
      </Box>
    </>
  );
}
