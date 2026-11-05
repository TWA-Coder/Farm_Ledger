// Outgoing SMS, shared by the notifier and the phone-account service.
// Every message is appended to services/out/sms.log. With AT_USERNAME / AT_API_KEY set it is also sent through
// Africa's Talking ("sandbox" username = their simulator; otherwise the live API, which costs per message).
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "out");
const SMS_LOG = path.join(OUT, "sms.log");

async function sendSms(phone, text) {
  fs.mkdirSync(OUT, { recursive: true });
  const line = `${new Date().toISOString()}  SMS -> +${phone}: ${text}`;
  fs.appendFileSync(SMS_LOG, line + "\n");
  console.log(line);
  if (!(process.env.AT_USERNAME && process.env.AT_API_KEY)) return { sent: false, logged: true };
  try {
    const sandbox = process.env.AT_USERNAME === "sandbox";
    const res = await fetch(`https://api.${sandbox ? "sandbox." : ""}africastalking.com/version1/messaging`, {
      method: "POST",
      headers: { apiKey: process.env.AT_API_KEY, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ username: process.env.AT_USERNAME, to: `+${phone}`, message: text }),
    });
    console.log(`  Africa's Talking: HTTP ${res.status}`);
    return { sent: res.ok, logged: true, status: res.status };
  } catch (e) {
    console.error("  Africa's Talking failed (SMS still logged):", e.message);
    return { sent: false, logged: true, error: e.message };
  }
}

module.exports = { sendSms, SMS_LOG };
