// Phase 6: Mobile Money. A farmer with a basic phone reviews the contract the underwriter drafted, pays it and gets
// paid, through USSD and MTN MoMo (services/payments.js); plus the MoMo Open API client (services/momo.js) against a
// local fake of MTN's API.
const { expect } = require("chai");
const crypto = require("crypto");
const http = require("http");
const { artifacts } = require("hardhat");
const { ethers, loadFixture, time, Metric, farmerFixture, b32 } = require("./helpers");
const uo = require("../web/shared/userop");
const dbm = require("../web/server/db");
const { createUssd } = require("../services/ussd-core");
const { createPhoneAccounts } = require("../services/phone-accounts");
const { createPayments } = require("../services/payments");
const { createSimulatedMomo, createMomo } = require("../services/momo");

const PHONE = "250783000700";
const PIN = "4321";
const DELAY = 5000;

async function fixture() {
  const base = await farmerFixture();
  const s = await ethers.getSigners();
  const entryPoint = await (await ethers.getContractFactory("EntryPoint")).deploy();
  const factory = await (await ethers.getContractFactory("SimpleAccountFactory")).deploy(await entryPoint.getAddress());
  const desk = await (await ethers.getContractFactory("PolicyDesk")).deploy(base.ledgerAddr);
  await base.ledger.grantRole(await base.ledger.ISSUER_ROLE(), await desk.getAddress());
  await base.ledger.grantRole(await base.ledger.REGISTRAR_ROLE(), await desk.getAddress());
  const paymaster = await (await ethers.getContractFactory("FarmLedgerPaymaster")).deploy(
    await entryPoint.getAddress(), [base.ledgerAddr, await base.token.getAddress(), await desk.getAddress()], ethers.parseEther("0.05"));
  await paymaster.deposit({ value: ethers.parseEther("10") });
  const gov = s[12];
  await base.ledger.grantRole(await base.ledger.SUBSIDY_ROLE(), gov.address);
  await base.token.mint(gov.address, 1_000_000);
  await base.token.connect(gov).approve(base.ledgerAddr, ethers.MaxUint256);
  await base.ledger.connect(gov).fundSubsidy(1_000_000);
  await base.ledger.connect(gov).setSubsidy(4000, 0);
  for (const id of [1, 4]) await base.ledger.connect(gov).setSubsidyEligible(id, true);
  await base.ledger.grantRole(await base.ledger.CLAIMS_AGENT_ROLE(), s[13].address);
  const agent = s[16];
  await desk.connect(base.underwriter).appointAgent(agent.address, [ethers.encodeBytes32String("BUGESERA")]);
  await desk.connect(base.farmer).join(ethers.encodeBytes32String("BUGESERA")); // Aline (web wallet) -> same agent
  const aa = { entryPoint: await entryPoint.getAddress(), accountFactory: await factory.getAddress(), paymaster: await paymaster.getAddress(), bundlerUrl: "unused" };
  return { ...base, entryPoint, relayer: s[10], agent, ussdAgent: s[13], treasury: s[14], aa, desk };
}

