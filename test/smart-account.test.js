// Farmers on ERC-4337 smart accounts: no ETH, no seed phrase, fees paid by the FarmLedgerPaymaster.
// Uses the standard v0.7 EntryPoint and SimpleAccountFactory; operations are packed and signed exactly like the
// portal's smart-account signer does, then submitted with handleOps the way the bundler service does.
const { expect } = require("chai");
const { ethers, loadFixture, b32, hash, PolicyStatus, deployFixture } = require("./helpers");
const uo = require("../web/shared/userop");
const core = require("../web/server/documents-core");

async function aaFixture() {
  const base = await deployFixture();
  const [admin] = await ethers.getSigners();
  const entryPoint = await (await ethers.getContractFactory("EntryPoint")).deploy();
  const factory = await (await ethers.getContractFactory("SimpleAccountFactory")).deploy(await entryPoint.getAddress());
  const desk = await (await ethers.getContractFactory("PolicyDesk")).deploy(await base.ledger.getAddress());
  await base.ledger.grantRole(await base.ledger.ISSUER_ROLE(), await desk.getAddress());
  await base.ledger.grantRole(await base.ledger.REGISTRAR_ROLE(), await desk.getAddress());
  const agent = (await ethers.getSigners())[16];
  await desk.connect(base.underwriter).appointAgent(agent.address, [ethers.encodeBytes32String("BUGESERA")]);
  const paymaster = await (await ethers.getContractFactory("FarmLedgerPaymaster")).deploy(
    await entryPoint.getAddress(), [await base.ledger.getAddress(), await base.token.getAddress(), await desk.getAddress()], ethers.parseEther("0.05"));
  await paymaster.deposit({ value: ethers.parseEther("10") });
  const bundler = (await ethers.getSigners())[10];
  const owner = ethers.Wallet.createRandom();
  const sender = await factory["getAddress(address,uint256)"](owner.address, 0);
  return { ...base, admin, entryPoint, factory, paymaster, bundler, owner, sender, desk, agent };
}

