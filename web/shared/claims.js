// Livestock claim evidence: how a claim photo is tied to the on-chain claim.
// Shared by the browser (farmer uploads, vet views) and the server (access checks). CommonJS for the Hardhat tests.
//
//   evidenceHash (on-chain, bytes32)  = SHA-256 of the photo file, as 0x-prefixed hex
//   storage application id            = "claim-<policyId>-<first 12 hex of the evidence hash>"
//
// Anyone who can read the claim on-chain can therefore find the photo, and anyone who downloads the photo can check
// it is exactly the file the farmer committed to: re-hash it and compare with the claim's evidenceHash.
const EVIDENCE_DOCUMENT = "claim_photo";

function evidenceHashFromSha(shaHex) {
  const h = String(shaHex).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("Expected a SHA-256 hex digest.");
  return "0x" + h;
}

function claimApplicationId(policyId, evidenceHash) {
  const id = Number(policyId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid policy id.");
  const h = evidenceHashFromSha(evidenceHash);
  return `claim-${id}-${h.slice(2, 14)}`;
}

const isClaimApplication = (application) => /^claim-\d+-[0-9a-f]{12}$/.test(String(application));

module.exports = { EVIDENCE_DOCUMENT, evidenceHashFromSha, claimApplicationId, isClaimApplication };
