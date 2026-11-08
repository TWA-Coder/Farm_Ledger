// MTN Mobile Money Open API client (https://momodeveloper.mtn.com): Collections (request to pay) and Disbursements
// (transfer). Used by services/payments.js.
//
//   Sandbox base   https://sandbox.momodeveloper.mtn.com     target environment "sandbox", currency EUR only
//   Live (Rwanda)  MOMO_BASE_URL from MTN (proxy.momoapi.mtn.com), MOMO_TARGET_ENV=mtnrwanda, MOMO_CURRENCY=RWF
//
// Each product (collection, disbursement) has its own subscription key (MOMO_*_KEY, from your developer profile) and
// API user + API key (MOMO_*_USER / MOMO_*_API_KEY). In the sandbox you create the user and key yourself:
// `npm run momo -- provision` (POST /v1_0/apiuser, then /v1_0/apiuser/{id}/apikey).
//
// Every write uses a fresh UUID as X-Reference-Id; the caller stores it BEFORE sending, and a retry re-uses the same
// reference, so a timeout can never turn into a second charge.
const crypto = require("crypto");

const PRODUCTS = {
  collection: { token: "/collection/token/", create: "/collection/v1_0/requesttopay", status: (r) => `/collection/v1_0/requesttopay/${r}` },
  disbursement: { token: "/disbursement/token/", create: "/disbursement/v1_0/transfer", status: (r) => `/disbursement/v1_0/transfer/${r}` },
};

function configFromEnv(env = process.env) {
  const p = (name) => ({ key: env[`MOMO_${name}_KEY`], user: env[`MOMO_${name}_USER`], apiKey: env[`MOMO_${name}_API_KEY`] });
  return {
    baseUrl: (env.MOMO_BASE_URL || "https://sandbox.momodeveloper.mtn.com").replace(/\/+$/, ""),
    targetEnv: env.MOMO_TARGET_ENV || "sandbox",
    currency: env.MOMO_CURRENCY || (env.MOMO_TARGET_ENV && env.MOMO_TARGET_ENV !== "sandbox" ? "RWF" : "EUR"),
    callbackUrl: env.MOMO_CALLBACK_URL || null,
    collection: p("COLLECTION"),
    disbursement: p("DISBURSEMENT"),
  };
}

const ready = (c, product) => Boolean(c[product]?.key && c[product]?.user && c[product]?.apiKey);

class MomoError extends Error {
  constructor(message, { transient = false, status = null, body = null } = {}) { super(message); this.transient = transient; this.status = status; this.body = body; }
}

