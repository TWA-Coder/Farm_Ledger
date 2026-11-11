// Acting on-chain as the signed-in person. Their key stays in the custody service; see server/auth.js.
//   POST {op: "send", tx: {to, data}}            -> { hash }
//   POST {op: "sign", message} | {op: "sign", typed: {domain, types, value}}   -> { signature }
import http from "../../../server/http";
import auth from "../../../server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    auth.guard(request);
    const viewer = auth.requireViewer(request);
    const b = await request.json();
    try {
      if (b.op === "send") return http.json({ hash: await auth.send(viewer, b.tx) });
      if (b.op === "sign") return http.json({ signature: await auth.sign(viewer, b) });
    } catch (e) {
      if (e.status || e.revert) return http.json({ error: e.message, revert: e.revert }, e.revert ? 422 : e.status >= 400 && e.status < 500 ? e.status : 502);
      throw e;
    }
    return http.json({ error: "Unknown operation." }, 400);
  } catch (e) { return http.fail(e); }
}
