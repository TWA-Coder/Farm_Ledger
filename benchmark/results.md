# FarmLedger benchmark

Generated 2026-10-25T12:16:26.957Z on in-process Hardhat network, 20 iterations.

Cost assumptions (change via env): gas price 0.02 gwei, ETH = USD 3000, USD 1 = RWF 1450.

| Operation | Avg gas | Est. cost (USD) | NFR-02 (<= 0.05) |
|---|---:|---:|:--:|
| Register farmer | 115,958 | 0.0070 | pass |
| Register plot | 166,946 | 0.0100 | pass |
| Register animal | 232,533 | 0.0140 | pass |
| Buy crop policy | 326,632 | 0.0196 | pass |
| Oracle reading + automatic payout | 135,349 | 0.0081 | pass |
| Buy livestock policy | 287,990 | 0.0173 | pass |
| File livestock claim | 115,520 | 0.0069 | pass |
| Vet-attested settlement + payout | 102,516 | 0.0062 | pass |

## Settlement latency (contract execution, trigger -> funds in farmer wallet)

| Path | Avg | Max | NFR-01 (<= 15 s) |
|---|---:|---:|:--:|
| Parametric (oracle tx -> payout) | 2 ms | 2 ms | pass |
| Livestock (vet signature tx -> payout) | 2 ms | 2 ms | pass |

On a local chain this is execution time only. For the report, re-run with --network arbitrumSepolia / polygonAmoy to include block time, and add the oracle data-fetch time separately.

## Against the manual baseline (proposal 1.2)

| Metric | Manual (NAIS) | FarmLedger |
|---|---|---|
| Claim settlement | 90-180 days | seconds-minutes (one transaction after the trigger / vet signature) |
| Settlement cost for a USD 14 premium | 30-45% of premium (loss adjustment) | ~0.06% of premium (gas only, assumed prices) |
| Fraud controls | paper checks | unique ear-tag registry, vet signature, waiting period, one policy per animal |
