// Each phone number's language (table ussd_lang): "en" or "rw". Set from the USSD menu ("0" on a first screen) and
// used for both the USSD screens (services/ussd-text.js) and the SMS a farmer receives (services/sms-text.js).
// Numbers that never chose get USSD_DEFAULT_LANG (en).
const LANGS = ["en", "rw"];
const defaultLang = (preferred) => [preferred, process.env.USSD_DEFAULT_LANG].find((l) => LANGS.includes(l)) || "en";

async function langOf(db, phone, preferred) {
  const r = phone ? await db.one("SELECT lang FROM ussd_lang WHERE phone = ?", [String(phone)]) : null;
  return r && LANGS.includes(r.lang) ? r.lang : defaultLang(preferred);
}

async function setLang(db, phone, lang) {
  if (!LANGS.includes(lang)) throw new Error(`Unknown language ${lang}`);
  await db.run(`INSERT INTO ussd_lang (phone, lang, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (phone) DO UPDATE SET lang = excluded.lang, updated_at = excluded.updated_at`, [String(phone), lang, Date.now()]);
}

module.exports = { LANGS, defaultLang, langOf, setLang };
