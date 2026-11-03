// Farmer notifications from the event index, in chain order (services/notifier.js runs this in a loop).
//
// Each tick: bring the event index up to date (web/server/indexer.js), turn every event after the notifier's cursor
// into SMS for the farmer concerned, put them in the outbox (services/sms.js) and move the cursor, in ONE database
// transaction. The outbox key is "<tx>:<logIndex>:<n>", so a crash or restart can neither lose nor repeat a message,
// and messages go out in the order things happened on-chain (the old listener could text a payout before the
// purchase). Then the outbox is drained (retries, per-phone order).
//
// Cursor: on the very first start the notifier skips the existing history (NOTIFY_HISTORY=all to text it). When the
// index is rebuilt for a new chain (indexer_epoch changes) it starts from the beginning of that chain.
const dbm = require("../web/server/db");
const indexer = require("../web/server/indexer");
const contacts = require("../web/server/contacts");

const DIAL = () => process.env.USSD_SHORTCODE || "the FarmLedger USSD code";
const fmt = (n) => Number(n).toLocaleString("en-US");
const day = (ts) => new Date(Number(ts) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const LIVESTOCK = 3;
const CROP_STATUS = { Approved: 2, Rejected: 3, Superseded: 4 };

const COVER = ["drought", "flood", "crop stress", "cattle"];

function createNotifier({ db = dbm.get(), provider, ledger, cropClaims = null, desk = null, outbox, onPayout = null, history = process.env.NOTIFY_HISTORY }) {
  async function phoneOf(address) {
    const c = contacts.read(db)[String(address).toLowerCase()];
    if (c) return c.phone;
    const f = await ledger.getFarmer(address);
    return f.exists ? contacts.phoneForHash(f.phoneHash, db) : null;
  }
  const holderOf = async (policyId) => (await ledger.getPolicy(policyId)).holder;
  const coverOf = async (productId) => COVER[Number((await ledger.getProduct(productId)).cover)];
  const masked = async (address) => { const p = await phoneOf(address); return p ? `+${p.slice(0, 5)}...${p.slice(-3)}` : "your farmer"; };

  // event -> [{to: address, text}] (and payouts for the Mobile Money bridge)
  async function messagesFor(e) {
    const a = e.args;
    switch (e.name) {
      case "FarmerRegistered":
        return [{ to: a.farmer, text: `Welcome to FarmLedger. Your account is ready. Dial ${DIAL()} to check your cover and report claims.` }];
      case "PolicyPurchased": {
        const block = await provider.getBlock(e.block);
        const when = Number(a.start) > Number(block.timestamp) + 60 ? `booked, cover starts ${day(a.start)}` : "active";
        const subsidy = await ledger.subsidyOf(a.policyId).catch(() => 0n);
        const paid = subsidy > 0n ? `you paid ${fmt(a.premium - subsidy)} RWF (subsidy ${fmt(subsidy)} RWF)` : `premium ${fmt(a.premium)} RWF`;
        return [{ to: a.holder, text: `FarmLedger: policy #${a.policyId} ${when} until ${day(a.end)}. Cover ${fmt(a.sumInsured)} RWF, ${paid}.` }];
      }
      case "PolicyExpired":
        return [{ to: await holderOf(a.policyId), text: `FarmLedger: policy #${a.policyId} has ended. No payout was due. Thank you for insuring with FarmLedger.` }];
      case "ClaimFiled":
        return [{ to: a.holder, text: `FarmLedger: claim #${a.claimId} received for policy #${a.policyId}. A veterinarian will verify it.` }];
      case "ClaimSettled":
        return a.approved ? [] // the payout message follows from PayoutExecuted
          : [{ to: await holderOf(a.policyId), text: `FarmLedger: claim #${a.claimId} was not approved by the veterinarians. Your cover continues.` }];
      case "CropClaimFiled":
        return [{ to: a.holder, text: `FarmLedger: loss claim #${a.claimId} received for policy #${a.policyId}. The insurer's reviewers will assess it.` }];
      case "CropClaimSettled": {
        const s = Number(a.status);
        if (s === CROP_STATUS.Rejected) return [{ to: await holderOf(a.policyId), text: `FarmLedger: loss claim #${a.claimId} was not approved by the reviewers. Your cover continues.` }];
        if (s === CROP_STATUS.Superseded) return [{ to: await holderOf(a.policyId), text: `FarmLedger: loss claim #${a.claimId} is closed because policy #${a.policyId} was already paid automatically.` }];
        return [];
      }
      case "PayoutExecuted": {
        const why = a.automatic ? "triggered by weather/satellite data"
          : Number(a.cover) === LIVESTOCK ? "confirmed by certified veterinarians"
          : "loss claim approved by the insurer's reviewers";
        return [{ to: a.holder, text: `FarmLedger: ${fmt(a.amount)} RWF paid for policy #${a.policyId} (${why}).`, payout: { amount: a.amount, policyId: a.policyId } }];
      }
      // ---- PolicyDesk: the application workflow (farmer and agent are both told)
      case "FarmerAssigned": {
        const agentPhone = await phoneOf(a.agent);
        return [
          { to: a.farmer, text: `FarmLedger: your insurance agent${agentPhone ? ` is on +${agentPhone}` : " has been assigned"}. They will collect your details and apply for cover for you.` },
          { to: a.agent, text: `FarmLedger: new farmer ${await masked(a.farmer)} assigned to you. Collect their details and submit an application on the portal.` },
        ];
      }
      case "ApplicationSubmitted":
        return [{ to: a.farmer, text: `FarmLedger: your agent applied for ${await coverOf(a.productId)} cover of ${fmt(a.sumInsured)} RWF (application #${a.applicationId}). The insurer will review it.` }];
      case "ContractDrafted": {
        const app = await desk.getApplication(a.applicationId);
        const subsidy = await ledger.subsidyFor(a.farmer, app.productId, a.premium).catch(() => 0n);
        const until = day(a.offerExpires);
        return [
          { to: a.farmer, text: `FarmLedger: your contract #${a.applicationId} is ready: cover ${fmt(app.sumInsured)} RWF, you pay ${fmt(a.premium - subsidy)} RWF. Dial ${DIAL()}, choose 6 to review and pay by ${until}.` },
          { to: a.agent, text: `FarmLedger: contract #${a.applicationId} for ${await masked(a.farmer)} is ready (valid to ${until}). Help them review and pay it.` },
        ];
      }
      case "ApplicationRejected":
        return [
          { to: a.farmer, text: `FarmLedger: application #${a.applicationId} was not accepted by the insurer. Your agent will explain why and can apply again.` },
          { to: a.agent, text: `FarmLedger: application #${a.applicationId} for ${await masked(a.farmer)} was rejected. See the reasons on the portal.` },
        ];
      case "PolicyIssuedFromApplication": {
        const app = await desk.getApplication(a.applicationId);
        return [{ to: app.agent, text: `FarmLedger: ${await masked(a.farmer)} accepted contract #${a.applicationId}; policy #${a.policyId} is issued.` }];
      }
      case "OfferDeclined": {
        const app = await desk.getApplication(a.applicationId);
        return [{ to: app.agent, text: `FarmLedger: ${await masked(a.farmer)} declined contract #${a.applicationId}.` }];
      }
      default:
        return [];
    }
  }

  const pos = (s) => { const [block, idx] = String(s).split(":").map(Number); return { block, idx }; };

  function cursor() {
    const identity = `${dbm.getMeta(db, "indexer_identity")}#${dbm.getMeta(db, "indexer_epoch")}`;
    if (dbm.getMeta(db, "notifier_identity") !== identity) {
      const firstStart = dbm.getMeta(db, "notifier_identity") === null;
      let start = "-1:-1";
      if (firstStart && history !== "all") {
        const last = db.prepare("SELECT block, log_index FROM events ORDER BY block DESC, log_index DESC LIMIT 1").get();
        if (last) start = `${last.block}:${last.log_index}`;
      }
      dbm.tx(db, () => { dbm.setMeta(db, "notifier_identity", identity); dbm.setMeta(db, "notifier_cursor", start); });
    }
    return pos(dbm.getMeta(db, "notifier_cursor") ?? "-1:-1");
  }

  async function tick() {
    await indexer.sync({ db, provider, ledger, others: [cropClaims, desk].filter(Boolean) });
    let queued = 0, noPhone = 0;
    for (const e of indexer.events(db, { after: cursor() })) {
      const msgs = await messagesFor(e); // chain reads happen before the transaction; a failure retries next tick
      const resolved = [];
      for (const m of msgs) {
        const phone = await phoneOf(m.to);
        if (phone) resolved.push({ ...m, phone }); else noPhone++;
      }
      dbm.tx(db, () => {
        resolved.forEach((m, n) => { if (outbox.enqueue({ phone: m.phone, text: m.text, kind: e.name, key: `${e.tx}:${e.idx}:${n}` })) queued++; });
        dbm.setMeta(db, "notifier_cursor", `${e.block}:${e.idx}`);
      });
      if (onPayout) for (const m of resolved) if (m.payout) await onPayout({ phone: m.phone, holder: m.to, ...m.payout, txHash: e.tx });
    }
    const sent = await outbox.drain();
    if (outbox.refreshStatuses) await outbox.refreshStatuses(); // Intouch has no delivery webhook
    return { queued, sent, noPhone };
  }

  return { tick, messagesFor };
}

module.exports = { createNotifier };
