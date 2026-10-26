const { expect }  = require("chai");
const { ethers }  = require("hardhat");
const { time }    = require("@nomicfoundation/hardhat-network-helpers");

// ──────────────────────────────────────────────────────────
//  FarmLedger – Comprehensive Unit Test Suite
// ──────────────────────────────────────────────────────────

// These tests target the removed farmer/harvest/loan contract. Keep them skipped
// until that separate API is restored; the active contract is FarmLedgerInsurance.
describe.skip("FarmLedger (legacy API)", function () {
  // Shared signers
  let admin, cooperative, lender, farmer1, farmer2, stranger;
  // Contract instance
  let farmLedger;

  // Role hash constants (mirroring the contract)
  let COOPERATIVE_ROLE;
  let LENDER_ROLE;
  let DEFAULT_ADMIN_ROLE;

  // ── Deploy a fresh contract before every test ───────────
  beforeEach(async function () {
    [admin, cooperative, lender, farmer1, farmer2, stranger] =
      await ethers.getSigners();

    const FarmLedgerFactory = await ethers.getContractFactory("FarmLedger");
    farmLedger = await FarmLedgerFactory.deploy();
    await farmLedger.waitForDeployment();

    COOPERATIVE_ROLE  = await farmLedger.COOPERATIVE_ROLE();
    LENDER_ROLE       = await farmLedger.LENDER_ROLE();
    DEFAULT_ADMIN_ROLE = await farmLedger.DEFAULT_ADMIN_ROLE();

    // Grant roles
    await farmLedger.connect(admin).grantRole(COOPERATIVE_ROLE, cooperative.address);
    await farmLedger.connect(admin).grantRole(LENDER_ROLE,      lender.address);
  });

  // ════════════════════════════════════════════════════════
  //  1. ROLE MANAGEMENT & FARMER REGISTRATION
  // ════════════════════════════════════════════════════════
  describe("Role Management & Farmer Registration", function () {

    it("1.1 – Deployer is granted DEFAULT_ADMIN_ROLE", async function () {
      expect(await farmLedger.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
    });

    it("1.2 – Admin can grant COOPERATIVE_ROLE to an address", async function () {
      expect(await farmLedger.hasRole(COOPERATIVE_ROLE, cooperative.address)).to.be.true;
    });

    it("1.3 – Admin can grant LENDER_ROLE to an address", async function () {
      expect(await farmLedger.hasRole(LENDER_ROLE, lender.address)).to.be.true;
    });

    it("1.4 – Admin registers a farmer and profile is stored correctly", async function () {
      await farmLedger.connect(admin).registerFarmer(
        farmer1.address, "Uwase Claudette", "COOP-KGL-001"
      );
      const profile = await farmLedger.getFarmer(farmer1.address);

      expect(profile.isRegistered).to.be.true;
      expect(profile.name).to.equal("Uwase Claudette");
      expect(profile.cooperativeId).to.equal("COOP-KGL-001");
      expect(profile.creditScore).to.equal(500n); // BASE_CREDIT_SCORE
    });

    it("1.5 – Registering the same farmer twice is rejected", async function () {
      await farmLedger.connect(admin).registerFarmer(
        farmer1.address, "Uwase Claudette", "COOP-KGL-001"
      );
      await expect(
        farmLedger.connect(admin).registerFarmer(
          farmer1.address, "Uwase Claudette", "COOP-KGL-001"
        )
      ).to.be.revertedWith("Farmer already registered");
    });

    it("1.6 – Non-admin CANNOT register a farmer", async function () {
      await expect(
        farmLedger.connect(stranger).registerFarmer(
          farmer2.address, "Hakizimana Jean", "COOP-KGL-002"
        )
      ).to.be.reverted;
    });

    it("1.7 – Registering with an empty name is rejected", async function () {
      await expect(
        farmLedger.connect(admin).registerFarmer(farmer1.address, "", "COOP-KGL-001")
      ).to.be.revertedWith("Name cannot be empty");
    });
  });

  // ════════════════════════════════════════════════════════
  //  2. HARVEST LOGGING
  // ════════════════════════════════════════════════════════
  describe("Harvest & Supply Chain Logging", function () {

    beforeEach(async function () {
      await farmLedger.connect(admin).registerFarmer(
        farmer1.address, "Uwase Claudette", "COOP-KGL-001"
      );
    });

    it("2.1 – Registered farmer can log a harvest batch", async function () {
      await farmLedger.connect(farmer1).logHarvest("maize", 3000);
      expect(await farmLedger.getTotalBatches()).to.equal(1n);
    });

    it("2.2 – Logged batch data is stored correctly", async function () {
      await farmLedger.connect(farmer1).logHarvest("coffee", 1500);
      const batch = await farmLedger.getHarvestBatch(0);

      expect(batch.farmer).to.equal(farmer1.address);
      expect(batch.cropType).to.equal("coffee");
      expect(batch.volumeKg).to.equal(1500n);
      expect(batch.isVerified).to.be.false;
    });

    it("2.3 – Logging emits HarvestLogged event with correct args", async function () {
      await expect(farmLedger.connect(farmer1).logHarvest("beans", 800))
        .to.emit(farmLedger, "HarvestLogged")
        .withArgs(0, farmer1.address, "beans", 800n);
    });

    it("2.4 – Unregistered address CANNOT log a harvest", async function () {
      await expect(
        farmLedger.connect(stranger).logHarvest("maize", 500)
      ).to.be.revertedWith("Farmer not registered");
    });

    it("2.5 – Logging with zero volume is rejected", async function () {
      await expect(
        farmLedger.connect(farmer1).logHarvest("maize", 0)
      ).to.be.revertedWith("Volume must be greater than zero");
    });
  });

  // ════════════════════════════════════════════════════════
  //  3. HARVEST VERIFICATION
  // ════════════════════════════════════════════════════════
  describe("Harvest Verification", function () {

    beforeEach(async function () {
      await farmLedger.connect(admin).registerFarmer(
        farmer1.address, "Uwase Claudette", "COOP-KGL-001"
      );
      await farmLedger.connect(farmer1).logHarvest("maize", 2000);
    });

    it("3.1 – Cooperative can verify a harvest batch", async function () {
      await farmLedger.connect(cooperative).verifyHarvest(0);
      const batch = await farmLedger.getHarvestBatch(0);
      expect(batch.isVerified).to.be.true;
      expect(batch.verifiedBy).to.equal(cooperative.address);
    });

    it("3.2 – Verifying updates totalVerifiedYieldKg", async function () {
      await farmLedger.connect(cooperative).verifyHarvest(0);
      const profile = await farmLedger.getFarmer(farmer1.address);
      expect(profile.totalVerifiedYieldKg).to.equal(2000n);
    });

    it("3.3 – Verifying a batch emits HarvestVerified event", async function () {
      await expect(farmLedger.connect(cooperative).verifyHarvest(0))
        .to.emit(farmLedger, "HarvestVerified")
        .withArgs(0, cooperative.address, 2000n);
    });

    it("3.4 – Non-cooperative CANNOT verify a batch", async function () {
      await expect(
        farmLedger.connect(stranger).verifyHarvest(0)
      ).to.be.reverted;
    });

    it("3.5 – Verifying the same batch twice is rejected", async function () {
      await farmLedger.connect(cooperative).verifyHarvest(0);
      await expect(
        farmLedger.connect(cooperative).verifyHarvest(0)
      ).to.be.revertedWith("Batch already verified");
    });

    it("3.6 – Verifying a non-existent batch ID is rejected", async function () {
      await expect(
        farmLedger.connect(cooperative).verifyHarvest(99)
      ).to.be.revertedWith("Invalid batch ID");
    });
  });

  // ════════════════════════════════════════════════════════
  //  4. DYNAMIC CREDIT SCORING
  // ════════════════════════════════════════════════════════
  describe("Credit Score – Dynamic Calculation", function () {

    beforeEach(async function () {
      await farmLedger.connect(admin).registerFarmer(
        farmer1.address, "Uwase Claudette", "COOP-KGL-001"
      );
    });

    it("4.1 – Newly registered farmer starts with BASE_CREDIT_SCORE (500)", async function () {
      const profile = await farmLedger.getFarmer(farmer1.address);
      expect(profile.creditScore).to.equal(500n);
    });

    it("4.2 – Verifying 2,000 kg adds +20 to credit score (2 x 10-point slots)", async function () {
      await farmLedger.connect(farmer1).logHarvest("maize", 2000);
      await farmLedger.connect(cooperative).verifyHarvest(0);
      const profile = await farmLedger.getFarmer(farmer1.address);
      // 500 + (2000/1000)*10 = 520
      expect(profile.creditScore).to.equal(520n);
    });

    it("4.3 – Credit score emits CreditScoreUpdated event on verification", async function () {
      await farmLedger.connect(farmer1).logHarvest("coffee", 5000);
      await expect(farmLedger.connect(cooperative).verifyHarvest(0))
        .to.emit(farmLedger, "CreditScoreUpdated")
        .withArgs(farmer1.address, 550n); // 500 + (5000/1000)*10 = 550
    });

    it("4.4 – Repaying a loan increases credit score by +50", async function () {
      // Setup: give farmer a credit score >= 400 (already 500), apply and full cycle
      const dueDateTs = (await time.latest()) + 86400 * 30; // 30 days
      await farmLedger.connect(farmer1).applyForLoan(1000, dueDateTs);
      await farmLedger.connect(lender).approveLoan(0);
      await farmLedger.connect(lender).disburseLoan(0);
      await farmLedger.connect(farmer1).repayLoan(0);

      const profile = await farmLedger.getFarmer(farmer1.address);
      // 500 + 0 (no yield) + 1*50 = 550
      expect(profile.creditScore).to.equal(550n);
    });

    it("4.5 – Defaulting on a loan decreases credit score by -100", async function () {
      const latestTs = await time.latest();
      const dueDateTs = latestTs + 60; // 60 seconds from now
      await farmLedger.connect(farmer1).applyForLoan(1000, dueDateTs);
      await farmLedger.connect(lender).approveLoan(0);
      await farmLedger.connect(lender).disburseLoan(0);

      // Advance time past due date
      await time.increase(120);

      await farmLedger.connect(lender).markLoanDefaulted(0);
      const profile = await farmLedger.getFarmer(farmer1.address);
      // 500 - 1*100 = 400
      expect(profile.creditScore).to.equal(400n);
    });

    it("4.6 – Credit score is capped at MAX (1000)", async function () {
      // Log 50,000 kg in a single batch → yield bonus = (50000/1000)*10 = 500 → 500+500 = 1000
      await farmLedger.connect(farmer1).logHarvest("maize", 50000);
      await farmLedger.connect(cooperative).verifyHarvest(0);
      const profile = await farmLedger.getFarmer(farmer1.address);
      expect(profile.creditScore).to.equal(1000n);
    });

    it("4.7 – Credit score cannot go below 0 (capped at 0)", async function () {
      // Register farmer with starting score 500, make them default 6 times
      // We'll apply, approve, and disburse all 6 loans FIRST while their score is 500.
      for (let i = 0; i < 6; i++) {
        const dueDateTs = (await time.latest()) + 60;
        await farmLedger.connect(farmer1).applyForLoan(100, dueDateTs);
        await farmLedger.connect(lender).approveLoan(i);
        await farmLedger.connect(lender).disburseLoan(i);
      }
      
      // Advance time past all due dates
      await time.increase(120);

      // Now default all 6 loans. Their penalty is 600. Base score is 500. Result should be 0.
      for (let i = 0; i < 6; i++) {
        await farmLedger.connect(lender).markLoanDefaulted(i);
      }

      const profile = await farmLedger.getFarmer(farmer1.address);
      // 500 - 600 -> capped at 0
      expect(profile.creditScore).to.equal(0n);
    });
  });

  // ════════════════════════════════════════════════════════
  //  5. LOAN APPLICATION
  // ════════════════════════════════════════════════════════
  describe("Loan Application", function () {

    beforeEach(async function () {
      await farmLedger.connect(admin).registerFarmer(
        farmer1.address, "Uwase Claudette", "COOP-KGL-001"
      );
    });

    it("5.1 – Registered farmer with sufficient score can apply for a loan", async function () {
      const dueDateTs = (await time.latest()) + 86400;
      await farmLedger.connect(farmer1).applyForLoan(5000, dueDateTs);
      expect(await farmLedger.getTotalLoans()).to.equal(1n);
    });

    it("5.2 – Loan application emits LoanApplied event", async function () {
      const dueDateTs = (await time.latest()) + 86400;
      await expect(farmLedger.connect(farmer1).applyForLoan(5000, dueDateTs))
        .to.emit(farmLedger, "LoanApplied")
        .withArgs(0, farmer1.address, 5000n);
    });

    it("5.3 – Loan data is stored correctly after application", async function () {
      const dueDateTs = (await time.latest()) + 86400;
      await farmLedger.connect(farmer1).applyForLoan(7500, dueDateTs);
      const loan = await farmLedger.getLoan(0);
      expect(loan.farmer).to.equal(farmer1.address);
      expect(loan.amount).to.equal(7500n);
      expect(loan.status).to.equal(0); // LoanStatus.Applied
    });

    it("5.4 – Unregistered address CANNOT apply for a loan", async function () {
      const dueDateTs = (await time.latest()) + 86400;
      await expect(
        farmLedger.connect(stranger).applyForLoan(5000, dueDateTs)
      ).to.be.revertedWith("Farmer not registered");
    });

    it("5.5 – Farmer with credit score < 400 CANNOT apply for a loan", async function () {
      // Default enough times to drop below 400 (need 2 defaults: 500-200=300)
      for (let i = 0; i < 2; i++) {
        const dueDateTs = (await time.latest()) + 60;
        await farmLedger.connect(farmer1).applyForLoan(100, dueDateTs);
        await farmLedger.connect(lender).approveLoan(i);
        await farmLedger.connect(lender).disburseLoan(i);
        await time.increase(90);
        await farmLedger.connect(lender).markLoanDefaulted(i);
      }
      // Score is now 500 - 200 = 300 → below MIN_CREDIT_FOR_LOAN
      const dueDateTs = (await time.latest()) + 86400;
      await expect(
        farmLedger.connect(farmer1).applyForLoan(1000, dueDateTs)
      ).to.be.revertedWith("Credit score too low");
    });

    it("5.6 – Applying with a due date in the past is rejected", async function () {
      const pastTs = (await time.latest()) - 1;
      await expect(
        farmLedger.connect(farmer1).applyForLoan(5000, pastTs)
      ).to.be.revertedWith("Due date must be in the future");
    });
  });

  // ════════════════════════════════════════════════════════
  //  6. LOAN APPROVAL & DISBURSEMENT
  // ════════════════════════════════════════════════════════
  describe("Loan Approval & Disbursement", function () {

    beforeEach(async function () {
      await farmLedger.connect(admin).registerFarmer(
        farmer1.address, "Uwase Claudette", "COOP-KGL-001"
      );
      const dueDateTs = (await time.latest()) + 86400 * 90;
      await farmLedger.connect(farmer1).applyForLoan(10000, dueDateTs);
    });

    it("6.1 – Lender can approve a loan in Applied status", async function () {
      await farmLedger.connect(lender).approveLoan(0);
      const loan = await farmLedger.getLoan(0);
      expect(loan.status).to.equal(1); // LoanStatus.Approved
      expect(loan.lender).to.equal(lender.address);
    });

    it("6.2 – approveLoan emits LoanApproved event", async function () {
      await expect(farmLedger.connect(lender).approveLoan(0))
        .to.emit(farmLedger, "LoanApproved")
        .withArgs(0, lender.address);
    });

    it("6.3 – Non-lender CANNOT approve a loan", async function () {
      await expect(
        farmLedger.connect(stranger).approveLoan(0)
      ).to.be.reverted;
    });

    it("6.4 – Approving an already-approved loan is rejected", async function () {
      await farmLedger.connect(lender).approveLoan(0);
      await expect(
        farmLedger.connect(lender).approveLoan(0)
      ).to.be.revertedWith("Loan is not in Applied status");
    });

    it("6.5 – Approving lender can disburse an approved loan", async function () {
      await farmLedger.connect(lender).approveLoan(0);
      await farmLedger.connect(lender).disburseLoan(0);
      const loan = await farmLedger.getLoan(0);
      expect(loan.status).to.equal(2); // LoanStatus.Disbursed
    });

    it("6.6 – disburseLoan emits LoanDisbursed event", async function () {
      await farmLedger.connect(lender).approveLoan(0);
      await expect(farmLedger.connect(lender).disburseLoan(0))
        .to.emit(farmLedger, "LoanDisbursed")
        .withArgs(0);
    });

    it("6.7 – A different lender CANNOT disburse a loan approved by another", async function () {
      // Grant LENDER_ROLE to a second lender address
      const [, , , , , , lender2] = await ethers.getSigners();
      await farmLedger.connect(admin).grantRole(LENDER_ROLE, lender2.address);

      await farmLedger.connect(lender).approveLoan(0);
      await expect(
        farmLedger.connect(lender2).disburseLoan(0)
      ).to.be.revertedWith("Only approving lender can disburse");
    });

    it("6.8 – Cannot disburse a loan that has NOT been approved", async function () {
      await expect(
        farmLedger.connect(lender).disburseLoan(0)
      ).to.be.revertedWith("Loan is not in Approved status");
    });
  });

  // ════════════════════════════════════════════════════════
  //  7. LOAN REPAYMENT
  // ════════════════════════════════════════════════════════
  describe("Loan Repayment", function () {

    beforeEach(async function () {
      await farmLedger.connect(admin).registerFarmer(
        farmer1.address, "Uwase Claudette", "COOP-KGL-001"
      );
      const dueDateTs = (await time.latest()) + 86400 * 90;
      await farmLedger.connect(farmer1).applyForLoan(10000, dueDateTs);
      await farmLedger.connect(lender).approveLoan(0);
      await farmLedger.connect(lender).disburseLoan(0);
    });

    it("7.1 – Borrower can repay a disbursed loan", async function () {
      await farmLedger.connect(farmer1).repayLoan(0);
      const loan = await farmLedger.getLoan(0);
      expect(loan.status).to.equal(3); // LoanStatus.Repaid
    });

    it("7.2 – repayLoan emits LoanRepaid event", async function () {
      await expect(farmLedger.connect(farmer1).repayLoan(0))
        .to.emit(farmLedger, "LoanRepaid")
        .withArgs(0, farmer1.address);
    });

    it("7.3 – loansRepaid counter increments after repayment", async function () {
      await farmLedger.connect(farmer1).repayLoan(0);
      const profile = await farmLedger.getFarmer(farmer1.address);
      expect(profile.loansRepaid).to.equal(1n);
    });

    it("7.4 – Non-borrower CANNOT repay someone else's loan", async function () {
      await expect(
        farmLedger.connect(stranger).repayLoan(0)
      ).to.be.revertedWith("Only the borrower can repay");
    });

    it("7.5 – Cannot repay a loan that is not in Disbursed status", async function () {
      await farmLedger.connect(farmer1).repayLoan(0); // now Repaid
      await expect(
        farmLedger.connect(farmer1).repayLoan(0)
      ).to.be.revertedWith("Loan is not in Disbursed status");
    });
  });

  // ════════════════════════════════════════════════════════
  //  8. LOAN DEFAULT
  // ════════════════════════════════════════════════════════
  describe("Loan Default", function () {

    beforeEach(async function () {
      await farmLedger.connect(admin).registerFarmer(
        farmer1.address, "Uwase Claudette", "COOP-KGL-001"
      );
      const dueDateTs = (await time.latest()) + 60; // 60 seconds
      await farmLedger.connect(farmer1).applyForLoan(10000, dueDateTs);
      await farmLedger.connect(lender).approveLoan(0);
      await farmLedger.connect(lender).disburseLoan(0);
    });

    it("8.1 – Lender can mark a past-due loan as defaulted", async function () {
      await time.increase(120); // advance past due date
      await farmLedger.connect(lender).markLoanDefaulted(0);
      const loan = await farmLedger.getLoan(0);
      expect(loan.status).to.equal(4); // LoanStatus.Defaulted
    });

    it("8.2 – markLoanDefaulted emits LoanDefaulted event", async function () {
      await time.increase(120);
      await expect(farmLedger.connect(lender).markLoanDefaulted(0))
        .to.emit(farmLedger, "LoanDefaulted")
        .withArgs(0, farmer1.address);
    });

    it("8.3 – loansDefaulted counter increments after default", async function () {
      await time.increase(120);
      await farmLedger.connect(lender).markLoanDefaulted(0);
      const profile = await farmLedger.getFarmer(farmer1.address);
      expect(profile.loansDefaulted).to.equal(1n);
    });

    it("8.4 – Cannot mark a loan as defaulted before the due date", async function () {
      // Do NOT advance time
      await expect(
        farmLedger.connect(lender).markLoanDefaulted(0)
      ).to.be.revertedWith("Loan is not past due date");
    });

    it("8.5 – Non-lender CANNOT mark a loan as defaulted", async function () {
      await time.increase(120);
      await expect(
        farmLedger.connect(stranger).markLoanDefaulted(0)
      ).to.be.reverted;
    });
  });

  // ════════════════════════════════════════════════════════
  //  9. MULTI-FARMER ISOLATION
  // ════════════════════════════════════════════════════════
  describe("Multi-Farmer Data Isolation", function () {

    it("9.1 – Multiple farmers can be registered independently", async function () {
      await farmLedger.connect(admin).registerFarmer(farmer1.address, "Alice", "COOP-A");
      await farmLedger.connect(admin).registerFarmer(farmer2.address, "Bob",   "COOP-B");

      const p1 = await farmLedger.getFarmer(farmer1.address);
      const p2 = await farmLedger.getFarmer(farmer2.address);
      expect(p1.name).to.equal("Alice");
      expect(p2.name).to.equal("Bob");
    });

    it("9.2 – Verifying Farmer A's harvest does not affect Farmer B's credit score", async function () {
      await farmLedger.connect(admin).registerFarmer(farmer1.address, "Alice", "COOP-A");
      await farmLedger.connect(admin).registerFarmer(farmer2.address, "Bob",   "COOP-B");

      await farmLedger.connect(farmer1).logHarvest("maize", 5000);
      await farmLedger.connect(cooperative).verifyHarvest(0);

      const p1 = await farmLedger.getFarmer(farmer1.address);
      const p2 = await farmLedger.getFarmer(farmer2.address);
      expect(p1.creditScore).to.equal(550n); // 500 + 50
      expect(p2.creditScore).to.equal(500n); // unchanged
    });
  });
});
