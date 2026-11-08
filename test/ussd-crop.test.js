// USSD with the CropClaims contract: a farmer can report a crop loss (reviewed by the insurer) and follow it.
// The gateway still makes one kind of call only: fileClaimFor (on FarmLedger for cattle, on CropClaims for crops).
const { expect } = require("chai");
const { artifacts } = require("hardhat");
const { ethers, loadFixture, time, farmerFixture, buyFor } = require("./helpers");
const { createUssd } = require("../services/ussd-core");
const dbm = require("../web/server/db");

const PIN = "1234";
const ALINE = "250788000001";
const DAY = 86400;

describe("USSD crop loss claims", function () {
  let ctx, u, claims;

  async function fixture() {
    const base = await farmerFixture();
    const c = await (await ethers.getContractFactory("CropClaims")).deploy(base.ledgerAddr);
    await base.ledger.grantRole(await base.ledger.ASSESSOR_ROLE(), await c.getAddress());
    await base.ledger.grantRole(await base.ledger.CLAIMS_AGENT_ROLE(), base.outsider.address);
    return { ...base, claims: c };
  }

  beforeEach(async () => {
    ctx = await loadFixture(fixture);
    claims = ctx.claims;
    const abi = {
      ledger: (await artifacts.readArtifact("FarmLedger")).abi,
      token: (await artifacts.readArtifact("MockRWF")).abi,
      cropClaims: (await artifacts.readArtifact("CropClaims")).abi,
    };
    u = createUssd({ provider: ethers.provider, abi, ledgerAddress: ctx.ledgerAddr, cropClaimsAddress: await claims.getAddress(), agent: ctx.outsider, db: dbm.openIsolated() });
    await dial([PIN, PIN]);
  });

  async function dial(inputs) {
    const sessionId = "s-" + Math.random();
    let reply;
    for (let k = 0; k <= inputs.length; k++) reply = await u.handle({ sessionId, phoneNumber: "+" + ALINE, text: inputs.slice(0, k).join("*") });
    return reply;
  }

  it("lists crop and cattle cover, files a crop loss claim for the holder through the agent, and shows its review", async () => {
    await buyFor(ctx.ledger, ctx.farmer, 1, 1, 100_000); // 1 drought
    await buyFor(ctx.ledger, ctx.farmer, 4, 1, 300_000); // 2 cattle
    const menu = await dial(["2"]);
    expect(menu).to.match(/^CON Claim on which cover\?\n1\. RW-TAG-0001 \(policy #2\)\n2\. MAIZE 5,000m2 \(policy #1\)$/);
    expect(await dial(["2", "2"])).to.match(/^CON Report a crop loss on MAIZE 5,000m2 \(policy #1\)\?/);
    expect(await dial(["2", "2", "1"])).to.equal("CON Enter your PIN to confirm");
    expect(await dial(["2", "2", "1", PIN])).to.equal("END Loss claim #1 registered. The insurer's reviewers will assess it. Dial again and choose 3 to follow it.");

    const c = await claims.getClaim(1);
    expect(c.holder).to.equal(ctx.farmer.address);
    expect(c.status).to.equal(1n);
    expect((await dial(["2"])).split("\n")).to.have.length(2); // the crop policy is no longer offered while under review

    expect(await dial(["3"])).to.equal("CON Your claims:\n1. Loss #1 Being reviewed");
    expect(await dial(["3", "1"])).to.match(/^END Loss claim #1, policy #1\nFiled .*\nStatus: being reviewed\nApprovals: 0 of 1 needed$/);
    await claims.connect(ctx.underwriter).review(1, true, 40_000);
    expect(await dial(["3", "1"])).to.match(/Status: approved\n40,000 RWF paid to you$/);
  });

  it("needs the PIN, and cattle claims still follow the waiting period", async () => {
    await buyFor(ctx.ledger, ctx.farmer, 1, 1, 100_000);
    expect(await dial(["2", "1", "1", "0000"])).to.equal("END Wrong PIN.");
    expect(await claims.claimCount()).to.equal(0n);
    await buyFor(ctx.ledger, ctx.farmer, 4, 1, 300_000);
    expect(await dial(["2", "1"])).to.match(/^END Claims for this policy open on/);
    await time.increase(8 * DAY);
    expect(await dial(["2", "1", "1", PIN])).to.match(/^END Claim #1 registered\. A vet will verify it/);
  });

  it("every screen fits the 182-character USSD limit", async () => {
    await buyFor(ctx.ledger, ctx.farmer, 1, 1, 100_000);
    const seen = [];
    for (const a of [["2"], ["2", "1"], ["2", "1", "1"], ["2", "1", "1", PIN], ["3"], ["3", "1"]]) seen.push(await dial(a));
    for (const s of seen) expect(s.length, s).to.be.at.most(182);
  });
});
