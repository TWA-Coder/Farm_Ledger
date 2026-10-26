// Notification + Mobile Money bridge (FR-11): texts farmers about every step of their cover, in chain order, and
// sends a Mobile Money disbursement for every payout. Logic: services/notifier-core.js; SMS: services/sms.js.
//
//   node services/notifier.js     (env: NOTIFIER_INTERVAL_MS 3000, NOTIFY_HISTORY=all, SMS settings in sms.js, MOMO_* in momo.js)
//
// Mobile Money (services/payments.js): payouts to phone-account farmers are sent to their MTN MoMo number, and
// premiums started from USSD are completed here. Simulated unless MTN MoMo credentials are set (see README).
const { ethers } = require("ethers");
const { connect, loadAbi } = require("./common");
const { createOutbox } = require("./sms");
const { createNotifier } = require("./notifier-core");
const { createPhoneAccounts, loadSecret } = require("./phone-accounts");
const { paymentsFromEnv } = require("./payments");

async function main() {
  const { dep, ledger, provider } = connect("notifier", "NOTIFIER_PRIVATE_KEY");
  const abi = loadAbi();
  const cropClaims = dep.cropClaims && abi.cropClaims ? new ethers.Contract(dep.cropClaims, abi.cropClaims, provider) : null;
  const desk = dep.policyDesk && abi.policyDesk ? new ethers.Contract(dep.policyDesk, abi.policyDesk, provider) : null;
  const local = ["localhost", "hardhat"].includes(dep.network);
  const outbox = createOutbox({ localChain: local });
  // Payments need the phone accounts (their keys sign the purchase and the payout sweep).
  const accounts = dep.aa && process.env.PHONE_ACCOUNTS !== "off"
    ? createPhoneAccounts({ provider, aa: dep.aa, ledgerAddress: dep.ledger, deskAddress: dep.policyDesk, abi, sendSms: (p, t, o) => outbox.sendNow(p, t, o),
      ...(process.env.CUSTODY_URL ? { custody: { url: process.env.CUSTODY_URL, token: process.env.CUSTODY_TOKEN } } : { secret: loadSecret({ local }) }) })
    : null;
  const payments = accounts ? paymentsFromEnv({ provider, dep, abi, accounts, outbox }) : null;
  const onPayout = async ({ holder, amount, policyId, txHash, phone }) => {
    const ref = payments && payments.startPayout({ holder, amount, policyId, txHash });
    console.log(ref ? `  MoMo payout ${ref.slice(0, 8)}: ${amount} RWF -> +${phone} (policy #${policyId})`
      : `  payout for policy #${policyId} stays in the farmer's own wallet (not a phone account)`);
  };
  const notifier = createNotifier({ provider, ledger, cropClaims, desk, outbox, onPayout });
  if (payments) console.log(`Mobile Money: ${payments.mode}`);
  console.log(`Notifier on ${dep.ledger}${cropClaims ? ` + CropClaims ${dep.cropClaims}` : ""} · SMS: ${outbox.describe}`);

  const every = Number(process.env.NOTIFIER_INTERVAL_MS || 3000);
  let failing = false;
  for (;;) {
    try {
      const r = await notifier.tick();
      if (payments) { const moved = await payments.tick(); if (moved) console.log(`${new Date().toISOString()}  ${moved} Mobile Money payment step(s) done`); }
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
