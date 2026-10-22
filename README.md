Link Video: https://www.awesomescreenshot.com/video/55105639?key=26a177482ab720003db55691d27a6ff9

# FarmLedger Agricultural Insurance

An educational Solidity prototype for crop and livestock insurance. Policies use native test ETH for premiums and payouts. A designated verifier submits a non-zero hash representing off-chain evidence; the contract does not connect to an oracle or independently assess claims.

## Requirements

- Node.js 18 or newer
- npm 8 or newer

## Install, compile, and test

Run these commands in the project directory:

```powershell
npm install
npm run compile
npm test
```

The active `FarmLedgerInsurance` suite checks pool funding, policy creation and payout reservations, access control, valid and invalid claims, one-time payments, policy expiry, and release of expired reservations. The old farmer/harvest/loan tests are skipped because that is a different contract API and is not implemented by the current Solidity source.

## Local end-to-end test

Open two PowerShell terminals in the project directory.

**Terminal 1 — start a local chain:**

```powershell
npm run node
```

Keep it running. Hardhat provides funded test accounts; these are not real ETH.

**Terminal 2 — deploy the contract and fund its pool:**

```powershell
npx hardhat run scripts/deploy.js --network localhost
```

The script deploys `FarmLedgerInsurance`, uses account 1 as the verifier, funds the pool with 10 test ETH, and prints the contract address.

Set that address in the second terminal (replace the example value):

```powershell
$env:FARMLEDGER_ADDRESS = "0xYourDeployedContractAddress"
npx hardhat run scripts/interact.js --network localhost
```

The interaction script uses account 2 as the farmer. It buys a crop policy for a 0.1 ETH premium with a 1 ETH payout, submits a test evidence hash from account 1, and prints the resulting policy and pool balance.

## What the contract enforces

- Only the owner can change the verifier; the new address cannot be zero.
- Buying a policy requires a positive premium, payout, and duration.
- Each active policy reserves its full payout. A purchase fails if total available pool funds cannot cover that reservation.
- Only the configured verifier can approve a claim, and the evidence hash cannot be zero.
- A policy can be paid only once and only through its coverage end time.
- Anyone can expire an unpaid policy after its end time, releasing its reserved payout back to the available pool.
- `poolBalance()` returns total ETH held; `availablePoolBalance()` excludes funds committed to active policies.

All amounts are denominated in wei. This prototype has no premium pricing model, withdrawal function, refund flow, production oracle, or dispute/appeal mechanism. Do not use it to insure real assets or deploy with real funds without a full security and product review.
