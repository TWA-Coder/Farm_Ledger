// Exports every USSD screen and farmer SMS as English / Kinyarwanda pairs to a CSV, for native speakers to review.
// Usage: npm run translations [-- out.csv]   (default: services/out/translations-review.csv)
// Texts with numbers or names in them are filled with sample values, e.g. {A}, 12345.
const fs = require("fs");
const path = require("path");
const { TEXT } = require("../services/ussd-text");
const { SMS } = require("../services/sms-text");

const SAMPLE_TS = Math.floor(Date.UTC(2026, 0, 15) / 1000);

function render(v) {
  if (typeof v !== "function") return String(v);
  // try sample arguments in turn: placeholders, then numbers and a timestamp (for date helpers)
  const tries = [
    Array.from({ length: v.length }, (_, i) => `{${String.fromCharCode(65 + i)}}`),
    Array.from({ length: v.length }, () => SAMPLE_TS),
    Array.from({ length: v.length }, () => SAMPLE_TS * 1000),
  ];
  for (const args of tries) {
    try {
      const out = v(...args);
      if (typeof out === "string") return out;
    } catch { /* next */ }
  }
  return `[function: ${v.toString().slice(0, 120)}]`;
}

function flatten(obj, prefix = "") {
  const rows = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") Object.assign(rows, flatten(v, key));
    else rows[key] = render(v);
  }
  return rows;
}

const csvCell = (s) => `"${String(s).replace(/"/g, '""')}"`;

function rowsFor(channel, table) {
  const en = flatten(table.en), rw = flatten(table.rw);
  return Object.keys(en).map((k) => [channel, k, en[k], rw[k] ?? "", "", "", ""]);
}

const out = process.argv[2] || path.join(__dirname, "..", "services", "out", "translations-review.csv");
const rows = [["channel", "key", "english", "kinyarwanda_draft", "ok_yes_no", "suggested_kinyarwanda", "reviewer_comment"],
  ...rowsFor("ussd", TEXT), ...rowsFor("sms", SMS)];
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n"); // BOM: opens in Excel
console.log(`Wrote ${rows.length - 1} texts to ${out}`);
