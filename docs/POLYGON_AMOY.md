# FarmLedger on Polygon Amoy

Polygon Amoy is Polygon's public test network (chain id 80002). Gas is paid in test POL from a faucet, so a full
deployment and demo cost nothing. The contracts, roles and services are the same as on the local chain; only the keys
and the RPC endpoint change.

## What you need

| Item | Where | Notes |
|---|---|---|
| A private RPC endpoint | Free [Alchemy](https://dashboard.alchemy.com) API key with Polygon Amoy enabled (`ALCHEMY_API_KEY`), or any full URL in `POLYGON_AMOY_RPC` + `RPC_URL` | The public RPC rate-limits heavily |
| Test POL, about 1.5 POL in total | [Polygon faucet](https://faucet.polygon.technology), Alchemy / QuickNode Amoy faucets | Faucets give small daily amounts: collect over a few days if needed |
| A Polygonscan API key (optional) | [polygonscan.com](https://polygonscan.com/myapikey) | Only to publish the verified source code |

## 1. Keys and settings

```bash
node deploy/new-keys.js >> .env            # one key per role, CALLBACK_TOKEN, PHONE_KEY_SECRET
```

Then copy the settings from `deploy/amoy.env.example` into `.env` and set `ALCHEMY_API_KEY`. Hardhat, the
services and the portal server all build the Amoy URL from it. Back `.env` up somewhere safe: `PHONE_KEY_SECRET` decrypts the farmers' phone-account
keys, and losing it locks those accounts.

## 2. Fund the deployer

Only the deployer (`PRIVATE_KEY`, the first address `new-keys.js` printed) needs test POL: **1 POL**. Measured at
Amoy's 30 gwei, the deployment costs ~0.23 POL in gas plus 0.1 POL for the paymaster deposit, and the seed script
then sends ~0.52 POL on to every other key that sends transactions (underwriter, government, treasury, demo people,
bundler, oracle, USSD agent). About 0.25 POL is left over.

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
