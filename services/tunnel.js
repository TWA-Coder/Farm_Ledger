// Public HTTPS address for the USSD service (Cloudflare quick tunnel, free, no account) and the exact callback URLs
// to paste into the Africa's Talking dashboard. The address changes every time this starts, so when the Android SMS
// gateway is configured (SMSGATE_*) its webhooks are re-registered to the new address automatically.
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
  console.log(`  Android SMS gateway webhook (automatic if SMSGATE_* is set): ${m[0]}/sms/gateway${key}`);
  console.log("\nThe URL is secret (it contains your token). Ctrl+C stops the tunnel.\n");
  registerGateway(`${m[0]}/sms/gateway${key}`).catch((e) => console.error("SMS gateway webhook registration failed:", e.message));
};

// SMS Gateway for Android: POST {base}/webhooks {id, url, event}. Fixed ids, so a new tunnel replaces the old URL.
async function registerGateway(url) {
  const base = String(process.env.SMSGATE_URL || "").replace(/\/+$/, "");
  if (!base || !process.env.SMSGATE_USER || !process.env.SMSGATE_PASSWORD) return;
  const auth = Buffer.from(`${process.env.SMSGATE_USER}:${process.env.SMSGATE_PASSWORD}`).toString("base64");
  console.log("SMS gateway phone: registering webhooks to this tunnel");
  for (const event of ["sms:received", "sms:sent", "sms:delivered", "sms:failed"]) {
    const res = await fetch(`${base}/webhooks`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: `farmledger-${event.replace(":", "-")}`, url, event }),
    });
    console.log(`  ${event}: ${res.ok ? "registered" : `HTTP ${res.status} ${(await res.text()).slice(0, 120)}`}`);
  }
}
cf.stdout.on("data", watch);
cf.stderr.on("data", watch);
process.on("SIGINT", () => { cf.kill(); process.exit(0); });
cf.on("exit", (code) => { console.log(`cloudflared exited (${code})`); process.exit(code || 0); });
