// Notification + Mobile Money bridge (FR-11): texts farmers about every step of their cover, in chain order, and
// sends a Mobile Money disbursement for every payout. Logic: services/notifier-core.js; SMS: services/sms.js.
//
//   node services/notifier.js     (env: NOTIFIER_INTERVAL_MS 3000, NOTIFY_HISTORY=all, AT_* and SMS_ALLOWLIST, see sms.js)
//
// MoMo: stub - records the disbursement in services/out/momo-ledger.json (idempotent per payout reference).
//       Phase 6 replaces disburseMomo() with the MTN MoMo Disbursements sandbox.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { connect, loadAbi } = require("./common");
const { createOutbox } = require("./sms");
const { createNotifier } = require("./notifier-core");

const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
const MOMO_LEDGER = path.join(OUT, "momo-ledger.json");

async function disburseMomo({ phone, amount, ref }) {
  const ledger = fs.existsSync(MOMO_LEDGER) ? JSON.parse(fs.readFileSync(MOMO_LEDGER, "utf8")) : [];
  // Idempotency: the reference is unique per payout, so a payout is never disbursed twice (also across restarts).
  if (ledger.some((e) => e.reference === ref)) return console.log(`  MoMo: ${ref} already disbursed, skipping`);
  ledger.push({ at: new Date().toISOString(), msisdn: phone, amountRWF: Number(amount), reference: ref, status: "SIMULATED_SUCCESS" });
  fs.writeFileSync(MOMO_LEDGER, JSON.stringify(ledger, null, 2));
  console.log(`  MoMo (simulated): ${amount} RWF -> +${phone}  ref ${ref}`);
}

async function main() {
  const { dep, ledger, provider } = connect("notifier", "NOTIFIER_PRIVATE_KEY");
  const abi = loadAbi();
  const cropClaims = dep.cropClaims && abi.cropClaims ? new ethers.Contract(dep.cropClaims, abi.cropClaims, provider) : null;
  const outbox = createOutbox({ localChain: ["localhost", "hardhat"].includes(dep.network) });
  const notifier = createNotifier({ provider, ledger, cropClaims, outbox, onPayout: disburseMomo });
  console.log(`Notifier on ${dep.ledger}${cropClaims ? ` + CropClaims ${dep.cropClaims}` : ""} · SMS: ${outbox.mode}${process.env.SMS_ALLOWLIST ? ` (allowlist ${process.env.SMS_ALLOWLIST})` : ""}`);

  const every = Number(process.env.NOTIFIER_INTERVAL_MS || 3000);
  let failing = false;
  for (;;) {
    try {
      const r = await notifier.tick();
      if (r.queued || r.noPhone) console.log(`${new Date().toISOString()}  queued ${r.queued} SMS${r.noPhone ? `, ${r.noPhone} without a phone number on file` : ""}`);
      if (failing) { console.log("chain reachable again"); failing = false; }
    } catch (e) {
      if (!failing) console.error("notifier tick failed (will retry):", e.shortMessage || e.message);
      failing = true;
    }
    await new Promise((r) => setTimeout(r, every));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
