// Read-only chain access for the API routes (server side). Uses the same deployment file as the browser.
const fs = require("fs");
const path = require("path");

const PUBLIC_DIR = path.join(process.cwd(), "public");
let cached = null;

function deployment() {
  const file = path.join(PUBLIC_DIR, "deployment.json");
  const stat = fs.statSync(file); // re-read after a redeploy
  if (!cached || cached.mtime !== stat.mtimeMs) cached = { mtime: stat.mtimeMs, dep: JSON.parse(fs.readFileSync(file, "utf8")) };
  return cached.dep;
}

// True when `address` holds an active, unexpired vet certification on the deployed contract.
async function isCertifiedVet(address) {
  const { ethers } = require("ethers");
  const dep = deployment();
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || dep.rpcUrl, undefined, { staticNetwork: true });
  const ledger = new ethers.Contract(dep.ledger, ["function isCertifiedVet(address) view returns (bool)"], provider);
  return Boolean(await ledger.isCertifiedVet(address));
}

// Read-only FarmLedger contract with the full ABI the deploy script publishes.
function ledger() {
  const { ethers } = require("ethers");
  const dep = deployment();
  const abi = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, "abi.json"), "utf8"));
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || dep.rpcUrl, undefined, { staticNetwork: true });
  return new ethers.Contract(dep.ledger, abi.ledger, provider);
}

// Read-only CropClaims contract (crop loss claims reviewed by the underwriter), or null on an older deployment.
function cropClaims() {
  const { ethers } = require("ethers");
  const dep = deployment();
  if (!dep.cropClaims) return null;
  const abi = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, "abi.json"), "utf8"));
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || dep.rpcUrl, undefined, { staticNetwork: true });
  return new ethers.Contract(dep.cropClaims, abi.cropClaims, provider);
}

async function isUnderwriter(address) {
  const l = ledger();
  return Boolean(await l.hasRole(await l.UNDERWRITER_ROLE(), address));
}

// owner() of a smart account (ERC-4337 SimpleAccount), or null for a plain key / undeployed address.
async function ownerOf(address) {
  const { ethers } = require("ethers");
  const dep = deployment();
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || dep.rpcUrl, undefined, { staticNetwork: true });
  if ((await provider.getCode(address)) === "0x") return null;
  try { return await new ethers.Contract(address, ["function owner() view returns (address)"], provider).owner(); } catch { return null; }
}

// Read-only PolicyDesk contract (agent applications, underwriter contracts), or null on an older deployment.
function policyDesk() {
  const { ethers } = require("ethers");
  const dep = deployment();
  if (!dep.policyDesk) return null;
  const abi = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, "abi.json"), "utf8"));
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || dep.rpcUrl, undefined, { staticNetwork: true });
  return new ethers.Contract(dep.policyDesk, abi.policyDesk, provider);
}

module.exports = { deployment, isCertifiedVet, ledger, cropClaims, policyDesk, isUnderwriter, ownerOf };
