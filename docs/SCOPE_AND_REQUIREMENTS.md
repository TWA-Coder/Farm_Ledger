# FarmLedger - scope, requirements and traceability

## 1. What "done today" means
A runnable end-to-end prototype of the proposal's core claim: **two ways of paying a claim, both without a human adjuster** -
parametric payout from oracle data (crops/pasture) and payout on a veterinarian's cryptographic attestation (livestock) -
with escrowed funds, role-based access, an audit trail, tests and benchmark evidence for Objective 4.

### In scope (built)
| Area | Delivered |
|---|---|
| Smart contracts (Solidity 0.8.24, OpenZeppelin 5) | `FarmLedger.sol` (registry, products, escrow, both claim modes, RBAC, pause) and `MockRWF.sol` (test stable token) |
| Tests | Hardhat suite, 40+ cases across FR-01..FR-10 and NFR-03/06 |
| Oracle | `services/oracle.js`: posts rainfall + NDVI per plot. Mock scenarios (default) or NASA POWER rainfall (`DATA_SOURCE=nasa`) |
| USSD access | `services/ussd-core.js`: policy monitoring, claim registration and claim status; phone accounts for basic-phone farmers (register with National ID + SMS code, PIN reset, number change with a 48 h cancellable wait) in `services/phone-accounts.js` + simulator page + tests. Booking and paying are still web-only |
| Notifications / payout rail | `services/notifier.js`: listens to chain events, sends SMS (logged, or Africa's Talking if keys set) and simulated MoMo disbursement |
| Web client | Next.js PWA: farmer, vet, underwriter and admin views, demo controls, public audit trail |
| Evidence | `npm run bench` writes gas, estimated cost and latency vs the manual baseline to `benchmark/results.md` |

### Deliberately simplified (state these honestly in the report)
| Proposal item | What the prototype does | Why |
|---|---|---|
| Chainlink Functions DON | Single authorised oracle account behind one adapter (`postReading`) | Functions needs a LINK-funded subscription and secrets; the contract interface is identical, so the oracle can be swapped later. Trust assumption: one oracle key (decentralisation is future work) |
| CHIRPS / satellite NDVI | NASA POWER rainfall (keyless) as the real-data option; NDVI from the mock adapter | No keyless NDVI API. Adapter signature is ready for Sentinel Hub / MODIS |
| ERC-4337 account abstraction (Biconomy) | Built without Biconomy: eth-infinitism v0.7 `EntryPoint` + `SimpleAccountFactory`, `contracts/aa/FarmLedgerPaymaster.sol` sponsors farmers' fees (FarmLedger and token calls only, per-operation cost cap), local bundler `services/bundler.js`. Vets, underwriters and admins use a browser wallet | Portal farmers' owner key is kept in browser storage with no recovery (production: passkeys or a hosted embedded wallet). Phone-account keys are server-held and encrypted (custodial; production: KMS/HSM for PHONE_KEY_SECRET). The local bundler does not enforce the full ERC-7562 validation rules; on a public network use the canonical EntryPoint and a hosted bundler (`BUNDLER_URL`) |
| IPFS/Filecoin | Only the content hash is stored on-chain (`geoHash`, `photoHash`, `evidenceHash`) | Pinning is an off-chain concern; the on-chain commitment is the same |
| MTN MoMo / Airtel payout | Payout is an ERC-20 transfer (mRWF); the notifier records a simulated MoMo disbursement | Sandbox keys needed; integration point is `disburseMomo()` |
| Agent applications and underwriter contracts | Built: `contracts/PolicyDesk.sol` (agents appointed per district by each underwriter, automatic assignment, applications with form hash, contracts drafted by the underwriter, 14-day offers, acceptance issues the policy via `FarmLedger.issuePolicy`; farmers can no longer book directly). Portal: agent desk, application form, underwriter application desk, farmer offers; USSD 6. My offers paid by MoMo. Document access limited to the product's underwriter and the farmer's agent, every view logged; auditors read-only | Agent licensing by the regulator and commissions are not modelled; the contract document is a structured record (terms + conditions) rather than a signed PDF |
| MTN Mobile Money | Built: `services/payments.js` + `services/momo.js`. Phone-account farmers add a plot or cow and buy cover from USSD; the premium (after subsidy) is collected by request-to-pay, the account is credited and buys in one sponsored operation; failed purchases are refunded; payouts are swept to the treasury and sent by MoMo transfer. Idempotent rows, polling. Verified end to end with the simulator on the local chain; the MoMo client is tested against a fake of MTN's API | Sandbox is EUR only; live needs an MTN Rwanda business account; on-chain money is a test token minted by the treasury (production: regulated stablecoin / e-money, treasury key in an HSM) |
| SMS menu channel (no shortcode) | Built: `services/sms-channel.js` serves the USSD menus over plain SMS through an Android phone running SMS Gateway for Android (signed, de-duplicated webhooks; replies from the gateway SIM). Verified against a fake gateway; a real run needs the owner's Android phone | Step-by-step SMS instead of instant USSD screens; the gateway phone must stay online; cloud mode relays messages through api.sms-gate.app |
| Africa's Talking USSD + SMS | Built: `services/ussd.js` speaks the Africa's Talking callback format (token-protected public callbacks, delivery reports); SMS outbox with retries, per-phone order and delivery tracking (`services/sms.js`); notifier driven by the event index in chain order; simulator at `/ussd`. Verified against a local fake of the API and through the public tunnel; a real sandbox/live run needs the owner's Africa's Talking key | A real shortcode needs registration with the operator. The gateway key holds only the claims-agent role; production needs key custody (HSM), SIM-swap checks and operator-grade authentication beyond a PIN |
| Public testnet | Local Hardhat chain by default; `deploy.js` supports Arbitrum Sepolia / Polygon Amoy | Needs a funded key and RPC |

### Out of scope
Real money, KYC, regulatory licensing, mainnet, custom IoT hardware (as in the proposal's delimitations).

## 2. Proposal corrections to make before submission
1. **FR-07 and FR-08 are identical.** Proposed FR-08: *"The system shall register the claim against the animal's ear-tag ID and reject duplicate or already-deceased animals."* (implemented: unique tag registry, one policy per animal, `deceased` flag).
2. **NFR-01 (<= 15 s)**: define it as contract execution after the trigger (measured by the benchmark). Oracle data latency is separate and not guaranteed by the chain.
3. **NFR-02 (<= USD 0.05)** is shown as gas x an assumed L2 gas price (parameters in `benchmark/benchmark.js`), not a measured testnet fee.
4. **NFR-04 (99.5% uptime) and NFR-05 (SUS >= 80)** cannot be shown in a day: report as targets with the measurement plan (uptime monitor on the oracle/web; SUS survey with 5+ farmers/vets during the field visits in the budget).
5. Figure/table numbering in Chapter 3 does not match the list of figures (Figure 3.6 appears twice; the list says 3.3 and 3.4).
6. Added design decisions worth a paragraph in Chapter 3: full-sum reservation per policy (solvency), a 7-day livestock waiting period (moral hazard), signer != claimant, EIP-712 attestation bound to claim, decision and deadline (anti-replay), personal data only as hashes.

## 3. Traceability
| Req | Where implemented | Verified by |
|---|---|---|
| FR-01 farmer identity | `registerFarmer` (ID/phone hashes, unique ID) | `Registry` tests |
| FR-02 plots & livestock | `registerPlot`, `registerAnimal` (GPS, crop, area; ear tag, breed, photo hash) | `Registry` tests |
| FR-03 premium calculation & payment | `quotePremium`, `buyPolicy` (+ UI quote) | `Products, premiums and escrow` tests. MoMo collection = simulated |
| FR-04 escrow | `poolBalance` / `poolReserved`, full reservation | escrow + solvency tests |
| FR-05 oracle queries | `services/oracle.js`, `postReading` | `Mode 1` tests; run `npm run oracle` |
| FR-06 automatic crop payout | `postReading` -> `_payout` | `Mode 1` tests (drought, flood, NDVI, multi-policy) |
| FR-07 livestock claim with evidence | `fileClaim` (evidence hash) | `Mode 2` tests |
| FR-08 (see correction above) | tag registry, one policy per animal, deceased flag | duplicate-tag / covered-animal tests |
| FR-09 vet attestation | EIP-712 `Attestation`, certification registry (licence hash, sector, expiry, revocation), web vet queue | `Mode 2` + `Vet certification and multi-signature` tests |
| FR-10 signature verification & payout | `settleLivestockClaim`: M-of-N distinct certified vets (quorum fixed per claim), replay, tamper and double-signing protection | `Mode 2` + quorum tests |
| FR-07 and claim follow-up for feature-phone users (policy booking excluded by design) | `services/ussd-core.js` + `fileClaimFor` (claims-agent role) | `test/ussd.test.js` |
| Supporting documents with policy booking | `web/shared/requirements.js`, `web/server/documents-core.js`, upload API, `recordApplication` | `test/documents.test.js`, claims-agent tests |
| FR-11 SMS + MoMo | `services/notifier.js` | simulated (log + ledger file) |
| FR-12 underwriter dashboard | `poolStats`, web underwriter view | manual / demo |
| NFR-01 | benchmark latency table | `npm run bench` |
| NFR-02 | benchmark gas table | `npm run bench` |
| NFR-03 security | OZ AccessControl/ReentrancyGuard/Pausable, 0.8 checked math, custom errors | `npm run slither` (needs Slither installed), tests |
| NFR-06 auditability | events for every transition, "Public audit trail" | event tests |
