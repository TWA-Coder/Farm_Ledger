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
Then open <http://localhost:3000> (landing page) or go straight to the portal at <http://localhost:3000/app>.

## Manual steps
```
npm install
npm test                         # contract tests (add  npm run test:gas  for a gas table)
npm run node                     # terminal 1: local chain
npm run deploy:local             # terminal 2: deploy contracts, write addresses + ABI
npm run seed                     # demo products, farmers, plots, cows, liquidity
npm run notify                   # terminal 3: SMS + MoMo bridge (logs to services/out/)
npm run bundler                  # terminal 3b: ERC-4337 bundler for farmers' smart accounts (port 4337)
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

## Farmer journey in the portal (/app)

The portal opens on **My farmer account (no fees)**: an ERC-4337 smart account created for this browser (see
*Accounts* below). The header also lists the shared test accounts and a **Connect wallet** link for vets,
underwriters and administrators. Either a new smart account or **New farmer (starts unregistered)** walks the
whole journey from the beginning:

| Stage | Screen | What really happens |
|---|---|---|
| 1. Onboarding | Home | `registerFarmer` with hashes of the National ID and phone (16-digit ID, `2507xxxxxxxx` phone validated). The plain phone number is then sent, signed by the farmer, to `/api/contacts` and stored off-chain only if it matches the on-chain hash, so the notifier can send SMS. |
| 2. Farm details | My farm | `registerPlot` (district centre or exact GPS inside Rwanda, size in hectares, crop) and `registerAnimal` (ear tag checked for duplicates before sending). |
| 3. Product discovery | Cover options | Active products read from the contract: trigger, cost example, length, documents needed and the rules the contract enforces. Missing NAIS terms are stated. |
| 4-5. Application, payment, policy | Apply for cover | Three-step wizard. Step 1: trigger level (e.g. rain below 120 / 150 / 180 mm, each with its own price), start date (today or up to 90 days ahead) and end date (30 days up to the product length; premium pro-rated by days), sum insured. Step 2: documents and the policy-schedule details (name, ID, district and sector, crop variety, expected yield…). Then `approve` (exact premium) + `buyCover` + `recordApplication`. If the last step fails after payment, the screen says the policy exists and offers a retry. |
| 6. Monitoring | Policies and claims, My farm | Latest rainfall and NDVI per plot from `getLatestReading`, each labelled **Real data** (NASA POWER rainfall) or **Sample data** (mock oracle, test tools, NDVI). |
| 7. Claim | Policies and claims | Cattle only: photo upload is required; its SHA-256 becomes the on-chain `evidenceHash` (`fileClaim`). Waiting period shown before the button appears. Crop cover needs no claim. |
| 8. Verification | Vet: Claims queue | Certified vets open the photo (server checks `isCertifiedVet` on-chain), the portal re-hashes it against the claim, and each vet signs an EIP-712 decision. |
| 9. Payout | automatic | Crop: inside `postReading`. Cattle: when the vet quorum is reached. Paid as test tokens; the notifier logs the SMS and a **simulated** Mobile Money disbursement. |
| Underwriter | Policies | Every policy on the underwriter's products and its **policy document** in the NAIS schedule layout (insured, premiums, risk details, sections covered, clauses, exclusions, schedule, claims, records), printable or savable as PDF. The application record is served only to that policy's underwriter (role and product checked on-chain) and compared with the hash anchored on-chain. |
| 10. Tracking | Home, Policies and claims, bell | Status steps, plain-language history, payout reference and block. Every action shows "waiting for confirmation", then the ledger reference or a plain error. |

### Accounts: smart accounts for farmers, browser wallets for professionals
* **Farmers** get an ERC-4337 smart account (eth-infinitism v0.7 `EntryPoint` + `SimpleAccountFactory`). The owner key is created on the device and kept in browser storage: no app to install, no seed phrase, no ETH. Every action is a UserOperation sent to the bundler (`services/bundler.js`); fees are paid by `contracts/aa/FarmLedgerPaymaster.sol`, which only sponsors calls to FarmLedger and the token, with no ETH value and a cost cap per operation. Document and contact requests are signed by the owner key; the server accepts them when that key is `owner()` of the account.
* **Vets, underwriters and administrators** can use a browser wallet (MetaMask or any EIP-1193 wallet): **Connect wallet** switches the wallet to this network and picks the role from the chain (admin role, underwriter role, or vet certification).
* Limits: the device key is lost if the browser storage is cleared (no recovery or guardians yet); production should use passkeys or a hosted embedded wallet. The local bundler simulates and submits operations one at a time but does not run the full ERC-7562 validation rules; on a public network use the canonical EntryPoint `0x0000000071727De22E5E9d8BAf0edAc6f37da032` and a hosted bundler (set `BUNDLER_URL`).

### Portal configuration (all optional)
| Variable | Default | Purpose |
|---|---|---|
| `RPC_URL` | `rpcUrl` in `web/public/deployment.json` | Chain the portal API reads (vet certification, phone hash) |
| `UPLOAD_DIR` | `web/.data/uploads` | Uploaded application and claim documents |
| `CONTACTS_FILE` | `web/.data/contacts.json` | Plain phone numbers for SMS (off-chain, git-ignored). The notifier reads the same path |
| `ORACLE_READINGS_LOG` | `services/out/readings.json` | Where the oracle records each reading's data source |
| `FARMLEDGER_REVIEWERS` | empty | Comma-separated addresses allowed to view any applicant document (on-chain underwriters can already view them) |
| `BUNDLER_URL` | `http://localhost:4337` | Written into the deployment at deploy time; where the portal sends farmers' UserOperations |
| `BUNDLER_PORT`, `BUNDLER_PRIVATE_KEY` | `4337`, Hardhat account #10 | Bundler service port and the key that submits `handleOps` |
| `PAYMASTER_DEPOSIT_ETH`, `PAYMASTER_MAX_COST_ETH` | `100` (local), `0.05` | Fee sponsorship deposit and the maximum cost of one sponsored operation |
| `DEPLOY_AA`, `ENTRYPOINT_ADDRESS` | off on testnets | Deploy the smart-account contracts on a public network, reusing an existing EntryPoint |

### Known limits of the test version
* The shared test accounts use public development keys that are in the client bundle (local chain only). Real users use a smart account (farmers) or a browser wallet (professionals), see above.
* Test money (`MockRWF`, open faucet). Mobile Money disbursement is simulated; SMS is logged unless Africa's Talking keys are set.
* NDVI is always sample data. CHIRPS is not integrated (NASA POWER rainfall is the real-data option). One oracle key is trusted.
* NAIS contract terms not modelled yet: 40% government premium share, excess, cause-of-death and vaccination rules, multi-animal schedules, yield assessment for crops. The policy document states which of these are not applied.

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
