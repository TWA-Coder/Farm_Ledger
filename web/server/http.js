// Small helpers shared by the API routes.
const { DocError, DocumentStore, defaultRoot, message, verifySigner, checkIssued, sha256Hex } = require("./documents-core");

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
function authenticate({ action, applicant, application, document, sha256, filename, issued, signature }) {
  checkIssued(issued);
  const msg = message({ action, applicant, application, document, sha256, filename, issued });
  return verifySigner(msg, signature, applicant);
}

// Viewing may also be done by a configured reviewer (underwriter back office) signing for a given applicant.
function authenticateView(params, signerClaim) {
  const msg = message({ ...params, applicant: params.applicant });
  checkIssued(params.issued);
  try { return verifySigner(msg, params.signature, params.applicant); } catch (e) {
    if (signerClaim && reviewers().includes(String(signerClaim).toLowerCase())) return verifySigner(msg, params.signature, signerClaim);
    throw e;
  }
}

module.exports = { store, json, fail, authenticate, authenticateView, sha256Hex, DocError };
