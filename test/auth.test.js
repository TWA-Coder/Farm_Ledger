// Portal sign-in (web/server/auth.js), staff keys (services/staff-keys.js) and what custody lets a session sign.
const { expect } = require("chai");
const crypto = require("crypto");
const { ethers } = require("hardhat");
const dbm = require("../web/server/db");
const auth = require("../web/server/auth");
const profiles = require("../web/server/profiles");
const { createStaffKeys } = require("../services/staff-keys");
const { createPinStore } = require("../services/pins");
const { allowedStaffTx, allowedMessage, allowedTyped } = require("../services/custody");
const signing = require("../web/shared/signing");

const req = (cookie, headers = {}) => new Request("http://localhost/api/auth", { headers: { ...(cookie ? { cookie } : {}), ...headers } });
const cookieOf = (setCookie) => setCookie.split(";")[0];
const expectFail = (fn, status, re) => {
  try { fn(); } catch (e) { expect(e.status).to.equal(status); if (re) expect(e.message).to.match(re); return; }
  throw new Error("expected a failure");
};

describe("Portal sign-in", function () {
  let db, staff, secret;
  const setPassword = (username, pw, mustChange = 0) => {
    const h = auth.hashPassword(pw);
    db.prepare("UPDATE staff_users SET pw_salt = ?, pw_hash = ?, must_change = ? WHERE username = ?").run(h.salt, h.hash, mustChange, username);
  };

  beforeEach(() => {
    db = dbm.open(":memory:");
    secret = crypto.randomBytes(32);
    staff = createStaffKeys({ db, secret });
  });

  describe("staff (username + password)", function () {
    it("stores no password and no key in the clear; the key opens only with the secret and only for its address", () => {
      const { address } = staff.create({ username: "grace.uw", name: "Grace Ingabire", role: "underwriter" });
      setPassword("grace.uw", "correct horse battery");
      const row = db.prepare("SELECT * FROM staff_users WHERE username = 'grace.uw'").get();
      expect(row.pw_hash).to.match(/^[0-9a-f]{128}$/);
      expect(JSON.stringify(row)).to.not.include("correct horse");
      expect(Object.keys(JSON.parse(row.enc_key)).sort()).to.deep.equal(["ct", "iv", "tag", "v"]);
      expect(staff.walletFor("grace.uw").address).to.equal(address);
      expect(() => createStaffKeys({ db, secret: crypto.randomBytes(32) }).walletFor("grace.uw")).to.throw(); // other secret
      db.prepare("UPDATE staff_users SET address = ? WHERE username = 'grace.uw'").run(ethers.Wallet.createRandom().address);
      expect(() => staff.walletFor("grace.uw")).to.throw(); // ciphertext bound to the address
    });

    it("validates usernames, roles and names, and refuses duplicates", () => {
      expect(() => staff.create({ username: "Bad Name", name: "X Y", role: "vet" })).to.throw(/username/);
      expect(() => staff.create({ username: "dr.u", name: "Dr Uwase", role: "oracle" })).to.throw(/Role/);
      expect(() => staff.create({ username: "dr.u", name: "1", role: "vet" })).to.throw(/name/);
      staff.create({ username: "dr.u", name: "Dr Uwase", role: "vet" });
      expect(() => staff.create({ username: "DR.U", name: "Dr Uwase", role: "vet" })).to.throw(/taken/);
      expect(profiles.all(db)[staff.rowOf("dr.u").address.toLowerCase()]).to.equal("Dr Uwase");
    });

    it("signs in with the right password only, the same answer for unknown users, and locks after 5 tries", () => {
      staff.create({ username: "eric", name: "Eric Nshimiyimana", role: "agent" });
      setPassword("eric", "agent-password-1");
      expectFail(() => auth.loginStaff("nobody", "x", db), 401, /Wrong username or password/);
      for (let i = 0; i < 4; i++) expectFail(() => auth.loginStaff("eric", "wrong-password", db), 401, /Wrong username or password/);
      expectFail(() => auth.loginStaff("eric", "wrong-password", db), 429, /locked/);
      expectFail(() => auth.loginStaff("eric", "agent-password-1", db), 429); // even the right one, while locked
      db.prepare("UPDATE staff_users SET locked_until = 0 WHERE username = 'eric'").run();
      const token = auth.loginStaff("ERIC", "agent-password-1", db);
      expect(auth.viewerOf(auth.sessionOf(req(`fl_session=${token}`), db), db)).to.include({ kind: "staff", username: "eric", role: "agent", name: "Eric Nshimiyimana" });
    });

    it("a disabled login cannot sign in, and its open sessions stop working", () => {
      staff.create({ username: "eric", name: "Eric N", role: "agent" });
      setPassword("eric", "agent-password-1");
      const token = auth.loginStaff("eric", "agent-password-1", db);
      db.prepare("UPDATE staff_users SET disabled = 1 WHERE username = 'eric'").run();
      expect(auth.viewerOf(auth.sessionOf(req(`fl_session=${token}`), db), db)).to.equal(null);
      expectFail(() => auth.loginStaff("eric", "agent-password-1", db), 401);
    });

    it("a one-time password must be changed, to a new password of at least 8 characters", () => {
      staff.create({ username: "dr.u", name: "Dr Uwase", role: "vet" });
      setPassword("dr.u", "kite-4821-moss", 1);
      const viewer = auth.viewerOf(auth.sessionOf(req(`fl_session=${auth.loginStaff("dr.u", "kite-4821-moss", db)}`), db), db);
      expect(viewer.mustChange).to.equal(true);
      expectFail(() => auth.changePassword(viewer, "wrong", "a-good-password", db), 401);
      expectFail(() => auth.changePassword(viewer, "kite-4821-moss", "short", db), 400);
      auth.changePassword(viewer, "kite-4821-moss", "a-good-password", db);
      expect(db.prepare("SELECT must_change FROM staff_users WHERE username = 'dr.u'").get().must_change).to.equal(0);
      expect(() => auth.loginStaff("dr.u", "a-good-password", db)).to.not.throw();
    });
  });

  describe("sessions", function () {
    it("keeps only a hash of the token; the cookie is HttpOnly and SameSite=Strict (Secure over https)", () => {
      const token = auth.createSession("farmer", "250788000001", db);
      expect(db.prepare("SELECT * FROM sessions").all().map((r) => r.id_hash)).to.not.include(token);
      expect(auth.sessionOf(req(`a=1; fl_session=${token}`), db)).to.include({ kind: "farmer", subject: "250788000001" });
      expect(auth.sessionOf(req("fl_session=forged"), db)).to.equal(null);
      const c = auth.sessionCookie(req(null), token);
      expect(c).to.include("HttpOnly").and.include("SameSite=Strict").and.not.include("Secure");
      expect(auth.sessionCookie(req(null, { "x-forwarded-proto": "https" }), token)).to.include("Secure");
    });

    it("expires, and ends on sign-out", () => {
      const token = auth.createSession("staff", "eric", db);
      db.prepare("UPDATE sessions SET expires_at = ?").run(Date.now() - 1);
      expect(auth.sessionOf(req(`fl_session=${token}`), db)).to.equal(null);
      const t2 = auth.createSession("staff", "eric", db);
      auth.endSession(req(`fl_session=${t2}`), db);
      expect(auth.sessionOf(req(`fl_session=${t2}`), db)).to.equal(null);
    });

    it("refuses changes without the X-FarmLedger header (cross-site requests cannot add it)", () => {
      expectFail(() => auth.guard(req(null)), 403);
      expect(() => auth.guard(req(null, { "x-farmledger": "1" }))).to.not.throw();
    });
  });

  describe("farmers (phone number + PIN, shared with USSD)", function () {
    const PHONE = "250788000777";
    beforeEach(() => {
      db.prepare("INSERT INTO phone_accounts (phone, account, owner, enc_key, status, created_at) VALUES (?, ?, ?, '{}', 'active', ?)")
        .run(PHONE, "0x00000000000000000000000000000000000000aa", "0x00000000000000000000000000000000000000bb", new Date().toISOString());
      createPinStore({ db }).setPin(PHONE, "2468");
      profiles.put("0x00000000000000000000000000000000000000aa", "Mukamana Aline", db);
    });

    it("signs in with the local or international number and the PIN", () => {
      const token = auth.loginFarmer("0788 000 777", "2468", db);
      expect(auth.viewerOf(auth.sessionOf(req(`fl_session=${token}`), db), db)).to.include({ kind: "farmer", role: "farmer", phone: PHONE, name: "Mukamana Aline" });
      expect(() => auth.loginFarmer("+250788000777", "2468", db)).to.not.throw();
    });

    it("3 wrong PINs lock the number for the portal AND the USSD menu", () => {
      expectFail(() => auth.loginFarmer(PHONE, "1111", db), 401);
      expectFail(() => auth.loginFarmer(PHONE, "1111", db), 401);
      expectFail(() => auth.loginFarmer(PHONE, "1111", db), 429, /locked/);
      expect(createPinStore({ db }).isLocked(PHONE)).to.equal(true); // the USSD menu sees the same lock
      expectFail(() => auth.loginFarmer(PHONE, "2468", db), 429);
    });

    it("an unknown number gets the same answer as a wrong PIN", () => {
      expectFail(() => auth.loginFarmer("0788999999", "2468", db), 401, /Wrong phone number or PIN/);
    });
  });

  describe("names (off-chain)", function () {
    it("staff see everyone's names; a farmer sees their own and the staff's, not other farmers'", () => {
      const { address: agent } = staff.create({ username: "eric", name: "Eric N", role: "agent" });
      profiles.put("0x00000000000000000000000000000000000000aa", "Aline M", db);
      profiles.put("0x00000000000000000000000000000000000000cc", "Jean H", db);
      const asStaff = auth.namesFor({ kind: "staff" }, db);
      expect(Object.values(asStaff)).to.include.members(["Eric N", "Aline M", "Jean H"]);
      const asAline = auth.namesFor({ kind: "farmer", address: "0x00000000000000000000000000000000000000AA" }, db);
      expect(asAline).to.deep.equal({ "0x00000000000000000000000000000000000000aa": "Aline M", [agent.toLowerCase()]: "Eric N" });
    });

    it("accepts real names and refuses junk", () => {
      expect(profiles.cleanName("  Uwase   Marie-Claire ")).to.equal("Uwase Marie-Claire");
      expect(profiles.cleanName("N'Dayishimiye É.")).to.equal("N'Dayishimiye É.");
      expect(() => profiles.cleanName("x")).to.throw();
      expect(() => profiles.cleanName("<script>")).to.throw();
      expect(() => profiles.cleanName("a".repeat(61))).to.throw();
    });
  });

  describe("what custody signs for a session", function () {
    const ledger = "0x1000000000000000000000000000000000000001";
    const desk = "0x2000000000000000000000000000000000000002";
    it("staff transactions only to FarmLedger contracts, without coins", () => {
      const check = allowedStaffTx([ledger, desk, null]);
      expect(check({ to: ledger, data: "0x12345678" })).to.equal(null);
      expect(check({ to: desk.toUpperCase().replace("0X", "0x"), data: "0x" })).to.equal(null);
      expect(check({ to: ethers.Wallet.createRandom().address, data: "0x" })).to.match(/not a FarmLedger contract/);
      expect(check({ to: ledger, data: "0x", value: "1" })).to.match(/no coins/);
      expect(check({ to: ledger, data: "nope" })).to.match(/unreadable/);
    });

    it("messages only in FarmLedger's document-request format; typed data only for the FarmLedger contract", () => {
      const m = signing.message({ action: "upload", applicant: ledger, application: "app-12345678", issued: 1 });
      expect(allowedMessage(m)).to.equal(null);
      expect(allowedMessage("Sign in to SomeDex\nnonce: 1")).to.match(/only FarmLedger/);
      expect(allowedTyped({ domain: { name: "FarmLedger", verifyingContract: ledger } }, ledger)).to.equal(null);
      expect(allowedTyped({ domain: { name: "Permit", verifyingContract: ledger } }, ledger)).to.match(/only FarmLedger/);
      expect(allowedTyped({ domain: { name: "FarmLedger", verifyingContract: desk } }, ledger)).to.match(/only FarmLedger/);
    });
  });
});
