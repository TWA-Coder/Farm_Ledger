// Mobile Money for phone-account farmers (services/phone-accounts.js), through MTN MoMo (services/momo.js).
//
// PREMIUM (paying a contract the underwriter drafted, PolicyDesk, from a basic phone)
//   requested -> pending      request to pay the farmer's share is sent; MoMo asks the farmer to approve on their phone
//   pending   -> successful   MoMo reports SUCCESSFUL
//   successful -> credited    the treasury credits the farmer's smart account with that amount of the RWF test token
//   credited  -> fulfilled    the farmer's account approves the premium and accepts the offer in ONE sponsored operation,
//                             which issues the policy (policy_id set)
//   pending   -> failed       the farmer declined, timed out or had no funds: nothing was bought
//   credited  -> refunding    the purchase failed (e.g. pool now too small): tokens go back to the treasury and the
//                             money is refunded by a MoMo transfer (a "refund" row)
// PAYOUT (claim or index payout to a phone-account farmer)
//   sweeping -> swept         the paid tokens move from the farmer's account to the treasury, so the farmer never
//                             holds both the tokens AND the Mobile Money
//   swept    -> pending -> paid | failed     MoMo transfer of the same amount to the farmer's number
//
// Every row is written BEFORE the call it describes and is keyed by a unique external id (premium-<ref>,
// payout-<policy>-<tx>, refund-<ref>), and MoMo calls reuse the row's reference, so a crash or retry never
// charges or pays twice. tick() (run by the notifier) moves each row one step at a time.
//
// Money: on-chain amounts are the RWF test token (MockRWF), minted by the treasury against confirmed MoMo money.
// The sandbox only accepts EUR, so the same number is sent with currency EUR there.
const crypto = require("crypto");
const { ethers } = require("ethers");
const dbm = require("../web/server/db");
const { SMS } = require("./sms-text");
const lang = require("./lang");

const CHECK_EVERY_MS = 5_000;
const NOT_FOUND_GIVE_UP_MS = 10 * 60 * 1000;
const fmt = (n) => Number(n).toLocaleString("en-US");

