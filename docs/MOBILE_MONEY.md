# Mobile Money (MTN MoMo)

Premium collection and payouts for farmers on basic phones.

## Mobile Money (MTN MoMo): buying cover and getting paid from a basic phone

Phone-account farmers can now do everything from USSD: **7. Add plot or cow**, then **6. Buy cover**, paid by
MTN Mobile Money, and payouts go back to their MoMo number. `services/payments.js` runs the money flows,
`services/momo.js` talks to the MTN MoMo Open API.

* **Buy cover (USSD 6):** cover, then plot or cow, then amount. The screen shows premium, subsidy and what the farmer pays. After **Pay** and the PIN, MoMo asks the farmer to approve on their phone (request to pay). When MoMo reports `SUCCESSFUL`, the treasury credits the farmer's smart account with that amount of the RWF test token, and the account approves and buys the cover in **one** sponsored operation. The farmer gets the usual "policy active" SMS. Uses the product's full length and standard trigger (the web offers more choices).
* **If the payment fails** (declined, timeout, no funds) nothing is bought or credited, and the farmer is told by SMS. **If the cover cannot be issued after payment** (the product was withdrawn, the pool shrank), the tokens go back to the treasury and the money is refunded by a MoMo transfer.
* **Payouts:** when a phone-account farmer is paid on-chain (index trigger, vet-approved or reviewer-approved claim), the tokens are swept from their account to the treasury and the same amount is sent to their MoMo number, then an SMS confirms it. The farmer holds either the tokens or the money, never both. Farmers using the website keep payouts in their own wallet.
* **Never twice:** each payment is a database row (`momo_payments`) written before the call it describes, with a unique external id (`premium-…`, `payout-<policy>-<tx>`, `refund-…`). MoMo calls reuse the row's reference, and a 409 "already exists" counts as sent. The notifier moves each payment one step per pass, so a crash resumes where it stopped.
* **Status by polling** (every 5 s), so no public callback is needed. `npm run momo` lists payments; `npm run momo -- retry <ref>` resends a failed payout or refund.

**Three modes:**

| Mode | When | What happens |
|---|---|---|
| Simulated | no MoMo credentials (default), or `MOMO_MODE=simulated` | No MTN account needed. Payments succeed after `MOMO_SIM_DELAY_MS` (5 s). The MTN sandbox test numbers fail as they would there (`46733123450` failed, `46733123451` rejected, `46733123452` timeout, `46733123453` / `…54` stay pending), and `MOMO_SIM_FAIL=<numbers>` makes chosen numbers decline |
| MTN sandbox | `MOMO_COLLECTION_*` and `MOMO_DISBURSEMENT_*` set | Real MTN API, test money in **EUR** (the sandbox accepts only EUR; the RWF amount is sent as the number) |
| Live (Rwanda) | `MOMO_TARGET_ENV=mtnrwanda`, `MOMO_BASE_URL` and live credentials from MTN | Real money in RWF. Needs a business account with MTN Rwanda (KYC and approval) |

**MTN sandbox setup (free):**
1. Sign up at <https://momodeveloper.mtn.com>, subscribe to the **Collections** and **Disbursements** products, and copy each one's **primary key**.
2. In `.env`: `MOMO_COLLECTION_KEY=<collections primary key>` and `MOMO_DISBURSEMENT_KEY=<disbursements primary key>`.
3. `npm run momo -- provision <any-host>` creates the sandbox API users and keys and prints four lines (`MOMO_*_USER`, `MOMO_*_API_KEY`). Add them to `.env`.
4. Restart `npm run phone`. It prints `Buy cover by USSD ON: premiums by MTN MoMo sandbox (EUR)`.

| Variable | Purpose |
|---|---|
| `MOMO_COLLECTION_KEY`, `MOMO_COLLECTION_USER`, `MOMO_COLLECTION_API_KEY` | Collections (premiums): subscription key, API user, API key |
| `MOMO_DISBURSEMENT_KEY`, `MOMO_DISBURSEMENT_USER`, `MOMO_DISBURSEMENT_API_KEY` | Disbursements (payouts, refunds) |
| `MOMO_BASE_URL`, `MOMO_TARGET_ENV`, `MOMO_CURRENCY` | Default sandbox / `sandbox` / `EUR`. Live: MTN's URL / `mtnrwanda` / `RWF` |
| `MOMO_MODE`, `MOMO_SIM_DELAY_MS`, `MOMO_SIM_FAIL` | `simulated` forces the simulator; its approval delay; numbers that decline |
| `TREASURY_PRIVATE_KEY` | Account that credits premiums and receives swept payouts (local default: Hardhat account #14) |

**Limits:** the on-chain money is the RWF **test token**, minted by the treasury against confirmed MoMo money. A
real deployment needs a regulated RWF stablecoin or e-money arrangement, and the treasury key in an HSM. The sandbox
API format was taken from MTN's published Open API. It is tested against a local fake of that API
(`test/payments.test.js`), not yet against MTN itself, so the first sandbox run with your keys is the real check.


---
Back to the [README](../README.md) · other topics: [Demo script](DEMO.md) · [Roles and the insurance workflow](ROLES_AND_WORKFLOW.md) · [Web portal](PORTAL.md) · [Phones: USSD, SMS and phone accounts](PHONE_AND_SMS.md) · [Smart contracts](CONTRACTS.md) · [Scope and requirements](SCOPE_AND_REQUIREMENTS.md)
