// Settings from the git-ignored env files at the repository root:
//   .env            shared by every network (SMS / Africa's Talking, ALCHEMY_API_KEY, CALLBACK_TOKEN, ...)
//   .env.<network>  only for that network, e.g. .env.polygonAmoy: role keys, PHONE_KEY_SECRET, indexer settings
// The overlay wins over .env, and variables already set in the shell win over both. Keeping network keys out of .env
// matters: on the local chain the services fall back to Hardhat's development keys only when no key is set, so Amoy
// keys in .env would replace them and break the local demo.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const loaded = new Set();

function readEnvFile(name) {
  const file = path.join(ROOT, name);
  return fs.existsSync(file) ? require("dotenv").parse(fs.readFileSync(file)) : null;
}

// network: the Hardhat network name; default NETWORK from the shell, else from .env.
function loadEnv(network) {
  const base = readEnvFile(".env") || {};
  const net = network || process.env.NETWORK || base.NETWORK;
  const overlay = net && net !== "localhost" && net !== "hardhat" ? readEnvFile(`.env.${net}`) || {} : {};
  const key = `${net || "-"}`;
  if (loaded.has(key)) return;
  loaded.add(key);
  for (const [k, v] of Object.entries({ ...base, ...overlay })) if (process.env[k] === undefined) process.env[k] = v;
}

// The Hardhat network of this process (`--network X` or HARDHAT_NETWORK).
function hardhatNetwork(argv = process.argv) {
  const i = argv.indexOf("--network");
  return (i >= 0 && argv[i + 1]) || process.env.HARDHAT_NETWORK || "hardhat";
}

module.exports = { loadEnv, hardhatNetwork };
