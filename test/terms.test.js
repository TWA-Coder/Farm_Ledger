// Policy terms chosen at purchase: start date, cover length (pro-rated premium) and trigger level.
const { expect } = require("chai");
const { loadFixture, time, Metric, PolicyStatus, farmerFixture, hash, buyFor } = require("./helpers");

const DAY = 24 * 3600;

describe("Chosen policy terms (buyCover)", function () {
  it("buyPolicy still means: start now, full length, standard trigger", async () => {
    const { ledger, farmer } = await loadFixture(farmerFixture);
    await buyFor(ledger, farmer, 1, 1, 100_000);
    const p = await ledger.getPolicy(1);
    expect(p.level).to.equal(0);
    expect(p.threshold).to.equal(1500n);
    expect(p.end - p.start).to.equal(BigInt(120 * DAY));
    expect(p.premium).to.equal(await ledger.quotePremium(1, 100_000));
  });

  it("pro-rates the premium by cover length and enforces the allowed range", async () => {
    const { ledger, farmer } = await loadFixture(farmerFixture);
    // product 1: 10% for 120 days -> 60 days costs half
    expect(await ledger.quoteCover(1, 0, 100_000, 60)).to.equal(5_000n);
    expect(await ledger.quoteCover(1, 0, 100_000, 120)).to.equal(await ledger.quotePremium(1, 100_000));
    await expect(buyFor(ledger, farmer, 1, 1, 100_000, 0, 0, 29)).to.be.revertedWithCustomError(ledger, "InvalidCoverPeriod");
    await expect(buyFor(ledger, farmer, 1, 1, 100_000, 0, 0, 121)).to.be.revertedWithCustomError(ledger, "InvalidCoverPeriod");
    await buyFor(ledger, farmer, 1, 1, 100_000, 0, 0, 60);
    const p = await ledger.getPolicy(1);
    expect(p.premium).to.equal(5_000n);
    expect(p.end - p.start).to.equal(BigInt(60 * DAY));
  });

  it("accepts a future start within 90 days, never a past one, and ignores readings before the start", async () => {
    const { ledger, farmer, oracle } = await loadFixture(farmerFixture);
    const now = await time.latest();
    await expect(buyFor(ledger, farmer, 1, 1, 100_000, 0, now - 10, 60)).to.be.revertedWithCustomError(ledger, "InvalidStart");
    await expect(buyFor(ledger, farmer, 1, 1, 100_000, 0, now + 91 * DAY, 60)).to.be.revertedWithCustomError(ledger, "InvalidStart");
    const start = now + 10 * DAY;
    await buyFor(ledger, farmer, 1, 1, 100_000, 0, start, 60);
    expect((await ledger.getPolicy(1)).start).to.equal(BigInt(start));
    // a drought reading before the cover starts does not pay
    await ledger.connect(oracle).postReading(1, Metric.Rainfall, 500, await time.latest());
    expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.Active);
    // once the cover has started, it does
    await time.increaseTo(start + DAY);
    await ledger.connect(oracle).postReading(1, Metric.Rainfall, 500, await time.latest());
    expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.PaidOut);
  });

  it("livestock claims wait for the start date plus the waiting period", async () => {
    const { ledger, farmer } = await loadFixture(farmerFixture);
    const start = (await time.latest()) + 5 * DAY;
    await buyFor(ledger, farmer, 4, 1, 300_000, 0, start, 365);
    await time.increaseTo(start + 3 * DAY);
    await expect(ledger.connect(farmer).fileClaim(1, hash("photo"))).to.be.revertedWithCustomError(ledger, "WaitingPeriodNotElapsed");
    await time.increaseTo(start + 7 * DAY + 1);
    await expect(ledger.connect(farmer).fileClaim(1, hash("photo"))).to.emit(ledger, "ClaimFiled");
  });

  it("trigger levels: only the product's underwriter adds them, each policy keeps the level it bought", async () => {
    const { ledger, farmer, farmer2, underwriter, outsider, oracle } = await loadFixture(farmerFixture);
    await expect(ledger.connect(outsider).addTriggerLevel(1, 1200, 700)).to.be.revertedWithCustomError(ledger, "NotOwner");
    await expect(ledger.connect(underwriter).addTriggerLevel(4, 0, 300)).to.be.revertedWithCustomError(ledger, "WrongAssetType");
    await expect(ledger.connect(underwriter).addTriggerLevel(1, 1200, 700)).to.emit(ledger, "TriggerLevelAdded").withArgs(1, 1, 1200, 700);
    const levels = await ledger.getTriggerLevels(1);
    expect(levels.map((l) => [Number(l.threshold), Number(l.rateBps)])).to.deep.equal([[1500, 1000], [1200, 700]]);
    await expect(buyFor(ledger, farmer, 1, 1, 100_000, 2, 0, 120)).to.be.revertedWithCustomError(ledger, "UnknownTriggerLevel");

    // farmer chooses the stricter, cheaper level (pays only below 120 mm)
    await buyFor(ledger, farmer, 1, 1, 100_000, 1, 0, 120);
    expect((await ledger.getPolicy(1)).premium).to.equal(7_000n);
    // a second farmer's plot with the standard level, for comparison
    await ledger.connect(farmer2).registerPlot(-2_150_000, 30_150_000, 5000, hash("x").slice(0, 66), hash("plot-2"));
    await buyFor(ledger, farmer2, 1, 2, 100_000, 0, 0, 120);

    // 130 mm: below the standard 150 mm trigger, above the stricter 120 mm one
    await ledger.connect(oracle).postReading(1, Metric.Rainfall, 1300, await time.latest());
    await ledger.connect(oracle).postReading(2, Metric.Rainfall, 1300, await time.latest());
    expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.Active);
    expect((await ledger.getPolicy(2)).status).to.equal(PolicyStatus.PaidOut);
    // 110 mm pays the stricter level too
    await ledger.connect(oracle).postReading(1, Metric.Rainfall, 1100, await time.latest());
    expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.PaidOut);
  });
});
