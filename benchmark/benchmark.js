// Objective 4: gas, cost and settlement-latency benchmark, compared with the manual-process baseline in the proposal.
//   npm run bench                         (in-process Hardhat network, nothing to start)
//   BENCH_NETWORK_NOTE="Arbitrum Sepolia" ... when you run it with --network to record real latency
// Assumptions are parameters, not facts: set them from live figures when you write up the results.
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const GAS_PRICE_GWEI = Number(process.env.L2_GAS_PRICE_GWEI || 0.02); // typical Arbitrum One order of magnitude
const ETH_USD = Number(process.env.ETH_USD || 3000);
const RWF_PER_USD = Number(process.env.RWF_PER_USD || 1450);
const N = Number(process.env.BENCH_N || 20);

const b32 = (s) => ethers.encodeBytes32String(s);
const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const usd = (gas) => (Number(gas) * GAS_PRICE_GWEI * 1e-9 * ETH_USD);
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;

async function timed(txPromise) {
  const t0 = process.hrtime.bigint();
  const tx = await txPromise;
  const rc = await tx.wait();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { gas: rc.gasUsed, ms };
}

async function main() {
  const [admin, uw, oracle, vet, ...farmers] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("MockRWF")).deploy();
  const ledger = await (await ethers.getContractFactory("FarmLedger")).deploy(admin.address, await token.getAddress());
  const addr = await ledger.getAddress();
  await ledger.grantRole(await ledger.UNDERWRITER_ROLE(), uw.address);
  await ledger.grantRole(await ledger.ORACLE_ROLE(), oracle.address);
  await ledger.certifyVet(vet.address, ethers.id("BENCH-LIC"), ethers.encodeBytes32String("BUGESERA"), Math.floor(Date.now() / 1000) + 31536000);
  await ledger.setWaitingPeriod(0);
  await token.mint(uw.address, 1_000_000_000);
  await token.connect(uw).approve(addr, ethers.MaxUint256);
  await ledger.connect(uw).depositLiquidity(500_000_000);
  await ledger.connect(uw).createProduct(0, 1500, 1000, 120);
  await ledger.connect(uw).createProduct(3, 0, 500, 365);

  const m = { register: [], plot: [], animal: [], buyCrop: [], buyLive: [], payoutCrop: [], fileClaim: [], payoutLive: [] };
  const lat = { crop: [], live: [] };
  const premiumRwf = 0.10 * 200_000; // 10% of a 200,000 RWF sum insured

  for (let i = 0; i < N; i++) {
    const f = farmers[i % farmers.length];
    await token.mint(f.address, 10_000_000);
    await token.connect(f).approve(addr, ethers.MaxUint256);
    if (i < farmers.length) m.register.push((await timed(ledger.connect(f).registerFarmer(h("id" + i), h("ph" + i)))).gas);
    const first = i < farmers.length;
    if (!first) { /* farmer already registered */ }
    const plot = await timed(ledger.connect(f).registerPlot(-2_150_000, 30_150_000, 5000, b32("MAIZE"), h("geo" + i)));
    m.plot.push(plot.gas);
    const an = await timed(ledger.connect(f).registerAnimal(b32("TAG" + i), b32("FRIESIAN"), 2021, h("photo" + i)));
    m.animal.push(an.gas);
    const plotId = Number(await ledger.plotCount());
    const animalId = Number(await ledger.animalCount());

    // crop path
    m.buyCrop.push((await timed(ledger.connect(f).buyPolicy(1, plotId, 200_000))).gas);
    const trig = await timed(ledger.connect(oracle).postReading(plotId, 0, 500, await time.latest()));
    m.payoutCrop.push(trig.gas); lat.crop.push(trig.ms);

    // livestock path
    m.buyLive.push((await timed(ledger.connect(f).buyPolicy(2, animalId, 200_000))).gas);
    const polId = Number(await ledger.policyCount());
    m.fileClaim.push((await timed(ledger.connect(f).fileClaim(polId, h("dead" + i)))).gas);
    const claimId = Number(await ledger.claimCount());
    const deadline = (await time.latest()) + 3600;
    const net = await ethers.provider.getNetwork();
    const sig = await vet.signTypedData(
      { name: "FarmLedger", version: "1", chainId: net.chainId, verifyingContract: addr },
      { Attestation: [
        { name: "claimId", type: "uint256" }, { name: "policyId", type: "uint256" },
        { name: "tagId", type: "bytes32" }, { name: "approved", type: "bool" }, { name: "deadline", type: "uint256" }] },
      { claimId, policyId: polId, tagId: b32("TAG" + i), approved: true, deadline });
    const set = await timed(ledger.connect(admin).settleLivestockClaim(claimId, true, deadline, sig));
    m.payoutLive.push(set.gas); lat.live.push(set.ms);
  }

  const rows = [
    ["Register farmer", m.register], ["Register plot", m.plot], ["Register animal", m.animal],
    ["Buy crop policy", m.buyCrop], ["Oracle reading + automatic payout", m.payoutCrop],
    ["Buy livestock policy", m.buyLive], ["File livestock claim", m.fileClaim],
    ["Vet-attested settlement + payout", m.payoutLive],
  ].filter(([, g]) => g.length);

  const lines = [];
  lines.push(`# FarmLedger benchmark`, ``,
    `Generated ${new Date().toISOString()} on ${process.env.BENCH_NETWORK_NOTE || "in-process Hardhat network"}, ${N} iterations.`,
    ``, `Cost assumptions (change via env): gas price ${GAS_PRICE_GWEI} gwei, ETH = USD ${ETH_USD}, USD 1 = RWF ${RWF_PER_USD}.`,
    ``, `| Operation | Avg gas | Est. cost (USD) | NFR-02 (<= 0.05) |`, `|---|---:|---:|:--:|`);
  for (const [name, g] of rows) {
    const a = avg(g.map(Number));
    lines.push(`| ${name} | ${Math.round(a).toLocaleString()} | ${usd(a).toFixed(4)} | ${usd(a) <= 0.05 ? "pass" : "FAIL"} |`);
  }
  const settleGas = avg(m.payoutCrop.map(Number));
  const overheadPct = (usd(settleGas) * RWF_PER_USD) / premiumRwf * 100;
  lines.push(``, `## Settlement latency (contract execution, trigger -> funds in farmer wallet)`, ``,
    `| Path | Avg | Max | NFR-01 (<= 15 s) |`, `|---|---:|---:|:--:|`,
    `| Parametric (oracle tx -> payout) | ${avg(lat.crop).toFixed(0)} ms | ${Math.max(...lat.crop).toFixed(0)} ms | ${Math.max(...lat.crop) <= 15000 ? "pass" : "FAIL"} |`,
    `| Livestock (vet signature tx -> payout) | ${avg(lat.live).toFixed(0)} ms | ${Math.max(...lat.live).toFixed(0)} ms | ${Math.max(...lat.live) <= 15000 ? "pass" : "FAIL"} |`,
    ``, `On a local chain this is execution time only. For the report, re-run with --network arbitrumSepolia / polygonAmoy to include block time, and add the oracle data-fetch time separately.`,
    ``, `## Against the manual baseline (proposal 1.2)`, ``,
    `| Metric | Manual (NAIS) | FarmLedger |`, `|---|---|---|`,
    `| Claim settlement | 90-180 days | seconds-minutes (one transaction after the trigger / vet signature) |`,
    `| Settlement cost for a USD ${(premiumRwf / RWF_PER_USD).toFixed(0)} premium | 30-45% of premium (loss adjustment) | ~${overheadPct.toFixed(2)}% of premium (gas only, assumed prices) |`,
    `| Fraud controls | paper checks | unique ear-tag registry, vet signature, waiting period, one policy per animal |`);

  const out = path.join(__dirname, "results.md");
  fs.writeFileSync(out, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nSaved ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
