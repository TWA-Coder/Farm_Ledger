// Phase 2 contract features: government premium subsidy, phone number change, and crop loss claims decided by the
// underwriter's reviewers (CropClaims.sol, M-of-N).
const { expect } = require("chai");
const { ethers, loadFixture, time, b32, hash, Cover, Metric, PolicyStatus, farmerFixture, buyFor } = require("./helpers");

const DAY = 24 * 3600;
const S = { None: 0, Pending: 1, Approved: 2, Rejected: 3, Superseded: 4 };

async function phase2Fixture() {
  const base = await farmerFixture();
  const { ledger, token, underwriter } = base;
  const signers = await ethers.getSigners();
  const [gov, reviewer1, reviewer2, agent] = [signers[10], signers[11], signers[12], signers[13]];

  const claims = await (await ethers.getContractFactory("CropClaims")).deploy(await ledger.getAddress());
  await ledger.grantRole(await ledger.ASSESSOR_ROLE(), await claims.getAddress());
  await ledger.grantRole(await ledger.SUBSIDY_ROLE(), gov.address);
  await ledger.grantRole(await ledger.CLAIMS_AGENT_ROLE(), agent.address);

  await token.mint(gov.address, 1_000_000);
  await token.connect(gov).approve(await ledger.getAddress(), ethers.MaxUint256);

  await claims.connect(underwriter).setReviewer(reviewer1.address, true);
  await claims.connect(underwriter).setReviewer(reviewer2.address, true);
  await claims.connect(underwriter).setReviewQuorum(2); // 2 of {underwriter, reviewer1, reviewer2}
  return { ...base, claims, gov, reviewer1, reviewer2, agent };
}

describe("Premium subsidy", function () {
  it("without a programme the farmer pays the whole premium", async () => {
    const { ledger, token, farmer } = await loadFixture(phase2Fixture);
    const before = await token.balanceOf(farmer.address);
    await buyFor(ledger, farmer, 1, 1, 100_000); // drought, 10%
    expect(before - (await token.balanceOf(farmer.address))).to.equal(10_000n);
    expect(await ledger.subsidyOf(1)).to.equal(0n);
  });

  it("pays 40% of the premium for an eligible product; the underwriter still receives the full premium", async () => {
    const { ledger, token, farmer, underwriter, gov } = await loadFixture(phase2Fixture);
    await ledger.connect(gov).fundSubsidy(500_000);
    await ledger.connect(gov).setSubsidy(4000, 0);
    await ledger.connect(gov).setSubsidyEligible(1, true);
    expect(await ledger.subsidyFor(farmer.address, 1, 10_000)).to.equal(4_000n);

    const farmerBefore = await token.balanceOf(farmer.address);
    const poolBefore = await ledger.poolBalance(underwriter.address);
    await expect(buyFor(ledger, farmer, 1, 1, 100_000))
      .to.emit(ledger, "PremiumSubsidised").withArgs(1, farmer.address, 4_000, 6_000);
    expect(farmerBefore - (await token.balanceOf(farmer.address))).to.equal(6_000n);
    expect((await ledger.poolBalance(underwriter.address)) - poolBefore).to.equal(10_000n);
    expect(await ledger.subsidyPool()).to.equal(496_000n);
    expect(await ledger.subsidyPaid()).to.equal(4_000n);
    expect(await ledger.subsidyUsed(farmer.address)).to.equal(4_000n);
    expect(await ledger.subsidyOf(1)).to.equal(4_000n);
    expect((await ledger.getPolicy(1)).premium).to.equal(10_000n); // the policy records the full premium
  });

  it("products outside the programme get nothing", async () => {
    const { ledger, farmer, gov } = await loadFixture(phase2Fixture);
    await ledger.connect(gov).fundSubsidy(500_000);
    await ledger.connect(gov).setSubsidy(4000, 0);
    await ledger.connect(gov).setSubsidyEligible(1, true);
    expect(await ledger.subsidyFor(farmer.address, 2, 10_000)).to.equal(0n);
    await expect(buyFor(ledger, farmer, 2, 1, 100_000)).not.to.emit(ledger, "PremiumSubsidised");
  });

  it("is limited by the per-farmer cap and by the money left in the pool", async () => {
    const { ledger, token, farmer, farmer2, gov } = await loadFixture(phase2Fixture);
    await ledger.connect(gov).setSubsidy(4000, 5_000); // at most 5,000 per farmer
    await ledger.connect(gov).setSubsidyEligible(1, true);
    await ledger.connect(gov).setSubsidyEligible(2, true);
    await ledger.connect(gov).fundSubsidy(7_000);

    await buyFor(ledger, farmer, 1, 1, 100_000); // premium 10,000 -> 4,000
    expect(await ledger.subsidyFor(farmer.address, 2, 8_000)).to.equal(1_000n); // cap leaves 1,000
    await buyFor(ledger, farmer, 2, 1, 100_000); // premium 8,000 -> 1,000 (cap reached)
    expect(await ledger.subsidyOf(2)).to.equal(1_000n);
    expect(await ledger.subsidyFor(farmer.address, 1, 10_000)).to.equal(0n);

    // farmer2: pool has 2,000 left, so 2,000 instead of 4,000
    await ledger.connect(farmer2).registerPlot(-1_300_000, 30_300_000, 8000, b32("BEANS"), hash("geo-2"));
    const before = await token.balanceOf(farmer2.address);
    await buyFor(ledger, farmer2, 1, 2, 100_000);
    expect(await ledger.subsidyOf(3)).to.equal(2_000n);
    expect(before - (await token.balanceOf(farmer2.address))).to.equal(8_000n);
    expect(await ledger.subsidyPool()).to.equal(0n);
  });

  it("only the programme account can fund, configure or withdraw, within limits", async () => {
    const { ledger, outsider, gov, admin } = await loadFixture(phase2Fixture);
    const role = await ledger.SUBSIDY_ROLE();
    await expect(ledger.connect(outsider).fundSubsidy(1)).to.be.revertedWithCustomError(ledger, "AccessControlUnauthorizedAccount").withArgs(outsider.address, role);
    await expect(ledger.connect(admin).setSubsidy(4000, 0)).to.be.revertedWithCustomError(ledger, "AccessControlUnauthorizedAccount");
    await expect(ledger.connect(gov).setSubsidy(9001, 0)).to.be.revertedWithCustomError(ledger, "InvalidInput");
    await expect(ledger.connect(gov).setSubsidyEligible(99, true)).to.be.revertedWithCustomError(ledger, "InvalidInput");
    await ledger.connect(gov).fundSubsidy(1_000);
    await expect(ledger.connect(gov).withdrawSubsidy(1_001)).to.be.revertedWithCustomError(ledger, "WithdrawExceedsAvailable").withArgs(1_000);
    await expect(ledger.connect(gov).withdrawSubsidy(1_000)).to.emit(ledger, "SubsidyWithdrawn").withArgs(gov.address, 1_000);
  });
});

