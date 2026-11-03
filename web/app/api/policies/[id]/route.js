// The application record behind a policy, for the underwriter who issued it (policy document / schedule).
// Query: signer, issued, signature  (signature over the canonical message with action "policy-record").
// Access: signer must hold UNDERWRITER_ROLE and be the underwriter of the policy's product (checked on-chain).
// Integrity: the stored record's hash is compared with the applicationHash anchored on-chain for the policy.
import http from "../../../../server/http";
import core from "../../../../server/documents-core";
import chain from "../../../../server/chain";
import contacts from "../../../../server/contacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const q = new URL(request.url).searchParams;
    const policyId = Number(params.id);
    const signer = q.get("signer") || "";
    if (!Number.isInteger(policyId) || policyId <= 0) throw new core.DocError(400, "Invalid policy id.");
    core.checkIssued(q.get("issued"));
    core.verifySigner(core.message({ action: "policy-record", applicant: signer, application: `policy-${policyId}`, issued: q.get("issued") }), q.get("signature"), signer);

    const ledger = chain.ledger();
    const pol = await ledger.getPolicy(policyId);
    if (pol.holder === "0x0000000000000000000000000000000000000000") throw new core.DocError(404, "No such policy.");
    const prod = await ledger.getProduct(pol.productId);
    if (!(await chain.isUnderwriter(signer)) || prod.underwriter.toLowerCase() !== signer.toLowerCase()) throw new core.DocError(403, "Only the underwriter of this policy can open its record.");

    const record = http.store.findForPolicy({ applicant: pol.holder, policyId });
    const anchored = await ledger.applicationHashOf(policyId);
    const phone = contacts.read()[pol.holder.toLowerCase()]?.phone || null;
    return http.json({
      record: record ? { application: record.application, answers: record.answers, documents: record.documents, finalizedAt: record.finalizedAt, schemaVersion: record.schemaVersion } : null,
      anchoredHash: anchored,
      matchesLedger: record ? record.applicationHash === anchored : null,
      phone,
    });
  } catch (e) { return http.fail(e); }
}
