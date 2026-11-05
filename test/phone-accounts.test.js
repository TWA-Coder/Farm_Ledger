// Phone accounts: farmers on basic phones get a smart account whose key the server holds encrypted
// (services/phone-accounts.js), driven from USSD (services/ussd-core.js). Real EntryPoint, factory and paymaster;
// operations are submitted with handleOps the way the bundler does.
const { expect } = require("chai");
const crypto = require("crypto");
const { artifacts } = require("hardhat");
const { ethers, loadFixture, hash, farmerFixture } = require("./helpers");
const uo = require("../web/shared/userop");
const dbm = require("../web/server/db");
const contacts = require("../web/server/contacts");
const { createUssd } = require("../services/ussd-core");
const { createPhoneAccounts, CODE_TRIES } = require("../services/phone-accounts");

const NEW = "250788000500";   // a farmer with only a basic phone
const NID = "1199580012345678";
const OTHER = "250788000600"; // the same farmer's next SIM
const ALINE = "250788000001"; // registered on the web with her own key (farmerFixture)
const PIN = "4321";
const HOUR = 3600 * 1000;

async function fixture() {
  const base = await farmerFixture();
  const signers = await ethers.getSigners();
  const relayer = signers[10];
  const entryPoint = await (await ethers.getContractFactory("EntryPoint")).deploy();
  const factory = await (await ethers.getContractFactory("SimpleAccountFactory")).deploy(await entryPoint.getAddress());
  const paymaster = await (await ethers.getContractFactory("FarmLedgerPaymaster")).deploy(
    await entryPoint.getAddress(), [base.ledgerAddr, await base.token.getAddress()], ethers.parseEther("0.05"));
  await paymaster.deposit({ value: ethers.parseEther("10") });
  const agent = signers[13];
  await base.ledger.grantRole(await base.ledger.CLAIMS_AGENT_ROLE(), agent.address);
  const aa = { entryPoint: await entryPoint.getAddress(), accountFactory: await factory.getAddress(), paymaster: await paymaster.getAddress(), bundlerUrl: "unused" };
  return { ...base, entryPoint, paymaster, relayer, agent, aa };
}

