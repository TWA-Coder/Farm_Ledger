// The off-chain event index (web/server/indexer.js) that replaced the portal's scan of every log since block 0.
const { expect } = require("chai");
const { ethers, loadFixture, farmerFixture, b32, hash, buyFor } = require("./helpers");
const dbm = require("../web/server/db");
const indexer = require("../web/server/indexer");
const { encodeArgs, reviveArgs } = require("../web/shared/event-json");

describe("Event index", function () {
  let ctx, db;
  const sync = () => indexer.sync({ db, provider: ethers.provider, ledger: ctx.ledger });
  const names = () => indexer.events(db).map((e) => e.name);

  beforeEach(async () => {
    ctx = await loadFixture(farmerFixture);
    db = dbm.open(":memory:");
  });

  it("indexes every contract event in chain order with typed arguments", async () => {
    await sync();
    const evs = indexer.events(db);
    // what farmerFixture did: roles, liquidity, products, 2 farmers, 1 plot, 1 animal
    expect(evs.filter((e) => e.name === "FarmerRegistered")).to.have.length(2);
    expect(names()).to.include.members(["PlotRegistered", "AnimalRegistered", "ProductCreated"]);
    const plot = evs.find((e) => e.name === "PlotRegistered");
    expect(plot.args.plotId).to.equal(1n); // BigInt survives storage
    expect(plot.args.owner).to.equal(ctx.farmer.address);
    expect(plot.args.crop).to.equal(b32("MAIZE"));
    for (let i = 1; i < evs.length; i++) {
      expect(evs[i].block * 1e6 + evs[i].idx).to.be.greaterThan(evs[i - 1].block * 1e6 + evs[i - 1].idx);
    }
  });

  it("reads only new blocks on the next sync and never stores an event twice", async () => {
    const first = await sync();
    const before = indexer.events(db).length;
    expect((await sync()).added).to.equal(0);
    await ctx.ledger.connect(ctx.farmer2).registerPlot(-1_300_000, 30_300_000, 8000, b32("BEANS"), hash("geo-2"));
    const second = await sync();
    expect(second.added).to.equal(1);
    expect(second.block).to.be.greaterThan(first.block);
    expect(indexer.events(db)).to.have.length(before + 1);
  });

  it("concurrent syncs in one process share the work", async () => {
    const [a, b] = await Promise.all([sync(), sync()]);
    expect(a).to.equal(b);
    expect(new Set(indexer.events(db).map((e) => `${e.block}:${e.idx}`)).size).to.equal(indexer.events(db).length);
  });

  it("drops events from a chain that was reset and rebuilds from the new chain", async () => {
    const snap = await ethers.provider.send("evm_snapshot", []);
    await ctx.ledger.connect(ctx.farmer2).registerPlot(-1_300_000, 30_300_000, 8000, b32("BEANS"), hash("old-chain"));
    await sync();
    expect(indexer.events(db, { name: "PlotRegistered" })).to.have.length(2);

    await ethers.provider.send("evm_revert", [snap]); // same block numbers will now be mined again with new hashes
    await ctx.ledger.connect(ctx.farmer).registerAnimal(b32("RW-TAG-0002"), b32("ANKOLE"), 2022, hash("new-chain"));
    await sync();
    expect(indexer.events(db, { name: "PlotRegistered" })).to.have.length(1); // the reverted plot is gone
    expect(indexer.events(db, { name: "AnimalRegistered" })).to.have.length(2);
  });

  it("indexes the CropClaims contract's events in the same chain-ordered list", async () => {
    const claims = await (await ethers.getContractFactory("CropClaims")).deploy(await ctx.ledger.getAddress());
    await ctx.ledger.grantRole(await ctx.ledger.ASSESSOR_ROLE(), await claims.getAddress());
    await buyFor(ctx.ledger, ctx.farmer, 1, 1, 100_000);
    await claims.connect(ctx.farmer).fileClaim(1, hash("ev"), 0);
    await indexer.sync({ db, provider: ethers.provider, ledger: ctx.ledger, others: [claims] });
    const filed = indexer.events(db, { name: "CropClaimFiled" });
    expect(filed).to.have.length(1);
    expect(filed[0].args.policyId).to.equal(1n);
    const order = names();
    expect(order.indexOf("PolicyPurchased")).to.be.lessThan(order.indexOf("CropClaimFiled"));
    expect(order).to.include("AssessmentHold"); // the ledger event from the same transaction
  });

  it("BigInt arguments survive the JSON round trip to the browser", () => {
    const fragment = { inputs: [{ name: "amount" }, { name: "holder" }, { name: "automatic" }] };
    const json = JSON.parse(JSON.stringify(encodeArgs(fragment, [10n ** 30n, "0xabc", true])));
    expect(reviveArgs(json)).to.deep.equal({ amount: 10n ** 30n, holder: "0xabc", automatic: true });
  });
});