function createMomo(cfg = configFromEnv(), { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const tokens = {}; // product -> {value, until}

  async function call(method, path, { headers = {}, body } = {}) {
    let res, text;
    try {
      res = await fetchImpl(cfg.baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      text = await res.text();
    } catch (e) {
      throw new MomoError(`MoMo unreachable: ${e.message}`, { transient: true });
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const msg = json?.message || json?.reason || json?.code || text || res.statusText;
      throw new MomoError(`MoMo ${method} ${path.split("/").slice(0, 4).join("/")}: HTTP ${res.status} ${String(msg).slice(0, 160)}`,
        { transient: res.status >= 500 || res.status === 429, status: res.status, body: json });
    }
    return { status: res.status, json };
  }

  async function token(product) {
    const t = tokens[product];
    if (t && now() < t.until) return t.value;
    const c = cfg[product];
    if (!ready(cfg, product)) throw new MomoError(`MoMo ${product} is not configured (MOMO_${product.toUpperCase()}_KEY / _USER / _API_KEY)`);
    const { json } = await call("POST", PRODUCTS[product].token, {
      headers: { Authorization: `Basic ${Buffer.from(`${c.user}:${c.apiKey}`).toString("base64")}`, "Ocp-Apim-Subscription-Key": c.key },
    });
    tokens[product] = { value: json.access_token, until: now() + (Number(json.expires_in || 3600) - 60) * 1000 };
    return json.access_token;
  }

  async function headersFor(product, ref) {
    const h = {
      Authorization: `Bearer ${await token(product)}`,
      "X-Target-Environment": cfg.targetEnv,
      "Ocp-Apim-Subscription-Key": cfg[product].key,
      "Content-Type": "application/json",
    };
    if (ref) h["X-Reference-Id"] = ref;
    if (ref && cfg.callbackUrl) h["X-Callback-Url"] = cfg.callbackUrl;
    return h;
  }

  // party: "2507..." digits. amount: integer RWF (sent as a string, as the API expects).
  async function requestToPay({ ref, amount, phone, externalId, payerMessage, payeeNote }) {
    await call("POST", PRODUCTS.collection.create, {
      headers: await headersFor("collection", ref),
      body: { amount: String(amount), currency: cfg.currency, externalId, payer: { partyIdType: "MSISDN", partyId: phone }, payerMessage, payeeNote },
    });
    return ref;
  }

  async function transfer({ ref, amount, phone, externalId, payerMessage, payeeNote }) {
    await call("POST", PRODUCTS.disbursement.create, {
      headers: await headersFor("disbursement", ref),
      body: { amount: String(amount), currency: cfg.currency, externalId, payee: { partyIdType: "MSISDN", partyId: phone }, payerMessage, payeeNote },
    });
    return ref;
  }

  // -> {status: "PENDING" | "SUCCESSFUL" | "FAILED", reason, financialTransactionId}. 404 = MoMo never got the request.
  async function status(product, ref) {
    try {
      const { json } = await call("GET", PRODUCTS[product].status(ref), { headers: await headersFor(product, null) });
      const reason = typeof json?.reason === "object" ? json.reason?.code || json.reason?.message : json?.reason;
      return { status: String(json?.status || "PENDING").toUpperCase(), reason: reason || null, financialTransactionId: json?.financialTransactionId || null };
    } catch (e) {
      if (e.status === 404) return { status: "NOT_FOUND", reason: "MoMo has no request with this reference" };
      throw e;
    }
  }

  // Sandbox only: create an API user and key for one product's subscription key.
  async function provision(subscriptionKey, callbackHost) {
    const user = crypto.randomUUID();
    await call("POST", "/v1_0/apiuser", {
      headers: { "X-Reference-Id": user, "Ocp-Apim-Subscription-Key": subscriptionKey, "Content-Type": "application/json" },
      body: { providerCallbackHost: callbackHost },
    });
    const { json } = await call("POST", `/v1_0/apiuser/${user}/apikey`, { headers: { "Ocp-Apim-Subscription-Key": subscriptionKey } });
    return { user, apiKey: json.apiKey };
  }

  return {
    requestToPay, transfer, provision,
    paymentStatus: (ref) => status("collection", ref),
    transferStatus: (ref) => status("disbursement", ref),
    ready: (product) => ready(cfg, product),
    config: { baseUrl: cfg.baseUrl, targetEnv: cfg.targetEnv, currency: cfg.currency },
  };
}

// ---------------------------------------------------------------- simulated MoMo (no MTN account needed)
// Same interface, state in the database (table momo_sim) because the USSD service starts payments and the notifier
// checks them. Outcomes follow the MTN sandbox test numbers; any other number succeeds after MOMO_SIM_DELAY_MS
// (default 5 s, the time a farmer would take to approve on their phone):
//   46733123450 FAILED   46733123451 REJECTED   46733123452 TIMEOUT   46733123453 / 46733123454 stay PENDING
// MOMO_SIM_FAIL (comma-separated numbers) makes chosen real-looking numbers decline, for demos of a failed payment.
const SIM_OUTCOME = { "46733123450": "FAILED:PAYER_FAILED", "46733123451": "FAILED:REJECTED", "46733123452": "FAILED:EXPIRED", "46733123453": "PENDING", "46733123454": "PENDING" };

function createSimulatedMomo({ db = require("../web/server/db").get(), now = () => Date.now(), delayMs = Number(process.env.MOMO_SIM_DELAY_MS ?? 5000) } = {}) {
  const put = (kind) => async ({ ref, amount, phone }) => {
    await db.run("INSERT INTO momo_sim (ref, kind, phone, amount, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (ref) DO NOTHING", [ref, kind, phone, String(amount), now()]);
    return ref;
  };
  const status = (kind) => async (ref) => {
    const r = await db.one("SELECT * FROM momo_sim WHERE ref = ? AND kind = ?", [ref, kind]);
    if (!r) return { status: "NOT_FOUND", reason: "MoMo has no request with this reference" };
    const forced = (process.env.MOMO_SIM_FAIL || "").split(",").map((x) => x.replace(/\D/g, "")).includes(r.phone) ? "FAILED:PAYER_DECLINED" : SIM_OUTCOME[r.phone];
    if (forced === "PENDING" || now() - r.created_at < delayMs) return { status: "PENDING", reason: null };
    if (forced) return { status: "FAILED", reason: forced.split(":")[1] };
    return { status: "SUCCESSFUL", reason: null, financialTransactionId: "SIM" + String(r.created_at).slice(-9) };
  };
  return {
    requestToPay: put("collection"), transfer: put("disbursement"),
    paymentStatus: status("collection"), transferStatus: status("disbursement"),
    provision: async () => { throw new Error("The simulator needs no credentials."); },
    ready: () => true,
    simulated: true,
    config: { baseUrl: "simulated", targetEnv: "simulated", currency: "RWF" },
  };
}

// MoMo from the environment: the real API when the collection and disbursement credentials are set
// (MOMO_MODE=live|sandbox optional), otherwise the simulator. MOMO_MODE=simulated forces the simulator.
function momoFromEnv(env = process.env) {
  const cfg = configFromEnv(env);
  const real = ready(cfg, "collection") && ready(cfg, "disbursement");
  if (env.MOMO_MODE === "simulated" || !real) return createSimulatedMomo();
  return createMomo(cfg);
}

module.exports = { createMomo, createSimulatedMomo, momoFromEnv, configFromEnv, MomoError };
