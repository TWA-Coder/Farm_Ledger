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
| `FARMLEDGER_DB` | `web/.data/farmledger.db` | Off-chain SQLite database shared by the portal and the services (see *Off-chain data* below) |
| `INDEXER_CONFIRMATIONS`, `INDEXER_CHUNK_BLOCKS` | `0`, `2000` | Event index: blocks to wait before indexing (use ~3 on a public network) and blocks per log request |
| `FARMLEDGER_REVIEWERS` | empty | Comma-separated addresses allowed to view any applicant document (on-chain underwriters can already view them) |
| `BUNDLER_URL` | `http://localhost:4337` | Written into the deployment at deploy time; where the portal sends farmers' UserOperations |
| `BUNDLER_PORT`, `BUNDLER_PRIVATE_KEY` | `4337`, Hardhat account #10 | Bundler service port and the key that submits `handleOps` |
| `PAYMASTER_DEPOSIT_ETH`, `PAYMASTER_MAX_COST_ETH` | `100` (local), `0.05` | Fee sponsorship deposit and the maximum cost of one sponsored operation |
| `DEPLOY_AA`, `ENTRYPOINT_ADDRESS` | off on testnets | Deploy the smart-account contracts on a public network, reusing an existing EntryPoint |

### Off-chain data
One SQLite file (`web/.data/farmledger.db`, git-ignored, owner-only permissions) holds what the chain does not:
plain phone numbers for SMS (`contacts`; the chain stores only their hash), USSD PIN state (`ussd_users`), where
each oracle reading came from (`readings`), and an index of every contract event (`events`). It uses SQLite built
into Node 22.5+, so there is nothing to install. The portal reads activity from `/api/events`, which brings the
index up to date on each request (`web/server/indexer.js`) instead of scanning the chain from block 0. When the local
chain is restarted, the index notices and rebuilds itself.
Older JSON files (`web/.data/contacts.json`, `services/out/ussd-users.json`, `services/out/readings.json`) are
imported once on first start and renamed to `*.imported`.

### Public URL for the phone network (USSD and SMS callbacks)
Africa's Talking must reach the USSD service over HTTPS. `npm run tunnel` (needs `brew install cloudflared`) opens a
free Cloudflare quick tunnel to the USSD service on port 4000 and prints a `https://….trycloudflare.com` address.
The address changes every time the tunnel starts, so paste the new one into the Africa's Talking callback setting
before a demo. Anyone who knows the address can reach the service while the tunnel runs; stop it when not in use.

### Known limits of the test version
* The shared test accounts use public development keys that are in the client bundle (local chain only). Real users use a smart account (farmers) or a browser wallet (professionals), see above.
* Test money (`MockRWF`, open faucet). Mobile Money disbursement is simulated; SMS is logged unless Africa's Talking keys are set.
* NDVI is always sample data. CHIRPS is not integrated (NASA POWER rainfall is the real-data option). One oracle key is trusted.
* NAIS contract terms not modelled yet (the 40% government premium share is, see *Premium subsidy*): excess, cause-of-death and vaccination rules, multi-animal schedules, yield assessment for crops. The policy document states which of these are not applied.

