# Web portal

Accounts, configuration, off-chain data and known limits of the web portal (`web/`).

## Accounts: smart accounts for farmers, browser wallets for professionals

* **Farmers** get an ERC-4337 smart account (eth-infinitism v0.7 `EntryPoint` + `SimpleAccountFactory`). The owner key is created on the device and kept in browser storage: no app to install, no seed phrase, no ETH. Every action is a UserOperation sent to the bundler (`services/bundler.js`); fees are paid by `contracts/aa/FarmLedgerPaymaster.sol`, which only sponsors calls to FarmLedger and the token, with no ETH value and a cost cap per operation. Document and contact requests are signed by the owner key; the server accepts them when that key is `owner()` of the account.
* **Vets, underwriters and administrators** can use a browser wallet (MetaMask or any EIP-1193 wallet): **Connect wallet** switches the wallet to this network and picks the role from the chain (admin role, underwriter role, or vet certification).
* Limits: the device key is lost if the browser storage is cleared (no recovery or guardians yet); production should use passkeys or a hosted embedded wallet. The local bundler simulates and submits operations one at a time but does not run the full ERC-7562 validation rules; on a public network use the canonical EntryPoint `0x0000000071727De22E5E9d8BAf0edAc6f37da032` and a hosted bundler (set `BUNDLER_URL`).

## Portal configuration (all optional)

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

## Off-chain data

One SQLite file (`web/.data/farmledger.db`, git-ignored, owner-only permissions) holds what the chain does not:
plain phone numbers for SMS (`contacts`; the chain stores only their hash), USSD PIN state (`ussd_users`), where
each oracle reading came from (`readings`), and an index of every contract event (`events`). It uses SQLite built
into Node 22.5+, so there is nothing to install. The portal reads activity from `/api/events`, which brings the
index up to date on each request (`web/server/indexer.js`) instead of scanning the chain from block 0. When the local
chain is restarted, the index notices and rebuilds itself.
Older JSON files (`web/.data/contacts.json`, `services/out/ussd-users.json`, `services/out/readings.json`) are
imported once on first start and renamed to `*.imported`.

## Known limits of the test version

* The shared test accounts use public development keys that are in the client bundle (local chain only). Real users use a smart account (farmers) or a browser wallet (professionals), see above.
* Test money (`MockRWF`, open faucet). Mobile Money is simulated unless MTN MoMo credentials are set (see [Mobile Money](MOBILE_MONEY.md)); SMS is logged unless an SMS provider is set.
* NDVI is always sample data. CHIRPS is not integrated (NASA POWER rainfall is the real-data option). One oracle key is trusted.
* NAIS contract terms not modelled yet (the 40% government premium share is, see [Premium subsidy](CONTRACTS.md)): excess, cause-of-death and vaccination rules, multi-animal schedules, yield assessment for crops. The policy document states which of these are not applied.


---
Back to the [README](../README.md) · other topics: [Demo script](DEMO.md) · [Roles and the insurance workflow](ROLES_AND_WORKFLOW.md) · [Phones: USSD, SMS and phone accounts](PHONE_AND_SMS.md) · [Mobile Money (MTN MoMo)](MOBILE_MONEY.md) · [Smart contracts](CONTRACTS.md) · [Scope and requirements](SCOPE_AND_REQUIREMENTS.md)