describe("Mobile Money (phone accounts, USSD, contracts drafted by the underwriter)", function () {
  let ctx, db, abi, accounts, payments, u, sms, clock, momo;

  const transport = (entryPoint, relayer) => async (op) => {
    const rc = await (await entryPoint.connect(relayer).handleOps([uo.packUserOp(op)], relayer.address)).wait();
    const evs = rc.logs.map((l) => { try { return entryPoint.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
    return { success: evs.find((e) => e.name === "UserOperationEvent").args.success, reason: evs.find((e) => e.name === "UserOperationRevertReason")?.args.revertReason || "0x", receipt: { transactionHash: rc.hash } };
  };
  const outbox = { enqueue: ({ phone, text }) => { sms.push({ phone, text }); return 1; } };

  beforeEach(async () => {
    ctx = await loadFixture(fixture);
    abi = { ledger: (await artifacts.readArtifact("FarmLedger")).abi, token: (await artifacts.readArtifact("MockRWF")).abi, policyDesk: (await artifacts.readArtifact("PolicyDesk")).abi };
    db = dbm.openIsolated();
    sms = []; clock = Date.now();
    const deskAddress = await ctx.desk.getAddress();
    accounts = createPhoneAccounts({ db, provider: ethers.provider, aa: ctx.aa, ledgerAddress: ctx.ledgerAddr, deskAddress, abi, secret: crypto.randomBytes(32),
      sendSms: async (phone, text) => { sms.push({ phone, text }); }, transport: transport(ctx.entryPoint, ctx.relayer), now: () => clock });
    momo = createSimulatedMomo({ db, now: () => clock, delayMs: DELAY });
    payments = createPayments({ db, provider: ethers.provider, ledgerAddress: ctx.ledgerAddr, tokenAddress: await ctx.token.getAddress(), deskAddress, abi, accounts, momo, outbox, treasury: ctx.treasury, now: () => clock });
    u = createUssd({ provider: ethers.provider, abi, ledgerAddress: ctx.ledgerAddr, deskAddress, agent: ctx.ussdAgent, accounts, payments, db });
    await accounts.register(PHONE, ethers.keccak256(ethers.toUtf8Bytes("1199580099990000")), "BUGESERA");
    await dial([PIN, PIN]); // choose the PIN
  });

  async function dial(inputs, phone = PHONE) {
    const sessionId = "s-" + Math.random();
    let reply;
    for (let k = 0; k <= inputs.length; k++) reply = await u.handle({ sessionId, phoneNumber: "+" + phone, text: inputs.slice(0, k).join("*") });
    return reply;
  }
  const account = async () => (await accounts.accountOf(PHONE)).account;
  async function settle(steps = 6) { for (let i = 0; i < steps; i++) { clock += DELAY; await payments.tick(); } }
  // the agent records the plot and applies; the underwriter drafts: application #n, offered
  async function offered(holder = null, sum = 200_000) {
    holder = holder || (await account());
    const plotTx = await (await ctx.desk.connect(ctx.agent).registerPlotFor(holder, -2_150_000, 30_150_000, 5000, b32("MAIZE"), ethers.id("g"))).wait();
    const plotId = Number(plotTx.logs.map((l) => { try { return ctx.ledger.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "PlotRegistered").args.plotId);
    await ctx.desk.connect(ctx.agent).submitApplication(holder, 1, plotId, sum, 0, 0, 120, ethers.id("form"));
    const id = Number(await ctx.desk.applicationCount());
    await ctx.desk.connect(ctx.underwriter).draftContract(id, 0, sum, 0, 120, ethers.id("contract"));
    return id;
  }

  it("registration with a district assigns the agent; the menu offers My offers and My agent", async () => {
    expect(await ctx.desk.agentOf((await account()))).to.equal(ctx.agent.address);
    expect(await ctx.desk.districtOf((await account()))).to.equal(b32("BUGESERA"));
    expect(await dial([])).to.equal("CON FarmLedger\n1. My policies\n2. Report a claim\n3. Claim status\n4. Reset PIN\n6. My offers\n7. My agent\n0. Ikinyarwanda");
    require("../web/server/contacts").put(ctx.agent.address, "250788000015", db);
    expect(await dial(["7"])).to.equal("END Your FarmLedger agent can be reached on +250788000015. They collect your details and apply for cover for you.");
    expect(await dial(["6"])).to.match(/^END You have no contract to review/);
  });

  it("USSD registration asks for the farm's province and district", async () => {
    const N = "250783000777";
    expect(await dial(["1", "1199580011112222"], N)).to.equal("CON Enter your full name, as on your ID:");
    expect(await dial(["1", "1199580011112222", "Uwase Diane"], N)).to.equal("CON Province of your farm:\n1. Kigali City\n2. Northern\n3. Southern\n4. Eastern\n5. Western");
    expect(await dial(["1", "1199580011112222", "Uwase Diane", "4"], N)).to.match(/^CON District:\n1\. Bugesera\n2\. Gatsibo/);
    expect(await dial(["1", "1199580011112222", "Uwase Diane", "4", "1"], N)).to.equal("CON Register Uwase Diane, ID ending 2222, farm in Bugesera, with this number?\n1. Yes\n2. No");
    await dial(["1", "1199580011112222", "Uwase Diane", "4", "1", "1"], N);
    const code = /code: (\d{6})/.exec(sms.filter((m) => m.phone === N).at(-1).text)[1];
    await dial([code], N);
    expect(await ctx.desk.agentOf((await accounts.accountOf(N)).account)).to.equal(ctx.agent.address);
  });

  it("the farmer reviews the drafted contract and pays by MoMo; the policy is issued with the subsidy", async () => {
    const id = await offered();
    expect(await dial(["6"])).to.equal(`CON Contracts to review:\n1. #${id} Drought 200,000 RWF`);
    expect(await dial(["6", "1"])).to.match(new RegExp(`^CON Contract #${id}: Drought, cover 200,000 RWF, 120 days from payment\.\nPremium 20,000, subsidy -8,000\. You pay 12,000\.\nValid to \\d{2}/\\d{2}/\\d{4}\n1\. Pay by MoMo\n2\. Decline$`));
    expect(await dial(["6", "1", "1", PIN])).to.equal("END Approve the MoMo payment of 12,000 RWF on your phone. Your policy is issued once it is paid; we will SMS you.");
    const [p] = (await payments.list());
    expect(p).to.deep.include({ kind: "premium", amount: 12_000, status: "pending" });
    await dial(["6", "1", "1", PIN]); // paying again while the first is pending does not charge twice
    expect((await payments.list())).to.have.length(1);
    const uwBefore = await ctx.ledger.poolBalance(ctx.underwriter.address);
    await settle();
    const done = (await payments.row(p.ref));
    expect(done.status).to.equal("fulfilled");
    expect((await ctx.desk.getApplication(id)).status).to.equal(5); // Issued
    const pol = await ctx.ledger.getPolicy(done.policy_id);
    expect(pol.holder).to.equal((await account()));
    expect(await ctx.ledger.applicationHashOf(done.policy_id)).to.equal(ethers.id("contract"));
    expect(await ctx.ledger.subsidyOf(done.policy_id)).to.equal(8_000n);
    expect(await ctx.token.balanceOf((await account()))).to.equal(0n);
    expect((await ctx.ledger.poolBalance(ctx.underwriter.address)) - uwBefore).to.equal(20_000n);
    expect(await dial(["6"])).to.match(/no contract to review/);
  });

  it("a declined payment issues nothing and tells the farmer", async () => {
    await offered();
    process.env.MOMO_SIM_FAIL = PHONE;
    try { await dial(["6", "1", "1", PIN]); await settle(); } finally { delete process.env.MOMO_SIM_FAIL; }
    expect((await payments.list())[0]).to.deep.include({ status: "failed", reason: "PAYER_DECLINED" });
    expect(await ctx.ledger.policyCount()).to.equal(0n);
    expect(sms.at(-1).text).to.match(/was not completed \(PAYER_DECLINED\)/);
  });

  it("if the offer is withdrawn while the farmer pays, the money is refunded by MoMo", async () => {
    const id = await offered();
    await dial(["6", "1", "1", PIN]);
    await ctx.desk.connect(ctx.underwriter).rejectApplication(id, ethers.id("reasons"));
    await settle(8);
    const [refund, premium] = (await payments.list());
    expect(premium).to.deep.include({ kind: "premium", status: "refunded" });
    expect(refund).to.deep.include({ kind: "refund", status: "paid", amount: 12_000 });
    expect(await ctx.token.balanceOf((await account()))).to.equal(0n);
    expect(sms.map((m) => m.text)).to.include("FarmLedger: 12,000 RWF refunded to your Mobile Money.");
  });

  it("the farmer can decline a contract from USSD", async () => {
    const id = await offered();
    expect(await dial(["6", "1", "2"])).to.match(/^CON Decline contract #\d+\?/);
    expect(await dial(["6", "1", "2", "1", PIN])).to.equal(`END Contract #${id} declined.`);
    expect((await ctx.desk.getApplication(id)).status).to.equal(4); // Declined
  });

  it("a farmer with their own wallet sees the contract on USSD and accepts it on the website", async () => {
    await offered(ctx.farmer.address);
    await dial([PIN, PIN], "250788000001");
    expect(await dial(["6", "1"], "250788000001")).to.match(/You pay 12,000\.[\s\S]*Accept and pay on the website\.$/);
  });

  it("a payout to a phone account is swept to the treasury and sent to the farmer's MoMo, exactly once", async () => {
    await offered();
    await dial(["6", "1", "1", PIN]);
    await settle();
    const { policy_id: policyId } = (await payments.list())[0];
    const plotId = Number((await ctx.ledger.getPolicy(policyId)).assetId);
    const tx = await ctx.ledger.connect(ctx.oracle).postReading(plotId, Metric.Rainfall, 800, await time.latest());
    expect(await ctx.token.balanceOf((await account()))).to.equal(200_000n);
    const ref = (await payments.startPayout({ holder: (await account()), amount: 200_000n, policyId, txHash: tx.hash }));
    expect((await payments.startPayout({ holder: (await account()), amount: 200_000n, policyId, txHash: tx.hash }))).to.equal(null);
    await settle();
    expect((await payments.row(ref))).to.deep.include({ kind: "payout", status: "paid", amount: 200_000 });
    expect(await ctx.token.balanceOf((await account()))).to.equal(0n);
    expect(await ctx.token.balanceOf(ctx.treasury.address)).to.equal(200_000n);
    expect(sms.at(-1).text).to.equal(`FarmLedger: 200,000 RWF sent to your MTN Mobile Money for policy #${policyId}.`);
  });

  it("farmers with their own wallet keep payouts as tokens (no MoMo transfer)", async () => {
    expect((await payments.startPayout({ holder: ctx.farmer.address, amount: 1n, policyId: 1, txHash: "0xabc" }))).to.equal(null);
  });
});

describe("MTN MoMo Open API client (against a local fake of MTN's API)", function () {
  let server, reqs, replies;
  before(async () => {
    server = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => { b += c; });
      req.on("end", () => {
        reqs.push({ method: req.method, url: req.url, headers: req.headers, body: b ? JSON.parse(b) : null });
        const r = replies.find((x) => x.match(req)) || { code: 404, body: {} };
        res.writeHead(r.code, { "Content-Type": "application/json" }); res.end(JSON.stringify(r.body));
      });
    });
    await new Promise((r) => server.listen(0, r));
  });
  after(() => server.close());

  const cfg = () => ({
    baseUrl: `http://127.0.0.1:${server.address().port}`, targetEnv: "sandbox", currency: "EUR", callbackUrl: null,
    collection: { key: "col-sub", user: "col-user", apiKey: "col-key" }, disbursement: { key: "dis-sub", user: "dis-user", apiKey: "dis-key" },
  });
  beforeEach(() => {
    reqs = [];
    replies = [
      { match: (q) => q.url === "/collection/token/", code: 200, body: { access_token: "tok-c", token_type: "access_token", expires_in: 3600 } },
      { match: (q) => q.url === "/disbursement/token/", code: 200, body: { access_token: "tok-d", expires_in: 3600 } },
      { match: (q) => q.url === "/collection/v1_0/requesttopay" && q.method === "POST", code: 202, body: {} },
      { match: (q) => q.url.startsWith("/collection/v1_0/requesttopay/"), code: 200, body: { status: "FAILED", reason: "NOT_ENOUGH_FUNDS", externalId: "x" } },
      { match: (q) => q.url === "/disbursement/v1_0/transfer" && q.method === "POST", code: 202, body: {} },
      { match: (q) => q.url.startsWith("/disbursement/v1_0/transfer/"), code: 200, body: { status: "SUCCESSFUL", financialTransactionId: "123456" } },
    ];
  });

  it("gets a token once, then sends request-to-pay with the documented headers and body", async () => {
    const m = createMomo(cfg());
    await m.requestToPay({ ref: "11111111-1111-4111-8111-111111111111", amount: 12000, phone: "250783000700", externalId: "premium-x", payerMessage: "pm", payeeNote: "pn" });
    await m.requestToPay({ ref: "22222222-2222-4222-8222-222222222222", amount: 1, phone: "250783000700", externalId: "premium-y", payerMessage: "pm", payeeNote: "pn" });
    expect(reqs.filter((q) => q.url === "/collection/token/")).to.have.length(1);
    expect(reqs[0].headers.authorization).to.equal("Basic " + Buffer.from("col-user:col-key").toString("base64"));
    expect(reqs[0].headers["ocp-apim-subscription-key"]).to.equal("col-sub");
    const pay = reqs[1];
    expect(pay.headers).to.include({ authorization: "Bearer tok-c", "x-reference-id": "11111111-1111-4111-8111-111111111111", "x-target-environment": "sandbox", "ocp-apim-subscription-key": "col-sub" });
    expect(pay.body).to.deep.equal({ amount: "12000", currency: "EUR", externalId: "premium-x", payer: { partyIdType: "MSISDN", partyId: "250783000700" }, payerMessage: "pm", payeeNote: "pn" });
  });

  it("reads payment and transfer status, including the failure reason", async () => {
    const m = createMomo(cfg());
    expect(await m.paymentStatus("r1")).to.deep.equal({ status: "FAILED", reason: "NOT_ENOUGH_FUNDS", financialTransactionId: null });
    await m.transfer({ ref: "r2", amount: 5, phone: "250783000700", externalId: "payout-1", payerMessage: "a", payeeNote: "b" });
    expect(reqs.find((q) => q.url === "/disbursement/v1_0/transfer").body.payee).to.deep.equal({ partyIdType: "MSISDN", partyId: "250783000700" });
    expect(await m.transferStatus("r2")).to.deep.include({ status: "SUCCESSFUL", financialTransactionId: "123456" });
  });

  it("marks server errors as temporary and a duplicate reference as 409", async () => {
    replies.unshift({ match: (q) => q.url === "/collection/v1_0/requesttopay" && q.method === "POST", code: 500, body: { message: "busy" } });
    const m = createMomo(cfg());
    const e1 = await m.requestToPay({ ref: "r", amount: 1, phone: "1", externalId: "e" }).catch((e) => e);
    expect(e1.transient).to.equal(true);
    replies[0] = { match: (q) => q.url === "/collection/v1_0/requesttopay" && q.method === "POST", code: 409, body: { code: "RESOURCE_ALREADY_EXIST" } };
    const e2 = await m.requestToPay({ ref: "r", amount: 1, phone: "1", externalId: "e" }).catch((e) => e);
    expect(e2.status).to.equal(409);
  });

  it("provisions a sandbox API user and key", async () => {
    replies.push({ match: (q) => q.url === "/v1_0/apiuser", code: 201, body: {} });
    replies.push({ match: (q) => /^\/v1_0\/apiuser\/[0-9a-f-]+\/apikey$/.test(q.url), code: 201, body: { apiKey: "new-key" } });
    const m = createMomo(cfg());
    const r = await m.provision("col-sub", "example.org");
    expect(r.apiKey).to.equal("new-key");
    const create = reqs.find((q) => q.url === "/v1_0/apiuser");
    expect(create.headers["x-reference-id"]).to.equal(r.user);
    expect(create.body).to.deep.equal({ providerCallbackHost: "example.org" });
  });
});
