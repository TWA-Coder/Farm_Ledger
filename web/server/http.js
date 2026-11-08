// Small helpers shared by the API routes.
const { DocError, DocumentStore, defaultRoot, message, verifySigner, verifyAccountSigner, checkIssued, sha256Hex } = require("./documents-core");
const { EVIDENCE_DOCUMENT, isClaimApplication } = require("../shared/claims");

const store = new DocumentStore(defaultRoot());

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function fail(e) {
  if (e instanceof DocError) return json({ error: e.message }, e.status);
  console.error("[api]", e);
  return json({ error: "Unexpected server error." }, 500);
}

// ---------------------------------------------------------------- who may do what with application documents
//
//   write (upload, delete, list, submit, link): the applicant (their key, or their smart account's owner key), or the
//         insurance agent assigned to them on-chain (PolicyDesk.agentOf), who fills in the application for them.
//   read: the applicant; their agent; the UNDERWRITER of the product the application is for (not every insurer);
//         a currently certified vet, claim evidence only; an auditor (FARMLEDGER_AUDITORS), everything, read-only.
// Every read by someone other than the applicant is written to the access log (table doc_access_log).
const auditors = () => [process.env.FARMLEDGER_AUDITORS, process.env.FARMLEDGER_REVIEWERS] // REVIEWERS: older name
  .join(",").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

const chainDeps = () => {
  const chain = require("./chain");
  return {
    ownerOf: chain.ownerOf,
    isCertifiedVet: chain.isCertifiedVet,
    isAgentOf: async (applicant, who) => {
      const desk = chain.policyDesk();
      if (!desk) return false;
      return same(await desk.agentOf(applicant), who) && Boolean(await desk.isAgent(who));
    },
    underwriterOfProduct: async (productId) => {
      const l = chain.ledger();
      const p = await l.getProduct(productId);
      return (await l.hasRole(await l.UNDERWRITER_ROLE(), p.underwriter)) ? p.underwriter : null;
    },
  };
};

async function logAccess(entry) {
  try {
    await require("./db").get().run("INSERT INTO doc_access_log (at, viewer, role, applicant, application, document, action) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [new Date().toISOString(), String(entry.viewer).toLowerCase(), entry.role, String(entry.applicant).toLowerCase(), entry.application, entry.document || "-", entry.action]);
  } catch (e) { console.error("[access-log]", e.message); }
}

const chainCheck = async (fn, what) => { try { return await fn(); } catch { throw new DocError(503, `Cannot check ${what}: the chain is unreachable.`); } };

// -> { who, role }   signerClaim: the signer's address when it is not the applicant (agent, underwriter, vet, auditor)
async function authorizeWrite(params, signerClaim, deps = chainDeps()) {
  checkIssued(params.issued);
  const msg = message(params);
  if (!signerClaim || same(signerClaim, params.applicant)) return { who: await verifyAccountSigner(msg, params.signature, params.applicant, deps.ownerOf), role: "applicant" };
  const who = verifySigner(msg, params.signature, signerClaim);
  if (await chainCheck(() => deps.isAgentOf(params.applicant, who), "the agent assignment")) return { who, role: "agent" };
  throw new DocError(403, "Only the applicant or their insurance agent can do that.");
}

async function authorizeRead(params, signerClaim, deps = { ...chainDeps(), store }) {
  checkIssued(params.issued);
  const msg = message(params);
  if (!signerClaim || same(signerClaim, params.applicant)) return { who: await verifyAccountSigner(msg, params.signature, params.applicant, deps.ownerOf), role: "applicant" };
  const who = verifySigner(msg, params.signature, signerClaim);
  const grant = (role) => { (deps.logAccess || logAccess)({ viewer: who, role, ...params }); return { who, role }; };
  if (auditors().includes(who.toLowerCase())) return grant("auditor");
  if (params.document === EVIDENCE_DOCUMENT && isClaimApplication(params.application)) {
    if (await chainCheck(() => deps.isCertifiedVet(who), "veterinarian certification")) return grant("vet");
    throw new DocError(403, "Only a currently certified veterinarian can view claim evidence.");
  }
  if (await chainCheck(() => deps.isAgentOf(params.applicant, who), "the agent assignment")) return grant("agent");
  // the insurer of THIS application's product only (the finalized application names the product)
  const rec = deps.store.readApplication({ applicant: params.applicant, application: params.application });
  if (rec && same(await chainCheck(() => deps.underwriterOfProduct(rec.ctx.productId), "the product's underwriter"), who)) return grant("underwriter");
  throw new DocError(403, "You are not allowed to see this application.");
}

// Kept for older callers: the applicant only.
async function authenticate(params, { ownerOf = require("./chain").ownerOf } = {}) {
  return (await authorizeWrite(params, null, { ownerOf })).who;
}

module.exports = { store, json, fail, authenticate, authorizeWrite, authorizeRead, logAccess, sha256Hex, DocError };
