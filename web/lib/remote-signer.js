"use client";
// The signed-in person's account, acting through the portal server. Their key never reaches the browser: the server
// passes each transaction / signature to the custody service (server/auth.js, services/custody.js). Screens use this
// like any ethers signer, so contract calls look the same as with a wallet.
import { ethers } from "ethers";

// JSON call to the portal API. Changes carry X-FarmLedger: 1 (the server refuses cross-site requests without it).
export async function api(path, body) {
  const res = await fetch(path, body === undefined ? { cache: "no-store" } : {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", "X-FarmLedger": "1" }, body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(j.error || `The portal server answered ${res.status}.`);
    e.status = res.status;
    if (j.revert) e.revert = j.revert;
    throw e;
  }
  return j;
}

// BigInts (claim ids, chain id) as decimal strings, so typed data can travel as JSON.
const plain = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

export class RemoteSigner extends ethers.AbstractSigner {
  constructor(address, provider) { super(provider); this.address = address; }
  connect(provider) { return new RemoteSigner(this.address, provider); }
  async getAddress() { return this.address; }
  async signTransaction() { throw new Error("Transactions are signed for you by the FarmLedger server."); }

  async sendTransaction(tx) {
    const to = await ethers.resolveAddress(tx.to, this.provider);
    const { hash } = await api("/api/wallet", { op: "send", tx: { to, data: tx.data || "0x" } });
    for (let i = 0; i < 240; i++) {
      const sent = await this.provider.getTransaction(hash);
      if (sent) return sent;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Transaction ${hash} was sent but the network has not shown it yet. Refresh in a moment.`);
  }

  async signMessage(message) {
    const text = typeof message === "string" ? message : ethers.toUtf8String(message);
    return (await api("/api/wallet", { op: "sign", message: text })).signature;
  }

  async signTypedData(domain, types, value) {
    return (await api("/api/wallet", { op: "sign", typed: plain({ domain, types, value }) })).signature;
  }
}
