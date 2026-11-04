// IntouchSMS provider (services/sms.js) against a local fake of https://www.intouchsms.co.rw/http-api:
// request shape, response parsing, errors, and delivery status by polling (Intouch has no delivery webhook).
const { expect } = require("chai");
const http = require("http");
const dbm = require("../web/server/db");
const { createOutbox } = require("../services/sms");

const ME = "250788000001";
const ENV = ["INTOUCH_USERNAME", "INTOUCH_PASSWORD", "INTOUCH_SENDER", "INTOUCH_URL", "INTOUCH_FORMAT", "INTOUCH_RECIPIENT_FORMAT",
  "SMS_PROVIDER", "SMS_ALLOWLIST", "AT_USERNAME", "AT_API_KEY", "SMSGATE_URL"];

describe("IntouchSMS provider", function () {
  let server, reqs, sendReply, statusReply, db, clock;
  const saved = {};

  before(async () => {
    server = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => { b += c; });
      req.on("end", () => {
        const body = (req.headers["content-type"] || "").includes("json") ? JSON.parse(b) : Object.fromEntries(new URLSearchParams(b));
        reqs.push({ url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], body });
        const r = req.url.includes("getsmsstatus") ? statusReply : sendReply;
        res.writeHead(r.http, { "Content-Type": "application/json" }); res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
      });
    });
    await new Promise((r) => server.listen(0, r));
  });
  after(() => server.close());

  beforeEach(() => {
    reqs = [];
    db = dbm.open(":memory:");
    clock = Date.now();
    for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, { INTOUCH_USERNAME: "farmledger", INTOUCH_PASSWORD: "pw", INTOUCH_SENDER: "FarmLedger",
      INTOUCH_URL: `http://127.0.0.1:${server.address().port}`, SMS_ALLOWLIST: ME });
    sendReply = { http: 200, body: { success: true, details: [{ status: "P", message: "hi", cost: 18.0, receipient: "+250788000001", messageid: 238254 }], summary: { cost: 18.0, totalmessages: 1 } } };
    statusReply = { http: 200, body: { success: true, results: { status: "D" } } };
  });
  afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  const box = () => createOutbox({ db, localChain: true, logFile: null, quiet: true, now: () => clock });
  const row = () => db.prepare("SELECT status, via, provider_id, provider_status, cost, error FROM sms_outbox ORDER BY id DESC").get();

  it("is chosen automatically when configured, and sends the documented form request with basic auth", async () => {
    const b = box();
    expect(b.mode).to.equal("intouch");
    await b.sendNow(ME, "FarmLedger code: 123456.", { kind: "otp", secret: "123456" });
    expect(reqs).to.have.length(1);
    const q = reqs[0];
    expect(q.url).to.equal("/api/sendsms/.json");
    expect(q.type).to.equal("application/x-www-form-urlencoded");
    expect(q.auth).to.equal("Basic " + Buffer.from("farmledger:pw").toString("base64"));
    expect(q.body).to.deep.equal({ username: "farmledger", password: "pw", recipients: "250788000001", message: "FarmLedger code: 123456.", sender: "FarmLedger" });
    expect(row()).to.deep.include({ status: "sent", via: "intouch", provider_id: "238254", provider_status: "P", cost: "RWF 18" });
    expect(db.prepare("SELECT text FROM sms_outbox").get().text).to.equal("FarmLedger code: ******."); // stored masked
  });

  it("can send JSON and other number formats instead (their docs disagree with their samples)", async () => {
    process.env.INTOUCH_FORMAT = "json";
    process.env.INTOUCH_RECIPIENT_FORMAT = "local";
    await box().sendNow(ME, "x");
    expect(reqs[0].type).to.equal("application/json");
    expect(reqs[0].body.recipients).to.equal("0788000001");
    process.env.INTOUCH_RECIPIENT_FORMAT = "plus";
    await box().sendNow(ME, "y");
    expect(reqs[1].body.recipients).to.equal("+250788000001");
  });

  it("follows the delivery status by polling: delivered, or undeliverable when the carrier did not send it", async () => {
    const b = box();
    await b.sendNow(ME, "one");
    expect(await b.refreshStatuses()).to.equal(0); // too soon: checked at most once a minute
    clock += 61_000;
    statusReply = { http: 200, body: { success: true, results: { status: "S" } } };
    expect(await b.refreshStatuses()).to.equal(0);
    expect(row()).to.deep.include({ status: "sent", provider_status: "S" });
    clock += 61_000;
    statusReply = { http: 200, body: { success: true, results: { status: "D" } } };
    expect(await b.refreshStatuses()).to.equal(1);
    expect(row()).to.deep.include({ status: "delivered", provider_status: "D" });
    expect(reqs.filter((r) => r.url === "/api/getsmsstatus/.json").at(-1).body).to.deep.include({ messageid: "238254" });

    await b.sendNow(ME, "two");
    clock += 61_000;
    statusReply = { http: 200, body: { success: true, results: { status: "U" } } };
    await b.refreshStatuses();
    expect(row()).to.deep.include({ status: "undeliverable", provider_status: "U" });
  });

  it("records a refused request with Intouch's reason and does not retry it; retries a server error", async () => {
    sendReply = { http: 400, body: { success: false, response: "Insufficient balance" } };
    await box().sendNow(ME, "a");
    expect(row()).to.deep.include({ status: "failed", error: "HTTP 400 Insufficient balance" });
    sendReply = { http: 503, body: "Service Unavailable" };
    await box().sendNow(ME, "b");
    expect(row()).to.deep.include({ status: "queued" });
  });

  it("still applies the allowlist on the local chain", async () => {
    await box().sendNow("250788000002", "not listed");
    expect(reqs).to.have.length(0);
    expect(row().status).to.equal("skipped");
  });

  it("SMS_ALLOWLIST=* texts any number except the seeded demo numbers", async () => {
    process.env.SMS_ALLOWLIST = "*";
    const b = box();
    await b.sendNow("250783123456", "anyone");
    expect(reqs).to.have.length(1);
    expect(row().status).to.equal("sent");
    await b.sendNow("250788000001", "demo farmer Aline");
    expect(reqs).to.have.length(1);
    expect(row()).to.deep.include({ status: "skipped", error: "seeded demo number (never texted live)" });
  });

  it("SMS_PROVIDER overrides the automatic choice", async () => {
    process.env.SMS_PROVIDER = "log";
    const b = box();
    expect(b.mode).to.equal("log");
    await b.sendNow(ME, "logged only");
    expect(reqs).to.have.length(0);
  });
});
