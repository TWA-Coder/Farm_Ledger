// USSD channel: monitoring and claim registration ONLY. Policy booking must be impossible from here.
const { expect } = require("chai");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { artifacts } = require("hardhat");
const { ethers, loadFixture, time, farmerFixture, signAttestation, b32, hash } = require("./helpers");
const { createUssd } = require("../services/ussd-core");

const PIN = "1234";
const ALINE = "250788000001"; // registered by farmerFixture (farmer), phone hash on-chain
const JEAN = "250788000002";  // registered, no assets
const STRANGER = "250788000777";
const DAY = 86400;

describe("USSD channel (monitoring and claim registration only)", function () {
  let ctx, u, agent, seen, usersFile;

  async function build(base) {
    const abi = {
      ledger: (await artifacts.readArtifact("FarmLedger")).abi,
      token: (await artifacts.readArtifact("MockRWF")).abi,
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ussd-"));
    usersFile = path.join(dir, "users.json");
    return createUssd({ provider: ethers.provider, abi, ledgerAddress: base.ledgerAddr, agent, usersFile });
  }

  beforeEach(async () => {
    const base = await loadFixture(farmerFixture);
    agent = base.outsider;
    await base.ledger.grantRole(await base.ledger.CLAIMS_AGENT_ROLE(), agent.address);
    u = await build(base);
    ctx = base;
    seen = [];
  });

  // Replays the answers one by one, exactly as the operator would, in a fresh session.
  async function dial(phone, inputs, sessionId = "s-" + Math.random()) {
    let reply;
    for (let k = 0; k <= inputs.length; k++) {
      reply = await u.handle({ sessionId, phoneNumber: "+" + phone, text: inputs.slice(0, k).join("*") });
      seen.push(reply);
    }
    return reply;
  }
  const withPin = (phone) => dial(phone, [PIN, PIN]);
  const buyCattle = () => ctx.ledger.connect(ctx.farmer).buyPolicy(4, 1, 300_000);
  const buyCrop = () => ctx.ledger.connect(ctx.farmer).buyPolicy(1, 1, 100_000);

  describe("who can use it", function () {
    it("tells an unregistered number to register on the web and offers nothing else", async () => {
      const r = await dial(STRANGER, []);
      expect(r).to.match(/^END /);
      expect(r).to.match(/not registered/i);
      expect(r).to.match(/website/i);
      expect(await dial(STRANGER, ["1"])).to.match(/^END .*not registered/i);
      expect(await ctx.ledger.policyCount()).to.equal(0n);
    });

    it("asks a registered farmer to choose a PIN on first use, then shows exactly three options", async () => {
      expect(await dial(ALINE, [])).to.match(/^CON Choose a 4-digit PIN/);
      const menu = await withPin(ALINE);
      expect(menu).to.equal("CON PIN saved.\nFarmLedger\n1. My policies\n2. Report a claim\n3. Claim status");
    });

    it("never offers registering, buying, adding assets, topping up or checking a balance", async () => {
      await withPin(ALINE);
      const menu = await dial(ALINE, []);
      expect(menu).to.not.match(/buy|purchase|register|add |land|balance|top|pay|book|activate/i);
    });

    it("rejects unknown menu choices, including the old buy/add/balance numbers", async () => {
      await withPin(ALINE);
      for (const c of ["4", "5", "0", "9", "buy"]) expect(await dial(ALINE, [c])).to.equal("END Invalid choice.");
    });
  });

  describe("policy monitoring", function () {
    beforeEach(async () => { await withPin(ALINE); });

    it("says so when there are no policies", async () => {
      expect(await dial(ALINE, ["1"])).to.match(/^END You have no policies yet/);
    });

    it("lists the caller's policies and shows details for the chosen one", async () => {
      await buyCattle(); await buyCrop();
      const list = await dial(ALINE, ["1"]);
      expect(list).to.match(/^CON Your policies:/);
      expect(list).to.match(/1\. #2 Drought Active/);
      expect(list).to.match(/2\. #1 Cattle death Active/);
      const detail = await dial(ALINE, ["1", "2"]);
      expect(detail).to.match(/^END Policy #1 Cattle death/);
      expect(detail).to.include("RW-TAG-0001");
      expect(detail).to.include("Cover 300,000 RWF");
      expect(detail).to.include("Premium 15,000 RWF");
      expect(detail).to.include("Status: Active");
    });

    it("never shows another farmer's policies", async () => {
      await buyCattle();
      await withPin(JEAN);
      expect(await dial(JEAN, ["1"])).to.match(/^END You have no policies yet/);
    });

    it("rejects an invalid selection", async () => {
      await buyCattle();
      expect(await dial(ALINE, ["1", "9"])).to.equal("END Invalid choice.");
    });
  });

  describe("claim registration", function () {
    beforeEach(async () => { await withPin(ALINE); });

    it("explains there is nothing to claim without cattle cover", async () => {
      expect(await dial(ALINE, ["2"])).to.match(/no active cattle cover/);
      await buyCrop();
      expect(await dial(ALINE, ["2"])).to.match(/pays by itself/);
    });

    it("refuses during the waiting period with the date it opens", async () => {
      await buyCattle();
      expect(await dial(ALINE, ["2", "1"])).to.match(/^END Claims for this policy open on \d{2}\/\d{2}\/\d{4}\./);
      expect(await ctx.ledger.claimCount()).to.equal(0n);
    });

    it("registers a claim through the agent after the waiting period, for the right holder", async () => {
      await buyCattle();
      await time.increase(8 * DAY);
      expect(await dial(ALINE, ["2", "1"])).to.match(/^CON Report death of RW-TAG-0001/);
      const r = await dial(ALINE, ["2", "1", "1", PIN]);
      expect(r).to.match(/^END Claim #1 registered\./);
      const claim = await ctx.ledger.getClaim(1);
      expect(claim.status).to.equal(1n);
      expect((await ctx.ledger.getPolicy(1)).status).to.equal(1n); // ClaimPending
      const logs = await ctx.ledger.queryFilter(ctx.ledger.filters.ClaimChannel(), 0, "latest");
      expect(logs[0].args.viaAgent).to.equal(true);
      expect(logs[0].args.filedBy).to.equal(agent.address);
      const filed = await ctx.ledger.queryFilter(ctx.ledger.filters.ClaimFiled(), 0, "latest");
      expect(filed[0].args.holder).to.equal(ctx.farmer.address);
    });

    it("needs the right PIN and locks the number after three wrong tries", async () => {
      await buyCattle();
      await time.increase(8 * DAY);
      expect(await dial(ALINE, ["2", "1", "1", "0000"])).to.equal("END Wrong PIN.");
      expect(await dial(ALINE, ["2", "1", "1", "1111"])).to.equal("END Wrong PIN.");
      expect(await dial(ALINE, ["2", "1", "1", "2222"])).to.match(/locked for 30 minutes/);
      expect(await dial(ALINE, ["2", "1", "1", PIN])).to.match(/locked for 30 minutes/);
      expect(await ctx.ledger.claimCount()).to.equal(0n);
    });

    it("cancels cleanly and does not file when the farmer answers No", async () => {
      await buyCattle();
      await time.increase(8 * DAY);
      expect(await dial(ALINE, ["2", "1", "2"])).to.equal("END Cancelled.");
      expect(await ctx.ledger.claimCount()).to.equal(0n);
    });

    it("does not repeat the claim when the network retries the same request", async () => {
      await buyCattle();
      await time.increase(8 * DAY);
      const sid = "retry-session", inputs = ["2", "1", "1", PIN];
      const first = await dial(ALINE, inputs, sid);
      const again = await u.handle({ sessionId: sid, phoneNumber: "+" + ALINE, text: inputs.join("*") });
      expect(again).to.equal(first);
      expect(await ctx.ledger.claimCount()).to.equal(1n);
    });

    it("cannot register a second claim on the same policy", async () => {
      await buyCattle();
      await time.increase(8 * DAY);
      await dial(ALINE, ["2", "1", "1", PIN]);
      expect(await dial(ALINE, ["2"])).to.match(/no active cattle cover/);
      expect(await ctx.ledger.claimCount()).to.equal(1n);
    });
  });

  describe("claim status tracking", function () {
    beforeEach(async () => { await withPin(ALINE); });

    it("says so when there are no claims", async () => {
      expect(await dial(ALINE, ["3"])).to.equal("END You have no claims.");
    });

    it("follows a claim from awaiting vets to approved and paid", async () => {
      await buyCattle();
      await time.increase(8 * DAY);
      await dial(ALINE, ["2", "1", "1", PIN]);

      expect(await dial(ALINE, ["3"])).to.match(/1\. #1 RW-TAG-0001 Awaiting vets/);
      const waiting = await dial(ALINE, ["3", "1"]);
      expect(waiting).to.include("Status: awaiting vets");
      expect(waiting).to.include("Signatures: 0 of 1 needed");

      const deadline = (await time.latest()) + 3600;
      const sig = await signAttestation(ctx.vet, ctx.ledger, { claimId: 1, policyId: 1, tagId: b32("RW-TAG-0001"), approved: true, deadline });
      await ctx.ledger.settleLivestockClaim(1, true, deadline, sig);

      expect(await dial(ALINE, ["3"])).to.match(/#1 RW-TAG-0001 Approved/);
      const paid = await dial(ALINE, ["3", "1"]);
      expect(paid).to.include("Status: approved");
      expect(paid).to.include("300,000 RWF paid to you");
    });

    it("shows a rejected claim and that the cover continues", async () => {
      await buyCattle();
      await time.increase(8 * DAY);
      await dial(ALINE, ["2", "1", "1", PIN]);
      const deadline = (await time.latest()) + 3600;
      const sig = await signAttestation(ctx.vet, ctx.ledger, { claimId: 1, policyId: 1, tagId: b32("RW-TAG-0001"), approved: false, deadline });
      await ctx.ledger.settleLivestockClaim(1, false, deadline, sig);
      const r = await dial(ALINE, ["3", "1"]);
      expect(r).to.include("Status: rejected");
      expect(r).to.include("Your cover continues.");
    });

    it("never shows another farmer's claims", async () => {
      await buyCattle();
      await time.increase(8 * DAY);
      await dial(ALINE, ["2", "1", "1", PIN]);
      await withPin(JEAN);
      expect(await dial(JEAN, ["3"])).to.equal("END You have no claims.");
    });
  });

  describe("policy booking and activation are impossible from USSD", function () {
    const FORBIDDEN = [
      "buyPolicy", "registerFarmer", "registerPlot", "registerAnimal", "createProduct", "setProductActive",
      "depositLiquidity", "withdrawLiquidity", "postReading", "settleLivestockClaim", "certifyVet", "revokeVet",
      "setVetQuorum", "grantRole", "recordApplication", "expirePolicy", "mint", "approve", "transfer",
      "sendTransaction", "signTypedData", "signMessage", "ethers.Wallet", "privateKey",
    ];

    it("the service code contains no call that books, pays, mints, signs or registers anything", () => {
      const src = fs.readFileSync(path.join(__dirname, "..", "services", "ussd-core.js"), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/ .*$/, "")).join("\n");
      // match real calls / property access, not words inside messages (e.g. "approved")
      for (const name of FORBIDDEN) {
        const esc = name.replace(/\./g, "\\.");
        expect(new RegExp(`\\.${esc}\\b|\\b${esc}\\s*\\(|\\b${esc}\\b(?=\\s*[:=,])`).test(src), `ussd-core.js must not reference ${name}`).to.equal(false);
      }
      expect(src.match(/fileClaimFor/g).length).to.be.greaterThan(0);
    });

    it("its only write path is fileClaimFor", () => {
      expect(u.writeSurface).to.deep.equal(["fileClaimFor"]);
      expect(u.agentAddress).to.equal(agent.address);
    });

    it("the gateway key itself cannot book a policy on-chain", async () => {
      await expect(ctx.ledger.connect(agent).buyPolicy(4, 1, 1000)).to.be.revertedWithCustomError(ctx.ledger, "NotRegistered");
      await expect(ctx.ledger.connect(agent).registerFarmer(hash("1199000000000001"), hash("250788000999"))).to.not.be.reverted; // anyone may register themselves...
      await expect(ctx.ledger.connect(agent).buyPolicy(4, 1, 1000)).to.be.reverted; // ...but still owns no animal, so cannot cover Aline's
    });

    it("no sequence of USSD inputs changes policies, assets, farmers or money", async () => {
      // Aline has cover and a PIN; Jean has a PIN and nothing; STRANGER is unknown.
      await buyCattle(); await buyCrop();
      await withPin(ALINE); await withPin(JEAN);
      const snap = async () => [
        await ctx.ledger.policyCount(), await ctx.ledger.plotCount(), await ctx.ledger.animalCount(), await ctx.ledger.claimCount(),
        await ctx.token.totalSupply(), await ctx.token.balanceOf(ctx.farmer.address), await ctx.token.balanceOf(ctx.farmer2.address),
        (await ctx.ledger.poolStats(ctx.underwriter.address)).balance,
      ];
      const before = await snap();

      const attempts = [
        [], ["1"], ["2"], ["3"], ["4"], ["5"], ["6"], ["0"], ["9"], ["*"], ["#"], ["buy"], ["register"], ["1*2*3"],
        ["1", "1"], ["1", "2"], ["2", "1"], ["2", "9"], ["2", "1", "1", "0000"], ["2", "1", "1", "9999"],
        ["2", "4", "1", "300000", "1", PIN], ["4", "2", "RW-TAG-9999", "1", "2022", PIN], ["4", "1", "1", "1", "5000", PIN],
        ["2", "1", "200000", "1", PIN], ["1", "1", "1", "1", "1"], ["5", "1"], ["3", "1"], ["3", "9"],
        ["2", "1", "1", "1234x"], ["2", "1", "1", "' OR 1=1 --"], ["2", "1", "1", "1".repeat(300)],
      ];
      for (const phone of [ALINE, JEAN, STRANGER]) for (const a of attempts) await dial(phone, a);
      expect(await snap()).to.deep.equal(before);
    });

    it("every screen fits the 182-character USSD limit", async () => {
      await buyCattle(); await buyCrop(); await withPin(ALINE);
      await time.increase(8 * DAY);
      for (const a of [[], ["1"], ["1", "1"], ["1", "2"], ["2"], ["2", "1"], ["2", "1", "1", PIN], ["3"], ["3", "1"], ["7"]]) await dial(ALINE, a);
      expect(seen.length).to.be.greaterThan(15);
      for (const s of seen) expect(s.length, s).to.be.at.most(182);
    });
  });
});
