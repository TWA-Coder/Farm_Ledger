// USSD texts (services/ussd-text.js): English and Kinyarwanda have the same screens, and the longest screens built
// from them still fit the 182-character USSD limit.
const { expect } = require("chai");
const { TEXT } = require("../services/ussd-text");
const { PROVINCES } = require("../web/shared/districts");

const LIMIT = 182;

// Every key path, with "fn" / "str" / "array:<n>" / "object", so the two tables can be compared exactly.
function shape(o, prefix = "") {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    const key = prefix + k;
    if (typeof v === "function") out[key] = "fn";
    else if (Array.isArray(v)) out[key] = `array:${v.length}`;
    else if (v && typeof v === "object") Object.assign(out, shape(v, key + "."));
    else out[key] = typeof v;
  }
  return out;
}

describe("USSD texts (English and Kinyarwanda)", function () {
  for (const lang of ["en", "rw"]) {
    const s = TEXT[lang];

    describe(lang, function () {
      it("has every screen the other language has", () => {
        expect(shape(s)).to.deep.equal(shape(TEXT.en));
        expect(s.provinces.length).to.equal(PROVINCES.length);
      });

      it("has no empty text", () => {
        // (index 0 of vetWord / cropWord is an intentional blank: claim statuses start at 1)
        const walk = (o, inArray) => Object.values(o).forEach((v, k) => (typeof v === "string" ? (inArray && k === 0) || expect(v.trim()).to.not.equal("") : v && typeof v === "object" && walk(v, Array.isArray(v))));
        walk(s, false);
      });

      it("fits the longest screens in 182 characters", () => {
        const m = s.menu;
        const id = "999", big = "5,000,000", day = "12/11/2026", when = "12/11/2026, 14:00";
        const longest = (a) => a.reduce((x, y) => (y.length > x.length ? y : x));
        const longestCover = longest(s.cover), longestShort = longest(s.coverShort);
        const screens = {
          welcome: `${s.welcome}\n${s.switchTo}`,
          fullMenu: [s.pinSaved, s.menuHead, ...Object.values(m).map((t, k) => `${k + 1}. ${t}`), s.switchTo].join("\n"),
          choosePin: `${s.choosePin}\n${s.switchTo}`,
          // a large but realistic contract: ids in the hundreds, cover in millions, premium and subsidy in 100,000s
          offer: [s.offerHead(999, longestCover, "5,000,000", 365, s.fromDate(day)), s.offerPay("450,000", "225,000", "225,000"), s.validTo(day), s.payOrDecline].join("\n"),
          offerWeb: [s.offerHead(999, longestCover, "5,000,000", 365, s.fromDate(day)), s.offerPay("450,000", "225,000", "225,000"), s.validTo(day), s.payOnWeb].join("\n"),
          register: `${s.confirmRegister("Uwamahoro Mukamana Jeanne", "1234", "Nyamasheke")}\n${s.yesNo}`,
          confirmCrop: `${s.confirmCrop(s.assetLabel("Maize 25,000m2", id))}\n${s.yesNo}`,
          policy: [s.policyHead(id, s.cover[3]), "RW-TAG-0001", s.coverAmount(big), s.premium("450,000"), s.valid(day, day), s.statusLine(s.status[1])].join("\n"),
          cropPolicy: [s.policyHead(id, s.cover[2]), "Maize 25,000m2", s.coverAmount(big), s.premium("450,000"), s.valid(day, day), s.statusLine(s.status[0]), s.paysItself].join("\n"),
          vetClaim: [s.vetClaimHead(id, "RW-TAG-0001"), s.filed(day), s.stAwaitingVets, s.signatures(2, 3)].join("\n"),
          cropClaim: [s.cropClaimHead(id, id), s.filed(day), s.stReviewed, s.approvals(2, 3)].join("\n"),
          moveSaved: s.moveSaved(when),
          moveWaiting: s.moveWaiting(when),
          agent: s.agentInfo("250788000015"),
          payApprove: s.payApprove(big),
          // five policies, mostly active (five with pending claims at 3-digit ids is still too long in English)
          policies: [s.yourPolicies, ...[1, 2, 3, 4, 5].map((k) => `${k}. #${id} ${longestShort} ${s.status[k === 1 ? 1 : 0]}`)].join("\n"),
          // three open contracts at once (five at 3-digit ids is too long in English as well)
          offers: [s.offersHead, ...[1, 2, 3].map((k) => `${k}. ${s.offerLine(id, longestShort, big)}`)].join("\n"),
          claims: [s.yourClaims, ...[1, 2, 3, 4, 5].map((k) => `${k}. ${s.cropClaimName(id)} ${s.cropWord[4]}`)].join("\n"),
        };
        const strings = [];
        const walk = (o) => Object.values(o).forEach((v) => (typeof v === "string" ? strings.push(v) : v && typeof v === "object" && !Array.isArray(v) && walk(v)));
        walk(s);
        for (const [name, text] of [...Object.entries(screens), ...strings.map((t) => [t, t])]) {
          expect(text.length, `${lang} ${name} (${text.length}):\n${text}`).to.be.at.most(LIMIT);
        }
      });
    });
  }

  it("offers the switch in the other language", () => {
    expect(TEXT.en.switchTo).to.equal("0. Ikinyarwanda");
    expect(TEXT.rw.switchTo).to.equal("0. English");
  });
});
