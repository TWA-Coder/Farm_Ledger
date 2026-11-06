# Roles and the insurance workflow

Who can do what, and how a policy comes to exist: farmer registration, agent application, underwriter contract, farmer acceptance and payment.

## Roles

| Role | Who | Can | Cannot |
|---|---|---|---|
| **Farmer** | Smallholder: web (smart account) or basic phone (phone account) | Register (with district), see cover options, review contracts drafted for them and **accept and pay** or decline, report cattle deaths and crop losses, follow claims | Book a policy directly (only a contract drafted by the underwriter can be accepted) |
| **Insurance agent** | Appointed by an underwriter for districts (`PolicyDesk.appointAgent`) | See the farmers assigned to them, record their plots and cattle, fill in and submit applications with documents, follow them | Apply to another insurer's products, accept or pay for the farmer, see other agents' farmers |
| **Underwriter** | Insurance company (`UNDERWRITER_ROLE`) | Products and trigger levels, liquidity, appoint and suspend agents, **review applications and draft contracts** or reject with reasons, crop-claim reviewers | See applications for other insurers' products. When suspended (role revoked) it sells nothing but can withdraw free funds |
| **Claims reviewer** | Underwriter staff (CropClaims) | Approve or reject crop loss claims on that insurer's policies (M-of-N, same amount) | Decide their own claim |
| **Veterinarian** | Certified by the vet registrar | Sign livestock claim decisions (quorum), view claim photos | Approve their own claim |
| **Vet registrar** | Professional body (`VET_REGISTRAR_ROLE`) | Certify and revoke vets | Anything else |
| **Oracle** | Data service (`ORACLE_ROLE`) | Post rainfall and NDVI readings (pays index cover) | Anything else |
| **Subsidy programme** | Government (`SUBSIDY_ROLE`) | Fund the subsidy pool, set rate, cap and eligible products | Anything else |
| **Governance** | Admin (`DEFAULT_ADMIN_ROLE`; a multisig via `GOVERNANCE_ADDRESS` off the local chain) | Grant and revoke roles, vet quorum, waiting period, **unpause**, reassign farmers between agents | Pause alone is the guardian's job too |
| **Guardian** | Operations (`PAUSER_ROLE`) | **Pause** at once | Unpause |
| **Auditor** | `FARMLEDGER_AUDITORS` (portal) | Read any application document (logged) | Change anything |
| **Support operator** | Shell access to the server | `npm run accounts` / `npm run momo` (named with `--by`, logged); early release of a number change only with the farmer's own agent | Act unlogged |
| Contracts and services | PolicyDesk (`ISSUER_ROLE`, `REGISTRAR_ROLE`), CropClaims (`ASSESSOR_ROLE`), USSD gateway (`CLAIMS_AGENT_ROLE`), custody service, treasury (token minter) | Exactly their one job | Anything else |

## How a policy comes to exist

1. **Register.** The farmer registers (web, or USSD with a code by SMS) and gives the farm's district. `PolicyDesk.join` assigns the active agent covering that district with the fewest farmers (the agent's insurer or governance can reassign).
2. **Apply.** The agent fills in the application with the farmer on the portal (*New application*): product, plot or animal (recorded by the agent if needed), requested terms, documents and policy-schedule details. The server checks on-chain that this agent is assigned to the farmer. Submitting seals the form and documents with a hash and records it with `PolicyDesk.submitApplication`.
3. **Draft.** The underwriter of that product opens it on the *Application desk* (only that underwriter can see the documents; every view is logged), and either drafts the contract (final terms, starting from the request; the premium always follows the product's published rate; optional special conditions) or rejects it with written reasons. The contract or reasons are stored next to the application and their hash is recorded on-chain (`draftContract` / `rejectApplication`).
4. **Notify.** The farmer and the agent get an SMS at every step: assigned, submitted, contract ready (with what the farmer pays and the deadline), rejected, issued.
5. **Accept and pay.** Within 14 days the farmer reviews the contract and pays the premium minus any subsidy: on a basic phone by **USSD 6. My offers + MTN Mobile Money**, on the web with **Accept and pay**. Only then does `PolicyDesk.acceptOffer` call `FarmLedger.issuePolicy`, which records the contract's hash with the policy. The farmer can also decline.

## Policy application and supporting documents (web, filled in by the agent)

**New application** (farmer) is a three-step wizard: cover details, supporting documents, review and pay.

| Document | When | Required |
|---|---|---|
| National ID (front and back) | every application (kept on file and reused) | yes |
| Proof of land use | crop covers | yes |
| Photo of the plot | crop covers | no |
| Photo of the animal showing the ear tag | cattle cover | yes |
| Veterinary health certificate | cattle cover | yes |
| Proof of ownership | cattle cover | no |

PDF, JPG or PNG, up to 5 MB each. Files are checked by content (not file name), can be viewed, replaced or removed before submitting, and the wizard will not continue while a required document is missing. The server re-checks completeness before the policy is issued.

Handling: every upload is signed by the applicant's wallet (so a file is bound to its owner), stored outside the public web root under `web/.data/uploads/<applicant>/<application>/`, and served only to a signed request from the owner or an address listed in `FARMLEDGER_REVIEWERS`. The final application (answers + each file's SHA-256) is hashed and that hash is recorded on-chain against the policy (`recordApplication`), so the file set cannot be altered later without detection. For production, move storage to encrypted object storage and add malware scanning.

Adding contract-driven fields later: see `docs/APPLICATION_MODEL.md`.


---
Back to the [README](../README.md) · other topics: [Demo script](DEMO.md) · [Web portal](PORTAL.md) · [Phones: USSD, SMS and phone accounts](PHONE_AND_SMS.md) · [Mobile Money (MTN MoMo)](MOBILE_MONEY.md) · [Smart contracts](CONTRACTS.md) · [Scope and requirements](SCOPE_AND_REQUIREMENTS.md)
