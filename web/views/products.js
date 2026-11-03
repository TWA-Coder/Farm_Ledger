"use client";
import requirements from "../shared/requirements";
import { Badge, Box } from "../components/ui";
import { fmt } from "../lib/chain";
import { COVER_PLAIN, DAY, cond } from "../lib/format";

const EXAMPLE_SUM = 100000;

// Rules below are the ones the smart contract actually enforces (contracts/FarmLedger.sol), not marketing text.
function rulesFor(cover, snap) {
  const common = [
    "Cover starts on the date you choose (today, or up to 90 days ahead) and ends on the date you choose. It can never start in the past.",
    "The insurer sets aside the full amount insured when you buy, so the money for your payout is always there.",
    "A payout pays the full amount insured and ends the policy.",
  ];
  if (cover === 3) {
    const wait = Math.round(Number(snap.waiting) / DAY);
    return [
      ...common,
      wait > 0 ? `You can report a death only after a waiting period of ${wait} day${wait === 1 ? "" : "s"} from the start of cover.` : "Waiting period: none in this test version (the standard contract uses one for deaths from disease).",
      "One active policy per animal. Each ear tag can be registered only once.",
      `${snap.vetQuorum} different certified veterinarian${snap.vetQuorum > 1 ? "s" : ""} must confirm the death. A vet cannot confirm their own claim.`,
      "If enough vets reject the claim, it is closed and your cover continues.",
    ];
  }
  return [
    ...common,
    "Only readings taken after your cover started count.",
    "You do not need to report anything: the payout happens when a reading meets the terms.",
  ];
}

export function Products({ snap, go }) {
  const active = snap.products.filter((p) => p.active);
  return (
    <>
      <div className="callout">
        <b>This is a test version.</b> Premiums and payouts use test money. The covers below follow the rules written in the FarmLedger smart contract.
        Some parts of the standard Rwandan (NAIS) contracts are not included yet: the 40% government share of the premium, the excess (deductible), and cause-of-death rules.
      </div>
      {active.length === 0 && <Box title="No cover is offered at the moment"><p className="muted">The insurer has not opened any products yet.</p></Box>}
      {active.map((p) => {
        const cover = Number(p.cover);
        const info = COVER_PLAIN[cover];
        const rate = Math.min(...(p.levels?.length ? p.levels : [p]).map((l) => Number(l.rateBps))) / 100;
        const docs = requirements.documentsFor({ cover });
        return (
          <Box key={p.id} title={info.name} sub={info.what} right={<Badge tone="g">from {rate}% of the amount insured</Badge>}>
            <dl className="kv">
              <dt>{cover === 3 ? "Pays when" : "Choose when it pays"}</dt><dd>{cover === 3 ? cond(p.cover, p.threshold) : (
                <ul className="plainlist">{(p.levels || []).map((l) => <li key={l.level}>{cond(p.cover, l.threshold)}: {Number(l.rateBps) / 100}% of the amount insured for {Number(p.durationDays)} days</li>)}</ul>
              )}</dd>
              {cover !== 3 && <><dt>How it is measured</dt><dd>{cover === 2 ? "NDVI, a satellite index of how green and healthy the crop is, from 0 (bare soil) to 1 (dense green crop)." : "Total millimetres of rain on your plot over the previous 30 days, from weather and satellite data."}</dd></>}
              <dt>Who decides</dt><dd>{info.decides}</dd>
              <dt>Cost example</dt><dd>To insure {fmt(EXAMPLE_SUM)} RWF for {Number(p.durationDays)} days at the standard level you pay {fmt(Math.max(1, Math.floor((EXAMPLE_SUM * Number(p.rateBps)) / 10000)))} RWF once.</dd>
              <dt>Length of cover</dt><dd>You choose: from {Math.min(30, Number(p.durationDays))} to {Number(p.durationDays)} days, starting today or on a date up to 90 days ahead. The premium is pro-rated by days.</dd>
              <dt>You need</dt><dd>A registered {info.asset === "animal" ? "animal with its ear tag number" : "plot with its location"}, and these documents:
                <ul className="plainlist">{docs.map((d) => <li key={d.id}>{d.label}{d.required ? "" : " (optional)"}</li>)}</ul>
              </dd>
              <dt>Rules</dt><dd><ul className="plainlist">{rulesFor(cover, snap).map((r, i) => <li key={i}>{r}</li>)}</ul></dd>
            </dl>
            <button className="btn" onClick={() => go("buy", { pid: p.id })}>Apply for {info.name.toLowerCase()}</button>
          </Box>
        );
      })}
    </>
  );
}