async function send(ctx, calls, { deploy = false, signer = ctx.owner } = {}) {
  const { entryPoint, factory, paymaster, bundler, owner, sender } = ctx;
  const fee = await ethers.provider.getFeeData();
  const op = {
    sender,
    nonce: await entryPoint.getNonce(sender, 0),
    ...(deploy ? { factory: await factory.getAddress(), factoryData: uo.factoryData(owner.address, 0n) } : {}),
    callData: uo.encodeCalls(calls),
    callGasLimit: 1_500_000n, verificationGasLimit: deploy ? 600_000n : 150_000n, preVerificationGas: 60_000n,
    maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    paymaster: await paymaster.getAddress(), paymasterVerificationGasLimit: 150_000n, paymasterPostOpGasLimit: 0n,
  };
  const packed = uo.packUserOp(op);
  const userOpHash = await entryPoint.getUserOpHash(packed);
  packed.signature = await signer.signMessage(ethers.getBytes(userOpHash));
  const rc = await (await entryPoint.connect(bundler).handleOps([packed], bundler.address)).wait();
  const ev = rc.logs.map((l) => { try { return entryPoint.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
  return { rc, success: ev.find((e) => e.name === "UserOperationEvent").args.success, revert: ev.find((e) => e.name === "UserOperationRevertReason")?.args.revertReason };
}

describe("Farmer smart accounts (ERC-4337, sponsored fees)", function () {
  it("a new farmer with no ETH registers, adds a plot and buys cover; the paymaster pays", async () => {
    const ctx = await loadFixture(aaFixture);
    const { ledger, token, sender, paymaster, entryPoint } = ctx;
    const L = await ledger.getAddress(), T = await token.getAddress();
    expect(await ethers.provider.getCode(sender)).to.equal("0x");
    const depositBefore = await entryPoint.balanceOf(await paymaster.getAddress());

    // first operation also deploys the account
    let r = await send(ctx, [{ to: L, data: ledger.interface.encodeFunctionData("registerFarmer", [hash("1199512345678901"), hash("250788000003")]) }], { deploy: true });
    expect(r.success).to.equal(true);
    expect(await ethers.provider.getCode(sender)).to.not.equal("0x");
    expect((await ledger.getFarmer(sender)).exists).to.equal(true);
    expect(await ethers.provider.getBalance(sender)).to.equal(0n);

    // test funds, a plot, then approve + buy cover in ONE operation
    r = await send(ctx, [
      { to: T, data: token.interface.encodeFunctionData("mint", [sender, 100_000]) },
      { to: L, data: ledger.interface.encodeFunctionData("registerPlot", [-2_150_000, 30_150_000, 5000, b32("MAIZE"), hash("p")]) },
    ]);
    expect(r.success).to.equal(true);
    // the farmer joins (district), their agent applies, the underwriter drafts; the farmer accepts and pays in ONE op
    const { desk, agent, underwriter } = ctx;
    const D = await desk.getAddress();
    r = await send(ctx, [{ to: D, data: desk.interface.encodeFunctionData("join", [b32("BUGESERA")]) }]);
    expect(r.success).to.equal(true);
    expect(await desk.agentOf(sender)).to.equal(agent.address);
    await desk.connect(agent).submitApplication(sender, 1, 1, 100_000, 0, 0, 60, hash("form"));
    await desk.connect(underwriter).draftContract(1, 0, 100_000, 0, 60, hash("contract"));
    const premium = await ledger.quoteCover(1, 0, 100_000, 60);
    r = await send(ctx, [
      { to: T, data: token.interface.encodeFunctionData("approve", [L, premium]) },
      { to: D, data: desk.interface.encodeFunctionData("acceptOffer", [1]) },
    ]);
    expect(r.success).to.equal(true);
    const p = await ledger.getPolicy(1);
    expect(p.holder).to.equal(sender);
    expect(p.status).to.equal(PolicyStatus.Active);
    expect(await token.balanceOf(sender)).to.equal(100_000n - premium);
    // fees came out of the paymaster's deposit, never from the farmer
    expect(await entryPoint.balanceOf(await paymaster.getAddress())).to.be.lessThan(depositBefore);
    expect(await ethers.provider.getBalance(sender)).to.equal(0n);
  });

  it("contract errors come back as the FarmLedger revert reason", async () => {
    const ctx = await loadFixture(aaFixture);
    const r = await send(ctx, [{ to: await ctx.ledger.getAddress(), data: ctx.ledger.interface.encodeFunctionData("registerPlot", [-2_150_000, 30_150_000, 5000, b32("MAIZE"), hash("p")]) }], { deploy: true });
    expect(r.success).to.equal(false);
    expect(ctx.ledger.interface.parseError(r.revert).name).to.equal("NotRegistered");
  });

  it("the paymaster refuses calls to other contracts, and operations signed by someone else fail", async () => {
    const ctx = await loadFixture(aaFixture);
    const { entryPoint, outsider } = ctx;
    await expect(send(ctx, [{ to: outsider.address, data: "0x" }], { deploy: true }))
      .to.be.revertedWithCustomError(entryPoint, "FailedOpWithRevert"); // AA33: paymaster validation reverted
    await expect(send(ctx, [{ to: await ctx.ledger.getAddress(), data: "0x" }], { deploy: true, signer: ethers.Wallet.createRandom() }))
      .to.be.revertedWithCustomError(entryPoint, "FailedOp"); // AA24 signature error
  });

  it("document requests from a smart account are accepted only when signed by its on-chain owner", async () => {
    const ctx = await loadFixture(aaFixture);
    await send(ctx, [{ to: await ctx.ledger.getAddress(), data: ctx.ledger.interface.encodeFunctionData("registerFarmer", [hash("1"), hash("2")]) }], { deploy: true });
    const ownerOf = async (a) => ((await ethers.provider.getCode(a)) === "0x" ? null : new ethers.Contract(a, uo.ACCOUNT_ABI, ethers.provider).owner());
    const msg = core.message({ action: "list", applicant: ctx.sender, application: "11111111-aaaa-bbbb-cccc-222222222222", issued: 1 });
    expect(await core.verifyAccountSigner(msg, await ctx.owner.signMessage(msg), ctx.sender, ownerOf)).to.equal(ctx.sender);
    await expect(core.verifyAccountSigner(msg, await ethers.Wallet.createRandom().signMessage(msg), ctx.sender, ownerOf)).to.be.rejectedWith("does not match");
  });

  it("only the owner can change the sponsored targets", async () => {
    const { paymaster, outsider } = await loadFixture(aaFixture);
    await expect(paymaster.connect(outsider).setAllowedTarget(outsider.address, true)).to.be.reverted;
  });
});
