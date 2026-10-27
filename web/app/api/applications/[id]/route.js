import http from "../../../../server/http";
import core from "../../../../server/documents-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const { store, json, fail, authenticate, sha256Hex } = http;

// Finalize: server re-checks completeness and returns the hash that the contract will anchor.
// Body: applicant, ctx{cover,productId,assetId,sumInsured}, answers, issued, signature
// The signature covers a hash of ctx+answers, so they cannot be altered in transit.
export async function POST(request, { params }) {
  try {
    const b = await request.json();
    const application = params.id;
    core.checkIds({ applicant: b.applicant, application });
    const payloadHash = sha256Hex(Buffer.from(JSON.stringify({ ctx: b.ctx, answers: b.answers || {} })));
    authenticate({ action: "submit", applicant: b.applicant, application, sha256: payloadHash, issued: b.issued, signature: b.signature });
    const { applicationHash, record } = store.finalize({ applicant: b.applicant, application, ctx: b.ctx, answers: b.answers || {} });
    return json({ applicationHash, documents: record.documents });
  } catch (e) { return fail(e); }
}

// Link the finalized application to the policy that was created. Body: applicant, policyId, issued, signature
export async function PATCH(request, { params }) {
  try {
    const b = await request.json();
    const application = params.id;
    core.checkIds({ applicant: b.applicant, application });
    authenticate({ action: "link", applicant: b.applicant, application, document: `policy-${Number(b.policyId)}`, issued: b.issued, signature: b.signature });
    store.link({ applicant: b.applicant, application, policyId: b.policyId });
    return json({ linked: true });
  } catch (e) { return fail(e); }
}
