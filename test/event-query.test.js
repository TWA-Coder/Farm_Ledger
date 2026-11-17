// services/event-query.js on a public network: events found through a scanner, read from the main provider, and
// remembered so a later lookup scans only the new blocks. The local node plays both providers here.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { queryEvents, _forget } = require("../services/event-query");

describe("Event lookups for the USSD service (event-query)", () => {
  let token, owner, other, scan, ranges;

  beforeEach(async () => {
    _forget();
    [owner, other] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("MockRWF")).deploy(true);
    await token.waitForDeployment();
    ranges = [];
    // the scanner: records each block range it is asked for
    scan = { getLogs: async (f) => { ranges.push([f.fromBlock, f.toBlock]); return ethers.provider.getLogs(f); } };
  });

  const mint = async (to) => (await token.mint(to, 1)).wait();
  const lookup = (filter, from) => queryEvents(token, filter, from, { scan, confirmations: 2 });

  it("finds events through the scanner and decodes them like queryFilter", async () => {
    const start = await ethers.provider.getBlockNumber();
    await mint(owner.address); await mint(other.address);
    const evs = await lookup(token.filters.Transfer(), start);
    expect(evs.map((e) => e.args.to)).to.deep.equal([owner.address, other.address]);
    expect(evs.map((e) => e.blockNumber)).to.deep.equal((await token.queryFilter(token.filters.Transfer(), start)).map((e) => e.blockNumber));
  });

  it("scans only the blocks after the last lookup, re-reading the unconfirmed ones, with no duplicates", async () => {
    const start = await ethers.provider.getBlockNumber();
    await mint(owner.address); await mint(owner.address); await mint(owner.address);
    expect(await lookup(token.filters.Transfer(), start)).to.have.length(3);
    const head1 = await ethers.provider.getBlockNumber();

    ranges = [];
    await mint(other.address);
    const evs = await lookup(token.filters.Transfer(), start);
    expect(evs).to.have.length(4);
    expect(new Set(evs.map((e) => `${e.blockNumber}:${e.index}`)).size).to.equal(4);
    // second lookup starts after the remembered (confirmed) part: head1 - 2 confirmations
    expect(ranges[0][0]).to.equal(head1 - 2 + 1);

    ranges = [];
    expect(await lookup(token.filters.Transfer(), start)).to.have.length(4); // nothing new: same answer
    expect(ranges[0][0]).to.be.greaterThan(start);
  });

  it("keeps filters apart (indexed arguments)", async () => {
    const start = await ethers.provider.getBlockNumber();
    await mint(owner.address); await mint(other.address); await mint(other.address);
    expect(await lookup(token.filters.Transfer(null, other.address), start)).to.have.length(2);
    expect(await lookup(token.filters.Transfer(null, owner.address), start)).to.have.length(1);
  });

  it("retries a refused scan request once instead of failing the lookup", async () => {
    const start = await ethers.provider.getBlockNumber();
    await mint(owner.address);
    let refusals = 1;
    const flaky = { getLogs: async (f) => { if (refusals-- > 0) throw new Error("could not coalesce error"); return ethers.provider.getLogs(f); } };
    expect(await queryEvents(token, token.filters.Transfer(), start, { scan: flaky, confirmations: 0 })).to.have.length(1);
  });

  it("without a scanner (local chain) it is a plain queryFilter", async () => {
    const start = await ethers.provider.getBlockNumber();
    await mint(owner.address);
    expect(await queryEvents(token, token.filters.Transfer(), start, { scan: null })).to.have.length(1);
  });
});
