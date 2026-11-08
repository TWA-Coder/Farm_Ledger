// Sign-in for the portal (server/auth.js).
//   GET                                      -> { viewer | null, local, demo? }   who is signed in
//   POST {action: "staff", username, password}   staff sign-in
//   POST {action: "farmer", phone, pin}          farmer sign-in (same PIN as USSD)
//   POST {action: "logout"}
//   POST {action: "password", current, next}     staff: change password (required after a one-time password)
import fs from "fs";
import path from "path";
import http from "../../../server/http";
import auth from "../../../server/auth";
import dbm from "../../../server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const withCookie = (body, cookie) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": cookie } });

// Local chain only: the seeded demo logins, so a demo can start without reading the docs (scripts/seed-demo.js).
function demoLogins() {
  try { return JSON.parse(fs.readFileSync(path.join(dbm.dataDir(), "demo-logins.json"), "utf8")); } catch { return null; }
}

export async function GET(request) {
  try {
    const viewer = await auth.viewerOf(await auth.sessionOf(request));
    const local = auth.isLocal();
    return http.json({ viewer, local, demo: local ? demoLogins() : null });
  } catch (e) { return http.fail(e); }
}

export async function POST(request) {
  try {
    auth.guard(request);
    const b = await request.json();
    if (b.action === "staff") return withCookie({ ok: true }, auth.sessionCookie(request, await auth.loginStaff(b.username, b.password)));
    if (b.action === "farmer") return withCookie({ ok: true }, auth.sessionCookie(request, await auth.loginFarmer(b.phone, b.pin)));
    if (b.action === "logout") { await auth.endSession(request); return withCookie({ ok: true }, auth.clearCookie(request)); }
    if (b.action === "password") { await auth.changePassword(await auth.requireViewer(request, { allowMustChange: true }), b.current, b.next); return http.json({ ok: true }); }
    return http.json({ error: "Unknown action." }, 400);
  } catch (e) { return http.fail(e); }
}
