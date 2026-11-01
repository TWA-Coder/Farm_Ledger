"use client";
// Farmer accounts without a wallet app, seed phrase or ETH: an ERC-4337 smart account (SimpleAccount) owned by a key
// kept on this device, with fees paid by the FarmLedger paymaster. The signer itself is shared with the phone-account
// service (shared/smart-account-signer.js); this file only adds the device key.
//
// Prototype limits (documented in the README): the device key lives in this browser's storage, so clearing it or
// changing device loses access. Farmers on basic phones use server-held phone accounts instead (services/phone-accounts.js).
import { ethers } from "ethers";
import sas from "../shared/smart-account-signer";

export const SmartAccountSigner = sas.SmartAccountSigner;
const KEY_STORAGE = "farmledger.deviceKey.v1";

export function deviceOwner() {
  let pk = null;
  try { pk = localStorage.getItem(KEY_STORAGE); } catch { /* storage blocked */ }
  if (!pk) {
    pk = ethers.Wallet.createRandom().privateKey;
    try { localStorage.setItem(KEY_STORAGE, pk); } catch { /* the account only lasts for this page then */ }
  }
  return new ethers.Wallet(pk);
}
