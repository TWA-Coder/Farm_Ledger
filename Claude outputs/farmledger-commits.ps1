# FarmLedger - commit the current work in logical steps, then push.
# Run in PowerShell from the Farm_Ledger folder:   .\farmledger-commits.ps1
# Review "git status" at the end before pushing.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# 1 ---------------------------------------------------------------------------
git rm -r --cached --quiet node_modules cache
git add .gitignore web/.gitignore .env.example
git commit -m "chore: stop tracking node_modules and build cache" `
  -m "node_modules/ and cache/ were committed by mistake. Remove them from the index and ignore them along with artifacts/, coverage/, services/out/, web/.next/ and web/.data/ (uploaded documents). Add .env.example listing the optional testnet, oracle and Africa's Talking settings."

# 2 ---------------------------------------------------------------------------
git add contracts/FarmLedger.sol contracts/MockRWF.sol hardhat.config.js package.json package-lock.json test/FarmLedger.test.js test/helpers.js
git commit -m "feat(contracts): rebuild FarmLedger as a role-based parametric insurance contract" `
  -m "Replace the single-verifier ETH pool with FarmLedger (AccessControl, EIP-712, ReentrancyGuard, Pausable):" `
  -m "- farmer, plot and animal registry with unique ear tags
- underwriter products, premium quotes and token escrow (deposit/withdraw liquidity)
- crop and pasture cover paid automatically when an oracle reading crosses the threshold
- livestock claims settled by EIP-712 vet attestations, with waiting period and one policy per animal
- vet certification registry (certify/revoke, expiry) and a configurable multi-vet quorum
- fileClaimFor for a claims agent and recordApplication to anchor the application hash
- MockRWF test token (0 decimals, open faucet - demo only)" `
  -m "Covers FR-01..FR-10 and NFR-03/NFR-06 in test/FarmLedger.test.js."

# 3 ---------------------------------------------------------------------------
git add scripts/deploy.js scripts/seed-demo.js deployments/localhost.json
git commit -m "feat(scripts): add deploy and demo seed scripts" `
  -m "deploy.js deploys MockRWF and FarmLedger, grants roles and writes the addresses and ABI for the web app. seed-demo.js creates demo products, farmers, plots, cattle, certified vets and pool liquidity on the local chain."

# 4 ---------------------------------------------------------------------------
git add services/adapters.js services/common.js services/oracle.js services/notifier.js services/phonebook.json services/scenario.json
git commit -m "feat(services): add weather oracle and payout notifier" `
  -m "oracle.js posts rainfall and NDVI readings per plot (mock scenarios or NASA POWER data) so the contract can pay automatically (FR-05/FR-06). notifier.js listens for payouts and sends the farmer an SMS (Africa's Talking, or logged) plus a stubbed Mobile Money disbursement (FR-11)."

# 5 ---------------------------------------------------------------------------
git add services/ussd-core.js services/ussd.js test/ussd.test.js
git commit -m "feat(ussd): add USSD channel for policy monitoring and claim registration" `
  -m "Africa's Talking-style USSD service: view policies, report a cattle death on an active policy (PIN protected, lockout after 3 wrong PINs) and track claim status. It holds only CLAIMS_AGENT_ROLE and can call nothing but fileClaimFor, so it cannot book or activate policies; the tests scan and fuzz the menus to prove it."

# 6 ---------------------------------------------------------------------------
git add web test/documents.test.js
git commit -m "feat(web): add Next.js portal with policy application wizard and documents" `
  -m "Role views for farmer, vet, underwriter and admin, a USSD handset simulator at /ussd and a PWA manifest. New policies go through a three-step wizard (cover, supporting documents, review and pay). Uploads are content-checked (PDF/JPG/PNG, 5 MB), signed by the applicant's wallet, stored outside the web root and served only to the owner or listed reviewers. The final application hash is recorded on-chain against the policy. Requirements live in web/shared/requirements.js, shared by browser, server and tests."

# 7 ---------------------------------------------------------------------------
git add benchmark
git commit -m "feat(bench): add gas, cost and settlement-latency benchmark" `
  -m "npm run bench measures average gas per operation, estimated USD cost against NFR-02 and trigger-to-payout latency against NFR-01, and writes benchmark/results.md with a comparison to the manual NAIS baseline."

# 8 ---------------------------------------------------------------------------
git add README.md docs FarmLedger-Insurance-Questionnaire.md
git commit -m "docs: rewrite README and add scope, requirements and application model" `
  -m "README now covers the one-command demo, manual steps, a 5-minute demo script, USSD, supporting documents, testnet deployment, units and security notes. Add docs/SCOPE_AND_REQUIREMENTS.md (scope, simplifications, requirement-to-test traceability) and docs/APPLICATION_MODEL.md. Move the insurance questionnaire to docs/research/."

# 9 ---------------------------------------------------------------------------
git add legacy
git commit -m "chore: archive first prototype under legacy/" `
  -m "Keep the original FarmLedgerInsurance contract, scripts and tests for reference (iteration 1 in the report). Not part of the main build or test run."

# 10 --------------------------------------------------------------------------
git add start-demo.bat cleanup.ps1
git commit -m "chore: add Windows demo launcher and cleanup script" `
  -m "start-demo.bat installs dependencies and starts the chain, deploy and seed, notifier, USSD service and web app. cleanup.ps1 removes superseded files and generated folders after the project merge."

# -----------------------------------------------------------------------------
git status
Write-Host "`nIf the status above is clean, push with:  git push origin main"
