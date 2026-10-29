import http from "../../../../server/http";
import core from "../../../../server/documents-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const { store, json, fail, authorizeWrite, authorizeRead, sha256Hex } = http;

// Finalize: server re-checks completeness and returns the hash that the contract will anchor.
// Body: applicant, ctx{cover,productId,assetId,sumInsured}, answers, issued, signature, signer (the agent, when the
// agent fills it in for the farmer). The signature covers a hash of ctx+answers, so they cannot be altered in transit.
export async function POST(request, { params }) {
  try {
    const b = await request.json();
    const application = params.id;
    core.checkIds({ applicant: b.applicant, application });
    const payloadHash = sha256Hex(Buffer.from(JSON.stringify({ ctx: b.ctx, answers: b.answers || {} })));
    await authorizeWrite({ action: "submit", applicant: b.applicant, application, sha256: payloadHash, issued: b.issued, signature: b.signature }, b.signer);
    const { applicationHash, record } = store.finalize({ applicant: b.applicant, application, ctx: b.ctx, answers: b.answers || {} });
    return json({ applicationHash, documents: record.documents });
  } catch (e) { return fail(e); }
}

// Link the finalized application to its PolicyDesk application number once the agent submitted it on-chain.
// Body: applicant, deskId, issued, signature, signer. The on-chain application must carry this record's hash.
export async function PATCH(request, { params }) {
  try {
    const b = await request.json();
    const application = params.id;
    core.checkIds({ applicant: b.applicant, application });
    const deskId = Number(b.deskId);
    await authorizeWrite({ action: "link", applicant: b.applicant, application, document: `desk-${deskId}`, issued: b.issued, signature: b.signature }, b.signer);
    const desk = require("../../../../server/chain").policyDesk();
    const rec = store.readApplication({ applicant: b.applicant, application });
    if (!desk || !rec) throw new core.DocError(404, "Application not found.");
    const onchain = await desk.getApplication(deskId);
    if (onchain.farmer.toLowerCase() !== b.applicant.toLowerCase() || onchain.formHash !== rec.applicationHash) throw new core.DocError(409, "The on-chain application does not match this record.");
    store.linkDesk({ applicant: b.applicant, application, deskApplicationId: deskId });
    return json({ linked: true });
  } catch (e) { return fail(e); }
}

// The finalized record (answers, product, documents' fingerprints) for the applicant, their agent, the product's
// underwriter or an auditor. Query: applicant, issued, signature, signer.
export async function GET(request, { params }) {
  try {
    const q = new URL(request.url).searchParams;
    const application = params.id, applicant = q.get("applicant") || "";
    core.checkIds({ applicant, application });
    await authorizeRead({ action: "view", applicant, application, document: "application", issued: q.get("issued"), signature: q.get("signature") }, q.get("signer"));
    const rec = store.readApplication({ applicant, application });
    if (!rec) throw new core.DocError(404, "Application not finalized.");
    return json({ record: rec, contract: store.getDecision({ applicant, application, kind: "contract" }), rejection: store.getDecision({ applicant, application, kind: "rejection" }) });
  } catch (e) { return fail(e); }
}
