# FarmLedger on Polygon Amoy

Polygon Amoy is Polygon's public test network (chain id 80002). Gas is paid in test POL from a faucet, so a full
deployment and demo cost nothing. The contracts, roles and services are the same as on the local chain; only the keys
and the RPC endpoint change.

## What you need

| Item | Where | Notes |
|---|---|---|
| A private RPC endpoint | Free [Alchemy](https://dashboard.alchemy.com) API key with Polygon Amoy enabled (`ALCHEMY_API_KEY`), or any full URL in `POLYGON_AMOY_RPC` + `RPC_URL` | The public RPC rate-limits heavily |
| Test POL, about 1.8 POL in total | [Polygon faucet](https://faucet.polygon.technology), Alchemy / QuickNode Amoy faucets | Faucets give small daily amounts: collect over a few days if needed |
| A Polygonscan API key (optional) | [polygonscan.com](https://polygonscan.com/myapikey) | Only to publish the verified source code |

## 1. Keys and settings

```bash
node deploy/new-keys.js >> .env            # one key per role, CALLBACK_TOKEN, PHONE_KEY_SECRET
```

Then copy the settings from `deploy/amoy.env.example` into `.env` and set `ALCHEMY_API_KEY`. Hardhat, the
services and the portal server all build the Amoy URL from it. Back `.env` up somewhere safe: `PHONE_KEY_SECRET` decrypts the farmers' phone-account
keys, and losing it locks those accounts.

## 2. Fund the deployer

Only the deployer (`PRIVATE_KEY`, the first address `new-keys.js` printed) needs test POL: **about 1.8 POL**. On
2026-11-17 (Amoy at ~36 gwei) the deployment plus a 0.1 POL paymaster deposit cost ~0.55 POL; with the 0.5 POL deposit
now in `deploy/amoy.env.example` (0.1 POL lets only a few farmer operations through) that is ~0.95 POL, and the seed script then sends ~0.48 POL on to every other key that sends
transactions (underwriter, government, treasury, demo people, bundler, oracle, USSD agent) and spends a little itself.
With 1 POL the seed runs out of gas during the top-ups; topping up the deployer and re-running `npm run seed:amoy`
is safe at that point (the top-ups fill each key up to its target, and nothing else has run yet). If it stops later,
while creating the farmers, run `SEED_RESUME=farmers npm run seed:amoy` instead: it skips the pool, products, subsidy,
reviewers and agents that are already on chain.

Faucets give small amounts and most require the receiving wallet to hold a little real ETH on Ethereum mainnet:

| Faucet | Amount | Requirement |
|---|---|---|
| [Chainlink](https://faucets.chain.link/polygon-amoy) | 0.5 POL | connect MetaMask |
| [Polygon](https://faucet.polygon.technology) | small | sign in |
| [Alchemy](https://www.alchemy.com/faucets/polygon-amoy) | 0.1 POL / day | 0.001 ETH and activity on mainnet |
| [QuickNode](https://faucet.quicknode.com/polygon/amoy) | varies, every 12 h | a small mainnet balance |

If a faucet only pays a wallet with mainnet history, claim into your own MetaMask wallet and send the POL on to the
deployer address. Check the balance on [amoy.polygonscan.com](https://amoy.polygonscan.com).

## 3. Deploy and seed

```bash
npm run compile
npm run deploy:amoy        # writes deployments/polygonAmoy.json and web/public/{deployment,abi}.json
npm run seed:amoy          # products, 2 farmers, 2 agents, subsidy, reviewers - run ONCE per deployment
```

The seed script creates wallets for the demo people (Aline, Jean, Eric, Claudine, the claims reviewer) and saves their
private keys to `services/out/polygonAmoy-demo-keys.json`. To act as one of them in the portal, import the key into
MetaMask; the portal adds the Amoy network to MetaMask by itself.

Optional, verify the source code on Polygonscan (repeat for each contract, with its constructor arguments):

```bash
npx hardhat verify --network polygonAmoy <FarmLedger address> <deployer address> <MockRWF address>
```

## 4. Run the services against Amoy

With `NETWORK=polygonAmoy` and `ALCHEMY_API_KEY` in `.env`, the usual commands use the Amoy deployment:

```bash
npm run bundler            # farmers' smart-account operations
npm run phone              # custody + USSD/SMS + notifier
npm run oracle             # weather/NDVI readings
npm run web                # portal
```

## 5. Hosting on a VM (Oracle Cloud Always Free)

The public demo runs on one small VM (tested: Oracle Cloud AMD micro, 1 GB RAM, Ubuntu 24.04). Caddy serves the portal
over HTTPS at `https://<ip-with-dashes>.sslip.io` (sslip.io turns the name into the IP, so no domain is needed), and
systemd keeps the services running. The templates are in `deploy/vm/`.

1. **Open ports 80 and 443 in Oracle's network:** OCI console > Networking > Virtual Cloud Networks > your VCN >
   subnet > Default Security List > Add Ingress Rules: source `0.0.0.0/0`, TCP, destination port `80`, and again for
   `443`. (`install.sh` opens them in the VM's own firewall.)
2. **Prepare the VM** (as the `ubuntu` user):
   ```bash
   sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile   # 1 GB RAM is not enough to build the portal
   # Node 22.5+ (e.g. NodeSource), Caddy (https://caddyserver.com/docs/install#debian-ubuntu-raspbian), cloudflared, iptables-persistent
   git clone <repo> Farm_Ledger && cd Farm_Ledger && npm ci && npm --prefix web ci && npx hardhat compile
   ```
3. **Copy `.env` and `.env.polygonAmoy`** from your computer (`scp`); `.env.polygonAmoy` must also hold `CUSTODY_TOKEN`
   (`openssl rand -hex 24`), which the portal and the phone services use to reach key custody.
4. **Deploy and seed from the VM** (sections 2 and 3), so `deployments/polygonAmoy.json` and the seeded sign-ins
   (`services/out/polygonAmoy-logins.txt`) are where the services run.
5. **Install the services:** `sudo deploy/vm/install.sh <public-ip>`. It prints the portal address and the USSD
   callback URL for Africa's Talking.

| Unit | Runs |
|---|---|
| `farmledger-bundler` | `services/bundler.js` (loopback only) |
| `farmledger-phone` | key custody, USSD/SMS service, notifier (`services/run-phone.js`) |
| `farmledger-web` | the portal, `next start` on 127.0.0.1:3000 (run `next build` again after changing `web/`) |
| `farmledger-tunnel` | Cloudflare quick tunnel to the USSD service, for Africa's Talking |

Logs: `journalctl -u farmledger-<name>`; requests: `/var/log/caddy/farmledger-access.log`.

What we ran into:

- **Africa's Talking refuses sslip.io callback URLs** ("A valid web URL is needed", without ever calling the server),
  even with no key in them. The USSD callback therefore goes through the Cloudflare tunnel:
  `https://<name>.trycloudflare.com/ussd?key=<CALLBACK_TOKEN>`. **That address changes whenever
  `farmledger-tunnel` restarts** (also after a reboot); get the new one with
  `journalctl -u farmledger-tunnel | grep trycloudflare | tail -1` and paste it into Africa's Talking again. A fixed
  address needs a domain on Cloudflare (a named tunnel).
- **The oracle is not a service on Amoy:** `oracle.js watch` posts a reading for every plot every 60 s and would drain
  the oracle key's POL within hours. Trigger readings when needed: `node services/oracle.js scenario drought 1`.
- **The portal's phone simulator (`/ussd`)** goes through the portal (`/api/ussd-sim`) and, off the local chain, only
  dials the demo numbers `25078800xxxx`, so a visitor cannot act as a real farmer's phone.
- **SMS:** a phone on your home Wi-Fi (e.g. a local-mode SMS gateway) is not reachable from the VM. Use Africa's Talking
  or SMS Gateway for Android in cloud mode (docs/PHONE_AND_SMS.md).

## Differences from the local chain

- **No one key holds every role.** `scripts/deploy.js` refuses to deploy until every role address is set.
- **MockRWF can only be minted by the treasury** (on the local chain anyone can, for the demo).
- **Transactions take a few seconds** (2 s blocks, sometimes more under load), not instantly.
- **The event index starts at the deployment block** (`deployBlock` in the deployment file) and waits for
  `INDEXER_CONFIRMATIONS` blocks, because public chains occasionally reorganise their last blocks.
- **The browser gets the public RPC** (`PUBLIC_RPC_URL`, default `https://polygon-amoy-bor-rpc.publicnode.com`); the private
  one with your API key stays on the server (`RPC_URL`).
- **Event scanning goes through a public node** (`INDEXER_RPC_URL`). Alchemy's free plan answers event queries for
  only 10 blocks at a time, so a public node finds the blocks with FarmLedger events and Alchemy supplies those
  blocks' events. If the public node refuses queries ("block range too large"), lower `INDEXER_CHUNK_BLOCKS`; without
  `INDEXER_RPC_URL` the indexer uses Alchemy alone (then set `INDEXER_CHUNK_BLOCKS=10`).
