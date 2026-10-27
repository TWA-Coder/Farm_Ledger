"use client";
import { useState } from "react";
import { Badge, Box, DataTable, Dialog, KV, Quorum, Stat, Timeline } from "../components/ui";
import { fmt, fromB32, short, signAttestation } from "../lib/chain";
import { DAY, dateTime, eventText, nameOf, relevantEvents } from "../lib/format";
import { ClaimDialog, claimBadge } from "./shared";

const canSign = (snap, c, address) =>
  Boolean(snap.myVet?.certified) && c.status === 1 && !c.iSigned && c.holder.toLowerCase() !== address.toLowerCase();

function Cert({ snap }) {
  const v = snap.myVet;
  if (!v) return <div className="callout err"><b>You are not a certified veterinarian.</b> Ask the administrator to certify your address (licence, sector, expiry). Without certification your signatures are rejected by the contract.</div>;
  if (!v.certified) return <div className="callout err"><b>Your certification is {v.active ? "expired" : "revoked"}.</b> Signatures from this account no longer count until the administrator renews it.</div>;
  return null;
}

export function VetOverview({ snap, address, account, go }) {
  const awaiting = snap.claims.filter((c) => canSign(snap, c, address));
  const mine = snap.claims.filter((c) => c.iSigned);
  const settled = snap.claims.filter((c) => c.status !== 1);
  const recent = relevantEvents(snap, account, address).slice(0, 6);
  return (
    <>
      <Cert snap={snap} />
      <div className="strip">
        <Stat tone={awaiting.length ? "warn" : ""} value={awaiting.length} label="Awaiting your signature" />
        <Stat value={mine.length} label="Signed by you" />
        <Stat value={settled.length} label="Settled claims" />
        <Stat tone="hi" value={`${snap.vetQuorum} of ${Math.max(snap.vets.filter((v) => v.certified).length, snap.vetQuorum)}`} label="Signatures needed (quorum of certified vets)" />
      </div>
      <div className="two">
        <Box title="How your signature works" sub="No vet can pay a claim alone.">
          <p>When a farmer reports a death, each certified vet reviews the evidence and signs <b>approve</b> or <b>reject</b>. The contract checks every signature against the certification registry. The claim pays only when <b>{snap.vetQuorum}</b> different certified vets agree.</p>
          <button className="btn" onClick={() => go("claims")}>Open claims queue{awaiting.length ? ` (${awaiting.length})` : ""}</button>
        </Box>
        <Box title="Recent activity">
          {recent.length === 0 ? <p className="muted">Nothing yet.</p> : <Timeline items={recent.map((e) => ({ text: eventText(e), meta: "block " + e.block }))} />}
        </Box>
      </div>
    </>
  );
}

