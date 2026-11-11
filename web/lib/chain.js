"use client";
import { ethers } from "ethers";
import plainErrors from "../shared/errors";

// Local chain only: Hardhat's public development key #2, which holds the ORACLE role in the local demo. The Test tools
// screen posts sample readings with it. Everyone else signs in (server/auth.js); no other key is in the browser.
export const LOCAL_ORACLE_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

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
  // cacheTimeout -1: ethers otherwise caches identical requests for 250 ms, so two transactions sent back to back
  // (approve, then buy) would read the same nonce and the second would fail with "nonce has already been used".
  return new ethers.JsonRpcProvider(dep.rpcUrl, undefined, { staticNetwork: true, cacheTimeout: -1 });
}

// pkOrSigner: a test-account private key, or a ready signer (smart account, browser wallet)
export function contractsFor(cfg, provider, pkOrSigner) {
  const signer = typeof pkOrSigner === "string" ? new ethers.Wallet(pkOrSigner, provider) : pkOrSigner || provider;
  return {
    signer,
    ledger: new ethers.Contract(cfg.dep.ledger, cfg.abi.ledger, signer),
    token: new ethers.Contract(cfg.dep.token, cfg.abi.token, signer),
    desk: cfg.dep.policyDesk && cfg.abi.policyDesk ? new ethers.Contract(cfg.dep.policyDesk, cfg.abi.policyDesk, signer) : null,
  };
}

export const b32 = (s) => ethers.encodeBytes32String(s.slice(0, 31));
export const hashOf = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
export const fromB32 = (x) => { try { return ethers.decodeBytes32String(x); } catch { return x; } };
export const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const fmt = (n) => Number(n).toLocaleString("en-US");
export const fmtDate = (ts) => new Date(Number(ts) * 1000).toLocaleDateString("en-GB");

export function errMsg(e) {
  const name = e?.revert?.name;
  if (name && plainErrors.PLAIN[name]) return plainErrors.PLAIN[name];
  const m = e?.shortMessage || e?.reason || e?.message || String(e);
  if (/ECONNREFUSED|failed to fetch|could not detect network|network error/i.test(m)) return "Cannot reach the FarmLedger network. Check that the test chain is running.";
  return name || m;
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
