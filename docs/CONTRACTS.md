# Smart contracts

Rules enforced on-chain beyond the application workflow, units, security notes and deploying to a public testnet. Contracts: `contracts/FarmLedger.sol`, `contracts/PolicyDesk.sol`, `contracts/CropClaims.sol`, `contracts/aa/FarmLedgerPaymaster.sol`, `contracts/MockRWF.sol`.

## Vet certification and multi-signature claims

Livestock claims are no longer decided by a single role-holder.

* **Certification registry.** The admin calls `certifyVet(address, licenseHash, sector, validUntil)`. The licence number is hashed in the browser; only the hash goes on-chain. A vet's signature counts only while the record is active and unexpired (`isCertifiedVet`). `revokeVet` takes effect immediately; renewal is another `certifyVet` call.
* **Quorum.** `setVetQuorum(1..5)` sets how many *distinct* certified vets must sign. The value is copied into each claim when it is filed, so changing it later never alters an open claim. Local demo: **2 of 3**.
* **Protocol.** Each vet signs an EIP-712 `Attestation(claimId, policyId, tagId, approved, deadline)`. Anyone can relay it. The contract recovers the signer, checks certification, rejects the claimant and duplicate signers (`AlreadyAttested`), and records `ClaimAttested`. When approvals reach the quorum the farmer is paid in that same transaction; when rejections reach it the claim closes and cover continues.
* **Try it:** log in as the farmer, buy cattle cover, advance time, report a death. Switch to *Dr. Mukamana* and sign (1/2, no payout), then *Dr. Habimana* (2/2, farmer paid). On USSD the same two vets are `250788000009` and `250788000010`.
* **Access control screen.** Admin → *Access control* reads `hasRole()` / `isCertifiedVet()` live from the chain.

## Premium subsidy (government programme)

Rwanda's National Agricultural Insurance Scheme (NAIS) pays 40% of the premium. FarmLedger models this on-chain:

* `SUBSIDY_ROLE` (deploy: `GOVERNMENT_ADDRESS`, local demo: Hardhat account #12) funds `subsidyPool` (`fundSubsidy` / `withdrawSubsidy`), sets the rate and an optional cap per farmer (`setSubsidy(rateBps, cap)`, at most 90%) and chooses which products qualify (`setSubsidyEligible`).
* At purchase the contract takes the subsidy from the pool and only the rest from the farmer. The underwriter always receives the full premium. `PremiumSubsidised(policyId, holder, subsidy, farmerPaid)` records the split; `subsidyFor(farmer, productId, premium)` gives the same number before buying (the portal shows it).
* The subsidy is cut when the farmer's cap or the pool runs out (never an error), and the farmer always pays at least 1 RWF.
* Local demo: 40%, 5,000,000 mRWF pool, 200,000 per farmer, all four products.
* The pool is test money (MockRWF). Real NAIS subsidies are paid to insurers off-chain; this is a model of the rule, not an integration with MINAGRI.

## Crop loss claims reviewed by the underwriter (CropClaims.sol)

Index cover pays automatically, but a farmer can lose a crop the index misses (hail, pests, a station far away). `contracts/CropClaims.sol` handles these claims:

* The holder (`fileClaim`) or the USSD gateway (`fileClaimFor`) files during the cover period with an evidence hash and an optional estimate. One open claim per policy, at most 3 per policy.
* Reviewers are the underwriter account plus the people it adds (`setReviewer`). `setReviewQuorum(M)` sets how many must agree, and is fixed per claim when filed. The claim pays when M reviewers approve **the same amount** (≤ sum insured), and closes when M reject it. Reviewers cannot decide their own claims.
* Payment goes through `FarmLedger.payAssessedLoss`, callable only by this contract (`ASSESSOR_ROLE`). The payout can be partial; the whole reserve is released.
* While a claim is open the policy cannot be expired (`UnderAssessment`), but it stays Active. If the index triggers during review, the automatic payout happens and the claim is closed as `Superseded`, so nothing is paid twice.
* Local demo: 2 of {underwriter, claims officer = Hardhat account #11}. Portal screens for the review queue come in a later phase.

## Units

Rainfall readings are the trailing 30-day total in **tenths of a mm** (2200 = 220 mm). NDVI is **index x 10000** (6500 = 0.65).
Amounts are mRWF (zero decimals, 1 token = 1 RWF).

## Security notes

* The Hardhat private keys in `web/lib/chain.js` and `services/common.js` are public development keys for the local chain only.
* One oracle account is a trust assumption (see scope doc). Pause and role control sit with the admin.
* `MockRWF.mint` is an open faucet: never deploy it as a real asset.

## Public testnet

Copy `.env.example` to `.env`, fill `PRIVATE_KEY` (funded test key), then
`npx hardhat run scripts/deploy.js --network arbitrumSepolia` (or `polygonAmoy`). Point the oracle at it with
`NETWORK=arbitrumSepolia ORACLE_PRIVATE_KEY=… node services/oracle.js run`.


---
Back to the [README](../README.md) · other topics: [Demo script](DEMO.md) · [Roles and the insurance workflow](ROLES_AND_WORKFLOW.md) · [Web portal](PORTAL.md) · [Phones: USSD, SMS and phone accounts](PHONE_AND_SMS.md) · [Mobile Money (MTN MoMo)](MOBILE_MONEY.md) · [Scope and requirements](SCOPE_AND_REQUIREMENTS.md)
