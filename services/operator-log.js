// Who did what from the operator tools (npm run accounts, npm run momo). Every changing command must name its
// operator (--by <name>, or OPERATOR in the environment) and is recorded in the database (table operator_log), so
// support actions can be audited.
const dbm = require("../web/server/db");

function operatorFrom(argv) {
  const i = argv.indexOf("--by");
  const name = (i >= 0 ? argv[i + 1] : process.env.OPERATOR) || "";
  if (!name.trim()) throw new Error("Name yourself: add --by <your name> (or set OPERATOR). Operator actions are logged.");
  return name.trim();
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

async function record({ operator, command, target, detail = "" }, db = dbm.get()) {
  await db.run("INSERT INTO operator_log (at, operator, command, target, detail) VALUES (?, ?, ?, ?, ?)", [new Date().toISOString(), operator, command, String(target), detail]);
}

function recent(limit = 20, db = dbm.get()) {
  return db.all("SELECT * FROM operator_log ORDER BY at DESC LIMIT ?", [limit]);
}

module.exports = { operatorFrom, flag, record, recent };
