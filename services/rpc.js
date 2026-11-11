// Private RPC endpoint from ALCHEMY_API_KEY, so .env needs the key once instead of a full URL per tool.
// The key never goes to the browser: deployment.json carries the network's PUBLIC endpoint (scripts/deploy.js).
// Precedence everywhere: an explicit URL (RPC_URL, POLYGON_AMOY_RPC, ...) > Alchemy from the key > public default.
const ALCHEMY = { polygonAmoy: "polygon-amoy", arbitrumSepolia: "arb-sepolia" }; // hardhat network -> Alchemy slug

function alchemyUrl(network) {
  const slug = ALCHEMY[network];
  const key = process.env.ALCHEMY_API_KEY;
  return slug && key ? `https://${slug}.g.alchemy.com/v2/${key}` : null;
}

// For the services and the portal server: fill RPC_URL from the key when it is not set explicitly.
function applyRpcEnv() {
  if (!process.env.RPC_URL) {
    const url = alchemyUrl(process.env.NETWORK);
    if (url) process.env.RPC_URL = url;
  }
}

module.exports = { alchemyUrl, applyRpcEnv };
