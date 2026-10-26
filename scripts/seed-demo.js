// Seeds the local chain with demo data so the web app has something to show.
// Run after deploy:local.   npm run seed
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const b32 = (s) => ethers.encodeBytes32String(s);
const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

async function main() {
  const info = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "localhost.json")));
  const signers = await ethers.getSigners();
  const [, underwriter, , , aline, jean] = signers;
  const ledger = await ethers.getContractAt("FarmLedger", info.ledger);
  const token = await ethers.getContractAt("MockRWF", info.token);
  const ledgerAddr = info.ledger;

  // funds
  await (await token.mint(underwriter.address, 20_000_000)).wait();
  await (await token.mint(aline.address, 2_000_000)).wait();
  await (await token.mint(jean.address, 2_000_000)).wait();
  await (await token.connect(underwriter).approve(ledgerAddr, ethers.MaxUint256)).wait();
  await (await token.connect(aline).approve(ledgerAddr, ethers.MaxUint256)).wait();
  await (await token.connect(jean).approve(ledgerAddr, ethers.MaxUint256)).wait();
  await (await ledger.connect(underwriter).depositLiquidity(10_000_000)).wait();

  // products (rainfall = 0.1 mm over trailing 30 days, NDVI x 10000)
  await (await ledger.connect(underwriter).createProduct(0, 1500, 1000, 120)).wait(); // 1 Drought  < 150 mm
  await (await ledger.connect(underwriter).createProduct(1, 3500, 800, 120)).wait();  // 2 Flood    > 350 mm
  await (await ledger.connect(underwriter).createProduct(2, 3000, 800, 120)).wait();  // 3 Low NDVI < 0.30
  await (await ledger.connect(underwriter).createProduct(3, 0, 500, 365)).wait();     // 4 Livestock mortality

  // Aline - maize in Bugesera (Eastern Province), one dairy cow
  await (await ledger.connect(aline).registerFarmer(h("1199080012345678"), h("250788000001"))).wait();
  await (await ledger.connect(aline).registerPlot(-2_150_000, 30_150_000, 5000, b32("MAIZE"), h("geojson-aline-plot-1"))).wait();
  await (await ledger.connect(aline).registerAnimal(b32("RW-TAG-0001"), b32("FRIESIAN"), 2021, h("photo-cow-1"))).wait();

  // Jean - beans in Nyagatare, one dairy cow
  await (await ledger.connect(jean).registerFarmer(h("1198570087654321"), h("250788000002"))).wait();
  await (await ledger.connect(jean).registerPlot(-1_300_000, 30_300_000, 8000, b32("BEANS"), h("geojson-jean-plot-1"))).wait();
  await (await ledger.connect(jean).registerAnimal(b32("RW-TAG-0002"), b32("CROSSBREED"), 2020, h("photo-cow-2"))).wait();

  // For the demo the livestock waiting period is shortened to 0 (production default: 7 days).
  await (await ledger.setWaitingPeriod(0)).wait();

  console.log("Seeded: 4 products, 2 farmers (Aline, Jean), 2 plots, 2 cows, 10,000,000 mRWF liquidity.");
}

main().catch((e) => { console.error(e); process.exit(1); });
