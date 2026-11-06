const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("FarmLedgerInsurance", function () {
  let owner;
  let verifier;
  let farmer;
  let stranger;
  let insurance;

  const oneEther = ethers.parseEther("1");
  const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("verified drought evidence"));

  beforeEach(async function () {
    [owner, verifier, farmer, stranger] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("FarmLedgerInsurance");
    insurance = await Factory.deploy(verifier.address);
    await insurance.waitForDeployment();
  });

  async function buyCropPolicy(overrides = {}) {
    const options = {
      insuranceType: 0,
      payoutAmount: oneEther,
      durationSeconds: 3600,
      premium: oneEther / 10n,
      ...overrides
    };

    const tx = await insurance.connect(farmer).buyPolicy(
      options.insuranceType,
      options.payoutAmount,
      options.durationSeconds,
      { value: options.premium }
    );
    await tx.wait();
    return insurance.getPolicy(1);
  }

  it("requires a non-zero verifier at deployment", async function () {
    const Factory = await ethers.getContractFactory("FarmLedgerInsurance");
    await expect(Factory.deploy(ethers.ZeroAddress))
      .to.be.revertedWith("Invalid verifier");
  });

  it("accepts positive pool funding and rejects zero funding", async function () {
    await expect(insurance.connect(owner).fundPool({ value: oneEther }))
      .to.emit(insurance, "PoolFunded")
      .withArgs(owner.address, oneEther);

    await expect(insurance.fundPool({ value: 0 }))
      .to.be.revertedWith("Funding must be positive");
    expect(await insurance.poolBalance()).to.equal(oneEther);
  });

  it("creates a policy and reserves its payout", async function () {
    await insurance.fundPool({ value: oneEther });

    const createPolicyTx = insurance.connect(farmer).buyPolicy(
      0,
      oneEther,
      3600,
      { value: oneEther / 10n }
    );
    await expect(createPolicyTx)
      .to.emit(insurance, "PolicyCreated")
      .withArgs(1, farmer.address, 0, oneEther / 10n, oneEther);

    const policy = await insurance.getPolicy(1);
    expect(policy.farmer).to.equal(farmer.address);
    expect(policy.insuranceType).to.equal(0);
    expect(policy.premium).to.equal(oneEther / 10n);
    expect(policy.payoutAmount).to.equal(oneEther);
    expect(policy.active).to.equal(true);
    expect(policy.paid).to.equal(false);
    expect(await insurance.reservedPayouts()).to.equal(oneEther);
    expect(await insurance.availablePoolBalance()).to.equal(oneEther / 10n);
  });

  it("rejects invalid policies and policies that exceed available pool capital", async function () {
    await expect(
      insurance.connect(farmer).buyPolicy(0, oneEther, 3600, { value: 0 })
    ).to.be.revertedWith("Premium must be positive");

    await expect(
      insurance.connect(farmer).buyPolicy(0, 0, 3600, { value: 1 })
    ).to.be.revertedWith("Payout must be positive");

    await expect(
      insurance.connect(farmer).buyPolicy(0, oneEther, 0, { value: 1 })
    ).to.be.revertedWith("Invalid duration");

    await expect(
      insurance.connect(farmer).buyPolicy(0, oneEther, 3600, { value: 1 })
    ).to.be.revertedWith("Insufficient available pool funds");
  });

  it("allows only the owner to set a non-zero verifier", async function () {
    await expect(insurance.connect(stranger).setVerifier(stranger.address))
      .to.be.revertedWith("Not contract owner");

    await expect(insurance.setVerifier(ethers.ZeroAddress))
      .to.be.revertedWith("Invalid verifier");

    await expect(insurance.setVerifier(stranger.address))
      .to.emit(insurance, "VerifierUpdated")
      .withArgs(stranger.address);
    expect(await insurance.verifier()).to.equal(stranger.address);
  });

  it("pays a verified claim once and releases the reserved payout", async function () {
    await insurance.fundPool({ value: oneEther });
    await buyCropPolicy();

    await expect(insurance.connect(stranger).verifyAndPay(1, evidenceHash))
      .to.be.revertedWith("Not authorized verifier");

    await expect(insurance.connect(verifier).verifyAndPay(1, ethers.ZeroHash))
      .to.be.revertedWith("Evidence required");

    const farmerBalanceBefore = await ethers.provider.getBalance(farmer.address);
    await expect(insurance.connect(verifier).verifyAndPay(1, evidenceHash))
      .to.emit(insurance, "EvidenceVerified")
      .withArgs(1, evidenceHash)
      .and.to.emit(insurance, "PayoutMade")
      .withArgs(1, farmer.address, oneEther);

    const farmerBalanceAfter = await ethers.provider.getBalance(farmer.address);
    const policy = await insurance.getPolicy(1);
    expect(farmerBalanceAfter - farmerBalanceBefore).to.equal(oneEther);
    expect(policy.active).to.equal(false);
    expect(policy.paid).to.equal(true);
    expect(await insurance.reservedPayouts()).to.equal(0);
    expect(await insurance.poolBalance()).to.equal(oneEther / 10n);

    await expect(insurance.connect(verifier).verifyAndPay(1, evidenceHash))
      .to.be.revertedWith("Policy is inactive");
  });

  it("expires a policy after its coverage period and frees its reservation", async function () {
    await insurance.fundPool({ value: oneEther });
    const policy = await buyCropPolicy({ durationSeconds: 60 });

    await expect(insurance.connect(stranger).expirePolicy(1))
      .to.be.revertedWith("Policy has not expired");

    await time.increaseTo(policy.endTime + 1n);
    await expect(insurance.connect(stranger).expirePolicy(1))
      .to.emit(insurance, "PolicyExpired")
      .withArgs(1);

    const expiredPolicy = await insurance.getPolicy(1);
    expect(expiredPolicy.active).to.equal(false);
    expect(expiredPolicy.paid).to.equal(false);
    expect(await insurance.reservedPayouts()).to.equal(0);
    expect(await insurance.availablePoolBalance()).to.equal(oneEther + oneEther / 10n);

    await expect(insurance.connect(verifier).verifyAndPay(1, evidenceHash))
      .to.be.revertedWith("Policy is inactive");
  });

  it("rejects nonexistent policy IDs", async function () {
    await expect(insurance.getPolicy(42))
      .to.be.revertedWith("Policy does not exist");
    await expect(insurance.connect(verifier).verifyAndPay(42, evidenceHash))
      .to.be.revertedWith("Policy does not exist");
    await expect(insurance.expirePolicy(42))
      .to.be.revertedWith("Policy does not exist");
  });
});
