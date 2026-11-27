# FarmLedger benchmark

Generated 2026-11-24T09:58:09.132Z on in-process Hardhat network, 20 iterations.

Cost assumptions (change via env): gas price 0.02 gwei, ETH = USD 3000, USD 1 = RWF 1450.

| Operation | Avg gas | Est. cost (USD) | NFR-02 (<= 0.05) |
|---|---:|---:|:--:|
| Register farmer | 116,398 | 0.0070 | pass |
| Register plot | 166,657 | 0.0100 | pass |
| Register animal | 232,088 | 0.0139 | pass |
| Buy crop policy | 366,637 | 0.0220 | pass |
| Oracle reading + automatic payout | 138,044 | 0.0083 | pass |
| Buy livestock policy | 308,956 | 0.0185 | pass |
| File livestock claim | 120,332 | 0.0072 | pass |
| Vet-attested settlement + payout | 132,718 | 0.0080 | pass |

## Settlement latency (contract execution, trigger -> funds in farmer wallet)

| Path | Avg | Max | NFR-01 (<= 15 s) |
|---|---:|---:|:--:|
| Parametric (oracle tx -> payout) | 1 ms | 1 ms | pass |
| Livestock (vet signature tx -> payout) | 1 ms | 3 ms | pass |

On a local chain this is execution time only. For the report, re-run with --network arbitrumSepolia / polygonAmoy to include block time, and add the oracle data-fetch time separately.

## Against the manual baseline (proposal 1.2)

| Metric | Manual (NAIS) | FarmLedger |
|---|---|---|
| Claim settlement | 90-180 days | seconds-minutes (one transaction after the trigger / vet signature) |
| Settlement cost for a USD 14 premium | 30-45% of premium (loss adjustment) | ~0.06% of premium (gas only, assumed prices) |
| Fraud controls | paper checks | unique ear-tag registry, vet signature, waiting period, one policy per animal |

The manual (NAIS) figures are the estimates from the proposal and still need a cited source before they are used as evidence.
