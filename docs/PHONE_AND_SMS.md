# Phones: USSD, SMS and phone accounts

Everything a farmer with a basic phone uses, and how to connect real phone networks.

## Starting the phone services

`npm run phone` starts the USSD/SMS service and the notifier together, with each line prefixed `[ussd]` / `[notify]`.
`npm run phone -- --tunnel` also opens the public tunnel. Ctrl+C stops everything; if one service stops, the others
are stopped too. (`npm run ussd` and `npm run notify` still start them one at a time.)

## USSD (monitoring, claim registration and phone accounts)

`npm run ussd` starts the USSD service (Africa's Talking callback format) on port 4000; `start-demo.bat` starts it for you.
Open <http://localhost:3000/ussd> for a handset simulator, or point an Africa's Talking USSD callback at `https://<host>/ussd`.

**Policies are applied for, paid for and issued on the web portal only (for now).** USSD cannot book or activate anything yet.

* Menu: **1** My policies (list, then details), **2** Report a claim (cattle death, or a crop loss for the insurer's reviewers, on an active policy, PIN required), **3** Claim status (awaiting vets / approved and paid / rejected), **4** Reset PIN and, while a number change is waiting, **5** Cancel number change (both only with phone accounts, below).
* Who: farmers registered on the web, and farmers who registered from their phone (phone accounts). With phone accounts off, an unknown number is told to register on the website.
* Demo numbers: `250788000001` Aline and `250788000002` Jean (registered by the seed script). First call asks for a 4-digit PIN; 3 wrong PINs lock the number for 30 minutes.
* **Why the gateway cannot book a policy (enforced, not just hidden):** the service holds one key with `CLAIMS_AGENT_ROLE`, which on-chain can call only `fileClaimFor` (on FarmLedger for cattle, on CropClaims for crop losses). It has no wallets, no gas sponsorship, no Mobile Money collection and no minting. Its write object is built from a one-function interface, and `test/ussd.test.js` scans the source for every state-changing method and fuzzes the menus to prove no policy, asset, claim-other-than-requested or token balance can change.
* Vets sign claims on the web portal, not on USSD.
* **Languages: English and Kinyarwanda.** The first screen of a call (welcome, PIN setup or main menu) ends with **0. Ikinyarwanda** (or **0. English**). The choice is kept per phone number (table `ussd_lang`) and also sets the language of the SMS that farmer receives: codes, policy, claim, payout, contract and Mobile Money messages. Messages to agents stay in English. Numbers that never chose use `USSD_DEFAULT_LANG` (`en`, or `rw`). Texts: `services/ussd-text.js` (screens, 182 characters max) and `services/sms-text.js` (SMS, 160 max); `test/ussd-text.test.js` and `test/sms-text.test.js` check both languages have every text and that they fit.
* Tests: `npm test` includes `test/ussd.test.js` and `test/phone-accounts.test.js`.

## Phone accounts (farmers with a basic phone)

A farmer with no smartphone can create a FarmLedger account from USSD. The account is the same kind of ERC-4337 smart account the portal uses, with fees paid by the paymaster, but **the server holds its key** (`services/phone-accounts.js`, the only file that touches farmer keys).

* **Register:** an unregistered number sees *1. Register / 2. I changed my number*. Register asks for the 16-digit National ID (refused if already registered), sends a 6-digit code by SMS, and on the next dial asks for the code, creates the account, registers the farmer on-chain from it (`registerFarmer(keccak(ID), keccak(phone))`) and asks for a PIN. The code proves the number receives SMS, which payout notices rely on. The network already identifies the caller.
* **Codes:** 6 digits, valid 10 minutes, 5 tries, at most one per minute and five a day per number (enter `0` on the code screen for a new one). Stored as an HMAC, never in plain text.
* **Key custody:** a new random owner key per phone, encrypted with AES-256-GCM using a key derived from `PHONE_KEY_SECRET`, and bound to the account address. It is decrypted only in memory to sign. On the local chain the secret is generated into `web/.data/phone-key.secret` (git-ignored, owner-only); anywhere else the service refuses to start without `PHONE_KEY_SECRET` (`openssl rand -hex 32`). **This is custodial:** whoever holds the secret and the database can sign for these farmers. Keep the secret apart from database backups.
* **Reset PIN (menu 4):** needs the National ID on the account. 3 wrong IDs lock the number for 30 minutes. The farmer gets an SMS that the PIN changed. Works for web-registered farmers too.
* **New SIM / new number (recovery):** from the new number choose *2. I changed my number*, give the old number and the National ID, and confirm the code sent to the new number. The old number is told by SMS and can cancel (menu 5) during the waiting period (`RECOVERY_DELAY_HOURS`, default 48). On the next dial after that, the **same account** (same address, policies and payouts) moves to the new number: `updatePhone()` records the new hash on-chain and the farmer chooses a new PIN. The same answer is given for an unknown number and a wrong ID, and 3 wrong tries lock the number. Farmers registered on the website keep their own key and change their number there.
* **Operator:** `npm run accounts` lists phone accounts and number changes; `-- cancel <id>` stops one (fraud report); `-- release <id>` ends the waiting period early after checking the farmer's ID in person.
* Buying cover and payouts by Mobile Money: see [Mobile Money](MOBILE_MONEY.md). **Not yet:** logging in to the portal with a phone account.

| Variable | Default | Purpose |
|---|---|---|
| `PHONE_KEY_SECRET` | generated locally | 64 hex chars. Encrypts phone-account keys and code hashes. Required off the local chain |
| `RECOVERY_DELAY_HOURS` | `48` | How long a number change waits for the old number to cancel |
| `USSD_SHORTCODE` | "the FarmLedger USSD code" | The code farmers dial, used in SMS texts (e.g. `*384*12345#`) |
| `PHONE_ACCOUNTS` | on when the smart-account contracts are deployed | `off` = monitoring and claims only |

## Phone number change

`updatePhone(newPhoneHash)` lets a registered farmer record a new number (SIM swap, lost phone). The account and its plots, animals and policies are unchanged. The service that calls it must verify the new number with a one-time SMS code first (phone accounts phase).

## SMS notifications

`npm run notify` texts farmers about every step: welcome, cover bought (with the subsidy split), claim received,
claim rejected, loss claim received / rejected / superseded, payout (with the reason) and cover ended.

* **In chain order, exactly once.** The notifier reads the event index (`web/server/indexer.js`) and keeps a cursor.
  Each event's messages go into the SMS outbox (`sms_outbox` table) together with the cursor move, in one database
  transaction, keyed by transaction and log position. A restart can neither lose nor repeat a message, and a payout
  can no longer arrive before the purchase.
* **Outbox** (`services/sms.js`): temporary failures (network, gateway errors, insufficient balance) retry after
  30 s, 2 min, 10 min, 1 h and 6 h. Later messages to the same phone wait behind a failed one, so order is kept.
  Permanent failures (invalid number, blacklisted) are recorded with the reason. One-time codes are sent at once,
  never retried, and stored with the code masked.
* **Delivery reports** from Africa's Talking (`POST /sms/delivery`) mark messages `delivered` or `undeliverable`.
* First start skips the existing history (`NOTIFY_HISTORY=all` to text it). After a chain reset it starts from the
  new chain's first event.

## Africa's Talking (real SMS and USSD)

Everything is built for the Africa's Talking API. What differs between test and live is configuration in `.env`.

**Costs in Rwanda (checked November 2026, confirm with Africa's Talking before paying):**
* **SMS:** about RWF 6 to 12 per message, depending on volume and network. Sender IDs are free in Rwanda. A few dollars of credit covers testing.
* **USSD on a real Rwandan phone needs a service code:** an application through the regulator RURA (RWF 25,000) and an Africa's Talking setup fee (about RWF 173,000 per mobile network) plus a monthly fee per network (about RWF 43,300). Sessions cost about RWF 13 each. Timelines: ask info@africastalking.com.
* **Sandbox:** free. The USSD and SMS simulator at <https://simulator.africastalking.com> uses the same callbacks.

**Steps (sandbox: free, no phone needed):**
1. Create an account at <https://account.africastalking.com>, open the **Sandbox** app, and generate an API key (Settings > API Key).
2. In `.env`: `AT_USERNAME=sandbox`, `AT_API_KEY=<key>`. `CALLBACK_TOKEN` is already there.
3. Start the demo, then `npm run tunnel` and copy the two URLs it prints.
4. Sandbox > USSD > Create channel (pick any free code), with the printed `/ussd?key=...` URL as the callback. Sandbox > SMS > SMS Callback URLs > Delivery Reports: the printed `/sms/delivery?key=...` URL.
5. Open the simulator, enter a phone number (for example a new `+2507...` number to try registration), dial your sandbox code. SMS (codes, notices) appear in the simulator's inbox.

**Steps (live SMS to your own phone):**
1. In your Africa's Talking account, create a live app and top up (SMS > airtime/credit). Generate the live API key.
2. In `.env`: `AT_USERNAME=<your app username>`, `AT_API_KEY=<live key>` and `SMS_ALLOWLIST=2507XXXXXXXX` (your number). **On the local chain live SMS only goes to allowlisted numbers**: the seeded demo numbers `2507880000xx` may belong to real people.
3. Set the delivery reports URL as above (live app > SMS > SMS Callback URLs).
4. Register your own number through the USSD simulator (or save it as a contact on the portal), then buy cover and trigger a payout. The texts arrive on your phone.

| Variable | Purpose |
|---|---|
| `AT_USERNAME`, `AT_API_KEY` | `sandbox` + sandbox key, or your live app username + live key. Without them SMS is only logged to `services/out/sms.log` |
| `AT_SENDER_ID` | Optional registered sender name (live) |
| `SMS_ALLOWLIST` | Comma-separated numbers, or `*` for any number. Required for live SMS on the local chain. With `*` the seeded demo numbers (`25078800xxxx`) are still never texted, since they may belong to real people |
| `CALLBACK_TOKEN` | Secret in the callback URLs (`openssl rand -hex 16`). Internet requests without it are refused |
| `USSD_SHORTCODE` | The code farmers dial, used in SMS texts |
| `NOTIFY_HISTORY`, `NOTIFIER_INTERVAL_MS` | `all` texts past events on first start; poll interval (3000 ms) |

## IntouchSMS (Rwandan SMS gateway)

Africa's Talking messages to MTN Rwanda can fail with `DeliveryFailure` when the account has no registered Rwandan
sender ID (seen in testing, November 2026). IntouchSMS (<https://www.intouchsms.co.rw>) is a Rwandan gateway with
direct MTN and Airtel routes. Set it up and FarmLedger sends every SMS (codes, notices) through it:

```
INTOUCH_USERNAME=...        # your IntouchSMS account
INTOUCH_PASSWORD=...
INTOUCH_SENDER=...          # the sender name approved on your account (up to 11 characters)
SMS_ALLOWLIST=2507XXXXXXXX  # still required on the local chain
```

Then restart the services (`npm run phone` starts the USSD service and the notifier together; Ctrl+C stops both);
the USSD service should print `SMS: intouch (...)`. When Intouch keys
are present they are used before Africa's Talking (`SMS_PROVIDER` picks explicitly: `intouch`, `africastalking`,
`smsgate` or `log`).

* **Sending:** `POST /api/sendsms/.json` with `recipients`, `message`, `sender`, authenticated with your username and password (sent as HTTP basic auth and as fields, as in their samples). Message id, status and cost are stored in the outbox.
* **Delivery status:** Intouch has no delivery webhook, so the notifier asks `POST /api/getsmsstatus/.json` about each sent message at most once a minute for up to 2 days: `D` delivered, `E` / `U` undeliverable, `P` / `Q` / `S` still on the way.
* **Retries:** server errors and network failures are retried; a refused request (HTTP 400, e.g. no balance or a wrong sender) is recorded with Intouch's reason and not retried.
* **If the first real message fails:** their documentation disagrees with itself. Try `INTOUCH_FORMAT=json` (JSON body instead of form fields) or `INTOUCH_RECIPIENT_FORMAT=local` (`0788…`) / `plus` (`+250788…`), and check `error` in the outbox:
  `psql "$DATABASE_URL" -c "select to_timestamp(created_at/1000), status, provider_status, error from sms_outbox order by id desc limit 3"`
* Tested against a local fake of their API (`test/intouch.test.js`). The first real send with your account is the real test.

## SMS menu channel (any basic phone, no USSD shortcode)

A real USSD code in Rwanda needs a RURA application and monthly fees (see *Africa's Talking*). Instead, an Android
phone with an ordinary SIM can act as an **SMS gateway**: farmers text it from any basic phone and get the **same
menus** as USSD by SMS, one answer per message. It runs the open-source app
[SMS Gateway for Android](https://github.com/capcom6/android-sms-gateway) (docs: <https://docs.sms-gate.app>).

* The app forwards each received SMS to `POST /sms/gateway` (event `sms:received`). `services/sms-channel.js` feeds
  it into the USSD menu engine and texts the screen back **from the gateway phone**, so the conversation stays on one
  number. Menus, PIN, one-time codes, registration, number change and claims all work the same.
* Text **FL** (or MENU / START) for the menu at any time. After an END screen, or 10 minutes of silence
  (`SMS_SESSION_MINUTES`), the next SMS starts again.
* **Security:** the webhook URL carries `?key=<CALLBACK_TOKEN>`. Each webhook must be signed: `X-Signature` = hex
  HMAC-SHA256(`SMSGATE_SIGNING_KEY`, raw body + `X-Timestamp`), with the timestamp within 5 minutes. Each webhook id is
  handled once (the app re-sends until it gets a 2xx). `*` and `#` are stripped, so one SMS is always one answer.
* **Costs:** only the gateway SIM's own SMS (an operator SMS bundle). No shortcode, regulator or monthly fee.
* **Limits:** each step is an SMS round trip (a few seconds, not an instant USSD screen). The gateway phone must
  stay on, charged and online. Its SIM sends every reply, so the allowlist still applies on the local chain. In
  cloud mode, messages (including one-time codes) pass through the app's relay at api.sms-gate.app. Local mode
  avoids that but needs the laptop and the phone on the same Wi-Fi. Fine for a pilot or demo. A production service
  in Rwanda would use an operator-approved shortcode.

**Set up (about 15 minutes):**
1. An Android phone (Android 5 or later) with an MTN or Airtel SIM and an SMS bundle. Install **SMS Gateway for Android** (Google Play or the GitHub releases page). Allow its SMS permissions, including *receive SMS*. Turn off battery optimisation for it and keep the phone charging.
2. In the app, turn on **Cloud server** and go online. Note the **username and password** it shows. Under Settings > Webhooks, copy the **signing key**.
3. In `.env`:
   ```
   SMSGATE_URL=https://api.sms-gate.app/3rdparty/v1     # local mode instead: http://<phone-ip>:8080
   SMSGATE_USER=...
   SMSGATE_PASSWORD=...
   SMSGATE_SIGNING_KEY=...
   SMS_ALLOWLIST=2507XXXXXXXX,2507YYYYYYYY              # the basic phones you will test with
   SMS_PROVIDER=smsgate                                  # optional: send notices and codes from the phone too
   ```
   Without `SMS_PROVIDER`, notices and codes still go through Africa's Talking when its keys are set. Menu replies always come from the gateway phone.
4. Restart `npm run ussd` (it should print `SMS menu channel ON ... (signature checked)`), then `npm run tunnel`. The tunnel registers the gateway webhooks to its new address automatically and prints the result.
5. From a basic phone, text **FL** to the gateway phone's number.

## Public URL for the phone network (USSD and SMS callbacks)

`npm run tunnel` (needs `brew install cloudflared`) opens a free Cloudflare quick tunnel to the USSD service on port
4000 and prints the two callback URLs to paste into Africa's Talking (see *Africa's Talking* in this file). The address
changes every time the tunnel starts. Requests through the tunnel are refused unless they carry `?key=<CALLBACK_TOKEN>`
(set in `.env`), because a USSD request's phone number is only as trustworthy as its sender. Stop the tunnel when
not in use.


---
Back to the [README](../README.md) · other topics: [Demo script](DEMO.md) · [Roles and the insurance workflow](ROLES_AND_WORKFLOW.md) · [Web portal](PORTAL.md) · [Mobile Money (MTN MoMo)](MOBILE_MONEY.md) · [Smart contracts](CONTRACTS.md) · [Scope and requirements](SCOPE_AND_REQUIREMENTS.md)
