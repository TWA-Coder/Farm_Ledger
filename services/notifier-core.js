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
//
// Language: a farmer's message is a function of the SMS texts (services/sms-text.js) and is written in the language
// of the number it goes to (services/lang.js). Messages to agents are plain English strings.
const dbm = require("../web/server/db");
const indexer = require("../web/server/indexer");
const contacts = require("../web/server/contacts");
const { SMS } = require("./sms-text");
const lang = require("./lang");

const fmt = (n) => Number(n).toLocaleString("en-US");
const day = (ts) => new Date(Number(ts) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const LIVESTOCK = 3;
const CROP_STATUS = { Approved: 2, Rejected: 3, Superseded: 4 };

function createNotifier({ db = dbm.get(), provider, ledger, cropClaims = null, desk = null, outbox, onPayout = null, history = process.env.NOTIFY_HISTORY, startBlock = 0 }) {
  async function phoneOf(address) {
    const c = (await contacts.read(db))[String(address).toLowerCase()];
    if (c) return c.phone;
    const f = await ledger.getFarmer(address);
    return f.exists ? contacts.phoneForHash(f.phoneHash, db) : null;
  }
  const holderOf = async (policyId) => (await ledger.getPolicy(policyId)).holder;
  const coverOf = async (productId) => Number((await ledger.getProduct(productId)).cover);
  const masked = async (address) => { const p = await phoneOf(address); return p ? `+${p.slice(0, 5)}...${p.slice(-3)}` : "your farmer"; };

  // event -> [{to: address, text}] (and payouts for the Mobile Money bridge). text: a string (agents) or (s) => string
  // with s the farmer's SMS texts.
  async function messagesFor(e) {
    const a = e.args;
    switch (e.name) {
      case "FarmerRegistered":
        return [{ to: a.farmer, text: (s) => s.welcome(s.dial()) }];
      case "PolicyPurchased": {
        const block = await provider.getBlock(e.block);
        const booked = Number(a.start) > Number(block.timestamp) + 60;
        const subsidy = await ledger.subsidyOf(a.policyId).catch(() => 0n);
        return [{ to: a.holder, text: (s) => s.policyPurchased(a.policyId, booked ? s.stateBooked(s.day(a.start)) : s.stateActive, s.day(a.end), fmt(a.sumInsured),
          subsidy > 0n ? s.paidWithSubsidy(fmt(a.premium - subsidy), fmt(subsidy)) : s.paidPremium(fmt(a.premium))) }];
      }
      case "PolicyExpired":
        return [{ to: await holderOf(a.policyId), text: (s) => s.policyExpired(a.policyId) }];
      case "ClaimFiled":
        return [{ to: a.holder, text: (s) => s.claimFiled(a.claimId, a.policyId) }];
      case "ClaimSettled":
        return a.approved ? [] // the payout message follows from PayoutExecuted
          : [{ to: await holderOf(a.policyId), text: (s) => s.claimRejected(a.claimId) }];
      case "CropClaimFiled":
        return [{ to: a.holder, text: (s) => s.cropClaimFiled(a.claimId, a.policyId) }];
      case "CropClaimSettled": {
        const st = Number(a.status);
        if (st === CROP_STATUS.Rejected) return [{ to: await holderOf(a.policyId), text: (s) => s.cropClaimRejected(a.claimId) }];
        if (st === CROP_STATUS.Superseded) return [{ to: await holderOf(a.policyId), text: (s) => s.cropClaimSuperseded(a.claimId, a.policyId) }];
        return [];
      }
      case "PayoutExecuted": {
        const why = (s) => (a.automatic ? s.whyAuto : Number(a.cover) === LIVESTOCK ? s.whyVets : s.whyReviewers);
        return [{ to: a.holder, text: (s) => s.payout(fmt(a.amount), a.policyId, why(s)), payout: { amount: a.amount, policyId: a.policyId } }];
      }
      // ---- PolicyDesk: the application workflow (farmer and agent are both told)
      case "FarmerAssigned": {
        const agentPhone = await phoneOf(a.agent);
        return [
          { to: a.farmer, text: (s) => s.agentAssigned(agentPhone) },
          { to: a.agent, text: `FarmLedger: new farmer ${await masked(a.farmer)} assigned to you. Collect their details and submit an application on the portal.` },
        ];
      }
      case "ApplicationSubmitted": {
        const cover = await coverOf(a.productId);
        return [{ to: a.farmer, text: (s) => s.applicationSubmitted(s.coverWord[cover], fmt(a.sumInsured), a.applicationId) }];
      }
      case "ContractDrafted": {
        const app = await desk.getApplication(a.applicationId);
        const subsidy = await ledger.subsidyFor(a.farmer, app.productId, a.premium).catch(() => 0n);
        const until = day(a.offerExpires);
        return [
          { to: a.farmer, text: (s) => s.contractReady(a.applicationId, fmt(app.sumInsured), fmt(a.premium - subsidy), s.dial(), s.day(a.offerExpires)) },
          { to: a.agent, text: `FarmLedger: contract #${a.applicationId} for ${await masked(a.farmer)} is ready (valid to ${until}). Help them review and pay it.` },
        ];
      }
      case "ApplicationRejected":
        return [
          { to: a.farmer, text: (s) => s.applicationRejected(a.applicationId) },
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

  async function cursor() {
    const identity = `${await dbm.getMeta(db, "indexer_identity")}#${await dbm.getMeta(db, "indexer_epoch")}`;
    const mine = await dbm.getMeta(db, "notifier_identity");
    if (mine !== identity) {
      let start = "-1:-1";
      if (mine === null && history !== "all") {
        const last = await db.one("SELECT block, log_index FROM events ORDER BY block DESC, log_index DESC LIMIT 1");
        if (last) start = `${last.block}:${last.log_index}`;
      }
      await db.tx(async (t) => { await dbm.setMeta(t, "notifier_identity", identity); await dbm.setMeta(t, "notifier_cursor", start); });
    }
    return pos((await dbm.getMeta(db, "notifier_cursor")) ?? "-1:-1");
  }

  async function tick() {
    await indexer.sync({ db, provider, ledger, others: [cropClaims, desk].filter(Boolean), startBlock });
    let queued = 0, noPhone = 0;
    for (const e of await indexer.events(db, { after: await cursor() })) {
      const msgs = await messagesFor(e); // chain reads happen before the transaction; a failure retries next tick
      const resolved = [];
      for (const m of msgs) {
        const phone = await phoneOf(m.to);
        if (!phone) { noPhone++; continue; }
        resolved.push({ ...m, phone, text: typeof m.text === "function" ? m.text(SMS[await lang.langOf(db, phone)]) : m.text });
      }
      // the messages and the cursor move together: an event is never texted twice, nor skipped
      await db.tx(async (t) => {
        for (const [n, m] of resolved.entries()) if (await outbox.enqueue({ phone: m.phone, text: m.text, kind: e.name, key: `${e.tx}:${e.idx}:${n}` }, t)) queued++;
        await dbm.setMeta(t, "notifier_cursor", `${e.block}:${e.idx}`);
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
