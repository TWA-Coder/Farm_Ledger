// USSD gateway callback server (Africa's Talking format).
//   npm run ussd                      -> http://localhost:4000/ussd
// Point the Africa's Talking USSD "callback URL" at https://<your-host>/ussd for a real shortcode.
//
// Env: USSD_PORT (4000)  RPC_URL  AGENT_PRIVATE_KEY (non-local networks)
//
// Monitoring and claim registration, plus phone accounts for farmers on basic phones (register, PIN reset, number
// change) when the smart-account contracts are deployed. The gateway key holds CLAIMS_AGENT_ROLE and nothing else;
// farmer keys live only in phone-accounts.js (encrypted). See ussd-core.js.
//
// Env: PHONE_ACCOUNTS=off disables account services. PHONE_KEY_SECRET (required off the local chain),
//      RECOVERY_DELAY_HOURS (48), AT_USERNAME / AT_API_KEY for real SMS (codes are otherwise only logged).
//
// Public access (Africa's Talking through `npm run tunnel`): set CALLBACK_TOKEN and give Africa's Talking the URLs
//   https://<tunnel>/ussd?key=<CALLBACK_TOKEN>            (USSD callback)
//   https://<tunnel>/sms/delivery?key=<CALLBACK_TOKEN>    (SMS delivery reports)
// Requests that arrive through the tunnel (they carry Cloudflare / proxy headers) are refused without the token,
// because the phone number in a USSD request is only as trustworthy as the caller. Direct local requests (the
// simulator at http://localhost:3000/ussd) do not need it.
const http = require("http");
const { ethers } = require("ethers");
const { loadDeployment, loadAbi } = require("./common");
const { createUssd } = require("./ussd-core");
const { createHandler } = require("./ussd-http");
const { createSmsChannel } = require("./sms-channel");
const { paymentsFromEnv } = require("./payments");
const { createPhoneAccounts, loadSecret } = require("./phone-accounts");
const { createOutbox } = require("./sms");

// Public Hardhat development key (account #9) - LOCAL chain only.
const LOCAL_AGENT = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";

const dep = loadDeployment();
const local = ["localhost", "hardhat"].includes(dep.network);
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || dep.rpcUrl, undefined, { cacheTimeout: -1 }); // no request cache: avoids nonce reuse
const agentKey = process.env.AGENT_PRIVATE_KEY || (local ? LOCAL_AGENT : null);
if (!agentKey) throw new Error("Set AGENT_PRIVATE_KEY (the key that holds CLAIMS_AGENT_ROLE).");
const agent = new ethers.Wallet(agentKey, provider);

const outbox = createOutbox({ localChain: local });
const sendSms = (phone, text, opts) => outbox.sendNow(phone, text, opts);
const accounts = dep.aa && process.env.PHONE_ACCOUNTS !== "off"
  ? createPhoneAccounts({ provider, aa: dep.aa, ledgerAddress: dep.ledger, deskAddress: dep.policyDesk, abi: loadAbi(), sendSms,
    ...(process.env.CUSTODY_URL ? { custody: { url: process.env.CUSTODY_URL, token: process.env.CUSTODY_TOKEN } } : { secret: loadSecret({ local }) }) })
  : null;
const TOKEN = process.env.CALLBACK_TOKEN || "";

// Buying cover from a basic phone: premiums collected by MTN Mobile Money (or the simulator), see payments.js.
const payments = accounts ? paymentsFromEnv({ provider, dep, abi: loadAbi(), accounts, outbox }) : null;

const ussd = createUssd({
  provider,
  abi: loadAbi(),
  ledgerAddress: dep.ledger,
  cropClaimsAddress: dep.cropClaims || null,
  deskAddress: dep.policyDesk || null,
  agent,
  accounts,
  payments,
});

(async () => {
  try {
    const ledger = new ethers.Contract(dep.ledger, loadAbi().ledger, provider);
    const ok = await ledger.hasRole(await ledger.CLAIMS_AGENT_ROLE(), agent.address);
    if (!ok) console.warn(`[ussd] WARNING: ${agent.address} does not hold CLAIMS_AGENT_ROLE - claim registration will fail. Re-run deploy.`);
    const bal = await provider.getBalance(agent.address);
    if (bal === 0n) console.warn(`[ussd] WARNING: ${agent.address} has no gas balance.`);
  } catch (e) { console.warn("[ussd] startup check skipped:", e.shortMessage || e.message); }
})();

// Farmers can also use the same menus by SMS, through an Android phone running SMS Gateway for Android.
const smsChannel = createSmsChannel({ ussd, outbox });
const server = http.createServer(createHandler({ ussd, outbox, smsChannel, token: TOKEN }));

const port = Number(process.env.USSD_PORT || 4000);
server.on("error", (e) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.error(`Port ${port} is already in use: another USSD service is probably running (find it with: lsof -nP -iTCP:${port} -sTCP:LISTEN). Stop it, or set USSD_PORT.`);
  process.exit(1);
});
server.listen(port, () => {
  console.log(`USSD service on http://localhost:${port}/ussd  (demo farmers: 250788000001 Aline, 250788000002 Jean)`);
  console.log(`  SMS: ${outbox.describe} · internet callbacks: ${TOKEN ? "need ?key=CALLBACK_TOKEN" : "REFUSED (set CALLBACK_TOKEN to accept them)"}`);
  console.log(outbox.gatewayReady
    ? `  SMS menu channel ON: Android gateway webhook at /sms/gateway${smsChannel.signed ? " (signature checked)" : " - WARNING: set SMSGATE_SIGNING_KEY so webhooks are verified"}`
    : "  SMS menu channel: set SMSGATE_URL / SMSGATE_USER / SMSGATE_PASSWORD to let farmers use the menus by SMS");
  if (accounts) console.log(process.env.CUSTODY_URL ? "  farmer keys: held by the custody service (this process cannot read them)" : "  farmer keys: IN THIS PROCESS (start with npm run phone to keep them in the custody service)");
  if (payments) console.log(`  Contracts paid by USSD (6. My offers): premiums by ${payments.mode}`);
  console.log(accounts
    ? `  phone accounts ON: new numbers can register; number changes wait ${accounts.recoveryDelayMs / 3600000} h. SMS codes are ${outbox.mode === "log" ? "only written to services/out/sms.log" : `sent by ${outbox.mode}`}.`
    : "  phone accounts OFF (no smart-account contracts, or PHONE_ACCOUNTS=off): monitoring and claims only.");
});
