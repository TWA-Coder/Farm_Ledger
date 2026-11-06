// Starts the phone-network services together: key custody, the USSD/SMS service and the notifier (and optionally the
// tunnel). Custody gets a fresh random token each run; the other two get CUSTODY_URL / CUSTODY_TOKEN, so the farmers'
// key secret stays in the custody process only.
//   npm run phone                 USSD service + notifier
//   npm run phone -- --tunnel     ... + the public tunnel for Africa's Talking / the SMS gateway
// Output is prefixed per service. Ctrl+C stops all of them; if one stops, the others are stopped too.
const { spawn } = require("child_process");
const crypto = require("crypto");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CUSTODY_PORT = Number(process.env.CUSTODY_PORT || 4100);
const env = { ...process.env, CUSTODY_TOKEN: crypto.randomBytes(24).toString("hex"), CUSTODY_URL: `http://127.0.0.1:${CUSTODY_PORT}`, CUSTODY_PORT: String(CUSTODY_PORT) };
const jobs = [["custody", "services/custody.js"], ["ussd   ", "services/ussd.js"], ["notify ", "services/notifier.js"]];
if (process.argv.includes("--tunnel")) jobs.push(["tunnel", "services/tunnel.js"]);

const children = [];
let stopping = false;
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGINT");
  setTimeout(() => process.exit(code), 1500);
}

function start(name, script) {
  const child = spawn(process.execPath, [script], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    let rest = "";
    stream.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop();
      for (const l of lines) console.log(`[${name}] ${l}`);
    });
  }
  child.on("exit", (code) => {
    if (stopping) return;
    console.log(`[${name}] stopped (exit code ${code}); stopping the others`);
    stopAll(code || 1);
  });
}

(async () => {
  start(...jobs[0]); // custody first; the others need it
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${env.CUSTODY_URL}/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const j of jobs.slice(1)) start(...j);
})();
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
