// Farmer registration (server/register.js).
//   POST {step: "start", name, nid, phone, district}  -> { phone, testCode? }   sends the SMS code
//   POST {step: "finish", phone, code, pin}           -> signs the new farmer in
import http from "../../../../server/http";
import auth from "../../../../server/auth";
import register from "../../../../server/register";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    auth.guard(request);
    const b = await request.json();
    if (b.step === "start") return http.json(await register.start(b));
    if (b.step === "finish") {
      const r = await register.finish(b);
      return new Response(JSON.stringify({ ok: true, account: r.account }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": auth.sessionCookie(request, r.token) } });
    }
    return http.json({ error: "Unknown step." }, 400);
  } catch (e) { return http.fail(e); }
}