function createPayments({ db = dbm.get(), provider, ledgerAddress, tokenAddress, deskAddress, abi, accounts, momo, outbox, treasury, now = () => Date.now() }) {
  const ledgerRO = new ethers.Contract(ledgerAddress, abi.ledger, provider);
  const deskRO = deskAddress ? new ethers.Contract(deskAddress, abi.policyDesk, provider) : null;
  const deskIface = abi.policyDesk ? new ethers.Interface(abi.policyDesk) : null;
  const tokenIface = new ethers.Interface(abi.token);
  const ledgerIface = new ethers.Interface(abi.ledger);
  const tokenAsTreasury = new ethers.Contract(tokenAddress, abi.token, treasury);
  const treasuryAddress = () => treasury.getAddress();

  const row = (ref) => db.one("SELECT * FROM momo_payments WHERE ref = ?", [ref]);
  const set = async (ref, fields) => {
    const keys = Object.keys(fields);
    await db.run(`UPDATE momo_payments SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE ref = ?`, [...keys.map((k) => fields[k]), now(), ref]);
  };
  // external_id is UNIQUE: the same payment (e.g. one payout per policy) can never be recorded twice
  async function insert({ kind, phone, account, amount, externalId, status, intent = null, parent = null }) {
    const ref = crypto.randomUUID();
    const t = now();
    const r = await db.run(`INSERT INTO momo_payments (ref, kind, phone, account, amount, currency, external_id, status, intent, parent, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [ref, kind, phone, account, amount, momo.config.currency, externalId, status, intent && JSON.stringify(intent), parent, t, t]);
    return r.changes ? ref : null;
  }
  // text: (s) => message, with s the SMS texts in the farmer's language (services/sms-text.js)
  const sms = async (r, key, text) => outbox.enqueue({ phone: r.phone, text: text(SMS[await lang.langOf(db, r.phone)]), kind: "momo", key: `momo:${r.ref}:${key}` });

  // ---------------------------------------------------------------- premium
  // What the farmer pays for a drafted contract: its premium minus the subsidy they would get now.
  async function quoteOffer({ account, applicationId }) {
    const a = await deskRO.getApplication(applicationId);
    const subsidy = await ledgerRO.subsidyFor(account, a.productId, a.premium).catch(() => 0n);
    return { app: a, premium: a.premium, subsidy, farmerPays: a.premium - subsidy };
  }

  async function startPremium({ phone, applicationId }) {
    if (!deskRO) throw new Error("PolicyDesk is not deployed.");
    const acct = await accounts.accountOf(phone);
    if (!acct || acct.status !== "active") throw new Error("No active phone account for this number.");
    const q = await quoteOffer({ account: acct.account, applicationId });
    if (q.app.farmer.toLowerCase() !== acct.account.toLowerCase() || Number(q.app.status) !== 2) throw new Error("This contract cannot be paid.");
    const open = await db.one("SELECT ref FROM momo_payments WHERE kind = 'premium' AND (intent::jsonb ->> 'applicationId')::bigint = ? AND status IN ('requested','pending','successful','credited')", [Number(applicationId)]);
    if (open) return { ref: open.ref, ...q, status: "pending" }; // already being paid: never charge twice
    const intent = { applicationId: Number(applicationId), premium: String(q.premium), subsidy: String(q.subsidy) };
    const ref = await insert({ kind: "premium", phone, account: acct.account, amount: Number(q.farmerPays), externalId: `premium-${crypto.randomUUID()}`, status: "requested", intent });
    await sendRequest(await row(ref));
    return { ref, ...q, status: (await row(ref)).status };
  }

  async function sendRequest(r) {
    try {
      await momo.requestToPay({ ref: r.ref, amount: r.amount, phone: r.phone, externalId: r.external_id,
        payerMessage: "FarmLedger cover premium", payeeNote: `FarmLedger ${r.external_id}` });
      await set(r.ref, { status: "pending", reason: null });
    } catch (e) {
      if (e.status === 409) return set(r.ref, { status: "pending" }); // MoMo already has this reference: our earlier send arrived
      if (e.transient) return set(r.ref, { reason: e.message }); // stays "requested": resent with the same reference
      await set(r.ref, { status: "failed", reason: e.message });
      await sms(r, "failed", (s) => s.momoNotStarted(fmt(r.amount)));
    }
  }

  async function checkPremium(r) {
    const st = await momo.paymentStatus(r.ref);
    if (st.status === "SUCCESSFUL") return set(r.ref, { status: "successful", financial_tx: st.financialTransactionId, reason: null });
    if (st.status === "FAILED") {
      await set(r.ref, { status: "failed", reason: st.reason || "FAILED" });
      return sms(r, "failed", (s) => s.momoNotCompleted(fmt(r.amount), st.reason || "declined"));
    }
    if (st.status === "NOT_FOUND" && now() - r.created_at > NOT_FOUND_GIVE_UP_MS) await set(r.ref, { status: "failed", reason: st.reason });
    else await set(r.ref, {}); // still pending: check again later
  }

  async function credit(r) {
    await (await tokenAsTreasury.mint(r.account, r.amount)).wait();
    await set(r.ref, { status: "credited" });
  }

  async function buy(r) {
    const it = JSON.parse(r.intent);
    const signer = { sendCalls: (calls) => accounts.sendCalls(r.phone, calls) }; // keys stay in custody
    try {
      const tx = await signer.sendCalls([
        { to: tokenAddress, data: tokenIface.encodeFunctionData("approve", [ledgerAddress, r.amount]) },
        { to: deskAddress, data: deskIface.encodeFunctionData("acceptOffer", [it.applicationId]) },
      ]);
      const rc = await tx.wait();
      const ev = rc.logs.map((l) => { try { return ledgerIface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "PolicyPurchased");
      await set(r.ref, { status: "fulfilled", policy_id: Number(ev.args.policyId) });
      // the notifier texts the purchase itself (PolicyPurchased); nothing more to send here
    } catch (e) {
      // Not bought: give the money back. Tokens first (so they are not left with the farmer), then MoMo.
      const why = e.revert?.name || e.shortMessage || e.message;
      const balance = await new ethers.Contract(tokenAddress, abi.token, provider).balanceOf(r.account);
      const back = balance < BigInt(r.amount) ? balance : BigInt(r.amount);
      if (back > 0n) await (await signer.sendCalls([{ to: tokenAddress, data: tokenIface.encodeFunctionData("transfer", [await treasuryAddress(), back]) }])).wait();
      const refund = await insert({ kind: "refund", phone: r.phone, account: r.account, amount: r.amount, externalId: `refund-${r.ref}`, status: "swept", parent: r.ref });
      await set(r.ref, { status: "refunding", reason: why });
      await sms(r, "refund", (s) => s.momoRefunding(why, fmt(r.amount)));
      if (refund) await sendTransfer(await row(refund));
    }
  }

  // ---------------------------------------------------------------- payout
  // Called by the notifier for every PayoutExecuted. Only phone accounts are paid by MoMo; farmers with their own
  // wallet (portal) keep the tokens. -> ref, or null when not a phone account / already started.
  async function startPayout({ holder, amount, policyId, txHash }) {
    const acct = await db.one("SELECT * FROM phone_accounts WHERE lower(account) = lower(?) AND status = 'active'", [holder]);
    if (!acct) return null;
    return insert({ kind: "payout", phone: acct.phone, account: acct.account, amount: Number(amount), externalId: `payout-${policyId}-${String(txHash).slice(0, 18)}`, status: "sweeping", intent: { policyId: Number(policyId) } });
  }

  async function sweep(r) {
    await (await accounts.sendCalls(r.phone, [{ to: tokenAddress, data: tokenIface.encodeFunctionData("transfer", [await treasuryAddress(), r.amount]) }])).wait();
    await set(r.ref, { status: "swept" });
  }

  async function sendTransfer(r) {
    try {
      await momo.transfer({ ref: r.ref, amount: r.amount, phone: r.phone, externalId: r.external_id,
        payerMessage: r.kind === "refund" ? "FarmLedger refund" : "FarmLedger insurance payout", payeeNote: `FarmLedger ${r.external_id}` });
      await set(r.ref, { status: "pending", reason: null });
    } catch (e) {
      if (e.status === 409) return set(r.ref, { status: "pending" });
      if (e.transient) return set(r.ref, { reason: e.message }); // stays "swept": resent with the same reference
      await set(r.ref, { status: "failed", reason: e.message }); // operator: npm run momo -- retry <ref>
    }
  }

  async function checkTransfer(r) {
    const st = await momo.transferStatus(r.ref);
    if (st.status === "SUCCESSFUL") {
      await set(r.ref, { status: "paid", financial_tx: st.financialTransactionId, reason: null });
      if (r.parent) await set(r.parent, { status: "refunded" });
      return sms(r, "paid", (s) => (r.kind === "refund"
        ? s.momoRefunded(fmt(r.amount))
        : s.momoPayout(fmt(r.amount), JSON.parse(r.intent || "{}").policyId ?? "?")));
    }
    if (st.status === "FAILED") return set(r.ref, { status: "failed", reason: st.reason || "FAILED" });
    if (st.status === "NOT_FOUND" && now() - r.updated_at > NOT_FOUND_GIVE_UP_MS) return set(r.ref, { status: "swept", reason: "not found at MoMo: resending" });
    await set(r.ref, {});
  }

  // ---------------------------------------------------------------- driver
  const STEP = {
    premium: { requested: sendRequest, pending: checkPremium, successful: credit, credited: buy },
    payout: { sweeping: sweep, swept: sendTransfer, pending: checkTransfer },
    refund: { swept: sendTransfer, pending: checkTransfer },
  };

  async function tick({ limit = 20 } = {}) {
    const rows = await db.all(`SELECT * FROM momo_payments WHERE status IN ('requested','pending','successful','credited','sweeping','swept')
      ORDER BY created_at LIMIT ?`, [limit]);
    let moved = 0;
    for (const r of rows) {
      const step = STEP[r.kind]?.[r.status];
      if (!step) continue;
      if (r.status === "pending" && now() - r.updated_at < CHECK_EVERY_MS) continue;
      try {
        const before = r.status;
        await step(r);
        if ((await row(r.ref)).status !== before) moved++;
      } catch (e) {
        // chain or MoMo unreachable: the row keeps its state and the step runs again next tick
        await set(r.ref, { reason: String(e.shortMessage || e.message).slice(0, 200) });
      }
    }
    return moved;
  }

  // Operator: send a failed payout or refund again (new reference, same external id).
  async function retry(ref) {
    const r = await row(ref);
    if (!r || r.status !== "failed" || r.kind === "premium") return false;
    await db.run("UPDATE momo_payments SET ref = ?, status = 'swept', reason = 'retried by operator', updated_at = ? WHERE ref = ?", [crypto.randomUUID(), now(), ref]);
    return true;
  }

  const list = (limit = 20) => db.all("SELECT * FROM momo_payments ORDER BY created_at DESC LIMIT ?", [limit]);

  return { quoteOffer, startPremium, startPayout, tick, retry, list, row };
}

// Hardhat development account #14 (public key, local chain ONLY): the treasury that credits MoMo premiums on-chain
// and receives the tokens of payouts sent to Mobile Money.
const LOCAL_TREASURY = "0xc526ee95bf44d8fc405a158bb884d9d1238d99f0612e9f33d006bb0789009aaa";

function paymentsFromEnv({ provider, dep, abi, accounts, outbox, db }) {
  const { momoFromEnv } = require("./momo");
  const local = ["localhost", "hardhat"].includes(dep.network);
  const key = process.env.TREASURY_PRIVATE_KEY || (local ? LOCAL_TREASURY : null);
  if (!key) throw new Error("Set TREASURY_PRIVATE_KEY (the account that credits MoMo premiums on-chain).");
  const momo = momoFromEnv();
  const payments = createPayments({ db, provider, ledgerAddress: dep.ledger, tokenAddress: dep.token, deskAddress: dep.policyDesk, abi, accounts, momo, outbox, treasury: new ethers.Wallet(key, provider) });
  payments.mode = momo.simulated ? "simulated (no MTN account)" : `MTN MoMo ${momo.config.targetEnv} (${momo.config.currency})`;
  return payments;
}

module.exports = { createPayments, paymentsFromEnv, LOCAL_TREASURY };
