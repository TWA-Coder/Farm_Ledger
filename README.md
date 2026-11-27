# FarmLedger

Blockchain-based crop and cattle micro-insurance for smallholder farmers in Rwanda (capstone prototype).

* **Farmers use a basic phone.** They register, check their cover, pay by MTN Mobile Money, report a loss and get
  SMS updates through USSD (`*code#`) and SMS menus, in English or Kinyarwanda. They do not need a smartphone, a
  wallet or any knowledge of blockchain. A web sign-in with the same phone number and PIN exists, but it is optional.
* **Insurance agents do the paperwork.** An agent appointed by the underwriter for the farmer's district submits the
  application and documents on the web portal. The underwriter drafts the contract, and the farmer reviews and pays
  it on USSD within 14 days. The government subsidy (40% of the premium, as in NAIS) is applied automatically.
* **Claims are paid without a loss adjuster in the common case.**
  * *Crops:* index cover pays automatically when the rainfall or vegetation (NDVI) reading for the plot crosses the
    trigger. A farmer can still report a loss the index misses (hail, pests, a weather station far from the plot).
    Only those claims go to the underwriter's reviewers. This is a known limitation of index insurance (basis risk),
    not the normal path.
  * *Cattle:* a certified veterinarian signs the death report and the contract pays in the same transaction. **One vet
    signature is enough by default** (`vetQuorum = 1` in `contracts/FarmLedger.sol`), because vets are scarce in
    many rural sectors. Where more vets are available, the admin can require up to 5 (`setVetQuorum`). The local demo
    is set to 2 of 3 to show this feature.
* Money is test money (mRWF, 1 token = 1 RWF). Nothing here moves real funds.

## Contents

