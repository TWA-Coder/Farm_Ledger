// Scores System Usability Scale (SUS) answers for NFR-05 (target: mean >= 80).
// Usage: npm run sus -- responses.csv
// CSV columns: participant,group,q1..q10, answers 1-5. See docs/research/SUS-usability-test.md.
const fs = require("fs");

const TARGET = 80;

function susScore(answers) {
  if (answers.length !== 10) throw new Error("expected 10 answers");
  let sum = 0;
  answers.forEach((a, i) => {
    if (!Number.isInteger(a) || a < 1 || a > 5) throw new Error(`answer q${i + 1} must be 1-5, got "${a}"`);
    sum += i % 2 === 0 ? a - 1 : 5 - a; // q1, q3, ... positive; q2, q4, ... negative
  });
  return sum * 2.5;
}

function parse(csv) {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const head = lines.shift().split(",").map((h) => h.trim().toLowerCase());
  const qi = Array.from({ length: 10 }, (_, i) => head.indexOf(`q${i + 1}`));
  if (qi.includes(-1)) throw new Error("header must contain q1..q10");
  const pi = head.indexOf("participant"), gi = head.indexOf("group");
  return lines.map((line, n) => {
    const c = line.split(",").map((x) => x.trim());
    const who = pi >= 0 ? c[pi] : `row ${n + 2}`;
    try {
      return { who, group: gi >= 0 && c[gi] ? c[gi] : "all", score: susScore(qi.map((i) => Number(c[i]))) };
    } catch (e) {
      throw new Error(`${who}: ${e.message}`);
    }
  });
}

function stats(xs) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1)) : 0;
  return { n: xs.length, mean, sd, min: Math.min(...xs), max: Math.max(...xs) };
}

function report(rows) {
  const out = ["| Participant | Group | SUS |", "|---|---|---:|"];
  for (const r of rows) out.push(`| ${r.who} | ${r.group} | ${r.score.toFixed(1)} |`);
  out.push("", "| Group | n | Mean | SD | Min | Max | NFR-05 (>= 80) |", "|---|---:|---:|---:|---:|---:|:--:|");
  const groups = [...new Set(rows.map((r) => r.group))];
  const line = (name, xs) => {
    const s = stats(xs);
    out.push(`| ${name} | ${s.n} | ${s.mean.toFixed(1)} | ${s.sd.toFixed(1)} | ${s.min.toFixed(1)} | ${s.max.toFixed(1)} | ${s.mean >= TARGET ? "met" : "not met"} |`);
  };
  for (const g of groups) line(g, rows.filter((r) => r.group === g).map((r) => r.score));
  if (groups.length > 1) line("**overall**", rows.map((r) => r.score));
  return out.join("\n");
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run sus -- responses.csv");
    process.exit(1);
  }
  try {
    const rows = parse(fs.readFileSync(file, "utf8"));
    if (!rows.length) throw new Error("no responses in the file");
    console.log(report(rows));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { susScore, parse, report };
