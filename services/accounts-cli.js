// Operator tool for phone accounts (services/phone-accounts.js). Never prints keys.
//   npm run accounts                    list phone accounts and number-change requests
//   npm run accounts -- cancel <id> --by <name>
//        cancel a waiting number change (e.g. the farmer called to report fraud)
//   npm run accounts -- release <id> --agent <agent address> --by <name>
//        end the waiting period now. Only after the farmer's OWN insurance agent checked their National ID in person:
//        the agent named must be the one assigned to the farmer on-chain. The move completes when the farmer next dials.
//   npm run accounts -- log             the operator log
// Changing commands are recorded with the operator's name (services/operator-log.js).
const { ethers } = require("ethers");
const { loadDeployment, loadAbi } = require("./common");
const { createPhoneAccounts, loadSecret } = require("./phone-accounts");
const { sendSms } = require("./sms");
const dbm = require("../web/server/db");
const oplog = require("./operator-log");

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
    const rows = await db.all("SELECT phone, account, status, created_at FROM phone_accounts ORDER BY created_at");
    console.log(`Phone accounts (${rows.length})`);
    for (const r of rows) console.log(`  +${r.phone}  ${r.account}  ${r.status}  since ${r.created_at}`);
    const reqs = await accounts.requests();
    console.log(`Number changes (${reqs.length})`);
    for (const q of reqs) console.log(`  #${q.id}  +${q.old_phone} -> +${q.new_phone}  ${q.status}  ready ${time(q.ready_at)}${q.note ? `  (${q.note})` : ""}`);
  } else if (cmd === "cancel") {
    const by = oplog.operatorFrom(process.argv);
    const ok = await accounts.cancelMove(Number(arg), `operator ${by}`);
    if (ok) await oplog.record({ operator: by, command: "accounts cancel", target: `move #${arg}` });
    console.log(ok ? `Request #${arg} cancelled.` : `No waiting request #${arg}.`);
  } else if (cmd === "release") {
    const by = oplog.operatorFrom(process.argv);
    const agent = oplog.flag(process.argv, "--agent");
    const q = (await accounts.requests("waiting")).find((r) => r.id === Number(arg));
    if (!q) { console.log(`No waiting request #${arg}.`); return; }
    if (!agent || !ethers.isAddress(agent)) throw new Error("Name the farmer's agent who checked the ID in person: --agent <address>.");
    if (!dep.policyDesk) throw new Error("PolicyDesk is not deployed: there is no agent to confirm the farmer's identity.");
    const desk = new ethers.Contract(dep.policyDesk, loadAbi().policyDesk, provider);
    const assigned = await desk.agentOf(q.account);
    if (assigned.toLowerCase() !== agent.toLowerCase()) throw new Error(`That is not this farmer's agent (on-chain: ${assigned}). Nothing was released.`);
    await accounts.releaseNow(q.id);
    await oplog.record({ operator: by, command: "accounts release", target: `move #${q.id}`, detail: `ID checked by agent ${agent}` });
    console.log(`Request #${q.id} released (ID checked by agent ${agent}). It completes when the farmer dials from the new number.`);
  } else if (cmd === "log") {
    for (const r of await oplog.recent()) console.log(`  ${r.at}  ${r.operator}  ${r.command}  ${r.target}${r.detail ? `  (${r.detail})` : ""}`);
  } else {
    console.log("Usage: npm run accounts [-- list | log | cancel <id> --by <name> | release <id> --agent <address> --by <name>]");
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
