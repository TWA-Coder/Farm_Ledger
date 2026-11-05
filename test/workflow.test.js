// End-to-end farmer journey, exactly as the portal drives it: registration -> farm -> policy -> monitoring ->
// claim with photo evidence -> vet decisions -> payout. Also covers the pieces the portal relies on off-chain:
// claim evidence storage and vet access, the oracle's data-source log, form validation and error messages.
const { expect } = require("chai");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  ethers, loadFixture, time, b32, hash, Metric, PolicyStatus, ClaimStatus, deployFixture, signAttestation,
} = require("./helpers");
const core = require("../web/server/documents-core");
const http = require("../web/server/http");
const claims = require("../web/shared/claims");
const req = require("../web/shared/requirements");
const validation = require("../web/shared/validation");
const { PLAIN } = require("../web/shared/errors");
const readingsLog = require("../services/readings-log");
const dbm = require("../web/server/db");
const contacts = require("../web/server/contacts");

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(512)]);
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const now = () => Math.floor(Date.now() / 1000);
const eventsOf = (ledger, rc, name) => rc.logs.map((l) => { try { return ledger.interface.parseLog(l); } catch { return null; } }).filter((e) => e && e.name === name);

describe("End-to-end insurance workflow", function () {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("crop journey: register, add plot, buy drought cover, reading triggers an automatic payout", async () => {
    const { ledger, token, farmer, oracle, underwriter } = await loadFixture(deployFixture);

    // 1. onboarding (validated the same way as the portal form)
    expect(validation.validateRegistration("1199080012345678", "250788000001")).to.deep.equal({});
    await ledger.connect(farmer).registerFarmer(hash("1199080012345678"), hash("250788000001"));
    // 2. farm details: Bugesera district centre, 0.5 ha of maize
    expect(validation.validatePlot({ lat: "-2.15", lon: "30.15", ha: "0.5" })).to.deep.equal({});
    await ledger.connect(farmer).registerPlot(-2_150_000, 30_150_000, 5000, b32("MAIZE"), hash("plot:-2.15,30.15:0.5:MAIZE"));
    // 3-5. product discovery, quote, payment and policy creation
    const quote = await ledger.quotePremium(1, 200_000);
    expect(quote).to.equal(20_000n);
    const before = await token.balanceOf(farmer.address);
    const rc = await (await ledger.connect(farmer).buyPolicy(1, 1, 200_000)).wait();
    const [bought] = eventsOf(ledger, rc, "PolicyPurchased");
    expect(bought.args.premium).to.equal(quote);
    expect((await ledger.poolStats(underwriter.address)).reserved).to.equal(200_000n);

    // 6. monitoring: a reading from before cover started does not count
    const startedAt = Number(bought.args.start);
    await ledger.connect(oracle).postReading(1, Metric.Rainfall, 500, startedAt - 1);
    expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.Active);
    // a normal season reading does not pay
    await ledger.connect(oracle).postReading(1, Metric.Rainfall, 2500, await time.latest());
    expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.Active);
    const latest = await ledger.getLatestReading(1, Metric.Rainfall);
    expect(latest.value).to.equal(2500n);

    // 9. drought reading -> payout in the same transaction
    const prc = await (await ledger.connect(oracle).postReading(1, Metric.Rainfall, 700, await time.latest())).wait();
    const [paid] = eventsOf(ledger, prc, "PayoutExecuted");
    expect(paid.args.automatic).to.equal(true);
    expect(paid.args.amount).to.equal(200_000n);
    // 10. status tracking
    expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.PaidOut);
    expect(await token.balanceOf(farmer.address)).to.equal(before - quote + 200_000n);
    expect((await ledger.poolStats(underwriter.address)).reserved).to.equal(0n);
  });

  it("cattle journey: claim photo is stored, bound to the claim, viewable by certified vets only, and 2 vets pay out", async () => {
    const { ledger, token, farmer, vet, vet2, outsider, admin, underwriter } = await loadFixture(deployFixture);
    await ledger.connect(admin).setVetQuorum(2);
    await ledger.connect(farmer).registerFarmer(hash("1199080012345678"), hash("250788000001"));
    expect(validation.validateAnimal({ tag: "990000015066386", year: "2021" }, 2026)).to.deep.equal({});
    await ledger.connect(farmer).registerAnimal(b32("990000015066386"), b32("FRIESIAN"), 2021, hash("animal:990000015066386"));
    await ledger.connect(farmer).buyPolicy(4, 1, 300_000);

    // 7. claim initiation is refused during the waiting period
    await expect(ledger.connect(farmer).fileClaim(1, "0x" + sha256(JPG))).to.be.revertedWithCustomError(ledger, "WaitingPeriodNotElapsed");
    await time.increase(7 * 24 * 3600 + 1);

    // the portal uploads the photo first, then files the claim with the photo's SHA-256 as evidence
    const evidenceHash = claims.evidenceHashFromSha(sha256(JPG));
    const app = claims.claimApplicationId(1, evidenceHash);
    expect(claims.isClaimApplication(app)).to.equal(true);
    const store = new core.DocumentStore(dir);
    store.put({ applicant: farmer.address, application: app, document: claims.EVIDENCE_DOCUMENT, buffer: JPG, originalName: "cow.jpg" });
    const frc = await (await ledger.connect(farmer).fileClaim(1, evidenceHash)).wait();
    const [filed] = eventsOf(ledger, frc, "ClaimFiled");
    expect(filed.args.evidenceHash).to.equal(evidenceHash);

    // anyone reading the claim on-chain can locate the photo and check it is the committed file
    const c = await ledger.getClaim(1);
    const hit = store.get({ applicant: farmer.address, application: claims.claimApplicationId(c.policyId, c.evidenceHash), document: claims.EVIDENCE_DOCUMENT });
    expect("0x" + sha256(fs.readFileSync(hit.path))).to.equal(c.evidenceHash);

    // 8. vet access to the photo: certified vets yes, anyone else no (certification read from the contract)
    const isCertifiedVet = (a) => ledger.isCertifiedVet(a);
    const UW = await ledger.UNDERWRITER_ROLE();
    const isUnderwriter = (a) => ledger.hasRole(UW, a);
    const viewAs = async (wallet) => {
      const params = { action: "view", applicant: farmer.address, application: app, document: claims.EVIDENCE_DOCUMENT, issued: now() };
      params.signature = await wallet.signMessage(core.message(params));
      return http.authenticateView(params, wallet.address, { isCertifiedVet, isUnderwriter });
    };
    expect((await viewAs(vet)).toLowerCase()).to.equal(vet.address.toLowerCase());
    await expect(viewAs(outsider)).to.be.rejectedWith("Only a currently certified veterinarian");
    // ...and the vet exception covers claim evidence only, never application documents
    const idParams = { action: "view", applicant: farmer.address, application: "11111111-aaaa-bbbb-cccc-222222222222", document: "national_id", issued: now() };
    idParams.signature = await vet.signMessage(core.message(idParams));
    await expect(http.authenticateView(idParams, vet.address, { isCertifiedVet, isUnderwriter })).to.be.rejectedWith("Signature does not match");
    // the underwriter (insurer) may open application documents, e.g. for the policy document
    const uwParams = { ...idParams, issued: now() };
    uwParams.signature = await underwriter.signMessage(core.message(uwParams));
    expect((await http.authenticateView(uwParams, underwriter.address, { isCertifiedVet, isUnderwriter })).toLowerCase()).to.equal(underwriter.address.toLowerCase());

    // 8-9. multisignature decision: first vet does not pay, second completes the quorum and pays
    const deadline = (await time.latest()) + 3600;
    const tagId = b32("990000015066386");
    const before = await token.balanceOf(farmer.address);
    await ledger.settleLivestockClaim(1, true, deadline, await signAttestation(vet, ledger, { claimId: 1, policyId: 1, tagId, approved: true, deadline }));
    expect((await ledger.getClaim(1)).status).to.equal(ClaimStatus.Pending);
    await expect(ledger.settleLivestockClaim(1, true, deadline, await signAttestation(outsider, ledger, { claimId: 1, policyId: 1, tagId, approved: true, deadline })))
      .to.be.revertedWithCustomError(ledger, "InvalidVet");
    await ledger.settleLivestockClaim(1, true, deadline, await signAttestation(vet2, ledger, { claimId: 1, policyId: 1, tagId, approved: true, deadline }));
    expect((await ledger.getClaim(1)).status).to.equal(ClaimStatus.Approved);
    expect((await ledger.getPolicy(1)).status).to.equal(PolicyStatus.PaidOut);
    expect(await token.balanceOf(farmer.address)).to.equal(before + 300_000n);
    expect((await ledger.getAnimal(1)).deceased).to.equal(true);
  });

  it("refuses the actions the portal guards against", async () => {
    const { ledger, token, farmer, outsider } = await loadFixture(deployFixture);
    // unregistered account cannot buy
    await expect(ledger.connect(outsider).buyPolicy(1, 1, 1000)).to.be.revertedWithCustomError(ledger, "NotRegistered");
    // a registered farmer without enough money cannot buy (the portal checks the balance first)
    await ledger.connect(outsider).registerFarmer(hash("1199000000000009"), hash("250788000009"));
    await ledger.connect(outsider).registerPlot(-2_150_000, 30_150_000, 5000, b32("MAIZE"), hash("p"));
    await token.connect(outsider).approve(await ledger.getAddress(), ethers.MaxUint256);
    await expect(ledger.connect(outsider).buyPolicy(1, 1, 200_000)).to.be.reverted;
    // the same National ID cannot register twice
    await expect(ledger.connect(farmer).registerFarmer(hash("1199000000000009"), hash("250788000010"))).to.be.revertedWithCustomError(ledger, "IdAlreadyUsed");
  });
});

