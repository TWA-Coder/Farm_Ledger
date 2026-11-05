"use client";
// Farmer accounts without a wallet app, seed phrase or ETH: an ERC-4337 smart account (SimpleAccount) owned by a key
// kept on this device, with fees paid by the FarmLedger paymaster. To the rest of the portal it is an ordinary
// ethers signer: contract writes become sponsored UserOperations sent to the bundler.
//
// Prototype limits (documented in the README): the device key lives in this browser's storage, so clearing it or
// changing device loses access (no recovery or guardians yet). Production would use passkeys or a hosted embedded
// wallet, and the canonical EntryPoint with a hosted bundler on a public network.
import { ethers } from "ethers";
import uo from "../shared/userop";

const KEY_STORAGE = "farmledger.deviceKey.v1";
const GAS = { call: 1_500_000n, verifyDeploy: 600_000n, verify: 150_000n, preVerification: 60_000n, paymasterVerify: 150_000n };

export function deviceOwner() {
  let pk = null;
  try { pk = localStorage.getItem(KEY_STORAGE); } catch { /* storage blocked */ }
  if (!pk) {
    pk = ethers.Wallet.createRandom().privateKey;
    try { localStorage.setItem(KEY_STORAGE, pk); } catch { /* the account only lasts for this page then */ }
  }
  return new ethers.Wallet(pk);
}

async function rpc(url, method, params) {
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
  } catch { throw new Error("Cannot reach the fee sponsor (bundler) service. Start it with: npm run bundler"); }
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

export class SmartAccountSigner extends ethers.AbstractSigner {
  // aa: { entryPoint, accountFactory, paymaster, bundlerUrl }; decoders: Interfaces used to explain reverts
  constructor(owner, provider, aa, decoders = [], salt = 0n) {
    super(provider);
    this.owner = owner.connect(provider);
    this.aa = aa;
    this.decoders = decoders;
    this.salt = salt;
    this.entryPoint = new ethers.Contract(aa.entryPoint, uo.ENTRYPOINT_ABI, provider);
    this.factory = new ethers.Contract(aa.accountFactory, uo.FACTORY_ABI, provider);
    this._address = null;
  }

  connect(provider) { return new SmartAccountSigner(this.owner, provider, this.aa, this.decoders, this.salt); }

  async getAddress() {
    if (!this._address) this._address = await this.factory["getAddress(address,uint256)"](this.owner.address, this.salt);
    return this._address;
  }

  // Off-chain messages (document requests) are signed by the owner key; the server checks owner() of the account.
  signMessage(message) { return this.owner.signMessage(message); }
  signTypedData(domain, types, value) { return this.owner.signTypedData(domain, types, value); }
  signTransaction() { throw new Error("A smart account does not sign raw transactions."); }

  async sendTransaction(tx) {
    if (tx.value && BigInt(tx.value) !== 0n) throw new Error("Sending ETH is not supported from a farmer account.");
    return this.sendCalls([{ to: await ethers.resolveAddress(tx.to, this.provider), data: tx.data || "0x" }]);
  }

  // Several contract calls in ONE operation (e.g. approve + buy cover): one confirmation for the farmer.
  async sendCalls(calls) {
    const sender = await this.getAddress();
    const deployed = (await this.provider.getCode(sender)) !== "0x";
    const fee = await this.provider.getFeeData();
    const op = {
      sender,
      nonce: await this.entryPoint.getNonce(sender, 0),
      ...(deployed ? {} : { factory: this.aa.accountFactory, factoryData: uo.factoryData(this.owner.address, this.salt) }),
      callData: uo.encodeCalls(calls),
      callGasLimit: GAS.call,
      verificationGasLimit: deployed ? GAS.verify : GAS.verifyDeploy,
      preVerificationGas: GAS.preVerification,
      maxFeePerGas: fee.maxFeePerGas ?? fee.gasPrice,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n,
      paymaster: this.aa.paymaster,
      paymasterVerificationGasLimit: GAS.paymasterVerify,
      paymasterPostOpGasLimit: 0n,
      paymasterData: "0x",
    };
    const hash = await this.entryPoint.getUserOpHash(uo.packUserOp(op));
    op.signature = await this.owner.signMessage(ethers.getBytes(hash));
    const userOpHash = await rpc(this.aa.bundlerUrl, "eth_sendUserOperation", [uo.toRpc(op), this.aa.entryPoint]);
    const receipt = await rpc(this.aa.bundlerUrl, "eth_getUserOperationReceipt", [userOpHash]);
    if (!receipt) throw new Error("The operation was sent but no receipt came back.");
    if (!receipt.success) {
      const err = new Error("The transaction was rejected by the contract.");
      for (const iface of this.decoders) { try { const p = iface.parseError(receipt.reason); if (p) { err.revert = p; break; } } catch { /* try next */ } }
      throw err;
    }
    // Return the real transaction so callers can .wait() for the receipt and read the contract's events from it.
    return this.provider.getTransaction(receipt.receipt.transactionHash);
  }
}
