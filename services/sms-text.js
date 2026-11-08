// SMS to farmers in English (en) and Kinyarwanda (rw), picked by the farmer's language (services/lang.js).
// Messages to agents stay in English: they are staff and work on the (English) portal.
//
// Both tables have exactly the same keys (a test checks this) and every message stays within 160 characters, one
// SMS. The Kinyarwanda is a DRAFT for a native speaker to review (dosiye = application, icyifuzo = request,
// umusanzu = premium, indishyi = payout, ubusabe = claim, inkunga = subsidy).

// The code farmers dial, e.g. *384*123#. Without USSD_SHORTCODE the messages name it in words.
const SHORTCODE = () => process.env.USSD_SHORTCODE || null;

const en = {
  dial: () => SHORTCODE() || "the FarmLedger USSD code",
  day: (ts) => new Date(Number(ts) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
  when: (ms) => new Date(ms).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }),
  coverWord: ["drought", "flood", "crop stress", "cattle"],

  // phone accounts (services/phone-accounts.js)
  codeRegister: (code, dial) => `FarmLedger code: ${code}. Dial ${dial} and enter it to finish registering. Valid 10 minutes.`,
  codeMove: (code, dial) => `FarmLedger code: ${code}. Dial ${dial} from this phone and enter it to move your account here. Valid 10 minutes.`,
  moveRequested: (to, dial, when) => `FarmLedger: request to move your account to ${to}. Not you? Dial ${dial} and choose 5 to cancel, before ${when}.`,
  moveCancelled: "FarmLedger: the request to move an account to this number was cancelled.",
  moveDone: (dial) => `FarmLedger: your account is now on this number. Dial ${dial} to choose a new PIN.`,
  pinChanged: "FarmLedger: your USSD PIN was changed. If this was not you, contact FarmLedger support.",

  // chain events (services/notifier-core.js)
  welcome: (dial) => `Welcome to FarmLedger. Your account is ready. Dial ${dial} to check your cover and report claims.`,
  policyPurchased: (id, state, end, sum, paid) => `FarmLedger: policy #${id} ${state} until ${end}. Cover ${sum} RWF, ${paid}.`,
  stateActive: "active",
  stateBooked: (start) => `booked, cover starts ${start}`,
  paidPremium: (premium) => `premium ${premium} RWF`,
  paidWithSubsidy: (pays, subsidy) => `you paid ${pays} RWF (subsidy ${subsidy} RWF)`,
  policyExpired: (id) => `FarmLedger: policy #${id} has ended. No payout was due. Thank you for insuring with FarmLedger.`,
  claimFiled: (claim, policy) => `FarmLedger: claim #${claim} received for policy #${policy}. A veterinarian will verify it.`,
  claimRejected: (claim) => `FarmLedger: claim #${claim} was not approved by the veterinarians. Your cover continues.`,
  cropClaimFiled: (claim, policy) => `FarmLedger: loss claim #${claim} received for policy #${policy}. The insurer's reviewers will assess it.`,
  cropClaimRejected: (claim) => `FarmLedger: loss claim #${claim} was not approved by the reviewers. Your cover continues.`,
  cropClaimSuperseded: (claim, policy) => `FarmLedger: loss claim #${claim} is closed because policy #${policy} was already paid automatically.`,
  payout: (amount, policy, why) => `FarmLedger: ${amount} RWF paid for policy #${policy} (${why}).`,
  whyAuto: "triggered by weather/satellite data",
  whyVets: "confirmed by certified veterinarians",
  whyReviewers: "loss claim approved by the insurer's reviewers",
  agentAssigned: (phone) => `FarmLedger: your insurance agent${phone ? ` is on +${phone}` : " has been assigned"}. They will collect your details and apply for cover for you.`,
  applicationSubmitted: (cover, sum, id) => `FarmLedger: your agent applied for ${cover} cover of ${sum} RWF (application #${id}). The insurer will review it.`,
  contractReady: (id, sum, pays, dial, until) => `FarmLedger: your contract #${id} is ready: cover ${sum} RWF, you pay ${pays} RWF. Dial ${dial}, choose 6 to review and pay by ${until}.`,
  applicationRejected: (id) => `FarmLedger: application #${id} was not accepted by the insurer. Your agent will explain why and can apply again.`,

  // Mobile Money (services/payments.js)
  momoNotStarted: (amount) => `FarmLedger: the Mobile Money payment of ${amount} RWF could not be started. No cover was bought.`,
  momoNotCompleted: (amount, reason) => `FarmLedger: the Mobile Money payment of ${amount} RWF was not completed (${reason}). No cover was bought.`,
  momoRefunding: (why, amount) => `FarmLedger: the cover could not be issued (${why}). Your ${amount} RWF is being refunded to your Mobile Money.`,
  momoRefunded: (amount) => `FarmLedger: ${amount} RWF refunded to your Mobile Money.`,
  momoPayout: (amount, policy) => `FarmLedger: ${amount} RWF sent to your MTN Mobile Money for policy #${policy}.`,
};

const pad = (n) => String(n).padStart(2, "0");
const numDate = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;