## USSD (monitoring, claim registration and phone accounts)
`npm run ussd` starts the USSD service (Africa's Talking callback format) on port 4000; `start-demo.bat` starts it for you.
Open <http://localhost:3000/ussd> for a handset simulator, or point an Africa's Talking USSD callback at `https://<host>/ussd`.

**Policies are applied for, paid for and issued on the web portal only (for now).** USSD cannot book or activate anything yet.

* Menu: **1** My policies (list, then details), **2** Report a claim (cattle death on an active policy, PIN required), **3** Claim status (awaiting vets / approved and paid / rejected), **4** Reset PIN and, while a number change is waiting, **5** Cancel number change (both only with phone accounts, below).
* Who: farmers registered on the web, and farmers who registered from their phone (phone accounts). With phone accounts off, an unknown number is told to register on the website.
* Demo numbers: `250788000001` Aline and `250788000002` Jean (registered by the seed script). First call asks for a 4-digit PIN; 3 wrong PINs lock the number for 30 minutes.
* **Why the gateway cannot book a policy (enforced, not just hidden):** the service holds one key with `CLAIMS_AGENT_ROLE`, which on-chain can call only `fileClaimFor`. It has no wallets, no gas sponsorship, no Mobile Money collection and no minting. Its write object is built from a one-function interface, and `test/ussd.test.js` scans the source for every state-changing method and fuzzes the menus to prove no policy, asset, claim-other-than-requested or token balance can change.
* Vets sign claims on the web portal, not on USSD.
* Tests: `npm test` includes `test/ussd.test.js` and `test/phone-accounts.test.js`.

## Phone accounts (farmers with a basic phone)

A farmer with no smartphone can create a FarmLedger account from USSD. The account is the same kind of ERC-4337 smart account the portal uses, with fees paid by the paymaster, but **the server holds its key** (`services/phone-accounts.js`, the only file that touches farmer keys).

* **Register:** an unregistered number sees *1. Register / 2. I changed my number*. Register asks for the 16-digit National ID (refused if already registered), sends a 6-digit code by SMS, and on the next dial asks for the code, creates the account, registers the farmer on-chain from it (`registerFarmer(keccak(ID), keccak(phone))`) and asks for a PIN. The code proves the number receives SMS, which payout notices rely on. The network already identifies the caller.
* **Codes:** 6 digits, valid 10 minutes, 5 tries, at most one per minute and five a day per number (enter `0` on the code screen for a new one). Stored as an HMAC, never in plain text.
* **Key custody:** a new random owner key per phone, encrypted with AES-256-GCM using a key derived from `PHONE_KEY_SECRET`, and bound to the account address. It is decrypted only in memory to sign. On the local chain the secret is generated into `web/.data/phone-key.secret` (git-ignored, owner-only); anywhere else the service refuses to start without `PHONE_KEY_SECRET` (`openssl rand -hex 32`). **This is custodial:** whoever holds the secret and the database can sign for these farmers. Keep the secret apart from database backups.
* **Reset PIN (menu 4):** needs the National ID on the account. 3 wrong IDs lock the number for 30 minutes. The farmer gets an SMS that the PIN changed. Works for web-registered farmers too.
* **New SIM / new number (recovery):** from the new number choose *2. I changed my number*, give the old number and the National ID, and confirm the code sent to the new number. The old number is told by SMS and can cancel (menu 5) during the waiting period (`RECOVERY_DELAY_HOURS`, default 48). On the next dial after that, the **same account** (same address, policies and payouts) moves to the new number: `updatePhone()` records the new hash on-chain and the farmer chooses a new PIN. The same answer is given for an unknown number and a wrong ID, and 3 wrong tries lock the number. Farmers registered on the website keep their own key and change their number there.
* **Operator:** `npm run accounts` lists phone accounts and number changes; `-- cancel <id>` stops one (fraud report); `-- release <id>` ends the waiting period early after checking the farmer's ID in person.
* **Not yet:** buying cover or paying premiums from USSD (phase 4/6), and logging in to the portal with a phone account.

| Variable | Default | Purpose |
|---|---|---|
| `PHONE_KEY_SECRET` | generated locally | 64 hex chars. Encrypts phone-account keys and code hashes. Required off the local chain |
| `RECOVERY_DELAY_HOURS` | `48` | How long a number change waits for the old number to cancel |
| `USSD_SHORTCODE` | "the FarmLedger USSD code" | The code farmers dial, used in SMS texts (e.g. `*384*12345#`) |
| `PHONE_ACCOUNTS` | on when the smart-account contracts are deployed | `off` = monitoring and claims only |

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

## Phone number change

`updatePhone(newPhoneHash)` lets a registered farmer record a new number (SIM swap, lost phone). The account and its plots, animals and policies are unchanged. The service that calls it must verify the new number with a one-time SMS code first (phone accounts phase).
