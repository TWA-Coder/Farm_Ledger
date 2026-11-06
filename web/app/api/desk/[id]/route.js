// A submitted application by its PolicyDesk number: the finalized form (answers, documents' fingerprints) and the
// underwriter's contract or rejection. For the farmer, their agent, the underwriter of the application, or an auditor.
// Query: signer, issued, signature, over the canonical message {action "view", applicant <farmer>, application
// "desk-<id>", document "application"}. Access by anyone but the farmer is logged.
import http from "../../../../server/http";
import core from "../../../../server/documents-core";
import chain from "../../../../server/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const q = new URL(request.url).searchParams;
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) throw new core.DocError(400, "Invalid application number.");
    const desk = chain.policyDesk();
    if (!desk) throw new core.DocError(404, "PolicyDesk is not deployed.");
    const app = await desk.getApplication(id);
    if (Number(app.status) === 0) throw new core.DocError(404, "No such application.");
    const farmer = app.farmer;
    const signer = q.get("signer") || farmer;
    core.checkIssued(q.get("issued"));
    const msg = core.message({ action: "view", applicant: farmer, application: `desk-${id}`, document: "application", issued: q.get("issued") });
    const same = (a, b) => a.toLowerCase() === b.toLowerCase();
    let role;
    if (same(signer, farmer)) { await core.verifyAccountSigner(msg, q.get("signature"), farmer, chain.ownerOf); role = "applicant"; }
    else {
      const who = core.verifySigner(msg, q.get("signature"), signer);
      const auditors = [process.env.FARMLEDGER_AUDITORS, process.env.FARMLEDGER_REVIEWERS].join(",").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (same(app.agent, who) || same(await desk.agentOf(farmer), who)) role = "agent";
      else if (same(app.underwriter, who) && (await chain.isUnderwriter(who))) role = "underwriter";
      else if (auditors.includes(who.toLowerCase())) role = "auditor";
      else throw new core.DocError(403, "You are not allowed to see this application.");
      http.logAccess({ viewer: who, role, applicant: farmer, application: `desk-${id}`, document: "application", action: "view" });
    }
    const rec = http.store.findForDesk({ applicant: farmer, deskApplicationId: id });
    return http.json({
      role,
      application: rec?.application || null,
      record: rec ? { answers: rec.answers, ctx: rec.ctx, documents: rec.documents, finalizedAt: rec.finalizedAt, applicationHash: rec.applicationHash } : null,
      matchesLedger: rec ? rec.applicationHash === app.formHash : null,
      contract: rec ? http.store.getDecision({ applicant: farmer, application: rec.application, kind: "contract" }) : null,
      rejection: rec ? http.store.getDecision({ applicant: farmer, application: rec.application, kind: "rejection" }) : null,
    });
  } catch (e) { return http.fail(e); }
}
