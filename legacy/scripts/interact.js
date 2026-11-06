const { ethers } = require("hardhat");

async function main() {
  const contractAddress = process.env.FARMLEDGER_ADDRESS;
  if (!contractAddress) {
    throw new Error("Set FARMLEDGER_ADDRESS to the address printed by scripts/deploy.js");
  }

  const [, verifier, farmer] = await ethers.getSigners();
  const insurance = await ethers.getContractAt(
    "FarmLedgerInsurance",
    contractAddress
  );
  const payoutAmount = ethers.parseEther("1");
  const premium = ethers.parseEther("0.1");
  const policyId = await insurance.nextPolicyId();
  const evidenceHash = ethers.keccak256(
    ethers.toUtf8Bytes("Local test evidence: verified drought")
  );

  const buyTx = await insurance.connect(farmer).buyPolicy(
    0,
    payoutAmount,
    3600,
    { value: premium }
  );
  await buyTx.wait();

  const claimTx = await insurance.connect(verifier).verifyAndPay(
    policyId,
    evidenceHash
  );
  await claimTx.wait();

  const policy = await insurance.getPolicy(policyId);
  console.log(`Policy ${policyId} purchased and paid.`);
  console.log(`Farmer: ${policy.farmer}`);
  console.log(`Premium: ${ethers.formatEther(policy.premium)} ETH`);
  console.log(`Payout: ${ethers.formatEther(policy.payoutAmount)} ETH`);
  console.log(`Paid: ${policy.paid}`);
  console.log(`Pool balance: ${ethers.formatEther(await insurance.poolBalance())} ETH`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
