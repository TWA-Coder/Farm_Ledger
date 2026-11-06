// MTN Mobile Money operator tool.
//   npm run momo                        list recent payments (premiums, payouts, refunds) and their step
//   npm run momo -- provision <host>    sandbox only: create the API user + key for Collections and Disbursements,
//                                       using MOMO_COLLECTION_KEY / MOMO_DISBURSEMENT_KEY (your subscription keys).
//                                       <host> = callback host, e.g. your tunnel's hostname (any value works for polling)
//   npm run momo -- retry <ref> --by <name>   send a failed payout or refund again (logged with the operator's name)
require("./common"); // .env
const { ethers } = require("ethers");
const { loadDeployment, loadAbi } = require("./common");
const { createMomo, configFromEnv } = require("./momo");
const dbm = require("../web/server/db");
const oplog = require("./operator-log");

async function main() {
  const [cmd = "list", arg] = process.argv.slice(2);
  if (cmd === "provision") {
    const cfg = configFromEnv();
    if (cfg.targetEnv !== "sandbox") throw new Error("Provisioning is for the sandbox only; MTN issues live credentials.");
    const momo = createMomo(cfg);
    const host = arg || "example.org";
    for (const product of ["COLLECTION", "DISBURSEMENT"]) {
      const key = process.env[`MOMO_${product}_KEY`];
      if (!key) { console.log(`MOMO_${product}_KEY is not set: skipping ${product.toLowerCase()}`); continue; }
      const r = await momo.provision(key, host);
      console.log(`MOMO_${product}_USER=${r.user}\nMOMO_${product}_API_KEY=${r.apiKey}`);
    }
    console.log("\nAdd the lines above to .env (keep them out of git and chat), then restart npm run phone.");
    return;
  }
  const db = dbm.get();
  if (cmd === "list") {
    const rows = db.prepare("SELECT * FROM momo_payments ORDER BY created_at DESC LIMIT 20").all();
    console.log(`Mobile Money payments (${rows.length} most recent)`);
    for (const r of rows) {
      console.log(`  ${new Date(r.created_at).toLocaleString("en-GB")}  ${r.kind.padEnd(7)} ${r.status.padEnd(10)} ${String(r.amount).padStart(9)} ${r.currency}  +${r.phone}`
        + `${r.policy_id ? `  policy #${r.policy_id}` : ""}  ref ${r.ref.slice(0, 8)}${r.reason ? `  (${r.reason})` : ""}`);
    }
    return;
  }
  if (cmd === "retry") {
    const by = oplog.operatorFrom(process.argv);
    const { createPayments } = require("./payments");
    const dep = loadDeployment();
    const full = db.prepare("SELECT ref FROM momo_payments WHERE ref LIKE ?").get(`${arg}%`);
    if (!full) throw new Error(`No payment with reference ${arg}`);
    // retry only re-queues the row; the notifier sends it on its next tick
    const p = createPayments({ db, provider: new ethers.JsonRpcProvider(dep.rpcUrl), ledgerAddress: dep.ledger, tokenAddress: dep.token, abi: loadAbi(),
      accounts: null, momo: { config: { currency: "-" } }, outbox: null, treasury: ethers.Wallet.createRandom() });
    const ok = p.retry(full.ref);
    if (ok) oplog.record({ operator: by, command: "momo retry", target: full.ref });
    console.log(ok ? "Queued again; the notifier sends it within a few seconds." : "Only a failed payout or refund can be retried.");
    return;
  }
  console.log("Usage: npm run momo [-- list | provision <host> | retry <ref> --by <name>]");
  process.exitCode = 1;
}

main().catch((e) => { console.error(e.message); process.exit(1); });
