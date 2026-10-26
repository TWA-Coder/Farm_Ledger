const { ethers } = require("hardhat");

async function main() {
  const [owner, verifier] = await ethers.getSigners();
  const Factory = await ethers.getContractFactory("FarmLedgerInsurance");
  const insurance = await Factory.deploy(verifier.address);
  await insurance.waitForDeployment();

  const funding = await insurance.fundPool({
    value: ethers.parseEther("10")
  });
  await funding.wait();

  console.log(`FarmLedgerInsurance deployed: ${await insurance.getAddress()}`);
  console.log(`Owner: ${owner.address}`);
  console.log(`Verifier: ${verifier.address}`);
  console.log(`Initial pool balance: ${ethers.formatEther(await insurance.poolBalance())} ETH`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
