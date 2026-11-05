// Public HTTPS address for the USSD service (Cloudflare quick tunnel, free, no account) and the exact callback URLs
// to paste into the Africa's Talking dashboard. The address changes every time this starts.
//   npm run tunnel        (needs: brew install cloudflared)
const { spawn } = require("child_process");
require("./common"); // loads .env (CALLBACK_TOKEN)

const port = Number(process.env.USSD_PORT || 4000);
const token = process.env.CALLBACK_TOKEN;
if (!token) console.warn("CALLBACK_TOKEN is not set (.env): the USSD service will refuse every request from the tunnel.");

const cf = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
cf.on("error", () => { console.error("cloudflared not found. Install it with: brew install cloudflared"); process.exit(1); });
let shown = false;
const watch = (chunk) => {
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(chunk));
  if (!m || shown) return;
  shown = true;
  const key = token ? `?key=${token}` : "";
  console.log(`\nTunnel up: ${m[0]} -> http://localhost:${port}\n`);
  console.log("Paste into the Africa's Talking dashboard:");
  console.log(`  USSD > Service codes > your code > Callback URL:  ${m[0]}/ussd${key}`);
  console.log(`  SMS > SMS Callback URLs > Delivery Reports:       ${m[0]}/sms/delivery${key}`);
  console.log("\nThe URL is secret (it contains your token). Ctrl+C stops the tunnel.\n");
};
cf.stdout.on("data", watch);
cf.stderr.on("data", watch);
process.on("SIGINT", () => { cf.kill(); process.exit(0); });
cf.on("exit", (code) => { console.log(`cloudflared exited (${code})`); process.exit(code || 0); });
