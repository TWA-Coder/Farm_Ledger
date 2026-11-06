// PolicyDesk: farmers do not book cover. Underwriters appoint district agents, a registered farmer is assigned to one,
// the agent submits the application, the underwriter drafts the contract, the farmer accepts and pays.
// Also: the role separation that came with it (vet registrar, guardian, suspended underwriters).
const { expect } = require("chai");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { ethers, loadFixture, time, b32, hash, Cover, farmerFixture } = require("./helpers");

const BUG = b32("BUGESERA");
const NYA = b32("NYAGATARE");
const DAY = 86400;

async function deskFixture() {
  const base = await farmerFixture();
  const { ledger, token, admin, underwriter } = base;
  const s = await ethers.getSigners();
  const [agentA, agentB, agentC, uw2] = [s[16], s[17], s[18], s[19]];
  const desk = await (await ethers.getContractFactory("PolicyDesk")).deploy(base.ledgerAddr);
  await ledger.grantRole(await ledger.ISSUER_ROLE(), await desk.getAddress());
  await ledger.grantRole(await ledger.REGISTRAR_ROLE(), await desk.getAddress());
  // a second insurer with its own drought product (id 5)
  await ledger.grantRole(await ledger.UNDERWRITER_ROLE(), uw2.address);
  await token.mint(uw2.address, 2_000_000);
  await token.connect(uw2).approve(base.ledgerAddr, ethers.MaxUint256);
  await ledger.connect(uw2).depositLiquidity(1_000_000);
  await ledger.connect(uw2).createProduct(Cover.Drought, 1500, 900, 120);
  await desk.connect(underwriter).appointAgent(agentA.address, [BUG, NYA]);
  await desk.connect(underwriter).appointAgent(agentB.address, [BUG]);
  return { ...base, desk, agentA, agentB, agentC, uw2, admin };
}

