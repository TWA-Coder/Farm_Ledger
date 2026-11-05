// Operator tool for phone accounts (services/phone-accounts.js). Never prints keys.
//   npm run accounts                    list phone accounts and number-change requests
//   npm run accounts -- cancel <id>     cancel a waiting number change (e.g. the farmer called to report fraud)
//   npm run accounts -- release <id>    end the waiting period now (after checking the farmer's ID in person);
//                                       the move completes the next time the farmer dials from the new number
const { ethers } = require("ethers");
const { loadDeployment, loadAbi } = require("./common");
const { createPhoneAccounts, loadSecret } = require("./phone-accounts");
const { sendSms } = require("./sms");
const dbm = require("../web/server/db");

async function main() {
  const [cmd = "list", arg] = process.argv.slice(2);
  const dep = loadDeployment();
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || dep.rpcUrl, undefined, { cacheTimeout: -1 });
  const accounts = createPhoneAccounts({
    provider, aa: dep.aa, ledgerAddress: dep.ledger, abi: loadAbi(),
    secret: loadSecret({ local: ["localhost", "hardhat"].includes(dep.network) }), sendSms,
  });
  const db = dbm.get();
  const time = (ms) => (ms ? new Date(ms).toLocaleString("en-GB") : "-");

  if (cmd === "list") {
    const rows = db.prepare("SELECT phone, account, status, created_at FROM phone_accounts ORDER BY created_at").all();
    console.log(`Phone accounts (${rows.length})`);
    for (const r of rows) console.log(`  +${r.phone}  ${r.account}  ${r.status}  since ${r.created_at}`);
    const reqs = accounts.requests();
    console.log(`Number changes (${reqs.length})`);
    for (const q of reqs) console.log(`  #${q.id}  +${q.old_phone} -> +${q.new_phone}  ${q.status}  ready ${time(q.ready_at)}${q.note ? `  (${q.note})` : ""}`);
  } else if (cmd === "cancel") {
    console.log((await accounts.cancelMove(Number(arg), "operator")) ? `Request #${arg} cancelled.` : `No waiting request #${arg}.`);
  } else if (cmd === "release") {
    console.log(accounts.releaseNow(Number(arg)) ? `Request #${arg} released. It completes when the farmer dials from the new number.` : `No waiting request #${arg}.`);
  } else {
    console.log("Usage: npm run accounts [-- list | cancel <id> | release <id>]");
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
