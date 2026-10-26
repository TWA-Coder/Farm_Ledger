// Shared helpers for the off-chain services (oracle + notifier).
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");

function loadDeployment() {
  const network = process.env.NETWORK || "localhost";
  const file = path.join(ROOT, "deployments", `${network}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment found at ${file}. Run "npm run deploy:local" first.`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadAbi() {
  const file = path.join(ROOT, "web", "public", "abi.json");
  if (!fs.existsSync(file)) throw new Error(`ABI not found at ${file}. Run "npm run deploy:local" first.`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Well-known Hardhat development keys (public, local chain ONLY). Account #2 holds the ORACLE role in the demo.
const HARDHAT_KEYS = {
  oracle: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
};

function connect(role, keyEnv) {
  const dep = loadDeployment();
  const abi = loadAbi();
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || dep.rpcUrl);
  const key = process.env[keyEnv] || HARDHAT_KEYS[role];
  const signer = key ? new ethers.Wallet(key, provider) : null;
  const ledger = new ethers.Contract(dep.ledger, abi.ledger, signer || provider);
  return { dep, provider, signer, ledger };
}

module.exports = { ROOT, loadDeployment, loadAbi, connect };
