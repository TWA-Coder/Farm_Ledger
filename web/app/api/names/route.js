// People's names the signed-in person may see, by address (lower-case). Names never go on-chain (server/profiles.js).
import http from "../../../server/http";
import auth from "../../../server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try { return http.json({ names: auth.namesFor(auth.requireViewer(request)) }); } catch (e) { return http.fail(e); }
}
