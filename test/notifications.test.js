// Phase 4: SMS outbox (services/sms.js), event-driven notifier in chain order (services/notifier-core.js), Africa's
// Talking request/response handling against a local fake, and the access rules of the USSD HTTP front.
const { expect } = require("chai");
const http = require("http");
const { Readable } = require("stream");
const { ethers, loadFixture, time, hash, Metric, farmerFixture, signAttestation } = require("./helpers");
const dbm = require("../web/server/db");
const contacts = require("../web/server/contacts");
const { createOutbox, BACKOFF_MS } = require("../services/sms");
const { createNotifier } = require("../services/notifier-core");
const { createHandler } = require("../services/ussd-http");

const ALINE = "250788000001";
const JEAN = "250788000002";
const DAY = 86400;

async function fixture() {
  const base = await farmerFixture();
  const claims = await (await ethers.getContractFactory("CropClaims")).deploy(base.ledgerAddr);
  await base.ledger.grantRole(await base.ledger.ASSESSOR_ROLE(), await claims.getAddress());
  return { ...base, claims };
}

describe("Notifications (SMS outbox + notifier)", function () {
  let ctx, db, sent, clock, outbox, notifier;
  const transport = async (phone, text) => { sent.push({ phone, text }); return { ok: true, providerId: "ATXid_" + sent.length, status: "Success", cost: "RWF 10" }; };

  function build({ history = "all", send = transport } = {}) { // history: "all" texts past events, null skips them
    outbox = createOutbox({ db, send, now: () => clock, logFile: null, quiet: true });
    notifier = createNotifier({ db, provider: ethers.provider, ledger: ctx.ledger, cropClaims: ctx.claims, outbox, history });
  }

  beforeEach(async () => {
    ctx = await loadFixture(fixture);
    db = dbm.open(":memory:");
    sent = [];
    clock = Date.now();
    contacts.put(ctx.farmer.address, ALINE, db);
    contacts.put(ctx.farmer2.address, JEAN, db);
    build();
  });

  describe("notifier", function () {
    it("texts in chain order: welcome, purchase, then payout, even when they happen back to back", async () => {
      await ctx.ledger.connect(ctx.farmer).buyPolicy(1, 1, 100_000);
      await ctx.ledger.connect(ctx.oracle).postReading(1, Metric.Rainfall, 900, await time.latest());
      const r = await notifier.tick();
      expect(r.queued).to.equal(4); // 2 welcomes (fixture), purchase, payout
      const aline = sent.filter((m) => m.phone === ALINE).map((m) => m.text);
      expect(aline[0]).to.match(/^Welcome to FarmLedger/);
      expect(aline[1]).to.match(/^FarmLedger: policy #1 active until .* Cover 100,000 RWF, premium 10,000 RWF\.$/);
      expect(aline[2]).to.equal("FarmLedger: 100,000 RWF paid for policy #1 (triggered by weather/satellite data).");
      for (const m of sent) expect(m.text.length, m.text).to.be.at.most(160);
    });

    it("never sends a message twice: not on the next tick, not after a restart", async () => {
      await ctx.ledger.connect(ctx.farmer).buyPolicy(1, 1, 100_000);
      await notifier.tick();
      const n = sent.length;
      expect((await notifier.tick()).queued).to.equal(0);
      build(); // a restarted notifier on the same database
      expect((await notifier.tick()).queued).to.equal(0);
      expect(sent).to.have.length(n);
    });

    it("on its very first start skips the history, then texts only what happens next", async () => {
      await ctx.ledger.connect(ctx.farmer).buyPolicy(1, 1, 100_000);
      build({ history: null }); // as without NOTIFY_HISTORY
      expect((await notifier.tick()).queued).to.equal(0);
      await ctx.ledger.connect(ctx.oracle).postReading(1, Metric.Rainfall, 900, await time.latest());
      await notifier.tick();
      expect(sent.map((m) => m.text)).to.deep.equal(["FarmLedger: 100,000 RWF paid for policy #1 (triggered by weather/satellite data)."]);
    });

    it("after a chain reset it starts again from the new chain's first event", async () => {
      const snap = await ethers.provider.send("evm_snapshot", []);
      await ctx.ledger.connect(ctx.farmer).buyPolicy(1, 1, 100_000);
      await ctx.ledger.connect(ctx.farmer).buyPolicy(1, 1, 100_000);
      await notifier.tick();
      await ethers.provider.send("evm_revert", [snap]); // same addresses, new blocks
      await ctx.ledger.connect(ctx.farmer2).registerPlot(-1_300_000, 30_300_000, 8000, ethers.encodeBytes32String("BEANS"), hash("g"));
      await ctx.ledger.connect(ctx.farmer2).buyPolicy(1, 2, 50_000);
      sent = [];
      await notifier.tick();
      expect(sent.map((m) => m.phone)).to.include(JEAN);
      expect(sent.some((m) => /policy #1 active/.test(m.text) && m.phone === JEAN)).to.equal(true);
    });

    it("covers claims: livestock filed and rejected, crop loss filed and rejected, expiry", async () => {
      const { ledger, claims, farmer, underwriter, vet } = ctx;
      await ledger.connect(farmer).buyPolicy(4, 1, 300_000); // 1 livestock
      await ledger.connect(farmer).buyPolicy(1, 1, 100_000); // 2 drought
      await time.increase(8 * DAY);
      await ledger.connect(farmer).fileClaim(1, hash("photo"));
      const deadline = (await time.latest()) + 3600;
      const sig = await signAttestation(vet, ledger, { claimId: 1, policyId: 1, tagId: (await ledger.getAnimal(1)).tagId, approved: false, deadline });
      await ledger.settleLivestockClaim(1, false, deadline, sig);
      await claims.connect(farmer).fileClaim(2, hash("hail"), 0);
      await claims.connect(underwriter).review(1, false, 0);
      await time.increase(400 * DAY);
      await ledger.expirePolicy(2);
      sent = [];
      await notifier.tick();
      const t = sent.map((m) => m.text);
      expect(t).to.include("FarmLedger: claim #1 received for policy #1. A veterinarian will verify it.");
      expect(t).to.include("FarmLedger: claim #1 was not approved by the veterinarians. Your cover continues.");
      expect(t).to.include("FarmLedger: loss claim #1 received for policy #2. The insurer's reviewers will assess it.");
      expect(t).to.include("FarmLedger: loss claim #1 was not approved by the reviewers. Your cover continues.");
      expect(t).to.include("FarmLedger: policy #2 has ended. No payout was due. Thank you for insuring with FarmLedger.");
    });

    it("an approved crop loss claim texts the agreed amount; a subsidised purchase shows the farmer's share", async () => {
      const { ledger, claims, farmer, underwriter, admin } = ctx;
      const gov = (await ethers.getSigners())[12];
      await ledger.connect(admin).grantRole(await ledger.SUBSIDY_ROLE(), gov.address);
      await ctx.token.mint(gov.address, 100_000);
      await ctx.token.connect(gov).approve(ctx.ledgerAddr, ethers.MaxUint256);
      await ledger.connect(gov).fundSubsidy(100_000);
      await ledger.connect(gov).setSubsidy(4000, 0);
      await ledger.connect(gov).setSubsidyEligible(1, true);
      await ledger.connect(farmer).buyPolicy(1, 1, 100_000);
      await claims.connect(farmer).fileClaim(1, hash("pests"), 0);
      await claims.connect(underwriter).review(1, true, 30_000);
      sent = [];
      await notifier.tick();
      const t = sent.map((m) => m.text);
      expect(t.some((x) => /you paid 6,000 RWF \(subsidy 4,000 RWF\)/.test(x))).to.equal(true);
      expect(t).to.include("FarmLedger: 30,000 RWF paid for policy #1 (loss claim approved by the insurer's reviewers).");
    });
  });

  describe("outbox", function () {
    it("retries a temporary failure with backoff and holds later messages to the same phone until it goes", async () => {
      let fail = true;
      build({ send: async (phone, text) => {
        if (fail && phone === ALINE) return { ok: false, transient: true, error: "500 InternalServerError" };
        sent.push({ phone, text }); return { ok: true, providerId: "x" + sent.length };
      } });
      outbox.enqueue({ phone: ALINE, text: "first", key: "a" });
      outbox.enqueue({ phone: ALINE, text: "second", key: "b" });
      outbox.enqueue({ phone: JEAN, text: "other phone", key: "c" });
      await outbox.drain();
      expect(sent.map((m) => m.text)).to.deep.equal(["other phone"]); // Aline's second waits behind her first
      fail = false;
      await outbox.drain();
      expect(sent).to.have.length(1); // not due yet
      clock += BACKOFF_MS[0];
      await outbox.drain();
      expect(sent.map((m) => m.text)).to.deep.equal(["other phone", "first", "second"]);
      expect(outbox.stats()).to.deep.equal({ sent: 3 });
    });

    it("gives up on a permanent failure and records why", async () => {
      build({ send: async () => ({ ok: false, transient: false, error: "403 InvalidPhoneNumber" }) });
      outbox.enqueue({ phone: "250700000000", text: "x", key: "k" });
      await outbox.drain();
      expect(db.prepare("SELECT status, error FROM sms_outbox").get()).to.deep.equal({ status: "failed", error: "403 InvalidPhoneNumber" });
    });

    it("one-time codes are stored masked and are not retried from the queue", async () => {
      build({ send: async () => ({ ok: false, transient: true, error: "network" }) });
      await outbox.sendNow(ALINE, "FarmLedger code: 123456. Valid 10 minutes.", { kind: "otp", secret: "123456" });
      const row = db.prepare("SELECT text, status FROM sms_outbox").get();
      expect(row).to.deep.equal({ text: "FarmLedger code: ******. Valid 10 minutes.", status: "failed" });
    });

    it("records Africa's Talking delivery reports", async () => {
      outbox.enqueue({ phone: ALINE, text: "x", key: "k" });
      await outbox.drain();
      expect(outbox.recordDelivery({ id: "ATXid_1", status: "Success" })).to.equal(true);
      expect(outbox.recordDelivery({ id: "unknown", status: "Success" })).to.equal(false);
      outbox.enqueue({ phone: JEAN, text: "y", key: "j" });
      await outbox.drain();
      outbox.recordDelivery({ id: "ATXid_2", status: "Failed", failureReason: "AbsentSubscriber" });
      expect(db.prepare("SELECT phone, status, error FROM sms_outbox ORDER BY id").all()).to.deep.equal([
        { phone: ALINE, status: "delivered", error: null }, { phone: JEAN, status: "undeliverable", error: "AbsentSubscriber" }]);
    });
  });

  describe("Africa's Talking client (against a local fake API)", function () {
    let server, requests, reply;
    const env = {};
    before(async () => {
      server = http.createServer((req, res) => {
        let body = ""; req.on("data", (c) => { body += c; });
        req.on("end", () => { requests.push({ url: req.url, headers: req.headers, form: Object.fromEntries(new URLSearchParams(body)) }); res.writeHead(reply.http, { "Content-Type": "application/json" }); res.end(JSON.stringify(reply.body)); });
      });
      await new Promise((r) => server.listen(0, r));
    });
    after(() => server.close());
    beforeEach(() => {
      requests = [];
      for (const k of ["AT_USERNAME", "AT_API_KEY", "AT_BASE_URL", "AT_SENDER_ID", "SMS_ALLOWLIST"]) env[k] = process.env[k];
      Object.assign(process.env, { AT_USERNAME: "farmledger", AT_API_KEY: "test-key", AT_BASE_URL: `http://127.0.0.1:${server.address().port}` });
      delete process.env.SMS_ALLOWLIST; delete process.env.AT_SENDER_ID;
    });
    afterEach(() => { for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
    const ok = { http: 201, body: { SMSMessageData: { Message: "Sent to 1/1", Recipients: [{ statusCode: 101, number: "+250788000001", status: "Success", cost: "RWF 10.0000", messageId: "ATXid_abc" }] } } };

    it("sends the documented form request and stores the message id and cost", async () => {
      reply = ok;
      process.env.SMS_ALLOWLIST = ALINE;
      const box = createOutbox({ db, localChain: true, logFile: null, quiet: true });
      expect(box.mode).to.equal("africastalking-live");
      await box.sendNow(ALINE, "hello");
      expect(requests[0].url).to.equal("/version1/messaging");
      expect(requests[0].headers.apikey).to.equal("test-key");
      expect(requests[0].form).to.deep.equal({ username: "farmledger", to: "+250788000001", message: "hello" });
      expect(db.prepare("SELECT status, provider_id, cost FROM sms_outbox").get()).to.deep.equal({ status: "sent", provider_id: "ATXid_abc", cost: "RWF 10.0000" });
    });

    it("on the local chain, live SMS goes only to SMS_ALLOWLIST numbers (demo numbers may be real people)", async () => {
      reply = ok;
      let box = createOutbox({ db, localChain: true, logFile: null, quiet: true });
      await box.sendNow(ALINE, "no allowlist");
      process.env.SMS_ALLOWLIST = "250780000999";
      box = createOutbox({ db, localChain: true, logFile: null, quiet: true });
      await box.sendNow(ALINE, "not listed");
      expect(requests).to.have.length(0);
      expect(db.prepare("SELECT status FROM sms_outbox").all().map((r) => r.status)).to.deep.equal(["skipped", "skipped"]);
    });

    it("treats insufficient balance and gateway errors as temporary, an invalid number as permanent", async () => {
      process.env.SMS_ALLOWLIST = `${ALINE},${JEAN}`;
      const box = createOutbox({ db, localChain: true, logFile: null, quiet: true });
      reply = { http: 201, body: { SMSMessageData: { Recipients: [{ statusCode: 405, status: "InsufficientBalance" }] } } };
      await box.sendNow(ALINE, "a");
      reply = { http: 201, body: { SMSMessageData: { Recipients: [{ statusCode: 403, status: "InvalidPhoneNumber" }] } } };
      await box.sendNow(JEAN, "b");
      expect(db.prepare("SELECT phone, status, error FROM sms_outbox ORDER BY id").all()).to.deep.equal([
        { phone: ALINE, status: "queued", error: "405 InsufficientBalance" }, { phone: JEAN, status: "failed", error: "403 InvalidPhoneNumber" }]);
    });
  });

  describe("USSD HTTP front", function () {
    const ussd = { handle: async ({ phoneNumber }) => `CON hello ${phoneNumber}` };
    async function call(handler, { url = "/ussd", headers = {}, body = "sessionId=s&phoneNumber=%2B250788000001&text=" } = {}) {
      const req = Readable.from([Buffer.from(body)]);
      Object.assign(req, { method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });
      const res = { code: 0, body: "", writeHead(c) { this.code = c; }, end(b = "") { this.body = String(b); } };
      await handler(req, res);
      return res;
    }
    const quiet = { log() {}, warn() {} };

    it("answers local requests (the simulator) without a token", async () => {
      const h = createHandler({ ussd, outbox: createOutbox({ db, logFile: null, quiet: true }), token: "", log: quiet });
      expect(await call(h)).to.deep.include({ code: 200, body: "CON hello +250788000001" });
    });

    it("refuses requests from the internet without the right ?key=, and always without a configured token", async () => {
      const tunnel = { "cf-connecting-ip": "203.0.113.5" };
      const open = createHandler({ ussd, outbox: createOutbox({ db, logFile: null, quiet: true }), token: "", log: quiet });
      expect((await call(open, { headers: tunnel })).code).to.equal(403);
      const h = createHandler({ ussd, outbox: createOutbox({ db, logFile: null, quiet: true }), token: "s3cret-token", log: quiet });
      expect((await call(h, { headers: tunnel })).code).to.equal(403);
      expect((await call(h, { headers: tunnel, url: "/ussd?key=wrong-token" })).code).to.equal(403);
      expect(await call(h, { headers: tunnel, url: "/ussd?key=s3cret-token" })).to.deep.include({ code: 200, body: "CON hello +250788000001" });
    });

    it("takes delivery reports on /sms/delivery", async () => {
      const box = createOutbox({ db, send: transport, now: () => clock, logFile: null, quiet: true });
      box.enqueue({ phone: ALINE, text: "x", key: "k" });
      await box.drain();
      const h = createHandler({ ussd, outbox: box, token: "t0ken", log: quiet });
      const r = await call(h, { url: "/sms/delivery?key=t0ken", headers: { "x-forwarded-for": "1.2.3.4" }, body: "id=ATXid_1&status=Success&phoneNumber=%2B250788000001" });
      expect(r.code).to.equal(200);
      expect(db.prepare("SELECT status FROM sms_outbox").get().status).to.equal("delivered");
    });
  });
});