describe("Test token issuing", function () {
  it("with the faucet closed only appointed minters (the treasury) can create money", async () => {
    const [owner, treasury, outsider] = await ethers.getSigners();
    const t = await (await ethers.getContractFactory("MockRWF")).deploy(false);
    await expect(t.connect(outsider).mint(outsider.address, 1)).to.be.revertedWithCustomError(t, "NotMinter");
    await expect(t.connect(outsider).setMinter(outsider.address, true)).to.be.revertedWithCustomError(t, "OwnableUnauthorizedAccount");
    await t.connect(owner).setMinter(treasury.address, true);
    await t.connect(treasury).mint(outsider.address, 500);
    expect(await t.balanceOf(outsider.address)).to.equal(500n);
  });
});

describe("Phone number change", function () {
  it("a registered farmer can record a new phone hash; the account keeps its assets", async () => {
    const { ledger, farmer, outsider } = await loadFixture(phase2Fixture);
    await expect(ledger.connect(farmer).updatePhone(hash("250788999999")))
      .to.emit(ledger, "FarmerPhoneChanged").withArgs(farmer.address, hash("250788999999"));
    expect((await ledger.getFarmer(farmer.address)).phoneHash).to.equal(hash("250788999999"));
    expect(await ledger.plotsOf(farmer.address)).to.deep.equal([1n]);
    await expect(ledger.connect(farmer).updatePhone(ethers.ZeroHash)).to.be.revertedWithCustomError(ledger, "InvalidInput");
    await expect(ledger.connect(outsider).updatePhone(hash("x"))).to.be.revertedWithCustomError(ledger, "NotRegistered");
  });
});

