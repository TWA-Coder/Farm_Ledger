const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const b32 = (s) => ethers.encodeBytes32String(s);
const hash = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

const Cover = { Drought: 0, Flood: 1, LowNDVI: 2, Livestock: 3 };
const Metric = { Rainfall: 0, NDVI: 1 };
const PolicyStatus = { Active: 0, ClaimPending: 1, PaidOut: 2, Expired: 3 };
const ClaimStatus = { None: 0, Pending: 1, Approved: 2, Rejected: 3 };

// Reading units: rainfall = trailing 30-day total in 0.1 mm, NDVI = index x 10000.
const DROUGHT_THRESHOLD = 1500; // < 150.0 mm
const FLOOD_THRESHOLD = 3500;   // > 350.0 mm
const NDVI_THRESHOLD = 3000;    // < 0.30

async function deployFixture() {
  const [admin, underwriter, oracle, vet, farmer, farmer2, outsider, vet2, vet3] = await ethers.getSigners();

  const token = await (await ethers.getContractFactory("MockRWF")).deploy(true);
  const ledger = await (await ethers.getContractFactory("FarmLedger")).deploy(admin.address, await token.getAddress());

  // governance hands the specialised roles out: vet registrar, guardian, and (for the ledger's own unit tests) an
  // issuer account standing in for PolicyDesk, so purchase rules can be tested directly
  await ledger.grantRole(await ledger.VET_REGISTRAR_ROLE(), admin.address);
  await ledger.grantRole(await ledger.PAUSER_ROLE(), admin.address);
  ISSUER = (await ethers.getSigners())[15];
  await ledger.grantRole(await ledger.ISSUER_ROLE(), ISSUER.address);
  await ledger.grantRole(await ledger.UNDERWRITER_ROLE(), underwriter.address);
  await ledger.grantRole(await ledger.ORACLE_ROLE(), oracle.address);
  // certified vets: licence + sector + expiry (a bare role grant is NOT enough to sign claims)
  const validUntil = (await time.latest()) + 365 * 24 * 3600;
  for (const [i, v] of [vet, vet2, vet3].entries()) {
    await ledger.certifyVet(v.address, ethers.id("RVC-LIC-00" + (i + 1)), ethers.encodeBytes32String("BUGESERA"), validUntil);
  }

  await token.mint(underwriter.address, 10_000_000);
  await token.mint(farmer.address, 1_000_000);
  await token.mint(farmer2.address, 1_000_000);

  const ledgerAddr = await ledger.getAddress();
  await token.connect(underwriter).approve(ledgerAddr, ethers.MaxUint256);
  await token.connect(farmer).approve(ledgerAddr, ethers.MaxUint256);
  await token.connect(farmer2).approve(ledgerAddr, ethers.MaxUint256);

  await ledger.connect(underwriter).depositLiquidity(5_000_000);

  // products 1..4
  await ledger.connect(underwriter).createProduct(Cover.Drought, DROUGHT_THRESHOLD, 1000, 120);
  await ledger.connect(underwriter).createProduct(Cover.Flood, FLOOD_THRESHOLD, 800, 120);
  await ledger.connect(underwriter).createProduct(Cover.LowNDVI, NDVI_THRESHOLD, 800, 120);
  await ledger.connect(underwriter).createProduct(Cover.Livestock, 0, 500, 365);

  return { admin, underwriter, oracle, vet, vet2, vet3, farmer, farmer2, outsider, token, ledger, ledgerAddr };
}

// Issues a policy the way PolicyDesk does once the farmer accepted (same order of arguments as the old buyCover).
// coverDays defaults to the product length, like the old buyPolicy.
let ISSUER = null;
async function buyFor(ledger, holder, productId, assetId, sumInsured, level = 0, startAt = 0, coverDays = null, contractHash = ethers.ZeroHash) {
  const days = coverDays ?? Number((await ledger.getProduct(productId)).durationDays);
  return ledger.connect(ISSUER).issuePolicy(holder.address ?? holder, productId, assetId, sumInsured, level, startAt, days, contractHash);
}

async function farmerFixture() {
  const base = await deployFixture();
  const { ledger, farmer, farmer2 } = base;
  await ledger.connect(farmer).registerFarmer(hash("1199080012345678"), hash("250788000001"));
  await ledger.connect(farmer2).registerFarmer(hash("1198570087654321"), hash("250788000002"));
  // plot 1 (Bugesera, maize), animal 1 (Nyagatare, dairy cow)
  await ledger.connect(farmer).registerPlot(-2_150_000, 30_150_000, 5000, b32("MAIZE"), hash("geojson-plot-1"));
  await ledger.connect(farmer).registerAnimal(b32("RW-TAG-0001"), b32("FRIESIAN"), 2021, hash("photo-cow-1"));
  return base;
}

async function signAttestation(vetSigner, ledger, { claimId, policyId, tagId, approved, deadline }) {
  const net = await ethers.provider.getNetwork();
  const domain = {
    name: "FarmLedger",
    version: "1",
    chainId: net.chainId,
    verifyingContract: await ledger.getAddress(),
  };
  const types = {
    Attestation: [
      { name: "claimId", type: "uint256" },
      { name: "policyId", type: "uint256" },
      { name: "tagId", type: "bytes32" },
      { name: "approved", type: "bool" },
      { name: "deadline", type: "uint256" },
    ],
  };
  return vetSigner.signTypedData(domain, types, { claimId, policyId, tagId, approved, deadline });
}

module.exports = {
  ethers, loadFixture, time, b32, hash, Cover, Metric, PolicyStatus, ClaimStatus,
  DROUGHT_THRESHOLD, FLOOD_THRESHOLD, NDVI_THRESHOLD,
  deployFixture, farmerFixture, signAttestation, buyFor, issuer: () => ISSUER,
};
