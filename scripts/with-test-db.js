// Runs a command against a throwaway PostgreSQL in Docker, then removes it.
//   node scripts/with-test-db.js npx hardhat test       (npm test)
// The tests read TEST_DATABASE_URL; each test file opens its own schema in that database (web/server/db.js
// openIsolated), so they never touch the app's DATABASE_URL (Neon). Set TEST_DATABASE_URL yourself to use another
// server (e.g. a CI service container) and the Docker step is skipped.
const { spawnSync, spawn } = require("child_process");

const NAME = "farmledger-test-pg";
const PORT = Number(process.env.TEST_DB_PORT || 55432);
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/farmledger_test`;
const sh = (args, opts = {}) => spawnSync("docker", args, { encoding: "utf8", ...opts });

async function main() {
  const cmd = process.argv.slice(2);
  if (!cmd.length) { console.error("usage: node scripts/with-test-db.js <command...>"); process.exit(2); }
  let started = false;
  if (!process.env.TEST_DATABASE_URL) {
    if (sh(["info"]).status !== 0) { console.error("Docker is not running. Start Docker Desktop (or set TEST_DATABASE_URL) and try again."); process.exit(1); }
    sh(["rm", "-f", NAME]); // a container left over from an interrupted run
    const run = sh(["run", "-d", "--rm", "--name", NAME, "-p", `127.0.0.1:${PORT}:5432`, "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=farmledger_test",
      "postgres:16", "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off", "-c", "max_connections=300"]);
    if (run.status !== 0) { console.error(run.stderr); process.exit(1); }
    started = true;
    for (let i = 0; i < 60; i++) {
      if (sh(["exec", NAME, "pg_isready", "-U", "postgres", "-d", "farmledger_test", "-h", "127.0.0.1"]).status === 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const env = { ...process.env, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL || URL };
  const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env, shell: process.platform === "win32" });
  const stop = () => { if (started) sh(["rm", "-f", NAME]); };
  process.on("SIGINT", () => { child.kill("SIGINT"); });
  child.on("exit", (code) => { stop(); process.exit(code ?? 1); });
}

main();