export function VetClaims({ ctx, snap, cfg, address, run, busy }) {
  const { ledger, signer } = ctx;
  const [open, setOpen] = useState(null);
  const [sign, setSign] = useState(null); // {claim, approved}
  const doSign = async () => {
    const { claim: c, approved } = sign;
    setSign(null); setOpen(null);
    await run(approved ? "Signed: approve" : "Signed: reject", async () => {
      const deadline = snap.now + 3600;
      const sig = await signAttestation(signer, cfg, { claimId: c.id, policyId: c.policyId, tagId: c.tagId, approved, deadline });
      await (await ledger.settleLivestockClaim(c.id, approved, deadline, sig)).wait();
    });
  };
  const sel = open && snap.claims.find((c) => c.id === open);
  return (
    <>
      <Cert snap={snap} />
      <Box title="Claims queue" sub="Your decision is an EIP-712 signed message. Anyone can relay it, but only a currently certified vet's signature counts, and each vet counts once.">
        <DataTable rows={snap.claims} empty="No claims have been filed." onRow={(c) => setOpen(c.id)} initialSort={{ key: "id", dir: "desc" }}
          filters={[{ value: "me", label: "Awaiting my signature" }, { value: "signed", label: "Signed by me" }, { value: "open", label: "Open" }, { value: "2", label: "Approved" }, { value: "3", label: "Rejected" }]}
          filterFn={(c, f) => (f === "me" ? canSign(snap, c, address) : f === "signed" ? c.iSigned : f === "open" ? c.status === 1 : String(c.status) === f)}
          columns={[
            { key: "id", label: "Claim", render: (c) => <>#{c.id}{c.status === 1 && snap.now - Number(c.filedAt) > 2 * DAY ? <span className="pill u">Overdue</span> : null}</>, sort: (c) => c.id, text: (c) => "#" + c.id },
            { key: "tag", label: "Animal" },
            { key: "holder", label: "Farmer", render: (c) => nameOf(c.holder), text: (c) => nameOf(c.holder) },
            { key: "sum", label: "Cover", render: (c) => `${fmt(c.sum)} RWF`, sort: (c) => Number(c.sum), text: (c) => String(c.sum) },
            { key: "quorum", label: "Signatures", render: (c) => <Quorum approvals={c.approvals} rejections={c.rejections} needed={c.quorum} />, sort: (c) => c.approvals, text: () => "" },
            { key: "status", label: "Status", render: (c) => <>{claimBadge(c)}{c.iSigned ? <span className="pill" style={{ background: "var(--gl)", color: "var(--g)" }}>You signed</span> : null}</>, sort: (c) => c.status, text: (c) => ["", "awaiting", "approved", "rejected"][c.status] },
          ]} />
      </Box>

      {sel && (
        <ClaimDialog snap={snap} claim={sel} onClose={() => setOpen(null)}
          actions={canSign(snap, sel, address) ? <>
            <button className="btn dng" disabled={busy} onClick={() => setSign({ claim: sel, approved: false })}>Reject</button>
            <button className="btn" disabled={busy} onClick={() => setSign({ claim: sel, approved: true })}>Confirm death &amp; sign</button></> : null} />
      )}

      {sign && (
        <Dialog title={sign.approved ? "Sign: death confirmed" : "Sign: reject the claim"} onClose={() => setSign(null)}
          sub="You are about to sign a message with your key. It cannot be changed or withdrawn once recorded."
          actions={<><button className="btn sec" onClick={() => setSign(null)}>Cancel</button><button className={"btn" + (sign.approved ? "" : " dng")} onClick={doSign}>Sign &amp; submit</button></>}>
          <KV rows={[
            ["Claim", `#${sign.claim.id} · ${sign.claim.tag}`],
            ["Decision", sign.approved ? "APPROVE (animal died)" : "REJECT"],
            ["Signatures so far", `${sign.claim.approvals} approve / ${sign.claim.rejections} reject, ${sign.claim.quorum} needed`],
            ["Valid for", "1 hour"],
          ]} />
          {sign.approved && sign.claim.approvals + 1 >= sign.claim.quorum && <div className="callout ok">Your signature completes the quorum: the farmer will be paid {fmt(sign.claim.sum)} RWF in this same transaction.</div>}
        </Dialog>
      )}
    </>
  );
}

export function VetProfile({ snap, address }) {
  const v = snap.myVet;
  return (
    <>
      <Cert snap={snap} />
      <Box title="My certification" sub="Recorded on-chain by the administrator. The contract re-checks it on every signature.">
        {!v ? <p className="empty">No certification on record for {short(address)}.</p> : (
          <KV rows={[
            ["Address", address],
            ["Status", <Badge tone={v.certified ? "g" : "r"}>{v.certified ? "Certified" : v.active ? "Expired" : "Revoked"}</Badge>],
            ["Sector", fromB32(v.sector)],
            ["Licence (hash)", v.licenseHash],
            ["Certified on", dateTime(v.certifiedAt)],
            ["Valid until", dateTime(v.validUntil)],
          ]} />
        )}
      </Box>
    </>
  );
}
