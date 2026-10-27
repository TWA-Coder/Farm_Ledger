import http from "../../../../../../server/http";
import core from "../../../../../../server/documents-core";
import fs from "fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const { store, fail, authenticateView } = http;

// Download one document. Query: applicant, issued, signature (and `signer` when a reviewer signs for an applicant).
export async function GET(request, { params }) {
  try {
    const q = new URL(request.url).searchParams;
    const applicant = q.get("applicant") || "";
    core.checkIds({ applicant, application: params.id, document: params.doc });
    authenticateView({ action: "view", applicant, application: params.id, document: params.doc, issued: q.get("issued"), signature: q.get("signature") }, q.get("signer"));
    const hit = store.get({ applicant, application: params.id, document: params.doc });
    if (!hit) throw new core.DocError(404, "Document not found.");
    const body = fs.readFileSync(hit.path);
    return new Response(body, { headers: { "Content-Type": hit.meta.mime, "Content-Disposition": `inline; filename="${hit.meta.originalName}"`, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" } });
  } catch (e) { return fail(e); }
}
