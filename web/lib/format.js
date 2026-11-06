import { DEMO_ACCOUNTS, COVER, fromB32, short, fmt } from "./chain";

export const DAY = 86400;
export const unit = (cover, v) => (Number(cover) === 2 ? (Number(v) / 10000).toFixed(2) + " NDVI" : (Number(v) / 10).toFixed(0) + " mm");
export const cond = (cover, thr) =>
  Number(cover) === 1 ? `rain on your plot over the last 30 days is above ${unit(cover, thr)}`
    : Number(cover) === 3 ? "the animal's death is confirmed by certified veterinarians"
      : Number(cover) === 2 ? `the crop health index (NDVI) for your plot is below ${unit(cover, thr)}`
        : `rain on your plot over the last 30 days is below ${unit(cover, thr)}`;

export const nameOf = (addr) => {
  const d = DEMO_ACCOUNTS.find((a) => a.addr.toLowerCase() === String(addr).toLowerCase());
  return d ? d.label.replace(/ \(.*\)/, "") : short(addr);
};

export const dateTime = (ts) => new Date(Number(ts) * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

export function eventText(e) {
  const a = e.args;
  switch (e.name) {
    case "FarmerRegistered": return `Farmer ${nameOf(a.farmer)} registered`;
    case "PlotRegistered": return `Plot #${a.plotId} registered (${fromB32(a.crop)})`;
    case "AnimalRegistered": return `Animal ${fromB32(a.tagId)} registered`;
    case "ProductCreated": return `Product #${a.productId} created: ${COVER[Number(a.cover)]}`;
    case "LiquidityDeposited": return `Liquidity +${fmt(a.amount)} RWF`;
    case "LiquidityWithdrawn": return `Liquidity −${fmt(a.amount)} RWF`;
    case "PolicyPurchased": return `Policy #${a.policyId} bought: cover ${fmt(a.sumInsured)}, premium ${fmt(a.premium)}`;
    case "ReadingPosted": return `Oracle reading, plot #${a.plotId}: ${Number(a.metric) === 0 ? "rainfall " + (Number(a.value) / 10).toFixed(0) + " mm" : "NDVI " + (Number(a.value) / 10000).toFixed(2)}`;
    case "ClaimFiled": return `Claim #${a.claimId} filed for policy #${a.policyId}`;
    case "ClaimAttested": return `${nameOf(a.vet)} signed claim #${a.claimId}: ${a.approved ? "APPROVE" : "REJECT"} (${a.approvals} approve / ${a.rejections} reject)`;
    case "ClaimSettled": return `Claim #${a.claimId} ${a.approved ? "approved" : "rejected"} by quorum`;
    case "PayoutExecuted": return `PAYOUT policy #${a.policyId}: ${fmt(a.amount)} RWF to ${nameOf(a.holder)} (${a.automatic ? "automatic trigger" : "vet quorum"})`;
    case "PolicyExpired": return `Policy #${a.policyId} expired`;
    case "VetCertified": return `Vet ${nameOf(a.vet)} certified (valid until ${new Date(Number(a.validUntil) * 1000).toLocaleDateString("en-GB")})`;
    case "VetRevoked": return `Vet ${nameOf(a.vet)} certification revoked`;
    case "ClaimChannel": return `Claim #${a.claimId} registered ${a.viaAgent ? "through the USSD channel" : "on the web portal"}`;
    case "ApplicationRecorded": return `Application for policy #${a.policyId} recorded (${a.applicationHash.slice(0, 10)}…)`;
    case "VetQuorumChanged": return `Vet quorum set to ${a.quorum}`;
    default: return e.name;
  }
}

export const sortedEvents = (events) => [...events].sort((x, y) => y.block - x.block || y.idx - x.idx);

// Events a given account cares about (drives the notification bell).
export function relevantEvents(snap, account, address) {
  const me = address.toLowerCase();
  const is = (v) => v && String(v).toLowerCase() === me;
  const myClaims = new Set(snap.claims.filter((c) => is(c.holder)).map((c) => Number(c.id)));
  return sortedEvents(snap.events.filter((e) => {
    const a = e.args;
    switch (account.role) {
      case "farmer": return is(a.holder) || is(a.farmer) || (["ClaimAttested", "ClaimSettled"].includes(e.name) && myClaims.has(Number(a.claimId)));
      case "vet": return ["ClaimFiled", "ClaimAttested", "ClaimSettled", "VetCertified", "VetRevoked"].includes(e.name) && (e.name !== "VetCertified" && e.name !== "VetRevoked" || is(a.vet));
      case "underwriter": return ["PolicyPurchased", "PayoutExecuted", "LiquidityDeposited"].includes(e.name);
      case "admin": return ["VetCertified", "VetRevoked", "ClaimSettled", "VetQuorumChanged"].includes(e.name);
      default: return e.name === "ReadingPosted";
    }
  }));
}

// Plain-language descriptions of each cover type (Cover enum order in the contract).
export const COVER_PLAIN = [
  { name: "Drought cover", asset: "plot", what: "Protects a crop plot against too little rain.", decides: "Paid automatically when the weather reading for your plot shows too little rain. Nobody has to visit or approve." },
  { name: "Flood cover", asset: "plot", what: "Protects a crop plot against too much rain.", decides: "Paid automatically when the weather reading for your plot shows too much rain. Nobody has to visit or approve." },
  { name: "Crop health cover", asset: "plot", what: "Protects a crop plot when the crop stops growing well.", decides: "Paid automatically when the satellite vegetation reading (NDVI) for your plot is too low." },
  { name: "Cattle cover", asset: "animal", what: "Protects one cow if it dies.", decides: "You report the death with a photo. Certified veterinarians check it; when enough of them confirm, you are paid." },
];

// Where a weather / vegetation reading came from. "real" readings are actual measurements; the rest are samples.
export const SOURCE_LABEL = {
  "nasa-power": { text: "Real satellite rainfall (NASA POWER)", real: true },
  sample: { text: "Sample value, simulated by the oracle service", real: false },
  test: { text: "Test value, entered with the test tools", real: false },
};

const PAY_REASON = (automatic) => (automatic ? "the weather reading met the policy terms" : "the veterinarians confirmed your claim");

// Notifications and history for farmers, without technical terms.
export function farmerEventText(e) {
  const a = e.args;
  switch (e.name) {
    case "FarmerRegistered": return "You registered with FarmLedger";
    case "PlotRegistered": return `Plot #${a.plotId} (${fromB32(a.crop).toLowerCase()}) added to your farm`;
    case "AnimalRegistered": return `Animal ${fromB32(a.tagId)} added to your farm`;
    case "PolicyPurchased": return `Policy #${a.policyId} started: cover ${fmt(a.sumInsured)} RWF, premium paid ${fmt(a.premium)} RWF`;
    case "ApplicationRecorded": return `Your application and documents for policy #${a.policyId} were recorded`;
    case "ClaimFiled": return `Claim #${a.claimId} reported for policy #${a.policyId}`;
    case "ClaimChannel": return `Claim #${a.claimId} was reported ${a.viaAgent ? "by phone (USSD)" : "on the website"}`;
    case "ClaimAttested": return `A veterinarian ${a.approved ? "confirmed" : "did not confirm"} claim #${a.claimId} (${a.approvals} confirmed, ${a.rejections} not confirmed)`;
    case "ClaimSettled": return a.approved ? `Claim #${a.claimId} approved` : `Claim #${a.claimId} rejected. Your cover continues.`;
    case "PayoutExecuted": return `You were paid ${fmt(a.amount)} RWF for policy #${a.policyId}, because ${PAY_REASON(a.automatic)}`;
    case "PolicyExpired": return `Policy #${a.policyId} ended without a claim`;
    default: return eventText(e);
  }
}
