// Document upload layer: content checks, signed requests, storage, completeness and application hash.
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const core = require("../web/server/documents-core");
const req = require("../web/shared/requirements");

let ethers = null;
try { ethers = require("ethers"); } catch { /* signature tests are skipped when ethers is unavailable */ }
const withEthers = ethers ? it : it.skip;

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 2)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 3)]);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200, 4)]);
const ALICE = "0x" + "a1".repeat(20);
const BOB = "0x" + "b2".repeat(20);
const APP = "11111111-aaaa-bbbb-cccc-222222222222";
const throwsStatus = (fn, status) => assert.throws(fn, (e) => e instanceof core.DocError && e.status === status, `expected DocError ${status}`);

describe("Application documents", function () {
  let store, dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-")); store = new core.DocumentStore(dir); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe("requirements registry", () => {
    it("asks for different documents for crop and livestock cover", () => {
      const crop = req.documentsFor({ cover: 0 }).map((d) => d.id);
      const cattle = req.documentsFor({ cover: 3 }).map((d) => d.id);
      assert.deepStrictEqual(crop, ["national_id", "land_proof", "field_photo"]);
      assert.deepStrictEqual(cattle, ["national_id", "animal_photo", "health_cert", "ownership_proof"]);
    });
    it("reports exactly the mandatory documents that are missing", () => {
      assert.deepStrictEqual(req.missingDocuments({ cover: 3 }, ["national_id"]), ["animal_photo", "health_cert"]);
      assert.deepStrictEqual(req.missingDocuments({ cover: 3 }, ["national_id", "animal_photo", "health_cert"]), []);
      assert.deepStrictEqual(req.missingDocuments({ cover: 1 }, ["national_id", "land_proof"]), []);
    });
    it("can be extended with new questions without touching any other code", () => {
      req.FIELDS.push({ id: "t_declaration", label: "I confirm the information is correct", type: "checkbox", required: true });
      try {
        assert.ok(req.validateAnswers({ cover: 0 }, {}).t_declaration);
        assert.deepStrictEqual(req.validateAnswers({ cover: 0 }, { t_declaration: true }), {});
      } finally { req.FIELDS.pop(); }
    });
  });

  describe("file inspection", () => {
    it("recognises PDF, JPG and PNG by content", () => {
      assert.strictEqual(core.sniff(PDF).ext, "pdf");
      assert.strictEqual(core.sniff(JPG).ext, "jpg");
      assert.strictEqual(core.sniff(PNG).ext, "png");
    });
    it("rejects executables renamed to look like documents", () => throwsStatus(() => core.inspectUpload(EXE), 415));
    it("rejects empty files", () => throwsStatus(() => core.inspectUpload(Buffer.alloc(0)), 400));
    it("rejects files over the size limit", () => throwsStatus(() => core.inspectUpload(Buffer.concat([PDF, Buffer.alloc(req.LIMITS.maxBytes)])), 413));
    it("rejects a file whose hash differs from the signed hash", () => throwsStatus(() => core.inspectUpload(PDF, "0".repeat(64)), 400));
    it("accepts a file whose hash matches", () => assert.strictEqual(core.inspectUpload(PDF, core.sha256Hex(PDF)).mime, "application/pdf"));
  });

  describe("storage", () => {
    const put = (document, buffer = PDF, applicant = ALICE, name = "scan.pdf") => store.put({ applicant, application: APP, document, buffer, originalName: name });

    it("stores a file under the applicant with a server-chosen name", () => {
      const meta = put("land_proof", PDF, ALICE, "../../etc/passwd");
      assert.strictEqual(meta.file, "land_proof.pdf");
      assert.ok(!meta.originalName.includes(".."));
      assert.ok(fs.existsSync(path.join(dir, ALICE.toLowerCase(), APP, "land_proof.pdf")));
    });
    it("replaces an earlier upload of the same document (even with a different format)", () => {
      put("land_proof", PDF);
      const m = put("land_proof", PNG, ALICE, "photo.png");
      assert.strictEqual(m.file, "land_proof.png");
      const files = fs.readdirSync(path.join(dir, ALICE.toLowerCase(), APP)).sort();
      assert.deepStrictEqual(files, ["land_proof.json", "land_proof.png"]);
    });
    it("removes a document", () => {
      put("land_proof");
      assert.strictEqual(store.remove({ applicant: ALICE, application: APP, document: "land_proof" }), true);
      assert.strictEqual(store.get({ applicant: ALICE, application: APP, document: "land_proof" }), null);
    });
    it("keeps each applicant's files separate", () => {
      put("land_proof", PDF, ALICE);
      assert.strictEqual(store.get({ applicant: BOB, application: APP, document: "land_proof" }), null);
    });
    it("reuses the applicant's identity document across applications", () => {
      put("national_id", JPG, ALICE, "id.jpg");
      const other = "99999999-aaaa-bbbb-cccc-000000000000";
      const found = store.list({ applicant: ALICE, application: other }).map((d) => d.document);
      assert.deepStrictEqual(found, ["national_id"]);
    });
    it("refuses path-traversal and unknown identifiers", () => {
      throwsStatus(() => store.put({ applicant: ALICE, application: "../../x", document: "land_proof", buffer: PDF, originalName: "a.pdf" }), 400);
      throwsStatus(() => store.put({ applicant: "../etc", application: APP, document: "land_proof", buffer: PDF, originalName: "a.pdf" }), 400);
      throwsStatus(() => store.put({ applicant: ALICE, application: APP, document: "../passwd", buffer: PDF, originalName: "a.pdf" }), 400);
      throwsStatus(() => store.put({ applicant: ALICE, application: APP, document: "constructor", buffer: PDF, originalName: "a.pdf" }), 400);
    });
  });

  describe("finalize and link", () => {
    const ctx = { cover: 3, productId: 4, assetId: 1, sumInsured: "300000" };
    const put = (document, buffer) => store.put({ applicant: ALICE, application: APP, document, buffer, originalName: document + ".pdf" });

    it("refuses to finalize while mandatory documents are missing", () => {
      put("national_id", JPG);
      throwsStatus(() => store.finalize({ applicant: ALICE, application: APP, ctx }), 422);
    });
    it("finalizes a complete application and returns a stable hash", () => {
      put("national_id", JPG); put("animal_photo", PNG); put("health_cert", PDF);
      const a = store.finalize({ applicant: ALICE, application: APP, ctx });
      const b = store.finalize({ applicant: ALICE, application: APP, ctx });
      assert.match(a.applicationHash, /^0x[0-9a-f]{64}$/);
      assert.strictEqual(a.applicationHash, b.applicationHash);
      assert.strictEqual(a.record.documents.length, 3);
    });
    it("changes the hash if a document is replaced or the sum insured changes", () => {
      put("national_id", JPG); put("animal_photo", PNG); put("health_cert", PDF);
      const base = store.finalize({ applicant: ALICE, application: APP, ctx }).applicationHash;
      put("health_cert", Buffer.concat([PDF, Buffer.from("x")]));
      const replaced = store.finalize({ applicant: ALICE, application: APP, ctx }).applicationHash;
      const sum = store.finalize({ applicant: ALICE, application: APP, ctx: { ...ctx, sumInsured: "400000" } }).applicationHash;
      assert.notStrictEqual(base, replaced);
      assert.notStrictEqual(replaced, sum);
    });
    it("links the application to a policy exactly once", () => {
      put("national_id", JPG); put("animal_photo", PNG); put("health_cert", PDF);
      store.finalize({ applicant: ALICE, application: APP, ctx });
      assert.strictEqual(store.link({ applicant: ALICE, application: APP, policyId: 7 }).policyId, 7);
      throwsStatus(() => store.link({ applicant: ALICE, application: APP, policyId: 8 }), 409);
    });
    it("cannot link an application that was never finalized", () => throwsStatus(() => store.link({ applicant: ALICE, application: APP, policyId: 1 }), 404));
  });

  describe("signed requests", () => {
    const msgFor = (over = {}, w) => core.message({ action: "upload", applicant: w.address, application: APP, document: "land_proof", sha256: "a".repeat(64), filename: "scan.pdf", issued: Math.floor(Date.now() / 1000), ...over });

    withEthers("accepts a signature from the applicant", async () => {
      const w = ethers.Wallet.createRandom();
      const m = msgFor({}, w);
      assert.strictEqual(core.verifySigner(m, await w.signMessage(m), w.address).toLowerCase(), w.address.toLowerCase());
    });
    withEthers("rejects a signature from somebody else", async () => {
      const w = ethers.Wallet.createRandom(), other = ethers.Wallet.createRandom();
      const m = msgFor({}, w);
      throwsStatus(() => core.verifySigner(m, awaitSync(other, m), w.address), 403);
    });
    withEthers("a signature for one file cannot be reused for another", async () => {
      const w = ethers.Wallet.createRandom();
      const sig = await w.signMessage(msgFor({ sha256: "a".repeat(64) }, w));
      throwsStatus(() => core.verifySigner(msgFor({ sha256: "b".repeat(64) }, w), sig, w.address), 403);
      throwsStatus(() => core.verifySigner(msgFor({ document: "national_id" }, w), sig, w.address), 403);
      throwsStatus(() => core.verifySigner(msgFor({ action: "delete" }, w), sig, w.address), 403);
    });
    it("rejects stale or future timestamps", () => {
      const now = 1_700_000_000;
      core.checkIssued(now - 60, now);
      throwsStatus(() => core.checkIssued(now - 3600, now), 401);
      throwsStatus(() => core.checkIssued(now + 3600, now), 401);
      throwsStatus(() => core.checkIssued("abc", now), 401);
    });

    // ethers signMessage is async; this helper blocks via a pre-computed map instead
    function awaitSync(wallet, m) { return wallet.signingKey.sign(ethers.hashMessage(m)).serialized; }
  });
});
