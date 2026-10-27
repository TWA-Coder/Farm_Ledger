const { expect } = require("chai");
const {
  ethers, loadFixture, time, b32, hash, Cover, Metric, PolicyStatus, ClaimStatus,
  deployFixture, farmerFixture, signAttestation,
} = require("./helpers");

const DAY = 24 * 60 * 60;

describe("FarmLedger", function () {
  // ------------------------------------------------------------------ FR-01 / FR-02
  describe("Registry (FR-01, FR-02)", function () {
    it("registers a farmer once and rejects duplicates and reused national IDs", async () => {
      const { ledger, farmer, farmer2 } = await loadFixture(deployFixture);
      await expect(ledger.connect(farmer).registerFarmer(hash("id-1"), hash("ph-1")))
        .to.emit(ledger, "FarmerRegistered");
      await expect(ledger.connect(farmer).registerFarmer(hash("id-2"), hash("ph-2")))
        .to.be.revertedWithCustomError(ledger, "AlreadyRegistered");
      await expect(ledger.connect(farmer2).registerFarmer(hash("id-1"), hash("ph-3")))
        .to.be.revertedWithCustomError(ledger, "IdAlreadyUsed");
      expect((await ledger.getFarmer(farmer.address)).exists).to.equal(true);
    });

    it("rejects empty identity hashes", async () => {
      const { ledger, farmer } = await loadFixture(deployFixture);
      await expect(ledger.connect(farmer).registerFarmer(ethers.ZeroHash, hash("p")))
        .to.be.revertedWithCustomError(ledger, "InvalidInput");
    });

    it("only registered farmers can register assets", async () => {
      const { ledger, outsider } = await loadFixture(deployFixture);
      await expect(ledger.connect(outsider).registerPlot(1, 1, 100, b32("MAIZE"), hash("g")))
        .to.be.revertedWithCustomError(ledger, "NotRegistered");
      await expect(ledger.connect(outsider).registerAnimal(b32("T1"), b32("X"), 2020, hash("p")))
        .to.be.revertedWithCustomError(ledger, "NotRegistered");
    });

    it("registers plots with GPS, crop and area, and lists them per farmer", async () => {
      const { ledger, farmer } = await loadFixture(farmerFixture);
      const plot = await ledger.getPlot(1);
      expect(plot.owner).to.equal(farmer.address);
      expect(plot.latE6).to.equal(-2_150_000);
      expect(plot.areaM2).to.equal(5000);
      expect(await ledger.plotsOf(farmer.address)).to.deep.equal([1n]);
    });

    it("rejects invalid coordinates and zero area", async () => {
      const { ledger, farmer } = await loadFixture(farmerFixture);
      await expect(ledger.connect(farmer).registerPlot(91_000_000, 0, 100, b32("MAIZE"), hash("g")))
        .to.be.revertedWithCustomError(ledger, "InvalidInput");
      await expect(ledger.connect(farmer).registerPlot(0, 0, 0, b32("MAIZE"), hash("g")))
        .to.be.revertedWithCustomError(ledger, "InvalidInput");
    });

    it("registers an animal by ear tag and blocks duplicate tags (anti phantom-policy)", async () => {
      const { ledger, farmer, farmer2 } = await loadFixture(farmerFixture);
      expect(await ledger.animalIdByTag(b32("RW-TAG-0001"))).to.equal(1);
      await expect(ledger.connect(farmer2).registerAnimal(b32("RW-TAG-0001"), b32("X"), 2020, hash("p")))
        .to.be.revertedWithCustomError(ledger, "TagAlreadyRegistered");
      expect((await ledger.getAnimal(1)).owner).to.equal(farmer.address);
    });
  });

  // ------------------------------------------------------------------ FR-03 / FR-04
  describe("Products, premiums and escrow (FR-03, FR-04)", function () {
    it("only underwriters create products", async () => {
      const { ledger, farmer } = await loadFixture(farmerFixture);
      await expect(ledger.connect(farmer).createProduct(Cover.Drought, 1000, 500, 90))
        .to.be.revertedWithCustomError(ledger, "AccessControlUnauthorizedAccount");
    });

    it("quotes premium from the product rate", async () => {
      const { ledger } = await loadFixture(farmerFixture);
      expect(await ledger.quotePremium(1, 100_000)).to.equal(10_000); // 10%
      expect(await ledger.quotePremium(4, 100_000)).to.equal(5_000);  // 5%
      expect(await ledger.quotePremium(1, 1)).to.equal(1);            // never zero
    });

    it("locks the premium and reserves the sum insured in escrow", async () => {
      const { ledger, token, farmer, underwriter, ledgerAddr } = await loadFixture(farmerFixture);
      const before = await token.balanceOf(farmer.address);
      await expect(ledger.connect(farmer).buyPolicy(1, 1, 100_000))
        .to.emit(ledger, "PolicyPurchased");
      expect(await token.balanceOf(farmer.address)).to.equal(before - 10_000n);
      const [balance, reserved, available, stats] = await ledger.poolStats(underwriter.address);
      expect(balance).to.equal(5_010_000n);
      expect(reserved).to.equal(100_000n);
      expect(available).to.equal(4_910_000n);
      expect(stats.premiums).to.equal(10_000n);
      expect(await token.balanceOf(ledgerAddr)).to.equal(5_010_000n);
    });

    it("refuses a policy the pool cannot fully cover", async () => {
      const { ledger, farmer } = await loadFixture(farmerFixture);
      await expect(ledger.connect(farmer).buyPolicy(1, 1, 6_000_000))
        .to.be.revertedWithCustomError(ledger, "InsufficientPool");
    });

    it("rejects someone else's asset, unknown assets, wrong asset types and inactive products", async () => {
      const { ledger, farmer, farmer2, underwriter } = await loadFixture(farmerFixture);
      await expect(ledger.connect(farmer2).buyPolicy(1, 1, 1000))
        .to.be.revertedWithCustomError(ledger, "NotOwner");
      await expect(ledger.connect(farmer).buyPolicy(1, 99, 1000))
        .to.be.revertedWithCustomError(ledger, "UnknownAsset");
      await expect(ledger.connect(farmer).buyPolicy(4, 5, 1000)) // livestock product, unknown animal
        .to.be.revertedWithCustomError(ledger, "UnknownAsset");
      await ledger.connect(underwriter).setProductActive(1, false);
      await expect(ledger.connect(farmer).buyPolicy(1, 1, 1000))
        .to.be.revertedWithCustomError(ledger, "ProductInactive");
    });

    it("lets the underwriter withdraw only unreserved liquidity", async () => {
      const { ledger, farmer, underwriter } = await loadFixture(farmerFixture);
      await ledger.connect(farmer).buyPolicy(1, 1, 1_000_000);
      const [, , available] = await ledger.poolStats(underwriter.address);
      await expect(ledger.connect(underwriter).withdrawLiquidity(available + 1n))
        .to.be.revertedWithCustomError(ledger, "WithdrawExceedsAvailable");
      await expect(ledger.connect(underwriter).withdrawLiquidity(available))
        .to.emit(ledger, "LiquidityWithdrawn");
    });
  });

  // ------------------------------------------------------------------ FR-05 / FR-06
  describe("Mode 1 - parametric crop claims (FR-05, FR-06)", function () {
    async function withDroughtPolicy() {
      const ctx = await farmerFixture();
      await ctx.ledger.connect(ctx.farmer).buyPolicy(1, 1, 200_000);
      return ctx;
    }

    it("only the oracle role can post readings", async () => {
      const { ledger, outsider, farmer } = await loadFixture(withDroughtPolicy);
      const now = await time.latest();
      await expect(ledger.connect(outsider).postReading(1, Metric.Rainfall, 100, now))
        .to.be.revertedWithCustomError(ledger, "AccessControlUnauthorizedAccount");
      await expect(ledger.connect(farmer).postReading(1, Metric.Rainfall, 100, now))
        .to.be.revertedWithCustomError(ledger, "AccessControlUnauthorizedAccount");
    });

    it("pays automatically when rainfall falls below the drought threshold", async () => {
      const { ledger, token, oracle, farmer, underwriter } = await loadFixture(withDroughtPolicy);
      const before = await token.balanceOf(farmer.address);
      const now = await time.latest();
      await expect(ledger.connect(oracle).postReading(1, Metric.Rainfall, 900, now))
        .to.emit(ledger, "PayoutExecuted").withArgs(1, farmer.address, 200_000, Cover.Drought, true);
      expect(await token.balanceOf(farmer.address)).to.equal(before + 200_000n);
      expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.PaidOut);
      const [, reserved, , stats] = await ledger.poolStats(underwriter.address);
      expect(reserved).to.equal(0);
      expect(stats.paidOut).to.equal(200_000n);
      expect(await ledger.activePoliciesOfPlot(1)).to.deep.equal([]);
    });

    it("does not pay when the reading is normal", async () => {
      const { ledger, oracle } = await loadFixture(withDroughtPolicy);
      const now = await time.latest();
      await ledger.connect(oracle).postReading(1, Metric.Rainfall, 2500, now);
      expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.Active);
    });

    it("treats the threshold itself as not triggered (strictly below)", async () => {
      const { ledger, oracle } = await loadFixture(withDroughtPolicy);
      await ledger.connect(oracle).postReading(1, Metric.Rainfall, 1500, await time.latest());
      expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.Active);
    });

    it("pays flood cover only when rainfall exceeds the threshold", async () => {
      const { ledger, token, oracle, farmer } = await loadFixture(farmerFixture);
      await ledger.connect(farmer).buyPolicy(2, 1, 100_000);
      await ledger.connect(oracle).postReading(1, Metric.Rainfall, 3000, await time.latest());
      expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.Active);
      const before = await token.balanceOf(farmer.address);
      await ledger.connect(oracle).postReading(1, Metric.Rainfall, 4200, await time.latest());
      expect(await token.balanceOf(farmer.address)).to.equal(before + 100_000n);
    });

    it("pays NDVI cover only from NDVI readings, not from rainfall readings", async () => {
      const { ledger, oracle, farmer } = await loadFixture(farmerFixture);
      await ledger.connect(farmer).buyPolicy(3, 1, 100_000);
      await ledger.connect(oracle).postReading(1, Metric.Rainfall, 10, await time.latest());
      expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.Active);
      await ledger.connect(oracle).postReading(1, Metric.NDVI, 2000, await time.latest());
      expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.PaidOut);
    });

    it("evaluates several policies on the same plot in one transaction", async () => {
      const { ledger, oracle, farmer } = await loadFixture(farmerFixture);
      await ledger.connect(farmer).buyPolicy(1, 1, 100_000); // drought
      await ledger.connect(farmer).buyPolicy(2, 1, 100_000); // flood (not triggered by low rain)
      await ledger.connect(farmer).buyPolicy(1, 1, 50_000);  // second drought policy
      await ledger.connect(oracle).postReading(1, Metric.Rainfall, 500, await time.latest());
      expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.PaidOut);
      expect((await ledger.getPolicy(2)).status).to.equal(PolicyStatus.Active);
      expect((await ledger.getPolicy(3)).status).to.equal(PolicyStatus.PaidOut);
      expect(await ledger.activePoliciesOfPlot(1)).to.deep.equal([2n]);
    });

    it("ignores readings observed before the policy started or after it ended", async () => {
      const { ledger, oracle } = await loadFixture(withDroughtPolicy);
      const policy = await ledger.getPolicy(1);
      await ledger.connect(oracle).postReading(1, Metric.Rainfall, 100, policy.start - 10n);
      expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.Active);
      await time.increase(121 * DAY);
      await ledger.connect(oracle).postReading(1, Metric.Rainfall, 100, await time.latest());
      expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.Active);
    });

    it("rejects readings from the future and for unknown plots", async () => {
      const { ledger, oracle } = await loadFixture(withDroughtPolicy);
      await expect(ledger.connect(oracle).postReading(1, Metric.Rainfall, 100, (await time.latest()) + 1000))
        .to.be.revertedWithCustomError(ledger, "InvalidInput");
      await expect(ledger.connect(oracle).postReading(77, Metric.Rainfall, 100, await time.latest()))
        .to.be.revertedWithCustomError(ledger, "UnknownAsset");
    });

    it("stores the latest reading for the dashboard", async () => {
      const { ledger, oracle } = await loadFixture(withDroughtPolicy);
      await ledger.connect(oracle).postReading(1, Metric.Rainfall, 2222, await time.latest());
      expect((await ledger.getLatestReading(1, Metric.Rainfall)).value).to.equal(2222);
    });

    it("expires a finished policy and releases its reserve", async () => {
      const { ledger, underwriter } = await loadFixture(withDroughtPolicy);
      await expect(ledger.expirePolicy(1)).to.be.revertedWithCustomError(ledger, "NotYetExpired");
      await time.increase(121 * DAY);
      await expect(ledger.expirePolicy(1)).to.emit(ledger, "PolicyExpired");
      expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.Expired);
      expect((await ledger.poolStats(underwriter.address))[1]).to.equal(0);
      await expect(ledger.expirePolicy(1)).to.be.revertedWithCustomError(ledger, "PolicyNotActive");
    });

    it("is solvent: payouts never exceed pool balance across many triggered policies", async () => {
      const { ledger, oracle, farmer, underwriter } = await loadFixture(farmerFixture);
      for (let i = 0; i < 10; i++) await ledger.connect(farmer).buyPolicy(1, 1, 400_000);
      await ledger.connect(oracle).postReading(1, Metric.Rainfall, 0, await time.latest());
      const [balance, reserved, , stats] = await ledger.poolStats(underwriter.address);
      expect(reserved).to.equal(0);
      expect(stats.paidOut).to.equal(4_000_000n);
      expect(balance).to.equal(5_000_000n + stats.premiums - 4_000_000n);
    });
  });

  // ------------------------------------------------------------------ FR-07 .. FR-10
  describe("Mode 2 - livestock claims with vet attestation (FR-07..FR-10)", function () {
    async function withCowPolicy() {
      const ctx = await farmerFixture();
      await ctx.ledger.connect(ctx.farmer).buyPolicy(4, 1, 300_000);
      return ctx;
    }
    async function claimReady() {
      const ctx = await withCowPolicy();
      await time.increase(8 * DAY);
      await ctx.ledger.connect(ctx.farmer).fileClaim(1, hash("photo-dead-cow"));
      return ctx;
    }
    const tagId = b32("RW-TAG-0001");
    const sign = async (ctx, signer, over = {}) =>
      signAttestation(signer, ctx.ledger, {
        claimId: 1, policyId: 1, tagId, approved: true,
        deadline: (await time.latest()) + 3600, ...over,
      });

    it("blocks claims during the waiting period (moral-hazard guard)", async () => {
      const { ledger, farmer } = await loadFixture(withCowPolicy);
      await expect(ledger.connect(farmer).fileClaim(1, hash("photo")))
        .to.be.revertedWithCustomError(ledger, "WaitingPeriodNotElapsed");
    });

    it("only the policy holder can file, with evidence, on a livestock policy", async () => {
      const { ledger, farmer, farmer2 } = await loadFixture(withCowPolicy);
      await time.increase(8 * DAY);
      await expect(ledger.connect(farmer2).fileClaim(1, hash("p")))
        .to.be.revertedWithCustomError(ledger, "NotPolicyHolder");
      await expect(ledger.connect(farmer).fileClaim(1, ethers.ZeroHash))
        .to.be.revertedWithCustomError(ledger, "InvalidInput");
    });

    it("refuses livestock claims on crop policies", async () => {
      const { ledger, farmer } = await loadFixture(farmerFixture);
      await ledger.connect(farmer).buyPolicy(1, 1, 1000);
      await time.increase(8 * DAY);
      await expect(ledger.connect(farmer).fileClaim(1, hash("p")))
        .to.be.revertedWithCustomError(ledger, "WrongAssetType");
    });

    it("files a claim and marks the policy ClaimPending", async () => {
      const { ledger } = await loadFixture(claimReady);
      expect((await ledger.getClaim(1)).status).to.equal(ClaimStatus.Pending);
      expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.ClaimPending);
    });

    it("pays out on a valid veterinarian signature and marks the animal deceased", async () => {
      const ctx = await loadFixture(claimReady);
      const { ledger, token, vet, farmer, outsider } = ctx;
      const deadline = (await time.latest()) + 3600;
      const sig = await sign(ctx, vet, { deadline });
      const before = await token.balanceOf(farmer.address);
      // a relayer (anyone) submits the vet's signature
      await expect(ledger.connect(outsider).settleLivestockClaim(1, true, deadline, sig))
        .to.emit(ledger, "PayoutExecuted").withArgs(1, farmer.address, 300_000, Cover.Livestock, false);
      expect(await token.balanceOf(farmer.address)).to.equal(before + 300_000n);
      expect((await ledger.getClaim(1)).status).to.equal(ClaimStatus.Approved);
      expect((await ledger.getAnimal(1)).deceased).to.equal(true);
      expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.PaidOut);
    });

    it("rejects signatures from accounts without the vet role", async () => {
      const ctx = await loadFixture(claimReady);
      const deadline = (await time.latest()) + 3600;
      const sig = await sign(ctx, ctx.outsider, { deadline });
      await expect(ctx.ledger.settleLivestockClaim(1, true, deadline, sig))
        .to.be.revertedWithCustomError(ctx.ledger, "InvalidVet");
    });

    it("rejects a farmer signing their own claim even if they hold the vet role", async () => {
      const ctx = await loadFixture(claimReady);
      await ctx.ledger.certifyVet(ctx.farmer.address, ethers.id("LIC-F"), ethers.encodeBytes32String("BUGESERA"), (await time.latest()) + 86400);
      const deadline = (await time.latest()) + 3600;
      const sig = await sign(ctx, ctx.farmer, { deadline });
      await expect(ctx.ledger.settleLivestockClaim(1, true, deadline, sig))
        .to.be.revertedWithCustomError(ctx.ledger, "VetCannotBeClaimant");
    });

    it("binds the signature to claim, decision and deadline (tampering fails)", async () => {
      const ctx = await loadFixture(claimReady);
      const deadline = (await time.latest()) + 3600;
      const sig = await sign(ctx, ctx.vet, { deadline, approved: false });
      // submit with approved=true although the vet signed 'false'
      await expect(ctx.ledger.settleLivestockClaim(1, true, deadline, sig))
        .to.be.revertedWithCustomError(ctx.ledger, "InvalidVet");
    });

    it("rejects expired attestations", async () => {
      const ctx = await loadFixture(claimReady);
      const deadline = (await time.latest()) + 60;
      const sig = await sign(ctx, ctx.vet, { deadline });
      await time.increase(120);
      await expect(ctx.ledger.settleLivestockClaim(1, true, deadline, sig))
        .to.be.revertedWithCustomError(ctx.ledger, "AttestationExpired");
    });

    it("cannot be replayed once settled", async () => {
      const ctx = await loadFixture(claimReady);
      const deadline = (await time.latest()) + 3600;
      const sig = await sign(ctx, ctx.vet, { deadline });
      await ctx.ledger.settleLivestockClaim(1, true, deadline, sig);
      await expect(ctx.ledger.settleLivestockClaim(1, true, deadline, sig))
        .to.be.revertedWithCustomError(ctx.ledger, "ClaimNotPending");
    });

    it("a rejected claim keeps the policy active and pays nothing", async () => {
      const ctx = await loadFixture(claimReady);
      const { ledger, token, farmer } = ctx;
      const deadline = (await time.latest()) + 3600;
      const sig = await sign(ctx, ctx.vet, { deadline, approved: false });
      const before = await token.balanceOf(farmer.address);
      await ledger.settleLivestockClaim(1, false, deadline, sig);
      expect(await token.balanceOf(farmer.address)).to.equal(before);
      expect((await ledger.getClaim(1)).status).to.equal(ClaimStatus.Rejected);
      expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.Active);
      expect((await ledger.getAnimal(1)).deceased).to.equal(false);
    });

    it("prevents a second policy on an animal that already has cover, and on a deceased animal", async () => {
      const ctx = await loadFixture(withCowPolicy);
      await expect(ctx.ledger.connect(ctx.farmer).buyPolicy(4, 1, 1000))
        .to.be.revertedWithCustomError(ctx.ledger, "AssetAlreadyCovered");
      await time.increase(8 * DAY);
      await ctx.ledger.connect(ctx.farmer).fileClaim(1, hash("p"));
      const deadline = (await time.latest()) + 3600;
      const sig = await sign(ctx, ctx.vet, { deadline });
      await ctx.ledger.settleLivestockClaim(1, true, deadline, sig);
      await expect(ctx.ledger.connect(ctx.farmer).buyPolicy(4, 1, 1000))
        .to.be.revertedWithCustomError(ctx.ledger, "AssetAlreadyCovered");
    });
  });

  // ------------------------------------------------------------------ vet RBAC + multi-signature quorum
  describe("Vet certification and multi-signature attestation", function () {
    async function withCowPolicy() {
      const ctx = await farmerFixture();
      await ctx.ledger.connect(ctx.farmer).buyPolicy(4, 1, 300_000);
      return ctx;
    }
    async function quorumReady() {
      const ctx = await withCowPolicy();
      await time.increase(8 * DAY);
      await ctx.ledger.connect(ctx.farmer).fileClaim(1, hash("photo-dead-cow"));
      return ctx;
    }
    const tagId = b32("RW-TAG-0001");
    const sign = async (ctx, signer, over = {}) =>
      signAttestation(signer, ctx.ledger, {
        claimId: 1, policyId: 1, tagId, approved: true,
        deadline: (await time.latest()) + 3600, ...over,
      });
    async function twoOfThree() {
      const base = await loadFixture(withCowPolicy);
      await base.ledger.setVetQuorum(2);
      // quorum is fixed when the claim is filed, so file after setting it
      await time.increase(8 * DAY);
      await base.ledger.connect(base.farmer).fileClaim(1, hash("photo"));
      return base;
    }

    it("only the admin can certify, revoke or change the quorum", async () => {
      const { ledger, outsider } = await loadFixture(quorumReady);
      const lic = ethers.id("L"), sec = ethers.encodeBytes32String("X");
      const exp = (await time.latest()) + 1000;
      await expect(ledger.connect(outsider).certifyVet(outsider.address, lic, sec, exp)).to.be.reverted;
      await expect(ledger.connect(outsider).revokeVet(outsider.address)).to.be.reverted;
      await expect(ledger.connect(outsider).setVetQuorum(2)).to.be.reverted;
    });

    it("stores the licence profile and lists certified vets", async () => {
      const { ledger, vet } = await loadFixture(quorumReady);
      const p = await ledger.getVetProfile(vet.address);
      expect(p.active).to.equal(true);
      expect(p.sector).to.equal(ethers.encodeBytes32String("BUGESERA"));
      expect(await ledger.isCertifiedVet(vet.address)).to.equal(true);
      expect((await ledger.getVets()).length).to.equal(3);
    });

    it("validates certification input and quorum bounds", async () => {
      const { ledger, outsider } = await loadFixture(quorumReady);
      const exp = (await time.latest()) + 1000;
      await expect(ledger.certifyVet(outsider.address, ethers.ZeroHash, ethers.id("s"), exp)).to.be.revertedWithCustomError(ledger, "InvalidInput");
      await expect(ledger.certifyVet(outsider.address, ethers.id("l"), ethers.id("s"), (await time.latest()) - 1)).to.be.revertedWithCustomError(ledger, "InvalidInput");
      await expect(ledger.setVetQuorum(0)).to.be.revertedWithCustomError(ledger, "InvalidQuorum");
      await expect(ledger.setVetQuorum(6)).to.be.revertedWithCustomError(ledger, "InvalidQuorum");
    });

    it("a revoked vet's signature no longer counts", async () => {
      const ctx = await loadFixture(quorumReady);
      await ctx.ledger.revokeVet(ctx.vet.address);
      expect(await ctx.ledger.isCertifiedVet(ctx.vet.address)).to.equal(false);
      const deadline = (await time.latest()) + 3600;
      const sig = await sign(ctx, ctx.vet, { deadline });
      await expect(ctx.ledger.settleLivestockClaim(1, true, deadline, sig)).to.be.revertedWithCustomError(ctx.ledger, "InvalidVet");
    });

    it("an expired licence no longer counts", async () => {
      const ctx = await loadFixture(quorumReady);
      await time.increase(366 * DAY);
      const deadline = (await time.latest()) + 3600;
      const sig = await sign(ctx, ctx.vet, { deadline });
      await expect(ctx.ledger.settleLivestockClaim(1, true, deadline, sig)).to.be.revertedWithCustomError(ctx.ledger, "InvalidVet");
    });

    it("a bare role grant without certification cannot sign", async () => {
      const ctx = await loadFixture(quorumReady);
      await ctx.ledger.grantRole(await ctx.ledger.VET_ROLE(), ctx.outsider.address);
      const deadline = (await time.latest()) + 3600;
      const sig = await sign(ctx, ctx.outsider, { deadline });
      await expect(ctx.ledger.settleLivestockClaim(1, true, deadline, sig)).to.be.revertedWithCustomError(ctx.ledger, "InvalidVet");
    });

    it("2-of-3: one signature records progress but does not pay", async () => {
      const ctx = await twoOfThree();
      const { ledger, token, vet, farmer } = ctx;
      const deadline = (await time.latest()) + 3600;
      const before = await token.balanceOf(farmer.address);
      await expect(ledger.settleLivestockClaim(1, true, deadline, await sign(ctx, vet, { deadline })))
        .to.emit(ledger, "ClaimAttested").withArgs(1, vet.address, true, 1, 0);
      expect(await token.balanceOf(farmer.address)).to.equal(before);
      const c = await ledger.getClaim(1);
      expect(c.status).to.equal(ClaimStatus.Pending);
      expect(c.quorum).to.equal(2);
      expect(c.approvals).to.equal(1);
      expect(await ledger.hasAttested(1, vet.address)).to.equal(true);
    });

    it("2-of-3: the second distinct vet triggers the payout", async () => {
      const ctx = await twoOfThree();
      const { ledger, token, vet, vet2, farmer } = ctx;
      const deadline = (await time.latest()) + 3600;
      await ledger.settleLivestockClaim(1, true, deadline, await sign(ctx, vet, { deadline }));
      const before = await token.balanceOf(farmer.address);
      await expect(ledger.settleLivestockClaim(1, true, deadline, await sign(ctx, vet2, { deadline })))
        .to.emit(ledger, "PayoutExecuted");
      expect(await token.balanceOf(farmer.address)).to.equal(before + 300_000n);
      expect((await ledger.getClaim(1)).status).to.equal(ClaimStatus.Approved);
      expect((await ledger.getAnimal(1)).deceased).to.equal(true);
    });

    it("the same vet cannot sign twice to reach the quorum", async () => {
      const ctx = await twoOfThree();
      const { ledger, vet } = ctx;
      const d1 = (await time.latest()) + 3600, d2 = d1 + 10;
      await ledger.settleLivestockClaim(1, true, d1, await sign(ctx, vet, { deadline: d1 }));
      await expect(ledger.settleLivestockClaim(1, true, d2, await sign(ctx, vet, { deadline: d2 })))
        .to.be.revertedWithCustomError(ledger, "AlreadyAttested");
      expect((await ledger.getClaim(1)).status).to.equal(ClaimStatus.Pending);
    });

    it("2-of-3: two rejections close the claim and keep the policy active", async () => {
      const ctx = await twoOfThree();
      const { ledger, vet, vet2, token, farmer } = ctx;
      const deadline = (await time.latest()) + 3600;
      const before = await token.balanceOf(farmer.address);
      await ledger.settleLivestockClaim(1, false, deadline, await sign(ctx, vet, { deadline, approved: false }));
      await ledger.settleLivestockClaim(1, false, deadline, await sign(ctx, vet2, { deadline, approved: false }));
      expect((await ledger.getClaim(1)).status).to.equal(ClaimStatus.Rejected);
      expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.Active);
      expect(await token.balanceOf(farmer.address)).to.equal(before);
    });

    it("split votes: one approve + one reject leaves the claim open for the third vet", async () => {
      const ctx = await twoOfThree();
      const { ledger, vet, vet2, vet3 } = ctx;
      const deadline = (await time.latest()) + 3600;
      await ledger.settleLivestockClaim(1, true, deadline, await sign(ctx, vet, { deadline }));
      await ledger.settleLivestockClaim(1, false, deadline, await sign(ctx, vet2, { deadline, approved: false }));
      expect((await ledger.getClaim(1)).status).to.equal(ClaimStatus.Pending);
      await ledger.settleLivestockClaim(1, true, deadline, await sign(ctx, vet3, { deadline }));
      expect((await ledger.getClaim(1)).status).to.equal(ClaimStatus.Approved);
    });

    it("changing the quorum later does not affect a claim already filed", async () => {
      const ctx = await twoOfThree();
      await ctx.ledger.setVetQuorum(1);
      expect((await ctx.ledger.getClaim(1)).quorum).to.equal(2);
      const deadline = (await time.latest()) + 3600;
      await ctx.ledger.settleLivestockClaim(1, true, deadline, await sign(ctx, ctx.vet, { deadline }));
      expect((await ctx.ledger.getClaim(1)).status).to.equal(ClaimStatus.Pending);
    });
  });

  // ------------------------------------------------------------------ USSD claims agent + application record
  describe("Claims agent (USSD) and application record", function () {
    async function setup() {
      const ctx = await farmerFixture();
      await ctx.ledger.connect(ctx.farmer).buyPolicy(4, 1, 300_000); // policy 1: cattle
      await ctx.ledger.connect(ctx.farmer).buyPolicy(1, 1, 100_000); // policy 2: drought on plot 1
      await ctx.ledger.grantRole(await ctx.ledger.CLAIMS_AGENT_ROLE(), ctx.outsider.address);
      return { ...ctx, agent: ctx.outsider };
    }

    it("lets the agent register a claim for the holder once the waiting period has passed", async () => {
      const { ledger, agent, farmer } = await loadFixture(setup);
      await time.increase(8 * DAY);
      await expect(ledger.connect(agent).fileClaimFor(1, hash("ussd-report")))
        .to.emit(ledger, "ClaimFiled").withArgs(1, 1, farmer.address, b32("RW-TAG-0001"), hash("ussd-report"))
        .and.to.emit(ledger, "ClaimChannel").withArgs(1, agent.address, true);
      expect((await ledger.getClaim(1)).status).to.equal(ClaimStatus.Pending);
      expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.ClaimPending);
    });

    it("still enforces every eligibility rule for agent-registered claims", async () => {
      const { ledger, agent } = await loadFixture(setup);
      await expect(ledger.connect(agent).fileClaimFor(1, hash("x"))).to.be.revertedWithCustomError(ledger, "WaitingPeriodNotElapsed");
      await time.increase(8 * DAY);
      await expect(ledger.connect(agent).fileClaimFor(2, hash("x"))).to.be.revertedWithCustomError(ledger, "WrongAssetType");
      await expect(ledger.connect(agent).fileClaimFor(99, hash("x"))).to.be.revertedWithCustomError(ledger, "NotPolicyHolder");
      await expect(ledger.connect(agent).fileClaimFor(1, ethers.ZeroHash)).to.be.revertedWithCustomError(ledger, "InvalidInput");
      await ledger.connect(agent).fileClaimFor(1, hash("x"));
      await expect(ledger.connect(agent).fileClaimFor(1, hash("y"))).to.be.revertedWithCustomError(ledger, "PolicyNotActive");
    });

    it("rejects fileClaimFor from anyone without the claims-agent role, even the policy holder", async () => {
      const { ledger, farmer, farmer2, vet, admin } = await loadFixture(setup);
      await time.increase(8 * DAY);
      for (const who of [farmer, farmer2, vet, admin]) {
        await expect(ledger.connect(who).fileClaimFor(1, hash("x"))).to.be.revertedWithCustomError(ledger, "AccessControlUnauthorizedAccount");
      }
    });

    it("gives the agent no way to book, change or settle anything", async () => {
      const { ledger, agent, token } = await loadFixture(setup);
      const policiesBefore = await ledger.policyCount();
      await expect(ledger.connect(agent).buyPolicy(4, 1, 1000)).to.be.revertedWithCustomError(ledger, "NotRegistered");
      await expect(ledger.connect(agent).createProduct(Cover.Livestock, 0, 500, 365)).to.be.reverted;
      await expect(ledger.connect(agent).certifyVet(agent.address, ethers.id("L"), b32("X"), (await time.latest()) + 1000)).to.be.reverted;
      await expect(ledger.connect(agent).setVetQuorum(1)).to.be.reverted;
      await expect(ledger.connect(agent).postReading(1, Metric.Rainfall, 0, await time.latest())).to.be.reverted;
      await time.increase(8 * DAY);
      await ledger.connect(agent).fileClaimFor(1, hash("x"));
      const deadline = (await time.latest()) + 3600;
      const sig = await signAttestation(agent, ledger, { claimId: 1, policyId: 1, tagId: b32("RW-TAG-0001"), approved: true, deadline });
      await expect(ledger.connect(agent).settleLivestockClaim(1, true, deadline, sig)).to.be.revertedWithCustomError(ledger, "InvalidVet");
      expect(await ledger.policyCount()).to.equal(policiesBefore);
    });

    it("anchors an application hash to a policy: holder only, once, non-zero", async () => {
      const { ledger, farmer, farmer2 } = await loadFixture(setup);
      const h = hash("application-1");
      await expect(ledger.connect(farmer2).recordApplication(1, h)).to.be.revertedWithCustomError(ledger, "NotPolicyHolder");
      await expect(ledger.connect(farmer).recordApplication(1, ethers.ZeroHash)).to.be.revertedWithCustomError(ledger, "InvalidInput");
      await expect(ledger.connect(farmer).recordApplication(1, h)).to.emit(ledger, "ApplicationRecorded").withArgs(1, farmer.address, h);
      expect(await ledger.applicationHashOf(1)).to.equal(h);
      expect(await ledger.applicationHashOf(2)).to.equal(ethers.ZeroHash);
      await expect(ledger.connect(farmer).recordApplication(1, hash("other"))).to.be.revertedWithCustomError(ledger, "ApplicationAlreadyRecorded");
    });

    it("a holder filing through the web still works and is marked as a direct claim", async () => {
      const { ledger, farmer } = await loadFixture(setup);
      await time.increase(8 * DAY);
      await expect(ledger.connect(farmer).fileClaim(1, hash("web")))
        .to.emit(ledger, "ClaimChannel").withArgs(1, farmer.address, false);
    });
  });

  // ------------------------------------------------------------------ admin / security
  describe("Governance and security (NFR-03, NFR-06)", function () {
    it("only the admin can pause, and pausing blocks state changes", async () => {
      const { ledger, farmer, outsider } = await loadFixture(farmerFixture);
      await expect(ledger.connect(outsider).pause())
        .to.be.revertedWithCustomError(ledger, "AccessControlUnauthorizedAccount");
      await ledger.pause();
      await expect(ledger.connect(farmer).buyPolicy(1, 1, 1000))
        .to.be.revertedWithCustomError(ledger, "EnforcedPause");
      await ledger.unpause();
      await expect(ledger.connect(farmer).buyPolicy(1, 1, 1000)).to.emit(ledger, "PolicyPurchased");
    });

    it("only the admin changes the waiting period, within bounds", async () => {
      const { ledger, outsider } = await loadFixture(farmerFixture);
      await expect(ledger.connect(outsider).setWaitingPeriod(0))
        .to.be.revertedWithCustomError(ledger, "AccessControlUnauthorizedAccount");
      await expect(ledger.setWaitingPeriod(31 * DAY)).to.be.revertedWithCustomError(ledger, "InvalidInput");
      await expect(ledger.setWaitingPeriod(0)).to.emit(ledger, "WaitingPeriodChanged");
    });

    it("only the product's own underwriter can switch it off", async () => {
      const { ledger, admin } = await loadFixture(farmerFixture);
      await expect(ledger.connect(admin).setProductActive(1, false))
        .to.be.revertedWithCustomError(ledger, "NotOwner");
    });

    it("emits an event for every state transition (audit trail)", async () => {
      const { ledger, farmer, oracle } = await loadFixture(farmerFixture);
      const tx = await ledger.connect(farmer).buyPolicy(1, 1, 100_000);
      await expect(tx).to.emit(ledger, "PolicyPurchased");
      await expect(ledger.connect(oracle).postReading(1, Metric.Rainfall, 1, await time.latest()))
        .to.emit(ledger, "ReadingPosted").and.to.emit(ledger, "PayoutExecuted");
    });
  });
});
