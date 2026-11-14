// The portal's handset simulator (/ussd) reaches the USSD service through this route, so it works on a hosted portal
// too (the browser cannot reach the service's own port there). The request goes to the service from this server, as a
// local request, so it needs no CALLBACK_TOKEN.
//
// The simulator lets the user type ANY phone number. On a public deployment that would let anyone act as a real
// farmer's phone, so off the local chain only the seeded demo numbers (25078800xxxx, never texted live: services/sms.js)
// are accepted. Real phones use the real channel (Africa's Talking).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEMO_NUMBER = /^25078800\d{4}$/;
const local = () => ["", "localhost", "hardhat"].includes(process.env.NETWORK || "");

export async function POST(request) {
  const form = new URLSearchParams(await request.text());
  const phone = String(form.get("phoneNumber") || "").replace(/\D/g, "");
  if (!local() && !DEMO_NUMBER.test(phone)) {
    return new Response("END On this public demo the simulator only dials the demo numbers (+25078800xxxx).", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const port = Number(process.env.USSD_PORT || 4000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ussd`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ sessionId: String(form.get("sessionId") || "sim"), serviceCode: String(form.get("serviceCode") || "*384*55#"), phoneNumber: "+" + phone, text: String(form.get("text") || "") }),
      signal: AbortSignal.timeout(60_000),
    });
    return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch {
    return new Response("END The USSD service is not running (npm run phone).", { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
