# FarmLedger

Decentralised parametric micro-insurance for Rwandan smallholders (capstone prototype).
Two claim paths, no human adjuster: **oracle-triggered payouts for crops/pasture** and **vet-attested payouts for livestock**.
See `docs/SCOPE_AND_REQUIREMENTS.md` for scope, simplifications and the requirement-to-test traceability.

## Prerequisites
Node.js 18+ (20/22 fine). Nothing else; the contracts run on a local Hardhat chain.

## One-command demo (Windows)
```
start-demo.bat
```
Then open <http://localhost:3000>.

## Manual steps
```
npm install
npm test                         # contract tests (add  npm run test:gas  for a gas table)
npm run node                     # terminal 1: local chain
npm run deploy:local             # terminal 2: deploy contracts, write addresses + ABI
npm run seed                     # demo products, farmers, plots, cows, liquidity
npm run notify                   # terminal 3: SMS + MoMo bridge (logs to services/out/)
npm run web:install && npm run web   # terminal 4: http://localhost:3000
npm run bench                    # gas / cost / latency report -> benchmark/results.md
```

## Demo script (5 minutes)
1. **Underwriter**: show escrow balance, products and the loss ratio (all zero).
2. **Aline (farmer)**: buy *Drought* cover on her maize plot (sum 200,000 mRWF, premium 20,000).
3. **Demo controls**: *Weather scenario = Drought*, plot 1, **Post oracle reading** -> Aline's wallet is paid in the same transaction; audit trail shows `PAYOUT … automatic`; notifier prints the SMS + simulated MoMo.
4. **Aline**: buy *Livestock mortality* cover on her cow, press **Report death**.
5. **Dr. Mukamana (vet)**: **Confirm death & pay** (signs an EIP-712 attestation) -> payout; try the same claim again and see the replay protection in the tests.
6. **Underwriter**: loss ratio, reserved vs available funds.
7. Oracle from the terminal instead of the button: `npm run oracle -- scenario flood 2`.

Real rainfall instead of the mock: `set DATA_SOURCE=nasa` (Windows) then `npm run oracle -- run`.

## USSD (monitoring and claim registration only)
`npm run ussd` starts the USSD service (Africa's Talking callback format) on port 4000; `start-demo.bat` starts it for you.
Open <http://localhost:3000/ussd> for a handset simulator, or point an Africa's Talking USSD callback at `https://<host>/ussd`.

**Policies are applied for, paid for and issued on the web portal only.** USSD cannot book or activate anything.

* Menu: **1** My policies (list, then details), **2** Report a claim (cattle death on an active policy, PIN required), **3** Claim status (awaiting vets / approved and paid / rejected).
* Who: only numbers whose hash was stored when the farmer registered on the web. An unknown number is told to register on the website.
* Demo numbers: `250788000001` Aline and `250788000002` Jean (registered by the seed script). First call asks for a 4-digit PIN; 3 wrong PINs lock the number for 30 minutes.
* **Why it cannot book a policy (enforced, not just hidden):** the service holds one key with `CLAIMS_AGENT_ROLE`, which on-chain can call only `fileClaimFor`. It has no wallets, no gas sponsorship, no Mobile Money collection and no minting. Its write object is built from a one-function interface, and `test/ussd.test.js` scans the source for every state-changing method and fuzzes the menus to prove no policy, asset, claim-other-than-requested or token balance can change.
* Vets sign claims on the web portal, not on USSD.
* Tests: `npm test` includes `test/ussd.test.js`.

## Policy application and supporting documents (web)
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

## Public testnet
Copy `.env.example` to `.env`, fill `PRIVATE_KEY` (funded test key), then
`npx hardhat run scripts/deploy.js --network arbitrumSepolia` (or `polygonAmoy`). Point the oracle at it with
`NETWORK=arbitrumSepolia ORACLE_PRIVATE_KEY=… node services/oracle.js run`.

## Units
Rainfall readings are the trailing 30-day total in **tenths of a mm** (2200 = 220 mm). NDVI is **index x 10000** (6500 = 0.65).
Amounts are mRWF (zero decimals, 1 token = 1 RWF).

## Security notes
* The Hardhat private keys in `web/lib/chain.js` and `services/common.js` are public development keys for the local chain only.
* One oracle account is a trust assumption (see scope doc). Pause and role control sit with the admin.
* `MockRWF.mint` is an open faucet: never deploy it as a real asset.

## Vet certification and multi-signature claims

Livestock claims are no longer decided by a single role-holder.

* **Certification registry.** The admin calls `certifyVet(address, licenseHash, sector, validUntil)`. The licence number is hashed in the browser; only the hash goes on-chain. A vet's signature counts only while the record is active and unexpired (`isCertifiedVet`). `revokeVet` takes effect immediately; renewal is another `certifyVet` call.
* **Quorum.** `setVetQuorum(1..5)` sets how many *distinct* certified vets must sign. The value is copied into each claim when it is filed, so changing it later never alters an open claim. Local demo: **2 of 3**.
* **Protocol.** Each vet signs an EIP-712 `Attestation(claimId, policyId, tagId, approved, deadline)`. Anyone can relay it. The contract recovers the signer, checks certification, rejects the claimant and duplicate signers (`AlreadyAttested`), and records `ClaimAttested`. When approvals reach the quorum the farmer is paid in that same transaction; when rejections reach it the claim closes and cover continues.
* **Try it:** log in as the farmer, buy cattle cover, advance time, report a death. Switch to *Dr. Mukamana* and sign (1/2, no payout), then *Dr. Habimana* (2/2, farmer paid). On USSD the same two vets are `250788000009` and `250788000010`.
* **Access control screen.** Admin → *Access control* reads `hasRole()` / `isCertifiedVet()` live from the chain.
