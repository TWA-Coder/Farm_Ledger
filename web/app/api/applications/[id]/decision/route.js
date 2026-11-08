// The underwriter's decision on a submitted application: the drafted contract, or the written reasons for a rejection.
// POST (underwriter of the application's product only): body applicant, deskId, kind ("contract" | "rejection"),
//   content {...}, issued, signature, signer. The server stores it next to the application and returns its hash; the
//   underwriter then records that hash on-chain (PolicyDesk.draftContract / rejectApplication).
// Reading it: GET /api/applications/<id> (applicant, agent, underwriter, auditor).
import http from "../../../../../server/http";
import core from "../../../../../server/documents-core";
import chain from "../../../../../server/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  try {
    const b = await request.json();
    const application = params.id;
    core.checkIds({ applicant: b.applicant, application });
    if (!["contract", "rejection"].includes(b.kind)) throw new core.DocError(400, "Unknown decision.");
    const deskId = Number(b.deskId);
    const contentHash = http.sha256Hex(Buffer.from(JSON.stringify(b.content || {})));
    core.checkIssued(b.issued);
    const msg = core.message({ action: "decision", applicant: b.applicant, application, document: `${b.kind}-${deskId}`, sha256: contentHash, issued: b.issued });
    const who = core.verifySigner(msg, b.signature, b.signer);

    const desk = chain.policyDesk();
    if (!desk) throw new core.DocError(404, "PolicyDesk is not deployed.");
    const app = await desk.getApplication(deskId);
    const rec = http.store.readApplication({ applicant: b.applicant, application });
    if (!rec || Number(rec.deskApplicationId) !== deskId || app.formHash !== rec.applicationHash) throw new core.DocError(409, "This record is not the submitted application.");
    if (app.underwriter.toLowerCase() !== who.toLowerCase() || !(await chain.isUnderwriter(who))) throw new core.DocError(403, "Only the underwriter of this application can decide on it.");
    const { hash } = http.store.putDecision({ applicant: b.applicant, application, kind: b.kind, content: b.content || {}, by: who });
    await http.logAccess({ viewer: who, role: "underwriter", applicant: b.applicant, application, document: b.kind, action: "decision" });
    return http.json({ hash });
  } catch (e) { return http.fail(e); }
}
