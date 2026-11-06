// SMS menu channel through an Android phone running SMS Gateway for Android (services/sms-channel.js): the same menus
// as USSD over plain SMS, signed and de-duplicated webhooks, replies from the gateway, and the gateway's send API.
const { expect } = require("chai");
const crypto = require("crypto");
const http = require("http");
const { artifacts } = require("hardhat");
const { ethers, loadFixture, farmerFixture, buyFor } = require("./helpers");
const dbm = require("../web/server/db");
const { createUssd } = require("../services/ussd-core");
const { createOutbox } = require("../services/sms");
const { createSmsChannel, verifySignature } = require("../services/sms-channel");

const ALINE = "250788000001";
const KEY = "test-signing-key";

describe("SMS menu channel (Android SMS gateway)", function () {
  let ctx, db, out, clock, channel, n;

  const sign = (raw, ts) => crypto.createHmac("sha256", KEY).update(raw + ts).digest("hex");
  async function webhook(body, { ts = Math.floor(clock / 1000), signature } = {}) {
    const raw = JSON.stringify(body);
    return channel.handleWebhook({ raw, headers: { "x-timestamp": String(ts), "x-signature": signature ?? sign(raw, ts) } });
  }
  async function text(message, phone = ALINE) {
    n++;
    const r = await webhook({ id: "wh-" + n, event: "sms:received", deviceId: "dev1", webhookId: "farmledger-sms-received",
      payload: { messageId: "m" + n, message, sender: "+" + phone, recipient: null, simNumber: 1, receivedAt: new Date(clock).toISOString() } });
    expect(r.status).to.equal(200);
    return out.at(-1);
  }

  beforeEach(async () => {
    ctx = await loadFixture(farmerFixture);
    await ctx.ledger.grantRole(await ctx.ledger.CLAIMS_AGENT_ROLE(), ctx.outsider.address);
    db = dbm.open(":memory:");
    out = []; clock = Date.now(); n = 0;
    const abi = { ledger: (await artifacts.readArtifact("FarmLedger")).abi, token: (await artifacts.readArtifact("MockRWF")).abi };
    const ussd = createUssd({ provider: ethers.provider, abi, ledgerAddress: ctx.ledgerAddr, agent: ctx.outsider, db });
    const outbox = createOutbox({ db, now: () => clock, logFile: null, quiet: true,
      send: async (phone, t) => { out.push({ phone, text: t }); return { ok: true, providerId: "gw-" + out.length }; } });
    channel = createSmsChannel({ db, ussd, outbox, signingKey: KEY, now: () => clock });
  });

  it("runs the same menu as USSD, one SMS per answer, and replies to the sender", async () => {
    let r = await text("FL");
    expect(r).to.deep.equal({ phone: ALINE, text: "Choose a 4-digit PIN to protect your claims:" });
    expect((await text("1234")).text).to.equal("Repeat your PIN:");
    expect((await text("1234")).text).to.equal("PIN saved.\nFarmLedger\n1. My policies\n2. Report a claim\n3. Claim status");
    await buyFor(ctx.ledger, ctx.farmer, 1, 1, 100_000);
    r = await text("1");
    expect(r.text).to.match(/^Your policies:\n1\. #1 Drought Active$/);
    r = await text("1");
    expect(r.text).to.match(/^Policy #1 Drought\n[\s\S]*Cover 100,000 RWF[\s\S]*Text FL for the menu\.$/); // END closes the session
    expect((await text("hello")).text).to.match(/^FarmLedger\n1\. My policies/); // anything after the end starts again
    expect(db.prepare("SELECT COUNT(*) n FROM sms_outbox WHERE kind = 'sms-menu' AND via = 'smsgate'").get().n).to.equal(6);
  });

  it("FL restarts at any time, and a conversation silent for 10 minutes starts over", async () => {
    await text("FL"); await text("1234"); await text("1234");
    expect((await text("2")).text).to.match(/no active cattle cover|Claim/);
    await text("FL");
    expect((await text("FL")).text).to.match(/^FarmLedger\n1\. My policies/);
    await text("1");
    clock += 11 * 60 * 1000;
    expect((await text("1")).text).to.match(/^FarmLedger\n1\. My policies/); // the stale "1" is not taken as an answer
  });

  it("refuses unsigned, wrongly signed and replayed (old timestamp) webhooks", async () => {
    const body = { id: "x1", event: "sms:received", payload: { messageId: "x1", message: "FL", sender: "+" + ALINE } };
    expect((await webhook(body, { signature: "" })).status).to.equal(401);
    expect((await webhook(body, { signature: "00".repeat(32) })).status).to.equal(401);
    const old = Math.floor(clock / 1000) - 600;
    expect((await webhook(body, { ts: old, signature: sign(JSON.stringify(body), old) })).status).to.equal(401);
    expect(out).to.have.length(0);
    expect(verifySignature({ raw: "{}", timestamp: "100", signature: crypto.createHmac("sha256", "k").update("{}100").digest("hex"), key: "k", nowS: 100 }).ok).to.equal(true);
  });

  it("handles a retried webhook once (the app re-sends until it gets a 2xx)", async () => {
    const body = { id: "same", event: "sms:received", payload: { messageId: "same", message: "FL", sender: "+" + ALINE } };
    expect((await webhook(body)).body).to.equal("ok");
    expect((await webhook(body)).body).to.equal("duplicate");
    expect(out).to.have.length(1);
  });

  it("never lets a '*' in an SMS inject extra answers", async () => {
    await text("FL"); await text("1234"); await text("1234");
    expect((await text("2*1*1*1234")).text).to.not.match(/registered/i);
  });

  it("records the gateway's delivery reports", async () => {
    await text("FL");
    await webhook({ id: "d1", event: "sms:delivered", payload: { messageId: "gw-1" } });
    expect(db.prepare("SELECT status FROM sms_outbox WHERE provider_id = 'gw-1'").get().status).to.equal("delivered");
  });

  describe("gateway send API (against a local fake of the phone's server)", function () {
    let server, reqs;
    const saved = {};
    before(async () => {
      server = http.createServer((req, res) => {
        let b = ""; req.on("data", (c) => { b += c; });
        req.on("end", () => { reqs.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }); res.writeHead(202, { "Content-Type": "application/json" }); res.end(JSON.stringify({ id: "gw-abc", state: "Pending" })); });
      });
      await new Promise((r) => server.listen(0, r));
    });
    after(() => server.close());
    beforeEach(() => {
      reqs = [];
      // provider settings from the developer's .env must not leak into these tests
      for (const k of ["SMSGATE_URL", "SMSGATE_USER", "SMSGATE_PASSWORD", "SMS_PROVIDER", "SMS_ALLOWLIST", "AT_USERNAME", "AT_API_KEY", "INTOUCH_USERNAME", "INTOUCH_PASSWORD"]) { saved[k] = process.env[k]; delete process.env[k]; }
      Object.assign(process.env, { SMSGATE_URL: `http://127.0.0.1:${server.address().port}/`, SMSGATE_USER: "sms", SMSGATE_PASSWORD: "pw", SMS_ALLOWLIST: ALINE });
    });
    afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

    it("posts the documented JSON with basic auth and keeps the message id", async () => {
      const box = createOutbox({ db, logFile: null, quiet: true });
      expect(box.mode).to.equal("android-gateway");
      await box.sendNow(ALINE, "hello");
      expect(reqs).to.have.length(1);
      expect(reqs[0].url).to.equal("/message");
      expect(reqs[0].auth).to.equal("Basic " + Buffer.from("sms:pw").toString("base64"));
      expect(reqs[0].body).to.deep.equal({ textMessage: { text: "hello" }, phoneNumbers: ["+250788000001"], withDeliveryReport: true });
      expect(db.prepare("SELECT status, provider_id FROM sms_outbox").get()).to.deep.equal({ status: "sent", provider_id: "gw-abc" });
    });

    it("still applies the allowlist on the local chain (the gateway phone pays for every SMS)", async () => {
      const box = createOutbox({ db, logFile: null, quiet: true });
      await box.sendNow("250788000002", "not listed");
      expect(reqs).to.have.length(0);
    });
  });
});
