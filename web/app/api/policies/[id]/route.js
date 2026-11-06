// The application and contract behind a policy, for the underwriter who issued it, the holder's agent, or an auditor.
// Query: signer, issued, signature  (signature over the canonical message with action "policy-record").
// Integrity: the stored contract's hash is compared with the hash PolicyDesk recorded on-chain with the policy.
import http from "../../../../server/http";
import core from "../../../../server/documents-core";
import chain from "../../../../server/chain";
import contacts from "../../../../server/contacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ZERO = "0x0000000000000000000000000000000000000000";

export async function GET(request, { params }) {
  try {
    const q = new URL(request.url).searchParams;
    const policyId = Number(params.id);
    const signer = q.get("signer") || "";
    if (!Number.isInteger(policyId) || policyId <= 0) throw new core.DocError(400, "Invalid policy id.");
    core.checkIssued(q.get("issued"));
    core.verifySigner(core.message({ action: "policy-record", applicant: signer, application: `policy-${policyId}`, issued: q.get("issued") }), q.get("signature"), signer);

    const ledger = chain.ledger();
    const desk = chain.policyDesk();
    const pol = await ledger.getPolicy(policyId);
    if (pol.holder === ZERO) throw new core.DocError(404, "No such policy.");
    const prod = await ledger.getProduct(pol.productId);
    const isUw = prod.underwriter.toLowerCase() === signer.toLowerCase() && (await chain.isUnderwriter(signer));
    const isAgent = desk ? (await desk.agentOf(pol.holder)).toLowerCase() === signer.toLowerCase() : false;
    const auditors = [process.env.FARMLEDGER_AUDITORS, process.env.FARMLEDGER_REVIEWERS].join(",").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const role = isUw ? "underwriter" : isAgent ? "agent" : auditors.includes(signer.toLowerCase()) ? "auditor" : null;
    if (!role) throw new core.DocError(403, "Only the policy's underwriter, the holder's agent or an auditor can open this record.");

    // which application became this policy (PolicyDesk event), then its stored record and contract
    let record = null;
    if (desk) {
      const [ev] = await desk.queryFilter(desk.filters.PolicyIssuedFromApplication(null, policyId), 0, "latest");
      if (ev) record = http.store.findForDesk({ applicant: pol.holder, deskApplicationId: Number(ev.args.applicationId) });
    }
    if (!record) record = http.store.findForPolicy({ applicant: pol.holder, policyId }); // policies from before PolicyDesk
    const contract = record ? http.store.getDecision({ applicant: pol.holder, application: record.application, kind: "contract" }) : null;
    const anchored = await ledger.applicationHashOf(policyId);
    http.logAccess({ viewer: signer, role, applicant: pol.holder, application: record?.application || `policy-${policyId}`, document: "policy-record", action: "view" });
    const phone = contacts.read()[pol.holder.toLowerCase()]?.phone || null;
    return http.json({
      record: record ? { application: record.application, answers: record.answers, documents: record.documents, finalizedAt: record.finalizedAt, schemaVersion: record.schemaVersion, deskApplicationId: record.deskApplicationId ?? null } : null,
      contract: contract ? contract.content : null,
      anchoredHash: anchored,
      matchesLedger: contract ? contract.hash === anchored : record ? record.applicationHash === anchored : null,
      phone,
    });
  } catch (e) { return http.fail(e); }
}
