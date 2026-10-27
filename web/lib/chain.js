"use client";
import { ethers } from "ethers";

// Well-known Hardhat development keys (public; local chain only). Real users would use a wallet / account abstraction.
export const DEMO_ACCOUNTS = [
  { key: "admin", label: "Admin", role: "admin", pk: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" },
  { key: "underwriter", label: "Underwriter (Old Mutual demo)", role: "underwriter", pk: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" },
  { key: "oracle", label: "Oracle", role: "oracle", pk: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" },
  { key: "vet", label: "Dr. Mukamana (Vet 1)", role: "vet", pk: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", license: "RVC-LIC-001" },
  { key: "vet2", label: "Dr. Habimana (Vet 2)", role: "vet", pk: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356", license: "RVC-LIC-002" },
  { key: "vet3", label: "Dr. Uwase (Vet 3)", role: "vet", pk: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97", license: "RVC-LIC-003" },
  { key: "aline", label: "Aline (Farmer, Bugesera)", role: "farmer", pk: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", phone: "250788000001", nid: "1199080012345678" },
  { key: "jean", label: "Jean (Farmer, Nyagatare)", role: "farmer", pk: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", phone: "250788000002", nid: "1198570087654321" },
  { key: "new", label: "New farmer (unregistered)", role: "farmer", pk: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", phone: "250788000003", nid: "1199512345678901" },
];

// Derive public addresses once so views can recognise demo accounts.
DEMO_ACCOUNTS.forEach((a) => { a.addr = new ethers.Wallet(a.pk).address; });

export const COVER = ["Drought", "Flood", "Low vegetation (NDVI)", "Livestock mortality"];
export const POLICY_STATUS = ["Active", "Claim pending", "Paid out", "Expired"];
export const CLAIM_STATUS = ["None", "Pending", "Approved", "Rejected"];

export async function loadConfig() {
  const [dep, abi] = await Promise.all([
    fetch("/deployment.json", { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error("deployment.json missing - run deploy:local"); return r.json(); }),
    fetch("/abi.json", { cache: "no-store" }).then((r) => r.json()),
  ]);
  return { dep, abi };
}

export function makeProvider(dep) {
  return new ethers.JsonRpcProvider(dep.rpcUrl, undefined, { staticNetwork: true });
}

export function contractsFor(cfg, provider, pk) {
  const signer = pk ? new ethers.Wallet(pk, provider) : provider;
  return {
    signer,
    ledger: new ethers.Contract(cfg.dep.ledger, cfg.abi.ledger, signer),
    token: new ethers.Contract(cfg.dep.token, cfg.abi.token, signer),
  };
}

export const b32 = (s) => ethers.encodeBytes32String(s.slice(0, 31));
export const hashOf = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
export const fromB32 = (x) => { try { return ethers.decodeBytes32String(x); } catch { return x; } };
export const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const fmt = (n) => Number(n).toLocaleString("en-US");
export const fmtDate = (ts) => new Date(Number(ts) * 1000).toLocaleDateString("en-GB");

export function errMsg(e) {
  return e?.revert?.name || e?.shortMessage || e?.reason || e?.message || String(e);
}

// Local-chain demo controls
export async function advanceTime(provider, seconds) {
  await provider.send("evm_increaseTime", [seconds]);
  await provider.send("evm_mine", []);
}

export async function signAttestation(signer, cfg, att) {
  const net = await signer.provider.getNetwork();
  return signer.signTypedData(
    { name: "FarmLedger", version: "1", chainId: net.chainId, verifyingContract: cfg.dep.ledger },
    {
      Attestation: [
        { name: "claimId", type: "uint256" }, { name: "policyId", type: "uint256" },
        { name: "tagId", type: "bytes32" }, { name: "approved", type: "bool" }, { name: "deadline", type: "uint256" },
      ],
    },
    att,
  );
}
