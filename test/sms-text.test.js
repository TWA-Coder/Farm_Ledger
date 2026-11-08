// SMS texts (services/sms-text.js): English and Kinyarwanda have the same messages, and each fits one SMS
// (160 characters) with realistic numbers, both with a short code and with the "USSD code" wording.
const { expect } = require("chai");
const { SMS } = require("../services/sms-text");

const LIMIT = 160;

const shape = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "function" ? "fn" : Array.isArray(v) ? `array:${v.length}` : typeof v]));

describe("SMS texts (English and Kinyarwanda)", function () {
  let saved;
  before(() => { saved = process.env.USSD_SHORTCODE; });
  after(() => { if (saved === undefined) delete process.env.USSD_SHORTCODE; else process.env.USSD_SHORTCODE = saved; });

  it("Kinyarwanda has every message English has", () => {
    expect(shape(SMS.rw)).to.deep.equal(shape(SMS.en));
  });

  it("writes dates without English month names in Kinyarwanda", () => {
    const ts = Date.UTC(2026, 10, 12, 12) / 1000;
    expect(SMS.rw.day(ts)).to.match(/^\d{2}\/\d{2}\/2026$/);
    expect(SMS.rw.when(ts * 1000)).to.match(/^\d{2}\/\d{2}\/2026 \d{2}:\d{2}$/);
    expect(SMS.en.day(ts)).to.match(/Nov 2026/);
  });

  for (const shortcode of ["*384*12345#", null]) {
    for (const lang of ["en", "rw"]) {
      it(`${lang}: every message fits one SMS (${shortcode ? "short code" : "no short code set"})`, () => {
        if (shortcode) process.env.USSD_SHORTCODE = shortcode; else delete process.env.USSD_SHORTCODE;
        const s = SMS[lang];
        const dial = s.dial(), day = s.day(Date.UTC(2026, 10, 12) / 1000), when = s.when(Date.UTC(2026, 10, 12, 14, 30));
        const id = 9999, big = "5,000,000", mid = "450,000";
        const longestCover = s.coverWord.reduce((a, b) => (b.length > a.length ? b : a));
        const msgs = {
          codeRegister: s.codeRegister("123456", dial),
          codeMove: s.codeMove("123456", dial),
          moveRequested: s.moveRequested("+25078...56", dial, when),
          moveCancelled: s.moveCancelled,
          moveDone: s.moveDone(dial),
          pinChanged: s.pinChanged,
          welcome: s.welcome(dial),
          purchasedBooked: s.policyPurchased(id, s.stateBooked(day), day, big, s.paidWithSubsidy(mid, mid)),
          purchasedActive: s.policyPurchased(id, s.stateActive, day, big, s.paidPremium(mid)),
          policyExpired: s.policyExpired(id),
          claimFiled: s.claimFiled(id, id),
          claimRejected: s.claimRejected(id),
          cropClaimFiled: s.cropClaimFiled(id, id),
          cropClaimRejected: s.cropClaimRejected(id),
          cropClaimSuperseded: s.cropClaimSuperseded(id, id),
          payoutAuto: s.payout(big, id, s.whyAuto),
          payoutVets: s.payout(big, id, s.whyVets),
          payoutReviewers: s.payout(big, id, s.whyReviewers),
          agentAssigned: s.agentAssigned("250788000015"),
          applicationSubmitted: s.applicationSubmitted(longestCover, big, id),
          contractReady: s.contractReady(id, big, mid, dial, day),
          applicationRejected: s.applicationRejected(id),
          momoNotStarted: s.momoNotStarted(mid),
          momoNotCompleted: s.momoNotCompleted(mid, "PAYER_LIMIT_REACHED"),
          momoRefunding: s.momoRefunding("OfferExpired", mid),
          momoRefunded: s.momoRefunded(mid),
          momoPayout: s.momoPayout(big, id),
        };
        expect(Object.keys(msgs).length).to.be.greaterThan(25);
        for (const [name, text] of Object.entries(msgs)) expect(text.length, `${lang} ${name} (${text.length}): ${text}`).to.be.at.most(LIMIT);
      });
    }
  }
});
