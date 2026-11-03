// Small helpers shared by the API routes.
const { DocError, DocumentStore, defaultRoot, message, verifySigner, verifyAccountSigner, checkIssued, sha256Hex } = require("./documents-core");
const { EVIDENCE_DOCUMENT, isClaimApplication } = require("../shared/claims");

const store = new DocumentStore(defaultRoot());
const reviewers = () => (process.env.FARMLEDGER_REVIEWERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function fail(e) {
  if (e instanceof DocError) return json({ error: e.message }, e.status);
  console.error("[api]", e);
  return json({ error: "Unexpected server error." }, 500);
}

// Verify that `signature` was produced by `applicant` over exactly this request.
// Applicants may be plain keys or smart accounts (signed by the account's owner key).
async function authenticate({ action, applicant, application, document, sha256, filename, issued, signature }, { ownerOf = require("./chain").ownerOf } = {}) {
  checkIssued(issued);
  const msg = message({ action, applicant, application, document, sha256, filename, issued });
  return verifyAccountSigner(msg, signature, applicant, ownerOf);
}

// Viewing may also be done by someone other than the applicant, signing the same request with their own key:
//   * a configured reviewer (FARMLEDGER_REVIEWERS, underwriter back office): any document;
//   * a veterinarian certified on-chain right now: claim evidence photos only (they decide the claim).
async function authenticateView(params, signerClaim, { isCertifiedVet = require("./chain").isCertifiedVet, isUnderwriter = require("./chain").isUnderwriter, ownerOf = require("./chain").ownerOf } = {}) {
  const msg = message({ ...params, applicant: params.applicant });
  checkIssued(params.issued);
  try { return await verifyAccountSigner(msg, params.signature, params.applicant, signerClaim ? null : ownerOf); } catch (e) {
    if (!signerClaim) throw e;
    if (reviewers().includes(String(signerClaim).toLowerCase())) return verifySigner(msg, params.signature, signerClaim);
    // the insurer: any account holding UNDERWRITER_ROLE on-chain may view application documents
    if (params.document !== EVIDENCE_DOCUMENT || !isClaimApplication(params.application)) {
      const signer = verifySigner(msg, params.signature, signerClaim);
      let ok = false;
      try { ok = await isUnderwriter(signer); } catch { throw new DocError(503, "Cannot check the underwriter role: the chain is unreachable."); }
      if (ok) return signer;
      throw e;
    }
    if (params.document === EVIDENCE_DOCUMENT && isClaimApplication(params.application)) {
      const signer = verifySigner(msg, params.signature, signerClaim);
      let ok = false;
      try { ok = await isCertifiedVet(signer); } catch { throw new DocError(503, "Cannot check veterinarian certification: the chain is unreachable."); }
      if (ok) return signer;
      throw new DocError(403, "Only a currently certified veterinarian can view claim evidence.");
    }
    throw e;
  }
}

module.exports = { store, json, fail, authenticate, authenticateView, sha256Hex, DocError };
