# FarmLedger

Blockchain-based crop and cattle micro-insurance for smallholder farmers in Rwanda (capstone prototype).
Farmers register on the web or from a basic phone (USSD + SMS). An insurance agent applies for cover for them,
the underwriter drafts the contract, and the farmer pays it with Mobile Money. Crop cover pays automatically from
weather and satellite readings; cattle claims are confirmed by certified veterinarians.

Everything runs on your computer: a local blockchain, the web portal and the phone services. Money is test money.

## Requirements

| | macOS | Windows |
|---|---|---|
| **Node.js 22.5 or later** (22 LTS recommended) | [nodejs.org](https://nodejs.org) or `brew install node@22` | [nodejs.org](https://nodejs.org) installer |
| **Git** | `xcode-select --install` or `brew install git` | [git-scm.com](https://git-scm.com/download/win) |
| A modern browser | Chrome, Edge, Firefox, Brave or Safari | Chrome, Edge, Firefox or Brave |

Check with `node -v` (must print v22.5 or higher). Nothing else is needed for the demo.

## Get the code

```
git clone https://github.com/TWA-Coder/Farm_Ledger.git
cd Farm_Ledger
```

## Run it

**macOS / Linux**: in Terminal, from the project folder:
```
./start-demo.sh
```
It installs what is missing, starts everything and opens the portal. Logs go to `services/out/`. Press **Ctrl+C** to stop.

**Windows**: double-click **`start-demo.bat`** (or run it in Command Prompt). Each service opens in its own window;
the portal opens after about 20 seconds. Close the windows to stop.

Then open:

| Page | Address |
|---|---|
| Landing page | http://localhost:3000 |
| Portal (all roles) | http://localhost:3000/app |
| Phone simulator (USSD) | http://localhost:3000/ussd |

In the portal, choose a demo account at the top: **Aline / Jean** (farmers), **Eric / Claudine** (insurance agents),
**Underwriter**, the **vets**, **Admin**. A guided tour is in [docs/DEMO.md](docs/DEMO.md).

<details>
<summary>Run the parts by hand (any system, one terminal each)</summary>

```
npm install && npm run web:install     # once
npm run node                           # 1. local blockchain (keep open)
npm run deploy:local && npm run seed   # 2. contracts + demo data (after every chain restart)
npm run bundler                        # 3. fee sponsor for farmers' accounts
npm run phone                          # 4. key custody + USSD/SMS service + notifier
npm run web                            # 5. portal on http://localhost:3000
```
</details>

## Browsers

* The portal and the phone simulator work in any current browser. Use them **on the computer that runs the demo**: they talk to `localhost`, so a phone or another computer cannot open them.
* **Farmer accounts** created in the browser keep their key in that browser. A different browser, profile or private window means a different (new) account, and clearing site data loses it. The demo accounts (Aline, Eric, ...) work everywhere.
* **Connect wallet** (vets, underwriters and admins with their own key) needs the MetaMask extension: Chrome, Edge, Brave or Firefox. Safari has no MetaMask extension; use the demo accounts there.
* After restarting the chain, reload the page (the portal says so if the contracts are gone).

## Tests

```
npm test
```
Contract, service and server tests (about 220). They also run on GitHub for every push.

## Real SMS, USSD and Mobile Money (optional)

The demo needs no accounts: SMS is written to `services/out/sms.log` and Mobile Money is simulated. To use real
services, copy `.env.example` to `.env` (never commit `.env`), fill in the keys and restart `npm run phone`.
Step by step: [Phones, USSD and SMS](docs/PHONE_AND_SMS.md) and [Mobile Money](docs/MOBILE_MONEY.md).

## Troubleshooting

| Problem | Fix |
|---|---|
| `node -v` is below 22.5, or `node:sqlite` errors | Install Node 22 LTS |
| "Port ... is already in use" | A previous run is still going: stop it (Ctrl+C or close its windows). Find it with `lsof -nP -iTCP:3000 -sTCP:LISTEN` (macOS) or `netstat -ano \| findstr :3000` (Windows) |
| Portal says the contracts are gone | The chain was restarted: run `npm run deploy:local && npm run seed`, then reload |
| No code SMS arrives | Without SMS keys, codes are only in `services/out/sms.log`; with keys see [PHONE_AND_SMS.md](docs/PHONE_AND_SMS.md) |
| `./start-demo.sh: Permission denied` | `chmod +x start-demo.sh` |

## Documentation

| Topic | |
|---|---|
| [Demo script](docs/DEMO.md) | A guided tour of every role |
| [Roles and workflow](docs/ROLES_AND_WORKFLOW.md) | Who can do what; how a policy comes to exist; application documents |
| [Web portal](docs/PORTAL.md) | Accounts, configuration, off-chain data, known limits |
| [Phones, USSD and SMS](docs/PHONE_AND_SMS.md) | USSD menus, phone accounts, SMS providers (Africa's Talking, Intouch, Android gateway), public tunnel |
| [Mobile Money](docs/MOBILE_MONEY.md) | MTN MoMo premiums, payouts, refunds; sandbox setup |
| [Smart contracts](docs/CONTRACTS.md) | Vets and claims, subsidy, crop loss claims, units, security, public testnet |
| [Application model](docs/APPLICATION_MODEL.md) | The application record and its fingerprint |
| [Scope and requirements](docs/SCOPE_AND_REQUIREMENTS.md) | What is built, what is simplified, requirement-to-test traceability |
| [`.env.example`](.env.example) | Every setting, with comments |
