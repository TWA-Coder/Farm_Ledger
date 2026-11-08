// POST {action: "reset" | "disable" | "enable"} on another staff login (reset -> a new one-time password).
import http from "../../../../server/http";
import auth from "../../../../server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  try {
    auth.guard(request);
    const viewer = await auth.requireViewer(request);
    const { action } = await request.json();
    return http.json(await auth.manageStaff(viewer, params.username, action));
  } catch (e) { return http.fail(e); }
}