describe("Portal support code", function () {
  it("claim evidence ids are deterministic and reject bad input", () => {
    const h = "0x" + "ab".repeat(32);
    expect(claims.claimApplicationId(7, h)).to.equal("claim-7-abababababab");
    expect(claims.claimApplicationId(7, h)).to.match(/^[a-zA-Z0-9-]{8,64}$/); // accepted by the document store
    expect(() => claims.claimApplicationId(0, h)).to.throw();
    expect(() => claims.evidenceHashFromSha("1234")).to.throw();
    expect(claims.isClaimApplication("11111111-aaaa-bbbb-cccc-222222222222")).to.equal(false);
  });

  it("claim photo is never demanded in a policy application", () => {
    for (const cover of [0, 1, 2, 3]) expect(req.documentsFor({ cover }).map((d) => d.id)).to.not.include("claim_photo");
  });

  it("oracle readings log records the real source and is idempotent", () => {
    const db = dbm.open(":memory:");
    {
      expect(readingsLog.sourceFor("nasa", Metric.Rainfall)).to.equal("nasa-power");
      expect(readingsLog.sourceFor("nasa", Metric.NDVI)).to.equal("sample"); // no live NDVI feed
      expect(readingsLog.sourceFor("mock", Metric.Rainfall)).to.equal("sample");
      const tx = "0x" + "cd".repeat(32);
      readingsLog.append({ tx, plotId: 1, metric: 0, value: 700, source: "sample" }, db);
      readingsLog.append({ tx: tx.toUpperCase().replace("0X", "0x"), plotId: 1, metric: 0, value: 700, source: "sample" }, db);
      expect(readingsLog.read(db)).to.have.length(1);
      expect(readingsLog.sources(db)).to.deep.equal({ [tx]: "sample" });
      expect(() => readingsLog.append({ tx, source: "made-up" }, db)).to.throw();
      expect(() => readingsLog.append({ tx: "0x12", source: "sample" }, db)).to.throw();
    }
  });

  it("form validation matches the farmer-facing rules", () => {
    expect(validation.validateRegistration("123", "250788000001")).to.have.property("nid");
    expect(validation.validateRegistration("1199080012345678", "0788000001")).to.have.property("phone");
    expect(validation.validatePlot({ lat: "1.5", lon: "30.1", ha: "1" })).to.have.property("lat"); // north of Rwanda
    expect(validation.validatePlot({ lat: "-2.1", lon: "31.5", ha: "1" })).to.have.property("lon");
    expect(validation.validatePlot({ lat: "-2.1", lon: "30.1", ha: "0" })).to.have.property("ha");
    expect(validation.validateAnimal({ tag: "", year: "2020" }, 2026)).to.have.property("tag");
    expect(validation.validateAnimal({ tag: "RW TAG", year: "2020" }, 2026)).to.have.property("tag");
    expect(validation.validateAnimal({ tag: "RW-1", year: "1990" }, 2026)).to.have.property("year");
  });

  it("SMS contact numbers are accepted only when signed by the farmer and matching the on-chain phone hash", async () => {
    const db = dbm.open(":memory:");
    const w = ethers.Wallet.createRandom(), other = ethers.Wallet.createRandom();
    const phone = "250788000003";
    const phoneHashOf = async (a) => (a.toLowerCase() === w.address.toLowerCase() ? hash(phone) : null);
    const req = async (signer, ph = phone, address = w.address) => {
      const issued = now();
      return { address, phone: ph, issued, signature: await signer.signMessage(contacts.contactMessage({ address, phone: ph, issued })) };
    };
    {
      await expect(contacts.save(await req(w, "250788999999"), { phoneHashOf, db })).to.be.rejectedWith("does not match");
      await expect(contacts.save(await req(other), { phoneHashOf, db })).to.be.rejectedWith("Signature does not match");
      await expect(contacts.save(await req(other, phone, other.address), { phoneHashOf, db })).to.be.rejectedWith("not registered");
      await expect(contacts.save(await req(w, "0788"), { phoneHashOf, db })).to.be.rejectedWith("Invalid phone");
      expect(await contacts.save(await req(w), { phoneHashOf, db })).to.deep.equal({ saved: true });
      expect(contacts.read(db)[w.address.toLowerCase()].phone).to.equal(phone);
      expect(contacts.phoneForHash(hash(phone), db)).to.equal(phone);
      expect(contacts.phoneForHash(hash("250788999999"), db)).to.equal(null);
    }
  });

  it("every FarmLedger and CropClaims contract error has a plain-language message", () => {
    const src = ["FarmLedger.sol", "CropClaims.sol"].map((f) => fs.readFileSync(path.join(__dirname, "..", "contracts", f), "utf8")).join("\n");
    const names = [...src.matchAll(/^\s*error (\w+)\(/gm)].map((m) => m[1]);
    expect(names.length).to.be.greaterThan(10);
    const missing = names.filter((n) => !PLAIN[n]);
    expect(missing, `missing messages: ${missing.join(", ")}`).to.deep.equal([]);
  });
});