const rw = {
  dial: () => SHORTCODE() || "kode ya USSD ya FarmLedger",
  day: (ts) => numDate(new Date(Number(ts) * 1000)), // no English month names
  when: (ms) => { const d = new Date(ms); return `${numDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; },
  coverWord: ["amapfa", "imyuzure", "ibihingwa", "amatungo"], // after "ubwishingizi bw'..."

  codeRegister: (code, dial) => `FarmLedger kode: ${code}. Kanda ${dial} uyandike urangize kwiyandikisha. Imara iminota 10.`,
  codeMove: (code, dial) => `FarmLedger kode: ${code}. Kanda ${dial} kuri iyi telefoni uyandike, konti yawe yimurirwe hano. Imara iminota 10.`,
  moveRequested: (to, dial, when) => `FarmLedger: hasabwe kwimurira konti yawe kuri ${to}. Si wowe? Kanda ${dial} uhitemo 5 ubihagarike mbere ya ${when}.`,
  moveCancelled: "FarmLedger: icyifuzo cyo kwimurira konti kuri iyi nimero cyahagaritswe.",
  moveDone: (dial) => `FarmLedger: konti yawe ubu iri kuri iyi nimero. Kanda ${dial} uhitemo PIN nshya.`,
  pinChanged: "FarmLedger: PIN yawe ya USSD yahinduwe. Niba atari wowe, hamagara ubufasha bwa FarmLedger.",

  welcome: (dial) => `Murakaza neza kuri FarmLedger. Konti yawe iriteguye. Kanda ${dial} urebe ubwishingizi bwawe kandi usabe indishyi.`,
  policyPurchased: (id, state, end, sum, paid) => `FarmLedger: ubwishingizi #${id} ${state} kugeza ${end}. Bwishingira ${sum} RWF, ${paid}.`,
  stateActive: "burakora",
  stateBooked: (start) => `bwanditswe, butangira ${start}`,
  paidPremium: (premium) => `umusanzu ${premium} RWF`,
  paidWithSubsidy: (pays, subsidy) => `wishyuye ${pays} RWF (inkunga ${subsidy} RWF)`,
  policyExpired: (id) => `FarmLedger: ubwishingizi #${id} bwarangiye. Nta ndishyi zari zikwiye. Murakoze kwishingira muri FarmLedger.`,
  claimFiled: (claim, policy) => `FarmLedger: ubusabe #${claim} ku bwishingizi #${policy} bwakiriwe. Umuganga w'amatungo azabugenzura.`,
  claimRejected: (claim) => `FarmLedger: ubusabe #${claim} ntibwemewe n'abaganga b'amatungo. Ubwishingizi bwawe burakomeza.`,
  cropClaimFiled: (claim, policy) => `FarmLedger: ubusabe #${claim} bw'igihombo ku bwishingizi #${policy} bwakiriwe. Abasuzuma b'umwishingizi bazabusuzuma.`,
  cropClaimRejected: (claim) => `FarmLedger: ubusabe #${claim} bw'igihombo ntibwemewe n'abasuzuma. Ubwishingizi bwawe burakomeza.`,
  cropClaimSuperseded: (claim, policy) => `FarmLedger: ubusabe #${claim} bw'igihombo bwafunzwe kuko ubwishingizi #${policy} bwari bwarishyuwe bwonyine.`,
  payout: (amount, policy, why) => `FarmLedger: ${amount} RWF zishyuwe ku bwishingizi #${policy} (${why}).`,
  whyAuto: "byagaragajwe n'amakuru y'ikirere n'icyogajuru",
  whyVets: "byemejwe n'abaganga b'amatungo bemewe",
  whyReviewers: "ubusabe bwemejwe n'abasuzuma b'umwishingizi",
  agentAssigned: (phone) => `FarmLedger: umuhuza wawe ${phone ? `aboneka kuri +${phone}` : "yagenwe"}. Azakusanya amakuru yawe akagusabira ubwishingizi.`,
  applicationSubmitted: (cover, sum, id) => `FarmLedger: umuhuza wawe yagusabiye ubwishingizi bw'${cover} bwa ${sum} RWF (dosiye #${id}). Umwishingizi azayisuzuma.`,
  contractReady: (id, sum, pays, dial, until) => `FarmLedger: amasezerano #${id} yiteguye: ${sum} RWF, wishyura ${pays} RWF. Kanda ${dial}, uhitemo 6 usuzume wishyure mbere ya ${until}.`,
  applicationRejected: (id) => `FarmLedger: dosiye #${id} ntiyemewe n'umwishingizi. Umuhuza wawe azakubwira impamvu kandi ashobora kongera gusaba.`,

  momoNotStarted: (amount) => `FarmLedger: kwishyura ${amount} RWF na Mobile Money ntibyatangiye. Nta bwishingizi bwaguzwe.`,
  momoNotCompleted: (amount, reason) => `FarmLedger: kwishyura ${amount} RWF na Mobile Money ntibyarangiye (${reason}). Nta bwishingizi bwaguzwe.`,
  momoRefunding: (why, amount) => `FarmLedger: ubwishingizi ntibwatanzwe (${why}). ${amount} RWF zawe zirasubizwa kuri Mobile Money yawe.`,
  momoRefunded: (amount) => `FarmLedger: ${amount} RWF zasubijwe kuri Mobile Money yawe.`,
  momoPayout: (amount, policy) => `FarmLedger: ${amount} RWF zoherejwe kuri MTN Mobile Money yawe ku bwishingizi #${policy}.`,
};

const SMS = { en, rw };

module.exports = { SMS };
