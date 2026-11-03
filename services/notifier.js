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
const SMS_LOG = path.join(OUT, "sms.log");
const MOMO_LEDGER = path.join(OUT, "momo-ledger.json");

// Demo phone book: only a hash of the number is on-chain, so the notifier needs the plain numbers it is allowed to use.
const PHONEBOOK_FILE = path.join(__dirname, "phonebook.json");
function phoneFor(phoneHash) {
  const book = JSON.parse(fs.readFileSync(PHONEBOOK_FILE, "utf8")).phones.slice();
  try { // numbers registered through USSD
    book.push(...Object.keys(JSON.parse(fs.readFileSync(path.join(OUT, "ussd-users.json"), "utf8"))));
  } catch {}
  try { // numbers farmers confirmed on the web portal at registration (web/server/contacts.js)
    const contacts = JSON.parse(fs.readFileSync(process.env.CONTACTS_FILE || path.join(__dirname, "..", "web", ".data", "contacts.json"), "utf8"));
    book.push(...Object.values(contacts).map((c) => c.phone));
  } catch {}
  return book.find((p) => ethers.keccak256(ethers.toUtf8Bytes(p)) === phoneHash) || null;
}

async function sendSms(phone, text) {
  const line = `${new Date().toISOString()}  SMS -> +${phone}: ${text}`;
  fs.appendFileSync(SMS_LOG, line + "\n");
  console.log(line);
  if (process.env.AT_USERNAME && process.env.AT_API_KEY) {
    try {
      const sandbox = process.env.AT_USERNAME === "sandbox";
      const res = await fetch(`https://api.${sandbox ? "sandbox." : ""}africastalking.com/version1/messaging`, {
        method: "POST",
        headers: { apiKey: process.env.AT_API_KEY, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ username: process.env.AT_USERNAME, to: `+${phone}`, message: text }),
      });
      console.log(`  Africa's Talking: HTTP ${res.status}`);
    } catch (e) {
      console.error("  Africa's Talking failed (SMS still logged):", e.message);
    }
  }
}

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
    if (phone) await sendSms(phone, `FarmLedger: policy #${policyId} ${when} until ${day(end)}. Cover ${sumInsured} RWF, premium ${premium} RWF.`);
  }));

  ledger.on("ClaimFiled", once(async (claimId, policyId, holder) => {
    const phone = await holderPhone(holder);
    if (phone) await sendSms(phone, `FarmLedger: claim #${claimId} received for policy #${policyId}. A veterinarian will verify it.`);
  }));

  ledger.on("PayoutExecuted", once(async (policyId, holder, amount, cover, automatic, ev) => {
    const phone = await holderPhone(holder);
    if (!phone) return console.log(`payout for policy ${policyId}: no phone on file for ${holder}`);
    const why = automatic ? "triggered by satellite/weather data" : "confirmed by certified veterinarians";
    await sendSms(phone, `FarmLedger: ${amount} RWF paid for policy #${policyId} (${why}).`);
    await disburseMomo(phone, Number(amount), `policy-${policyId}-${ev.log.transactionHash.slice(0, 10)}`);
  }));

  provider.on("error", (e) => console.error("provider error:", e.message));
  await new Promise(() => {}); // keep running
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
