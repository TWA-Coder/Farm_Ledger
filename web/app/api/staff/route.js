// Staff logins. The admin sees and adds admins, underwriters and vets; an underwriter sees and adds agents.
//   GET                                   -> { staff: [...] }
//   POST {name, username, role, phone?}   -> { username, address, tempPassword }   (shown once; changed at first sign-in)
import http from "../../../server/http";
import auth from "../../../server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try { return http.json({ staff: await auth.listStaff(await auth.requireViewer(request)) }); } catch (e) { return http.fail(e); }
}

export async function POST(request) {
  try {
    auth.guard(request);
    const viewer = await auth.requireViewer(request);
    return http.json(await auth.createStaff(viewer, await request.json()));
  } catch (e) { return http.fail(e); }
}
