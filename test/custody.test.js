// Key custody (services/custody.js): only the custody process holds the farmers' key secret, and it signs only the
// operations the insurance workflow needs. The USSD service uses it over HTTP (phone-accounts.js, `custody` option).
const { expect } = require("chai");
const crypto = require("crypto");
const http = require("http");
const { artifacts } = require("hardhat");
const { ethers, loadFixture, hash, farmerFixture } = require("./helpers");
const uo = require("../web/shared/userop");
const dbm = require("../web/server/db");
const { createPhoneAccounts } = require("../services/phone-accounts");
const { allowedCalls } = require("../services/custody");

describe("Key custody service", function () {
  let ctx, abi;

  async function fixture() {
    const base = await farmerFixture();
    const s = await ethers.getSigners();
    const entryPoint = await (await ethers.getContractFactory("EntryPoint")).deploy();
    const factory = await (await ethers.getContractFactory("SimpleAccountFactory")).deploy(await entryPoint.getAddress());
    const desk = await (await ethers.getContractFactory("PolicyDesk")).deploy(base.ledgerAddr);
    await base.ledger.grantRole(await base.ledger.ISSUER_ROLE(), await desk.getAddress());
    const paymaster = await (await ethers.getContractFactory("FarmLedgerPaymaster")).deploy(
      await entryPoint.getAddress(), [base.ledgerAddr, await base.token.getAddress(), await desk.getAddress()], ethers.parseEther("0.05"));
    await paymaster.deposit({ value: ethers.parseEther("5") });
    await desk.connect(base.underwriter).appointAgent(s[16].address, [ethers.encodeBytes32String("BUGESERA")]);
    const aa = { entryPoint: await entryPoint.getAddress(), accountFactory: await factory.getAddress(), paymaster: await paymaster.getAddress(), bundlerUrl: "unused" };
    return { ...base, entryPoint, desk, aa, relayer: s[10], treasury: s[14], agent: s[16] };
  }

  beforeEach(async () => {
    ctx = await loadFixture(fixture);
    abi = { ledger: (await artifacts.readArtifact("FarmLedger")).abi, token: (await artifacts.readArtifact("MockRWF")).abi, policyDesk: (await artifacts.readArtifact("PolicyDesk")).abi };
  });

  it("signs only the workflow's operations, and sends money only to the treasury", async () => {
    const tokenAddr = await ctx.token.getAddress(), deskAddr = await ctx.desk.getAddress();
    const check = allowedCalls({ abi, ledger: ctx.ledgerAddr, desk: deskAddr, token: tokenAddr, treasury: ctx.treasury.address });
    const L = new ethers.Interface(abi.ledger), T = new ethers.Interface(abi.token), D = new ethers.Interface(abi.policyDesk);
    const call = (to, i, fn, args) => ({ to, data: i.encodeFunctionData(fn, args) });
    expect(check([call(ctx.ledgerAddr, L, "registerFarmer", [hash("a"), hash("b")]), call(deskAddr, D, "join", [ethers.encodeBytes32String("HUYE")])])).to.equal(null);
    expect(check([call(tokenAddr, T, "approve", [ctx.ledgerAddr, 5]), call(deskAddr, D, "acceptOffer", [1])])).to.equal(null);
    expect(check([call(tokenAddr, T, "transfer", [ctx.treasury.address, 5])])).to.equal(null);
    expect(check([call(tokenAddr, T, "transfer", [ctx.outsider.address, 5])])).to.match(/transfer is not allowed to that address/);
    expect(check([call(tokenAddr, T, "approve", [ctx.outsider.address, 5])])).to.match(/approve is not allowed/);
    // a farmer signed in on the portal records their own farm and claims (same account as on USSD)
    expect(check([call(ctx.ledgerAddr, L, "registerPlot", [0, 0, 1, hash("x"), hash("y")])])).to.equal(null);
    expect(check([call(ctx.ledgerAddr, L, "fileClaim", [1, hash("evidence")])])).to.equal(null);
    // never the insurer's, the oracle's or the admin's operations, and no test money off the local chain
    expect(check([call(ctx.ledgerAddr, L, "postReading", [1, 0, 100, 1])])).to.match(/postReading is not allowed/);
    expect(check([call(ctx.ledgerAddr, L, "grantRole", [ethers.ZeroHash, ctx.outsider.address])])).to.match(/grantRole is not allowed/);
    expect(check([call(tokenAddr, T, "mint", [ctx.outsider.address, 5])])).to.match(/mint is not allowed/);
    expect(allowedCalls({ abi, ledger: ctx.ledgerAddr, desk: deskAddr, token: tokenAddr, treasury: ctx.treasury.address, local: true })([call(tokenAddr, T, "mint", [ctx.outsider.address, 5])])).to.equal(null);
    expect(check([call(deskAddr, D, "submitApplication", [ctx.outsider.address, 1, 1, 1, 0, 0, 120, hash("f")])])).to.match(/not allowed/);
    expect(check([{ to: ctx.outsider.address, data: "0x12345678" }])).to.match(/is not allowed/);
    expect(check([])).to.match(/1 to 4 calls/);
  });

  it("the USSD side registers a farmer through the custody service without ever holding the key secret", async () => {
    const db = dbm.open(":memory:");
    const transport = async (op) => {
      const rc = await (await ctx.entryPoint.connect(ctx.relayer).handleOps([uo.packUserOp(op)], ctx.relayer.address)).wait();
      const evs = rc.logs.map((l) => { try { return ctx.entryPoint.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
      return { success: evs.find((e) => e.name === "UserOperationEvent").args.success, reason: "0x", receipt: { transactionHash: rc.hash } };
    };
    const common = { db, provider: ethers.provider, aa: ctx.aa, ledgerAddress: ctx.ledgerAddr, deskAddress: await ctx.desk.getAddress(), abi, sendSms: async () => {}, transport };
    // the custody process: holds the secret, exposes /keys and /calls behind a token, refuses other operations
    const inside = createPhoneAccounts({ ...common, secret: crypto.randomBytes(32) });
    const check = allowedCalls({ abi, ledger: ctx.ledgerAddr, desk: await ctx.desk.getAddress(), token: await ctx.token.getAddress(), treasury: ctx.treasury.address });
    const TOKEN = "t".repeat(32);
    const server = http.createServer(async (req, res) => {
      let b = ""; for await (const c of req) b += c;
      const send = (code, j) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(j)); };
      if (req.headers["x-custody-token"] !== TOKEN) return send(401, { error: "bad custody token" });
      const j = JSON.parse(b);
      if (req.url === "/keys") return send(200, await inside.keyring.createKey(j.phone));
      const why = check(j.calls); if (why) return send(403, { error: `Refused by custody: ${why}.` });
      return send(200, { hash: (await inside.keyring.sendCalls(j.phone, j.calls)).hash });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      const outside = createPhoneAccounts({ ...common, custody: { url, token: TOKEN } });
      expect(() => outside.signerFor("250783000800")).to.throw(/custody/);
      const { account } = await outside.register("250783000800", hash("1199580000001111"), "BUGESERA");
      expect((await ctx.ledger.getFarmer(account)).exists).to.equal(true);
      expect(await ctx.desk.agentOf(account)).to.equal(ctx.agent.address);
      // a request to send the farmer's money elsewhere is refused by custody
      const T = new ethers.Interface(abi.token);
      await expect(outside.sendCalls("250783000800", [{ to: await ctx.token.getAddress(), data: T.encodeFunctionData("transfer", [ctx.outsider.address, 1]) }]))
        .to.be.rejectedWith("Refused by custody: transfer is not allowed to that address.");
      // and without the token custody answers nothing
      const bad = createPhoneAccounts({ ...common, custody: { url, token: "wrong-token-wrong-token" } });
      await expect(bad.register("250783000801", hash("1199580000002222"), null)).to.be.rejectedWith("bad custody token");
    } finally { server.close(); }
  });
});
