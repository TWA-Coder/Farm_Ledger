// HTTP front of the USSD service: Africa's Talking USSD callbacks (POST /ussd), Africa's Talking SMS delivery reports
// (POST /sms/delivery) and the Android SMS gateway webhook (POST /sms/gateway, see sms-channel.js). Kept apart from
// ussd.js so the access rules can be tested.
//
// Requests that came through the public tunnel carry Cloudflare / proxy headers. Those are refused unless the URL has
// ?key=<CALLBACK_TOKEN>, or the token as the last path segment (/ussd/<CALLBACK_TOKEN>) for gateways whose
// callback-URL field refuses query strings: the phone number in a USSD request is only as trustworthy as whoever sent it, so a stranger
// who learned the tunnel address must not be able to act as a farmer. Direct local requests (the simulator) pass.
const crypto = require("crypto");

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const viaInternet = (req) => Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.headers["cf-ray"]);

const ROUTES = ["/ussd", "/sms/delivery", "/sms/gateway"];
// "/ussd/<key>" -> { route: "/ussd", pathKey: "<key>" }; other paths are returned unchanged.
function splitPath(url) {
  const path = new URL(url, "http://x").pathname;
  for (const r of ROUTES) if (path.startsWith(r + "/") && path.length > r.length + 1) return { route: r, pathKey: decodeURIComponent(path.slice(r.length + 1)) };
  return { route: path, pathKey: "" };
}

function tokenOk(req, token) {
  if (!viaInternet(req)) return true;
  if (!token) return false;
  const key = new URL(req.url, "http://x").searchParams.get("key") || splitPath(req.url).pathKey;
  return key.length === token.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(token));
}

function createHandler({ ussd, outbox, smsChannel = null, token = "", log = console }) {
  return async (req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
    const { route } = splitPath(req.url);
    if (route === "/health") { res.writeHead(200, CORS); return res.end("ok"); }
    if (req.method === "GET" && route === "/") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", ...CORS });
      return res.end("FarmLedger USSD service is running.\n\nThis address is for the phone network (POST /ussd), not for browsers.\nTry it in the simulator: http://localhost:3000/ussd\n");
    }
    // A browser, or a gateway checking the callback URL when it is saved, sends GET: say what this is (no data, no key
    // needed), instead of a 404 that looks like a wrong address.
    if (req.method === "GET" && (ROUTES.includes(route) || route === "/ussd/")) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", ...CORS });
      return res.end("FarmLedger USSD/SMS callback endpoint. The phone network sends POST requests here.\n");
    }
    if (req.method !== "POST" || !ROUTES.includes(route)) { res.writeHead(404, CORS); return res.end("not found"); }
    if (!tokenOk(req, token)) {
      log.warn(`[ussd] refused ${route} from the internet: ${token ? "wrong or missing key" : "CALLBACK_TOKEN is not set"}`);
      res.writeHead(403, CORS); return res.end("forbidden");
    }

    let body = "";
    for await (const chunk of req) { body += chunk; if (body.length > 10_000) { res.writeHead(413, CORS); return res.end(); } }
    if (route === "/sms/gateway") {
      if (!smsChannel) { res.writeHead(404, CORS); return res.end("SMS gateway channel is not enabled"); }
      const r = await smsChannel.handleWebhook({ raw: body, headers: req.headers });
      if (r.status !== 200) log.warn(`[sms-gateway] refused webhook: ${r.body}`);
      res.writeHead(r.status, CORS); return res.end(r.body);
    }
    const ct = req.headers["content-type"] || "";
    let data;
    try { data = ct.includes("json") ? JSON.parse(body || "{}") : Object.fromEntries(new URLSearchParams(body)); }
    catch { res.writeHead(400, CORS); return res.end("bad request"); }

    if (route === "/sms/delivery") { // always 200, so Africa's Talking does not keep retrying a report we cannot use
      const known = await outbox.recordDelivery(data);
      log.log(`[sms] delivery report ${data.id || "?"}: ${data.status || "?"}${data.failureReason ? ` (${data.failureReason})` : ""}${known ? "" : " - unknown message id"}`);
      res.writeHead(200, CORS); return res.end("ok");
    }

    const t0 = Date.now();
    const reply = await ussd.handle({ sessionId: data.sessionId || "s", phoneNumber: data.phoneNumber, text: data.text || "" });
    log.log(`[ussd] ${data.phoneNumber} text="${data.text || ""}" -> ${reply.split("\n")[0]} (${Date.now() - t0} ms)`);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", ...CORS });
    res.end(reply);
  };
}

module.exports = { createHandler, tokenOk };