describe("PolicyDesk (agent applications, underwriter contracts)", function () {
  describe("agents and assignment", function () {
    it("only an underwriter appoints agents, each agent belongs to one insurer", async () => {
      const { desk, agentA, agentC, outsider, uw2, underwriter } = await loadFixture(deskFixture);
      await expect(desk.connect(outsider).appointAgent(agentC.address, [BUG])).to.be.revertedWithCustomError(desk, "NotUnderwriter");
      await expect(desk.connect(uw2).appointAgent(agentA.address, [BUG])).to.be.revertedWithCustomError(desk, "AlreadyAgent");
      await expect(desk.connect(underwriter).appointAgent(underwriter.address, [BUG])).to.be.revertedWithCustomError(desk, "InvalidInput");
      await expect(desk.connect(uw2).appointAgent(agentC.address, [])).to.be.revertedWithCustomError(desk, "InvalidInput");
      expect((await desk.getAgent(agentA.address)).underwriter).to.equal(underwriter.address);
      expect(await desk.districtsOfAgent(agentA.address)).to.deep.equal([BUG, NYA]);
    });

    it("a farmer who joins is assigned to the active agent in their district with the fewest farmers", async () => {
      const { desk, farmer, farmer2, agentA, agentB, ledger, outsider } = await loadFixture(deskFixture);
      await expect(desk.connect(farmer).join(BUG)).to.emit(desk, "FarmerAssigned").withArgs(farmer.address, agentA.address, farmer.address);
      await desk.connect(farmer2).join(BUG); // agentA now has 1, agentB 0
      expect(await desk.agentOf(farmer2.address)).to.equal(agentB.address);
      await expect(desk.connect(farmer).join(BUG)).to.be.revertedWithCustomError(desk, "AlreadyJoined");
      await expect(desk.connect(outsider).join(BUG)).to.be.revertedWithCustomError(desk, "NotRegistered");
      await ledger.connect(outsider).registerFarmer(hash("id-3"), hash("ph-3"));
      await expect(desk.connect(outsider).join(b32("HUYE"))).to.emit(desk, "FarmerJoined").and.not.to.emit(desk, "FarmerAssigned");
      expect(await desk.agentOf(outsider.address)).to.equal(ethers.ZeroAddress); // waits for an agent
    });

    it("suspended agents get no new farmers", async () => {
      const { desk, farmer, agentA, agentB, underwriter } = await loadFixture(deskFixture);
      await desk.connect(underwriter).setAgentActive(agentA.address, false);
      await desk.connect(farmer).join(BUG);
      expect(await desk.agentOf(farmer.address)).to.equal(agentB.address);
    });

    it("reassignment: the farmer's insurer to its own agents, any insurer for a waiting farmer, governance always", async () => {
      const { desk, ledger, farmer, outsider, agentA, agentB, agentC, uw2, underwriter, admin } = await loadFixture(deskFixture);
      await desk.connect(uw2).appointAgent(agentC.address, [b32("HUYE")]);
      await desk.connect(farmer).join(BUG); // -> agentA (underwriter)
      await expect(desk.connect(uw2).reassign(farmer.address, agentC.address)).to.be.revertedWithCustomError(desk, "NotYourFarmer");
      await expect(desk.connect(underwriter).reassign(farmer.address, agentC.address)).to.be.revertedWithCustomError(desk, "NotYourAgent");
      await desk.connect(underwriter).reassign(farmer.address, agentB.address);
      expect((await desk.getAgent(agentA.address)).farmers).to.equal(0);
      expect((await desk.getAgent(agentB.address)).farmers).to.equal(1);
      await desk.connect(admin).reassign(farmer.address, agentC.address); // governance
      expect(await desk.agentOf(farmer.address)).to.equal(agentC.address);
      await ledger.connect(outsider).registerFarmer(hash("id-3"), hash("ph-3"));
      await desk.connect(outsider).join(b32("RUBAVU")); // nobody there
      await desk.connect(uw2).reassign(outsider.address, agentC.address);
      expect(await desk.agentOf(outsider.address)).to.equal(agentC.address);
    });

    it("an agent records plots and animals for their own farmers only", async () => {
      const { desk, ledger, farmer, farmer2, agentA, agentB } = await loadFixture(deskFixture);
      await desk.connect(farmer).join(BUG); // agentA
      await desk.connect(farmer2).join(BUG); // agentB
      await expect(desk.connect(agentA).registerPlotFor(farmer.address, -2_150_000, 30_150_000, 7000, b32("BEANS"), hash("g")))
        .to.emit(ledger, "PlotRegistered").withArgs(2, farmer.address, -2_150_000, 30_150_000, 7000, b32("BEANS"), hash("g"));
      await desk.connect(agentA).registerAnimalFor(farmer.address, b32("RW-TAG-0900"), b32("ANKOLE"), 2022, hash("photo"));
      expect((await ledger.getAnimal(2)).owner).to.equal(farmer.address);
      await expect(desk.connect(agentA).registerPlotFor(farmer2.address, 0, 0, 1, b32("X"), hash("g"))).to.be.revertedWithCustomError(desk, "NotYourFarmer");
      await expect(ledger.connect(agentA).registerPlotFor(farmer.address, 0, 0, 1, b32("X"), hash("g"))).to.be.revertedWithCustomError(ledger, "AccessControlUnauthorizedAccount");
    });
  });

  describe("application -> contract -> acceptance", function () {
    async function applied() {
      const ctx = await loadFixture(deskFixture);
      await ctx.desk.connect(ctx.farmer).join(BUG); // -> agentA
      await ctx.desk.connect(ctx.agentA).submitApplication(ctx.farmer.address, 1, 1, 200_000, 0, 0, 120, hash("form+documents"));
      return ctx;
    }

    it("only the farmer's agent submits, only to their own insurer's active products, with valid terms", async () => {
      const ctx = await loadFixture(deskFixture);
      const { desk, farmer, agentA, agentB, underwriter, ledger } = ctx;
      await desk.connect(farmer).join(BUG);
      await expect(desk.connect(agentB).submitApplication(farmer.address, 1, 1, 1, 0, 0, 120, hash("f"))).to.be.revertedWithCustomError(desk, "NotYourFarmer");
      await expect(desk.connect(agentA).submitApplication(farmer.address, 5, 1, 1, 0, 0, 120, hash("f"))).to.be.revertedWithCustomError(desk, "WrongUnderwriter");
      await expect(desk.connect(agentA).submitApplication(farmer.address, 1, 1, 1, 9, 0, 120, hash("f"))).to.be.revertedWithCustomError(ledger, "UnknownTriggerLevel");
      await expect(desk.connect(agentA).submitApplication(farmer.address, 1, 1, 1, 0, 0, 120, ethers.ZeroHash)).to.be.revertedWithCustomError(desk, "InvalidInput");
      await ledger.connect(underwriter).setProductActive(1, false);
      await expect(desk.connect(agentA).submitApplication(farmer.address, 1, 1, 1, 0, 0, 120, hash("f"))).to.be.revertedWithCustomError(desk, "BadStatus");
      await ledger.connect(underwriter).setProductActive(1, true);
      await desk.connect(underwriter).setAgentActive(agentA.address, false);
      await expect(desk.connect(agentA).submitApplication(farmer.address, 1, 1, 1, 0, 0, 120, hash("f"))).to.be.revertedWithCustomError(desk, "NotAgent");
    });

    it("the underwriter drafts the contract (terms may change, the price follows the product rate) and the farmer accepts", async () => {
      const { desk, ledger, token, farmer, agentA, underwriter } = await applied();
      expect((await desk.getApplication(1)).status).to.equal(1); // Submitted
      await expect(desk.connect(agentA).draftContract(1, 0, 150_000, 0, 90, hash("contract"))).to.be.revertedWithCustomError(desk, "NotUnderwriter");
      const tx = desk.connect(underwriter).draftContract(1, 0, 150_000, 0, 90, hash("contract"));
      await expect(tx).to.emit(desk, "ContractDrafted").withArgs(1, farmer.address, agentA.address, await ledger.quoteCover(1, 0, 150_000, 90), anyValue, hash("contract"));
      const a = await desk.getApplication(1);
      const mined = await ethers.provider.getBlock((await (await tx).wait()).blockNumber);
      expect(a.offerExpires).to.equal(BigInt(mined.timestamp + 14 * DAY));
      expect(a.status).to.equal(2); // Offered
      expect(a.sumInsured).to.equal(150_000n);
      expect(a.coverDays).to.equal(90);

      await expect(desk.connect(agentA).acceptOffer(1)).to.be.revertedWithCustomError(desk, "NotFarmerOfApplication"); // the agent can't accept
      const before = await token.balanceOf(farmer.address);
      await expect(desk.connect(farmer).acceptOffer(1)).to.emit(desk, "PolicyIssuedFromApplication").withArgs(1, 1, farmer.address)
        .and.to.emit(ledger, "ApplicationRecorded").withArgs(1, farmer.address, hash("contract"));
      const pol = await ledger.getPolicy(1);
      expect(pol.holder).to.equal(farmer.address);
      expect(pol.sumInsured).to.equal(150_000n);
      expect(before - (await token.balanceOf(farmer.address))).to.equal(a.premium);
      expect((await desk.getApplication(1)).policyId).to.equal(1n);
      await expect(desk.connect(farmer).acceptOffer(1)).to.be.revertedWithCustomError(desk, "BadStatus");
    });

    it("an offer expires after 14 days; it can be re-drafted before acceptance; the farmer can decline", async () => {
      const { desk, farmer, underwriter } = await applied();
      await desk.connect(underwriter).draftContract(1, 0, 200_000, 0, 120, hash("c1"));
      await time.increase(15 * DAY);
      await expect(desk.connect(farmer).acceptOffer(1)).to.be.revertedWithCustomError(desk, "OfferExpired");
      await desk.connect(underwriter).draftContract(1, 0, 200_000, 0, 120, hash("c2")); // a fresh offer
      await expect(desk.connect(farmer).declineOffer(1)).to.emit(desk, "OfferDeclined").withArgs(1, farmer.address);
      await expect(desk.connect(farmer).acceptOffer(1)).to.be.revertedWithCustomError(desk, "BadStatus");
    });

    it("the underwriter can reject with written reasons (hash); the other insurer cannot touch it", async () => {
      const { desk, farmer, agentA, underwriter, uw2 } = await applied();
      await expect(desk.connect(uw2).rejectApplication(1, hash("reasons"))).to.be.revertedWithCustomError(desk, "NotUnderwriter");
      await expect(desk.connect(uw2).draftContract(1, 0, 1, 0, 120, hash("c"))).to.be.revertedWithCustomError(desk, "NotUnderwriter");
      await expect(desk.connect(underwriter).rejectApplication(1, hash("reasons")))
        .to.emit(desk, "ApplicationRejected").withArgs(1, farmer.address, agentA.address, hash("reasons"));
      await expect(desk.connect(underwriter).draftContract(1, 0, 1, 0, 120, hash("c"))).to.be.revertedWithCustomError(desk, "BadStatus");
    });

    it("acceptance applies the subsidy, and fails (nothing issued) without the farmer's approval of the premium", async () => {
      const ctx = await applied();
      const { desk, ledger, token, farmer, underwriter } = ctx;
      const gov = (await ethers.getSigners())[12];
      await ledger.grantRole(await ledger.SUBSIDY_ROLE(), gov.address);
      await token.mint(gov.address, 100_000); await token.connect(gov).approve(ctx.ledgerAddr, ethers.MaxUint256);
      await ledger.connect(gov).fundSubsidy(100_000); await ledger.connect(gov).setSubsidy(4000, 0); await ledger.connect(gov).setSubsidyEligible(1, true);
      await desk.connect(underwriter).draftContract(1, 0, 200_000, 0, 120, hash("c"));
      await token.connect(farmer).approve(ctx.ledgerAddr, 0);
      await expect(desk.connect(farmer).acceptOffer(1)).to.be.reverted;
      expect(await ledger.policyCount()).to.equal(0n);
      await token.connect(farmer).approve(ctx.ledgerAddr, 12_000); // 60% of 20,000
      await expect(desk.connect(farmer).acceptOffer(1)).to.emit(ledger, "PremiumSubsidised").withArgs(1, farmer.address, 8_000, 12_000);
    });
  });

  describe("role separation (section 6)", function () {
    it("a suspended underwriter sells nothing new but can still withdraw its free funds", async () => {
      const { desk, ledger, farmer, underwriter, admin } = await applied2();
      await desk.connect(underwriter).draftContract(1, 0, 200_000, 0, 120, hash("c"));
      await ledger.connect(admin).revokeRole(await ledger.UNDERWRITER_ROLE(), underwriter.address);
      await expect(desk.connect(farmer).acceptOffer(1)).to.be.revertedWithCustomError(ledger, "ProductInactive");
      await expect(ledger.connect(underwriter).withdrawLiquidity(1_000)).to.emit(ledger, "LiquidityWithdrawn");
    });

    it("vets are certified by the vet registrar, not by governance alone; the guardian pauses, only governance unpauses", async () => {
      const { ledger, admin, outsider } = await loadFixture(deskFixture);
      const reg = (await ethers.getSigners())[14];
      await ledger.connect(admin).revokeRole(await ledger.VET_REGISTRAR_ROLE(), admin.address);
      const until = (await time.latest()) + 365 * DAY;
      await expect(ledger.connect(admin).certifyVet(outsider.address, hash("lic"), b32("HUYE"), until)).to.be.revertedWithCustomError(ledger, "AccessControlUnauthorizedAccount");
      await ledger.connect(admin).grantRole(await ledger.VET_REGISTRAR_ROLE(), reg.address);
      await expect(ledger.connect(reg).certifyVet(outsider.address, hash("lic"), b32("HUYE"), until)).to.emit(ledger, "VetCertified");

      const guardian = (await ethers.getSigners())[13];
      await ledger.connect(admin).grantRole(await ledger.PAUSER_ROLE(), guardian.address);
      await ledger.connect(guardian).pause();
      await expect(ledger.connect(guardian).unpause()).to.be.revertedWithCustomError(ledger, "AccessControlUnauthorizedAccount");
      await ledger.connect(admin).unpause();
      expect(await ledger.paused()).to.equal(false);
    });
  });

  async function applied2() {
    const ctx = await loadFixture(deskFixture);
    await ctx.desk.connect(ctx.farmer).join(BUG);
    await ctx.desk.connect(ctx.agentA).submitApplication(ctx.farmer.address, 1, 1, 200_000, 0, 0, 120, hash("form"));
    return ctx;
  }
});
