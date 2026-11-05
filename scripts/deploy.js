// Deploys MockRWF + FarmLedger + CropClaims, grants roles and writes the addresses/ABI the services and web app read.
//   Local:   npx hardhat node                      (terminal 1)
//            npm run deploy:local                  (terminal 2)
//   Testnet: set PRIVATE_KEY (+ optional UNDERWRITER_ADDRESS / ORACLE_ADDRESS / VET_ADDRESS) in .env, then
//            npx hardhat run scripts/deploy.js --network arbitrumSepolia
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { ethers, network, artifacts } = hre;
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const local = ["localhost", "hardhat"].includes(network.name);

  const underwriter = process.env.UNDERWRITER_ADDRESS || (local ? signers[1].address : deployer.address);
  const oracle = process.env.ORACLE_ADDRESS || (local ? signers[2].address : deployer.address);
  // The USSD gateway key: may ONLY register claims on behalf of holders (CLAIMS_AGENT_ROLE).
  const claimsAgent = process.env.USSD_AGENT_ADDRESS || (local ? signers[9].address : deployer.address);
  const vet = process.env.VET_ADDRESS || (local ? signers[3].address : deployer.address);
  // The premium-subsidy programme (government, e.g. NAIS): funds the subsidy pool and sets the rate.
  const government = process.env.GOVERNMENT_ADDRESS || (local ? signers[12].address : deployer.address); // #10 is the bundler relayer

  console.log(`Deploying to ${network.name} as ${deployer.address}`);
  const token = await (await ethers.getContractFactory("MockRWF")).deploy();
  await token.waitForDeployment();
  const ledger = await (await ethers.getContractFactory("FarmLedger")).deploy(deployer.address, await token.getAddress());
  await ledger.waitForDeployment();

  await (await ledger.grantRole(await ledger.UNDERWRITER_ROLE(), underwriter)).wait();
  await (await ledger.grantRole(await ledger.ORACLE_ROLE(), oracle)).wait();
  await (await ledger.grantRole(await ledger.CLAIMS_AGENT_ROLE(), claimsAgent)).wait();
  await (await ledger.grantRole(await ledger.SUBSIDY_ROLE(), government)).wait();

  // Crop loss claims reviewed by the underwriter's reviewers. Only this contract may pay assessed losses.
  const cropClaims = await (await ethers.getContractFactory("CropClaims")).deploy(await ledger.getAddress());
  await cropClaims.waitForDeployment();
  await (await ledger.grantRole(await ledger.ASSESSOR_ROLE(), await cropClaims.getAddress())).wait();
  // vets are certified (licence hash, sector, expiry), not just granted a role
  const vetExpiry = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  const vets = local
    ? [signers[3].address, signers[7].address, signers[8].address]
    : [vet];
  for (const [i, v] of vets.entries()) {
    await (await ledger.certifyVet(v, ethers.id("RVC-LIC-00" + (i + 1)), ethers.encodeBytes32String("BUGESERA"), vetExpiry)).wait();
  }
  if (local) await (await ledger.setVetQuorum(2)).wait(); // demo: 2-of-3

  // ERC-4337 smart accounts for farmers (local chain): EntryPoint v0.7, SimpleAccountFactory and a paymaster that
  // sponsors fees for calls to FarmLedger and the token only. On a public network use the canonical EntryPoint
  // (0x0000000071727De22E5E9d8BAf0edAc6f37da032) and a hosted bundler instead; set ENTRYPOINT_ADDRESS to reuse one.
  let aa = null;
  if (local || process.env.DEPLOY_AA === "true") {
    const entryPoint = process.env.ENTRYPOINT_ADDRESS
      ? await ethers.getContractAt("EntryPoint", process.env.ENTRYPOINT_ADDRESS)
      : await (await ethers.getContractFactory("EntryPoint")).deploy();
    await entryPoint.waitForDeployment();
    const factory = await (await ethers.getContractFactory("SimpleAccountFactory")).deploy(await entryPoint.getAddress());
    await factory.waitForDeployment();
    const paymaster = await (await ethers.getContractFactory("FarmLedgerPaymaster")).deploy(
      await entryPoint.getAddress(), [await ledger.getAddress(), await token.getAddress(), await cropClaims.getAddress()], ethers.parseEther(process.env.PAYMASTER_MAX_COST_ETH || "0.05"));
    await paymaster.waitForDeployment();
    await (await paymaster.deposit({ value: ethers.parseEther(process.env.PAYMASTER_DEPOSIT_ETH || (local ? "100" : "0.05")) })).wait();
    aa = {
      entryPoint: await entryPoint.getAddress(),
      accountFactory: await factory.getAddress(),
      paymaster: await paymaster.getAddress(),
      bundlerUrl: process.env.BUNDLER_URL || "http://localhost:4337",
    };
  }

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const info = {
    network: network.name,
    chainId,
    rpcUrl: network.config.url || "http://127.0.0.1:8545",
    token: await token.getAddress(),
    ledger: await ledger.getAddress(),
    cropClaims: await cropClaims.getAddress(),
    roles: { admin: deployer.address, underwriter, oracle, vet, claimsAgent, government },
    aa,
    deployedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.join(__dirname, "..", "deployments"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), JSON.stringify(info, null, 2));

  const ledgerArt = await artifacts.readArtifact("FarmLedger");
  const tokenArt = await artifacts.readArtifact("MockRWF");
  const claimsArt = await artifacts.readArtifact("CropClaims");
  const webPublic = path.join(__dirname, "..", "web", "public");
  fs.mkdirSync(webPublic, { recursive: true });
  fs.writeFileSync(path.join(webPublic, "deployment.json"), JSON.stringify(info, null, 2));
  fs.writeFileSync(path.join(webPublic, "abi.json"), JSON.stringify({ ledger: ledgerArt.abi, token: tokenArt.abi, cropClaims: claimsArt.abi }));

  console.log("MockRWF   :", info.token);
  console.log("FarmLedger:", info.ledger);
  console.log("CropClaims:", info.cropClaims);
  console.log("Roles     :", info.roles);
  if (aa) console.log("Smart accounts:", aa);
  console.log(`Saved deployments/${network.name}.json and web/public/{deployment,abi}.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