* [Demo](#demo)
* [Why a blockchain](#why-a-blockchain)
* [How it fits together](#how-it-fits-together)
* [Repository layout](#repository-layout)
* [Run it on your computer](#run-it-on-your-computer)
* [Tests and benchmark](#tests-and-benchmark)
* [What is real, simulated or not yet validated](#what-is-real-simulated-or-not-yet-validated)
* [Troubleshooting](#troubleshooting)
* [Documentation](#documentation)

## Demo

| | |
|---|---|
| Hosted demo (contracts on the Polygon Amoy test network) | https://155-248-230-250.sslip.io/ |
| Phone simulator on the hosted demo | https://155-248-230-250.sslip.io/ussd (only the demo numbers `25078800xxxx`) |
| Video walkthrough | https://www.awesomescreenshot.com/video/58175426?key=6f2bd69d5f89b78570f20686baab9eb0 |
| Guided tour of every role | [docs/DEMO.md](docs/DEMO.md) |

Demo sign-ins (local and hosted demo):

| Who | Signs in with |
|---|---|
| Admin, underwriter, vets (`vet1`-`vet3`), agents Eric and Claudine | username (`admin`, `underwriter`, `vet1`, `eric`, ...) + password `farmledger` |
| Farmers Aline and Jean | phone `0788000001` PIN `1357`, phone `0788000002` PIN `2468` (the same PIN works on USSD) |

## Why a blockchain

A claim involves several parties who do not fully trust each other: the farmer, the insurer, the government that pays
the subsidy, and the vets. The blockchain is the shared record that none of them can change alone:

* **Payout rules are public and enforced by code.** When the trigger is crossed, or the required vet signatures
  arrive, the contract pays. The insurer cannot delay or refuse a valid claim, and the farmer cannot be paid for an
  invalid one.
* **Funds are reserved up front.** The full sum insured is locked in escrow when a policy is issued, so a valid claim
  can always be paid.
* **Anyone can audit it.** Every policy, reading, attestation and payout is an event. The government can check how the
  subsidy was used without asking the insurer for reports.
* **Vet signatures are checked on-chain** (EIP-712). They are tied to one claim and a deadline, so they cannot be
  forged, replayed or reused.

Trade-offs: a shared database with audit logs, run by a trusted body, could provide much of the same record at lower
complexity. The blockchain is justified here because no single party has to be trusted to run it, and because payout
is automatic. Farmers never see this layer: the server signs for them (custodial phone accounts) and the network fees
are sponsored. Personal data (names, ID numbers, documents) is kept off-chain; only hashes go on-chain.

## How it fits together

```
 Farmer (basic phone)            Agent / underwriter / vet / admin (web)
   │ USSD, SMS menus                   │ browser
   ▼                                   ▼
 services/ussd.js, sms-channel.js    web/ (Next.js portal)
   │                                   │
   └──────► custody service (encrypted keys, signs after phone + PIN or password)
                 │ ERC-4337 operations, fees sponsored by the paymaster
                 ▼
   Smart contracts: FarmLedger · PolicyDesk · CropClaims · FarmLedgerPaymaster · MockRWF
                 ▲                              │ events
   oracle (rainfall + NDVI per plot)          notifier ──► SMS (Africa's Talking) + MoMo payouts
```

Diagram sources (architecture, use case, class, sequence) are in [docs/diagrams/](docs/diagrams) (Eraser format).

## Repository layout

| Path | What it is |
|---|---|
| `contracts/FarmLedger.sol` | Farmers, plots, cattle, products, policies, escrow, automatic crop payout, vet-attested cattle claims, subsidy, roles |
| `contracts/PolicyDesk.sol` | Agents per district, applications, contracts drafted by the underwriter, 14-day offers |
| `contracts/CropClaims.sol` | Crop losses the index missed, decided by M-of-N underwriter reviewers |
| `contracts/aa/` | ERC-4337 paymaster that sponsors farmers' fees |
| `contracts/MockRWF.sol` | Test token (mRWF) |
| `services/` | USSD and SMS menus, phone accounts, custody, oracle, notifier, bundler, MoMo |
| `web/` | Portal for all roles and the phone simulator |
| `scripts/` | Deploy, demo data, test database helper, SUS scoring, translation export |
| `test/` | Contract, service and server tests |
| `benchmark/` | Gas, cost and latency benchmark (`benchmark/results.md`) |
| `docs/` | Detailed documentation (see [Documentation](#documentation)) |

## Run it on your computer

### Requirements

| | macOS | Windows |
|---|---|---|
| **Node.js 22.5 or later** (22 LTS recommended) | [nodejs.org](https://nodejs.org) or `brew install node@22` | [nodejs.org](https://nodejs.org) installer |
| **Git** | `xcode-select --install` or `brew install git` | [git-scm.com](https://git-scm.com/download/win) |
| **A PostgreSQL database** | a free [Neon](https://neon.com) project (or any PostgreSQL 14+) | same |
| A modern browser | Chrome, Edge, Firefox, Brave or Safari | Chrome, Edge, Firefox or Brave |
| Docker Desktop (only to run the tests) | [docker.com](https://www.docker.com/products/docker-desktop/) | same |

Check with `node -v` (must print v22.5 or higher).

**Database:** create a `.env` file in the project folder with your database's connection string (Neon: *Connect* ->
pooled connection string). `.env` is git-ignored; never commit it or paste it anywhere.
```
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DBNAME?sslmode=require
```
The tables are created on first start. See [Web portal: off-chain data](docs/PORTAL.md#off-chain-data).

### Get the code

```
git clone https://github.com/TWA-Coder/Farm_Ledger.git
cd Farm_Ledger
```

### Start

The local run uses its own blockchain on your computer (Hardhat), not Amoy.

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

The portal opens on a sign-in page that lists the seeded demo people (see [Demo](#demo)). New farmers register on USSD
or on the same page (name, National ID, phone, district, then an SMS code and a PIN). The admin adds new staff
(*Staff logins*) and each underwriter adds its own agents (*Agents*).

<details>
<summary>Run the parts by hand (any system, one terminal each)</summary>

```
npm install && npm run web:install     # once
npm run node                           # 1. local blockchain (keep open)
npm run deploy:local && npm run seed   # 2. contracts + demo data (after every chain restart)
npm run bundler                        # 3. fee sponsor for farmers' accounts
npm run phone                          # 4. key custody + USSD/SMS service + notifier
npm run web                            # 5. portal on http://localhost:3000
npm run oracle                         # optional: post rainfall/NDVI readings (mock, or DATA_SOURCE=nasa)
```
</details>

On the local run, use the portal and simulator **on the same computer**: they talk to `localhost`. No wallet
extension is needed. After restarting the chain, reload the page (the portal tells you if the contracts are gone).

To deploy to the public test network yourself, see [docs/POLYGON_AMOY.md](docs/POLYGON_AMOY.md).

### Real SMS, USSD and Mobile Money (optional)

The demo needs no accounts: SMS is written to `services/out/sms.log` and Mobile Money is simulated. To use real
services, copy `.env.example` to `.env` (never commit `.env`), fill in the keys and restart `npm run phone`.
Step by step: [Phones, USSD and SMS](docs/PHONE_AND_SMS.md) and [Mobile Money](docs/MOBILE_MONEY.md).

## Tests and benchmark

```
npm test        # about 250 contract, service and server tests
npm run bench   # gas, estimated cost and settlement latency -> benchmark/results.md
```
The tests need **Docker Desktop running**. `npm test` starts a throwaway PostgreSQL container, gives every test file its
own schema in it and removes the container afterwards, so the tests never touch your `DATABASE_URL`. To use another
PostgreSQL instead (e.g. in CI), set `TEST_DATABASE_URL`.

Requirement-to-test traceability: [docs/SCOPE_AND_REQUIREMENTS.md](docs/SCOPE_AND_REQUIREMENTS.md#3-traceability).

## What is real, simulated or not yet validated

| Part | Status |
|---|---|
| Smart contracts, claims, subsidy, escrow | Real code, tested; on a local chain and the Polygon Amoy test network (not mainnet) |
| Money | Test token. MoMo is simulated by default; the MTN sandbox client is built (EUR only in the sandbox) |
| Weather data | Mock scenarios by default; real rainfall from NASA POWER (`DATA_SOURCE=nasa`) as a stand-in for CHIRPS. NDVI is mocked |
| SMS | Logged locally by default; real SMS through Africa's Talking when keys are set |
| USSD | Africa's Talking sandbox and the built-in simulator. A live Rwandan shortcode needs RURA and operator registration |
| Kinyarwanda texts | **Draft, not yet reviewed by native speakers.** Export them for review with `npm run translations` |
| Usability (NFR-05, SUS >= 80) | **Not yet measured.** Test protocol and scoring: [docs/research/SUS-usability-test.md](docs/research/SUS-usability-test.md) |
| Manual-process baseline (NAIS settlement time and cost) | Figures in `benchmark/results.md` come from the proposal and still need a cited source |

## Troubleshooting

| Problem | Fix |
|---|---|
| `node -v` is below 22.5 | Install Node 22 LTS |
| "Set DATABASE_URL in .env" or "Cannot open the FarmLedger database" | Add your PostgreSQL connection string to `.env` (see *Requirements*); check the password and that the database is reachable |
| `npm test`: "Docker is not running" | Start Docker Desktop and wait until it says it is running |
| "Port ... is already in use" | A previous run is still going: stop it (Ctrl+C or close its windows). Find it with `lsof -nP -iTCP:3000 -sTCP:LISTEN` (macOS) or `netstat -ano \| findstr :3000` (Windows) |
| Portal says the contracts are gone | The chain was restarted: run `npm run deploy:local && npm run seed`, then reload |
| No code SMS arrives | Without SMS keys, codes are only in `services/out/sms.log`; with keys see [PHONE_AND_SMS.md](docs/PHONE_AND_SMS.md) |
| `./start-demo.sh: Permission denied` | `chmod +x start-demo.sh` |

## Documentation

| Topic | |
|---|---|
| [Demo script](docs/DEMO.md) | A guided tour of every role |
| [Roles and workflow](docs/ROLES_AND_WORKFLOW.md) | Who can do what; how a policy comes to exist; application documents |
| [Smart contracts](docs/CONTRACTS.md) | Vets and claims, subsidy, crop loss claims, units, security |
| [Phones, USSD and SMS](docs/PHONE_AND_SMS.md) | USSD menus, phone accounts, SMS providers, public tunnel |
| [Mobile Money](docs/MOBILE_MONEY.md) | MTN MoMo premiums, payouts, refunds; sandbox setup |
| [Web portal](docs/PORTAL.md) | Accounts, configuration, off-chain data, known limits |
| [Application model](docs/APPLICATION_MODEL.md) | The application record and its fingerprint |
| [Polygon Amoy](docs/POLYGON_AMOY.md) | Deploying to the public test network |
| [Scope and requirements](docs/SCOPE_AND_REQUIREMENTS.md) | What is built, what is simplified, requirement-to-test traceability |
| [Usability test (SUS)](docs/research/SUS-usability-test.md) | How to run and score the usability test with farmers, agents and vets |
| [`.env.example`](.env.example) | Every setting, with comments |