describe("Crop loss claims (CropClaims)", function () {
  async function insured() {
    const ctx = await loadFixture(phase2Fixture);
    await buyFor(ctx.ledger, ctx.farmer, 1, 1, 100_000); // policy 1, drought on plot 1
    return ctx;
  }

  it("a claim approved by 2 of 3 reviewers for the same amount pays that amount and releases the whole reserve", async () => {
    const { ledger, claims, token, farmer, underwriter, reviewer1 } = await insured();
    await expect(claims.connect(farmer).fileClaim(1, hash("photos+report"), 70_000))
      .to.emit(claims, "CropClaimFiled").withArgs(1, 1, farmer.address, hash("photos+report"), 70_000, 2, false)
      .and.to.emit(ledger, "AssessmentHold").withArgs(1, true);
    expect(await ledger.underAssessment(1)).to.equal(true);
    expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.Active); // index cover keeps working

    await expect(claims.connect(reviewer1).review(1, true, 60_000))
      .to.emit(claims, "CropClaimReviewed").withArgs(1, reviewer1.address, true, 60_000, 1, 0);
    await expect(claims.connect(underwriter).review(1, true, 50_000)).to.be.revertedWithCustomError(claims, "AmountMismatch").withArgs(60_000);

    const before = await token.balanceOf(farmer.address);
    const poolBefore = await ledger.poolBalance(underwriter.address);
    await expect(claims.connect(underwriter).review(1, true, 60_000))
      .to.emit(claims, "CropClaimSettled").withArgs(1, 1, S.Approved, 60_000)
      .and.to.emit(ledger, "PayoutExecuted").withArgs(1, farmer.address, 60_000, Cover.Drought, false);
    expect((await token.balanceOf(farmer.address)) - before).to.equal(60_000n);
    expect(poolBefore - (await ledger.poolBalance(underwriter.address))).to.equal(60_000n);
    expect(await ledger.poolReserved(underwriter.address)).to.equal(0n);
    expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.PaidOut);
    expect(await ledger.underAssessment(1)).to.equal(false);
    expect(await claims.openClaimOf(1)).to.equal(0n);
  });

  it("only the underwriter's reviewers can vote, once each, never on their own claim", async () => {
    const { claims, farmer, outsider, reviewer1, underwriter } = await insured();
    await claims.connect(farmer).fileClaim(1, hash("ev"), 0);
    await expect(claims.connect(outsider).review(1, true, 1)).to.be.revertedWithCustomError(claims, "NotReviewer");
    await claims.connect(reviewer1).review(1, false, 0);
    await expect(claims.connect(reviewer1).review(1, false, 0)).to.be.revertedWithCustomError(claims, "AlreadyReviewed");
    await expect(claims.connect(underwriter).review(1, true, 100_001)).to.be.revertedWithCustomError(claims, "InvalidInput");

    // a reviewer who is also the policy holder cannot decide it
    await claims.connect(underwriter).setReviewer(farmer.address, true);
    await expect(claims.connect(farmer).review(1, true, 1)).to.be.revertedWithCustomError(claims, "ReviewerIsHolder");
  });

  it("a rejected claim releases the hold: cover continues, the policy can expire, the farmer may file again (max 3)", async () => {
    const { ledger, claims, farmer, underwriter, reviewer1, reviewer2 } = await insured();
    await claims.connect(farmer).fileClaim(1, hash("ev1"), 0);
    await expect(claims.connect(farmer).fileClaim(1, hash("ev1b"), 0)).to.be.revertedWithCustomError(claims, "ClaimAlreadyOpen");
    await claims.connect(reviewer1).review(1, false, 0);
    await expect(claims.connect(reviewer2).review(1, false, 0))
      .to.emit(claims, "CropClaimSettled").withArgs(1, 1, S.Rejected, 0)
      .and.to.emit(ledger, "AssessmentHold").withArgs(1, false);
    expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.Active);

    for (const n of [2, 3]) {
      await claims.connect(farmer).fileClaim(1, hash("ev" + n), 0);
      await claims.connect(underwriter).review(n, false, 0);
      await claims.connect(reviewer1).review(n, false, 0);
    }
    await expect(claims.connect(farmer).fileClaim(1, hash("ev4"), 0)).to.be.revertedWithCustomError(claims, "TooManyClaims");
    await time.increase(121 * DAY);
    await expect(ledger.expirePolicy(1)).to.emit(ledger, "PolicyExpired");
  });

  it("an open claim keeps the reserve: the policy cannot be expired until the claim is decided", async () => {
    const { ledger, claims, farmer, underwriter, reviewer1 } = await insured();
    await claims.connect(farmer).fileClaim(1, hash("ev"), 0);
    await time.increase(121 * DAY);
    await expect(ledger.expirePolicy(1)).to.be.revertedWithCustomError(ledger, "UnderAssessment");
    await expect(claims.connect(farmer).fileClaim(1, hash("late"), 0)).to.be.revertedWithCustomError(claims, "OutsidePolicyPeriod");
    // the decision may come after the cover period
    await claims.connect(reviewer1).review(1, true, 40_000);
    await expect(claims.connect(underwriter).review(1, true, 40_000)).to.emit(ledger, "PayoutExecuted");
  });

  it("if the index pays during the review, the claim is closed as superseded and nothing is paid twice", async () => {
    const { ledger, claims, token, farmer, oracle, reviewer1 } = await insured();
    await claims.connect(farmer).fileClaim(1, hash("ev"), 0);
    await time.increase(DAY);
    const now = await time.latest();
    await expect(ledger.connect(oracle).postReading(1, Metric.Rainfall, 900, now))
      .to.emit(ledger, "PayoutExecuted").withArgs(1, farmer.address, 100_000, Cover.Drought, true)
      .and.to.emit(ledger, "AssessmentHold").withArgs(1, false);

    const before = await token.balanceOf(farmer.address);
    await expect(claims.connect(reviewer1).review(1, true, 50_000)).to.emit(claims, "CropClaimSettled").withArgs(1, 1, S.Superseded, 0);
    expect(await token.balanceOf(farmer.address)).to.equal(before);
    expect((await claims.getClaim(1)).status).to.equal(S.Superseded);
    await expect(claims.closeSuperseded(1)).to.be.revertedWithCustomError(claims, "ClaimNotPending");
  });

  it("filing rules: holder or USSD agent only, crop cover only, during cover, evidence required", async () => {
    const { ledger, claims, farmer, outsider, agent } = await insured();
    await expect(claims.connect(outsider).fileClaim(1, hash("ev"), 0)).to.be.revertedWithCustomError(claims, "NotPolicyHolder");
    await expect(claims.connect(outsider).fileClaimFor(1, hash("ev"), 0)).to.be.revertedWithCustomError(claims, "NotPolicyHolder");
    await expect(claims.connect(farmer).fileClaim(1, ethers.ZeroHash, 0)).to.be.revertedWithCustomError(claims, "InvalidInput");
    await expect(claims.connect(farmer).fileClaim(1, hash("ev"), 100_001)).to.be.revertedWithCustomError(claims, "InvalidInput");

    await buyFor(ledger, farmer, 4, 1, 300_000); // policy 2: livestock -> vets, not this contract
    await expect(claims.connect(farmer).fileClaim(2, hash("ev"), 0)).to.be.revertedWithCustomError(claims, "WrongCover");

    await expect(claims.connect(agent).fileClaimFor(1, hash("ev"), 0))
      .to.emit(claims, "CropClaimFiled").withArgs(1, 1, farmer.address, hash("ev"), 0, 2, true);
  });

  it("quorum is set by the underwriter, cannot exceed its reviewers, and is fixed per claim when filed", async () => {
    const { claims, farmer, underwriter, reviewer1, reviewer2, outsider } = await insured();
    await expect(claims.connect(outsider).setReviewer(outsider.address, true)).to.be.revertedWithCustomError(claims, "NotUnderwriter");
    await expect(claims.connect(underwriter).setReviewQuorum(4)).to.be.revertedWithCustomError(claims, "InvalidQuorum");
    expect(await claims.reviewersOf(underwriter.address)).to.deep.equal([reviewer1.address, reviewer2.address]);

    await claims.connect(farmer).fileClaim(1, hash("ev"), 0); // quorum 2
    await claims.connect(underwriter).setReviewQuorum(1);
    expect((await claims.getClaim(1)).quorum).to.equal(2);
    await claims.connect(reviewer1).review(1, true, 10_000);
    expect((await claims.getClaim(1)).status).to.equal(S.Pending); // still needs a second approval

    // removing reviewers lowers a quorum that could no longer be reached
    await claims.connect(underwriter).setReviewQuorum(3);
    await claims.connect(underwriter).setReviewer(reviewer2.address, false);
    expect(await claims.reviewQuorum(underwriter.address)).to.equal(2);
    expect(await claims.isReviewer(underwriter.address, reviewer2.address)).to.equal(false);
  });

  it("the ledger's assessment hooks can only be called by the CropClaims contract", async () => {
    const { ledger, underwriter } = await insured();
    await expect(ledger.connect(underwriter).payAssessedLoss(1, 1)).to.be.revertedWithCustomError(ledger, "AccessControlUnauthorizedAccount");
    await expect(ledger.connect(underwriter).setAssessmentHold(1, true)).to.be.revertedWithCustomError(ledger, "AccessControlUnauthorizedAccount");
  });
});