describe("Phone accounts (server-held key, USSD + SMS)", function () {
  let ctx, db, accounts, u, sms, clock, abi, secret;

  // What the bundler does: submit the signed operation with handleOps and report the outcome.
  const transport = (entryPoint, relayer) => async (op) => {
    const packed = uo.packUserOp(op);
    const rc = await (await entryPoint.connect(relayer).handleOps([packed], relayer.address)).wait();
    const evs = rc.logs.map((l) => { try { return entryPoint.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
    const ev = evs.find((e) => e.name === "UserOperationEvent");
    return { success: ev.args.success, reason: evs.find((e) => e.name === "UserOperationRevertReason")?.args.revertReason || "0x", receipt: { transactionHash: rc.hash } };
  };

  function build({ delayMs = 48 * HOUR, key = secret } = {}) {
    accounts = createPhoneAccounts({
      db, provider: ethers.provider, aa: ctx.aa, ledgerAddress: ctx.ledgerAddr, abi, secret: key,
      sendSms: async (phone, text) => { sms.push({ phone, text }); }, transport: transport(ctx.entryPoint, ctx.relayer),
      now: () => clock, recoveryDelayMs: delayMs,
    });
    u = createUssd({ provider: ethers.provider, abi, ledgerAddress: ctx.ledgerAddr, agent: ctx.agent, accounts, db });
  }

  beforeEach(async () => {
    ctx = await loadFixture(fixture);
    abi = { ledger: (await artifacts.readArtifact("FarmLedger")).abi, token: (await artifacts.readArtifact("MockRWF")).abi };
    db = dbm.open(":memory:");
    sms = [];
    clock = Date.now();
    secret = crypto.randomBytes(32);
    build();
  });

  async function dial(phone, inputs) {
    const sessionId = "s-" + Math.random();
    let reply;
    for (let k = 0; k <= inputs.length; k++) reply = await u.handle({ sessionId, phoneNumber: "+" + phone, text: inputs.slice(0, k).join("*") });
    return reply;
  }
  const lastCode = (phone) => /code: (\d{6})/.exec([...sms].reverse().find((m) => m.phone === phone).text)[1];
  async function registerByUssd(phone = NEW, nid = NID) {
    expect(await dial(phone, ["1", nid, "1"])).to.match(/^END We sent you a 6-digit code/);
    expect(await dial(phone, [lastCode(phone), PIN, PIN])).to.match(/^CON PIN saved\./);
    return accounts.accountOf(phone).account;
  }

  describe("registration from a basic phone", function () {
    it("a new number registers with its National ID and an SMS code, then sets a PIN; the farmer pays no fees", async () => {
      expect(await dial(NEW, [])).to.equal("CON Welcome to FarmLedger\n1. Register\n2. I changed my number");
      expect(await dial(NEW, ["1"])).to.match(/National ID/);
      expect(await dial(NEW, ["1", NID])).to.equal("CON Register ID ending 5678 with this number?\n1. Yes\n2. No");
      expect(await dial(NEW, ["1", NID, "1"])).to.match(/^END We sent you a 6-digit code by SMS/);
      expect(sms).to.have.length(1);
      expect(sms[0].phone).to.equal(NEW);
      expect(sms[0].text).to.not.include(NID); // the code SMS never repeats the ID

      expect(await dial(NEW, [])).to.equal("CON Enter the 6-digit code from the SMS:\n0. Send a new code");
      expect(await dial(NEW, [lastCode(NEW)])).to.equal("CON Registered! Your FarmLedger account is ready.\nChoose a 4-digit PIN to protect it:");
      const { account, status } = accounts.accountOf(NEW);
      expect(status).to.equal("active");

      const f = await ctx.ledger.getFarmer(account);
      expect(f.exists).to.equal(true);
      expect(f.idHash).to.equal(hash(NID));
      expect(f.phoneHash).to.equal(hash(NEW));
      expect(await ethers.provider.getCode(account)).to.not.equal("0x"); // the smart account was deployed by that operation
      expect(await ethers.provider.getBalance(account)).to.equal(0n);
      expect(contacts.read(db)[account.toLowerCase()].phone).to.equal(NEW); // payout SMS will find the number

      // PIN, then the full menu with account services
      expect(await dial(NEW, [PIN])).to.equal("CON Repeat your PIN:");
      expect(await dial(NEW, [PIN, PIN])).to.equal("CON PIN saved.\nFarmLedger\n1. My policies\n2. Report a claim\n3. Claim status\n4. Reset PIN");
    });

    it("the owner key is stored encrypted and bound to its account; the wrong secret cannot open it", async () => {
      const account = await registerByUssd();
      const row = db.prepare("SELECT * FROM phone_accounts WHERE phone = ?").get(NEW);
      const enc = JSON.parse(row.enc_key);
      expect(Object.keys(enc).sort()).to.deep.equal(["ct", "iv", "tag", "v"]);
      // a signer from the stored key controls exactly this account
      expect(await accounts.signerFor(NEW).getAddress()).to.equal(account);
      expect(accounts.signerFor(NEW).owner.address).to.equal(row.owner);

      build({ key: crypto.randomBytes(32) }); // same database, different secret
      expect(() => accounts.signerFor(NEW)).to.throw();
      build();
      db.prepare("UPDATE phone_accounts SET account = ? WHERE phone = ?").run(ethers.Wallet.createRandom().address, NEW); // row moved to another account
      expect(() => accounts.signerFor(NEW)).to.throw();
    });

    it("refuses a malformed or already registered National ID before sending any SMS", async () => {
      expect(await dial(NEW, ["1", "12345"])).to.match(/^END A National ID has 16 digits/);
      expect(await dial(NEW, ["1", "1199080012345678"])).to.match(/^END This National ID is already registered/); // Aline's
      expect(await dial(NEW, ["1", NID, "2"])).to.equal("END Cancelled.");
      expect(sms).to.have.length(0);
    });

    it("codes: limited tries, expire after 10 minutes, at most one per minute and five a day", async () => {
      await dial(NEW, ["1", NID, "1"]);
      expect(await dial(NEW, [])).to.match(/^CON Enter the 6-digit code/); // a pending code: the next dial asks for it
      const good = lastCode(NEW);
      const bad = good === "000000" ? "111111" : "000000";
      for (let i = 1; i < CODE_TRIES; i++) expect(await dial(NEW, [bad])).to.equal(`END Wrong code. ${CODE_TRIES - i} tries left. Dial again.`);
      expect(await dial(NEW, [bad])).to.match(/no longer works/);
      expect(await dial(NEW, [])).to.equal("CON Welcome to FarmLedger\n1. Register\n2. I changed my number");

      expect(await dial(NEW, ["1", NID, "1"])).to.match(/Wait \d+ seconds/); // resend throttle, even for a voided code
      clock += 61_000;
      await dial(NEW, ["1", NID, "1"]); // code 2
      clock += 11 * 60_000; // expired
      expect(await dial(NEW, [])).to.match(/^CON Welcome/);
      await dial(NEW, ["1", NID, "1"]); // code 3
      expect(await dial(NEW, ["0"])).to.match(/Wait \d+ seconds/);
      clock += 61_000;
      expect(await dial(NEW, ["0"])).to.equal("END We sent a new code by SMS. Dial again within 10 minutes and enter it."); // code 4
      clock += 61_000;
      await dial(NEW, ["0"]); // code 5
      clock += 61_000;
      expect(await dial(NEW, ["0"])).to.equal("END Too many codes today. Try again tomorrow.");
      expect(sms).to.have.length(5);
      expect(accounts.accountOf(NEW)).to.equal(null);
      expect(await dial(NEW, [lastCode(NEW), PIN, PIN])).to.match(/^CON PIN saved/); // the last code still works
    });

    it("a registration that fails on-chain leaves no key behind", async () => {
      await expect(accounts.register(NEW, hash("1199080012345678"))).to.be.rejected; // Aline's ID: IdAlreadyUsed
      expect(accounts.accountOf(NEW)).to.equal(null);
    });
  });

  describe("PIN reset", function () {
    it("needs the National ID on the account; three wrong IDs lock the number; the farmer is told by SMS", async () => {
      await registerByUssd();
      expect(await dial(NEW, ["4"])).to.equal("CON Enter your National ID number:");
      expect(await dial(NEW, ["4", "1199580000000000"])).to.equal("END That ID does not match this account.");
      expect(await dial(NEW, ["4", NID, "1111", "1111"])).to.equal("END PIN changed.");
      expect(sms.at(-1).text).to.match(/PIN was changed/);
      expect(await dial(NEW, ["4", "1199580000000000"])).to.equal("END That ID does not match this account.");
      await dial(NEW, ["4", "1199580000000000"]);
      expect(await dial(NEW, ["4", "1199580000000000"])).to.match(/locked/);
      expect(await dial(NEW, ["4", NID])).to.match(/locked/);
    });

    it("also works for farmers registered on the website (their PIN is only the USSD gate)", async () => {
      await dial(ALINE, [PIN, PIN]);
      expect(await dial(ALINE, ["4", "1199080012345678", "2222", "2222"])).to.equal("END PIN changed.");
    });
  });

  describe("number change (recovery)", function () {
    async function requestMove() {
      expect(await dial(OTHER, ["2"])).to.match(/OLD phone number/);
      expect(await dial(OTHER, ["2", "0788000500", NID])).to.match(/^END We sent a 6-digit code by SMS to this phone/);
      return dial(OTHER, [lastCode(OTHER)]);
    }

    it("moves the SAME account to the new number after the waiting period; the old number is warned first", async () => {
      const account = await registerByUssd();
      expect(await requestMove()).to.match(/^END Request saved\. For your safety the account moves from/);
      const warn = sms.find((m) => m.phone === NEW && /move your account/.test(m.text));
      expect(warn.text).to.include("+25078...00").and.to.include("choose 5 to cancel");
      for (const m of sms) expect(m.text.length, m.text).to.be.at.most(160); // one SMS each, even with a long shortcode


      expect(await dial(NEW, [])).to.match(/5\. Cancel number change$/); // the old number can still cancel
      expect(await dial(OTHER, [])).to.match(/^END Your number change is waiting/);

      clock += 48 * HOUR + 1;
      expect(await dial(OTHER, [])).to.equal("CON Your account is now on this number.\nChoose a 4-digit PIN to protect it:");
      expect(accounts.accountOf(OTHER).account).to.equal(account);
      expect(accounts.accountOf(NEW)).to.equal(null);
      expect((await ctx.ledger.getFarmer(account)).phoneHash).to.equal(hash(OTHER)); // updatePhone from the account itself
      expect(contacts.read(db)[account.toLowerCase()].phone).to.equal(OTHER);

      expect(await dial(OTHER, [PIN, PIN])).to.match(/^CON PIN saved\.\nFarmLedger/);
      expect(await dial(NEW, [])).to.match(/^CON Welcome to FarmLedger/); // the old SIM no longer reaches the account
    });

    it("the old number can cancel; the new number is told and gets nothing", async () => {
      const account = await registerByUssd();
      await requestMove();
      expect(await dial(NEW, ["5", "1"])).to.equal("END Number change cancelled. Your account stays on this number.");
      expect(sms.at(-1)).to.deep.include({ phone: OTHER });
      clock += 49 * HOUR;
      expect(await dial(OTHER, [])).to.match(/^CON Welcome/);
      expect((await ctx.ledger.getFarmer(account)).phoneHash).to.equal(hash(NEW));
    });

    it("gives one answer for an unknown number and a wrong ID, and locks after three tries", async () => {
      await registerByUssd();
      expect(await dial(OTHER, ["2", "0788999999", NID])).to.match(/^END No phone account matches/);
      expect(await dial(OTHER, ["2", "0788000500", "1199580000000000"])).to.match(/^END No phone account matches/);
      expect(await dial(OTHER, ["2", "0788000500", "1199580000000000"])).to.match(/locked/);
      expect(sms.filter((m) => m.phone === OTHER)).to.have.length(0);
    });

    it("web-registered farmers (own key) are not movable from USSD", async () => {
      await dial(ALINE, [PIN, PIN]);
      expect(await dial(OTHER, ["2", "0788000001", "1199080012345678"])).to.match(/^END No phone account matches.*website/);
    });

    it("the operator can release a request early; with no waiting period the move completes at once", async () => {
      const account = await registerByUssd();
      await requestMove();
      const [q] = accounts.requests("waiting");
      expect(accounts.releaseNow(q.id)).to.equal(true);
      expect(await dial(OTHER, [])).to.match(/^CON Your account is now on this number/);

      build({ delayMs: 0 });
      clock += 2 * 60_000;
      await dial(NEW, ["2", "0788000600", NID]); // and back again, instantly
      expect(await dial(NEW, [lastCode(NEW)])).to.match(/^CON Your account is now on this number/);
      expect(accounts.accountOf(NEW).account).to.equal(account);
    });
  });
});
