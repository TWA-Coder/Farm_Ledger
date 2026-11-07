// Save the farmer's plain phone number for SMS notifications (see server/contacts.js).
import http from "../../../server/http";
import contacts from "../../../server/contacts";
import chain from "../../../server/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function phoneHashOf(address) {
  const { ethers } = await import("ethers");
  const dep = chain.deployment();
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || dep.rpcUrl, undefined, { staticNetwork: true });
  const ledger = new ethers.Contract(dep.ledger, ["function getFarmer(address) view returns (tuple(bytes32 idHash, bytes32 phoneHash, uint64 registeredAt, bool exists))"], provider);
  const f = await ledger.getFarmer(address);
  return f.exists ? f.phoneHash : null;
}

export async function POST(request) {
  try {
    const b = await request.json();
    return http.json(await contacts.save(b, { phoneHashOf, ownerOf: chain.ownerOf }));
  } catch (e) { return http.fail(e); }
}
