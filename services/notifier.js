// Notification + Mobile Money bridge (FR-11).
// Listens to on-chain events and, for every payout, sends the farmer an SMS and a Mobile Money disbursement.
//
// SMS: set AT_USERNAME / AT_API_KEY (Africa's Talking sandbox) to send for real; otherwise the SMS is only logged.
// MoMo: stub - records the disbursement in services/out/momo-ledger.json. Replace disburseMomo() with the
//       MTN MoMo "Disbursements" sandbox API call for a live integration.
//
//   node services/notifier.js
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { connect } = require("./common");

const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
const MOMO_LEDGER = path.join(OUT, "momo-ledger.json");

// Only a hash of the number is on-chain, so the notifier looks the plain number up in the off-chain database
// (contacts saved by farmers on the portal, and the seeded demo farmers).
const contacts = require("../web/server/contacts");
const phoneFor = (phoneHash) => contacts.phoneForHash(phoneHash);

const { sendSms } = require("./sms");

async function disburseMomo(phone, amount, ref) {
  const ledger = fs.existsSync(MOMO_LEDGER) ? JSON.parse(fs.readFileSync(MOMO_LEDGER, "utf8")) : [];
  // Idempotency: the reference is unique per payout, so a payout is never disbursed twice (also across restarts).
  if (ledger.some((e) => e.reference === ref)) return console.log(`  MoMo: ${ref} already disbursed, skipping`);
  ledger.push({ at: new Date().toISOString(), msisdn: phone, amountRWF: amount, reference: ref, status: "SIMULATED_SUCCESS" });
  fs.writeFileSync(MOMO_LEDGER, JSON.stringify(ledger, null, 2));
  console.log(`  MoMo (simulated): ${amount} RWF -> +${phone}  ref ${ref}`);
}

async function main() {
  const { ledger, provider } = connect("notifier", "NOTIFIER_PRIVATE_KEY");
  console.log("Notifier listening on", await ledger.getAddress());

  // Event polling can deliver the same log more than once: handle each (tx, logIndex) exactly once.
  const seen = new Set();
  const once = (handler) => async (...args) => {
    const log = args[args.length - 1].log;
    const key = `${log.transactionHash}:${log.index}`;
    if (seen.has(key)) return;
    seen.add(key);
    await handler(...args);
  };

  const holderPhone = async (holder) => {
    const f = await ledger.getFarmer(holder);
    return phoneFor(f.phoneHash);
  };

  ledger.on("PolicyPurchased", once(async (policyId, holder, productId, assetId, sumInsured, premium, start, end) => {
    const phone = await holderPhone(holder);
    const day = (ts) => new Date(Number(ts) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    const block = await provider.getBlock("latest");
    const when = Number(start) > Number(block.timestamp) + 60 ? `booked, cover starts ${day(start)}` : "active";
    // premium in the event is the full premium; the farmer paid it minus any government subsidy
    const subsidy = await ledger.subsidyOf(policyId).catch(() => 0n);
    const paid = subsidy > 0n ? `you paid ${premium - subsidy} RWF (government subsidy ${subsidy} RWF)` : `premium ${premium} RWF`;
    if (phone) await sendSms(phone, `FarmLedger: policy #${policyId} ${when} until ${day(end)}. Cover ${sumInsured} RWF, ${paid}.`);
  }));

  ledger.on("ClaimFiled", once(async (claimId, policyId, holder) => {
    const phone = await holderPhone(holder);
    if (phone) await sendSms(phone, `FarmLedger: claim #${claimId} received for policy #${policyId}. A veterinarian will verify it.`);
  }));

  ledger.on("PayoutExecuted", once(async (policyId, holder, amount, cover, automatic, ev) => {
    const phone = await holderPhone(holder);
    if (!phone) return console.log(`payout for policy ${policyId}: no phone on file for ${holder}`);
    const why = automatic ? "triggered by satellite/weather data"
      : Number(cover) === 3 ? "confirmed by certified veterinarians" // livestock
      : "loss claim approved by the insurer's reviewers"; // crop loss claim (CropClaims)
    await sendSms(phone, `FarmLedger: ${amount} RWF paid for policy #${policyId} (${why}).`);
    await disburseMomo(phone, Number(amount), `policy-${policyId}-${ev.log.transactionHash.slice(0, 10)}`);
  }));

  provider.on("error", (e) => console.error("provider error:", e.message));
  await new Promise(() => {}); // keep running
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
