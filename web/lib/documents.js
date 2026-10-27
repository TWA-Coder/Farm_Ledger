"use client";
// Browser side of document handling: local validation, signed API calls.
import requirements from "../shared/requirements";
import signing from "../shared/signing";

const { LIMITS } = requirements;
export const MAX_MB = LIMITS.maxBytes / 1024 / 1024;
export const FORMATS = requirements.acceptList();
export const ACCEPT_ATTR = requirements.acceptAttr();

export const newApplicationId = () => (globalThis.crypto?.randomUUID?.() || `app-${Date.now()}-${Math.random().toString(16).slice(2)}`);

export async function sha256Hex(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const formatBytes = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

// Checks size and real content type (not just the file name). Returns an error string or null.
export async function validateFile(file) {
  if (!file) return "Choose a file.";
  if (file.size === 0) return "This file is empty.";
  if (file.size > LIMITS.maxBytes) return `This file is ${formatBytes(file.size)}. The limit is ${MAX_MB} MB.`;
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d;
  const isJpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  if (!isPdf && !isJpg && !isPng) return `This file type is not accepted. Upload a ${FORMATS.replace(/, ([A-Z]+)$/, " or $1")} file.`;
  return null;
}

const now = () => Math.floor(Date.now() / 1000);

async function signed(signer, fields) {
  const issued = now();
  const msg = signing.message({ ...fields, issued });
  return { issued, signature: await signer.signMessage(msg) };
}
async function parse(res) {
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status}).`);
  return body;
}

export async function listDocuments(signer, applicant, application) {
  const { issued, signature } = await signed(signer, { action: "list", applicant, application });
  const q = new URLSearchParams({ applicant, issued: String(issued), signature });
  return (await parse(await fetch(`/api/applications/${application}/documents?${q}`, { cache: "no-store" }))).documents;
}

export async function uploadDocument(signer, applicant, application, document, file, sha256) {
  const { issued, signature } = await signed(signer, { action: "upload", applicant, application, document, sha256, filename: file.name });
  const form = new FormData();
  form.set("file", file); form.set("applicant", applicant); form.set("document", document);
  form.set("sha256", sha256); form.set("issued", String(issued)); form.set("signature", signature);
  return (await parse(await fetch(`/api/applications/${application}/documents`, { method: "POST", body: form }))).document;
}

export async function removeDocument(signer, applicant, application, document) {
  const { issued, signature } = await signed(signer, { action: "delete", applicant, application, document });
  return parse(await fetch(`/api/applications/${application}/documents`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ applicant, document, issued, signature }),
  }));
}

export async function finalizeApplication(signer, applicant, application, ctx, answers) {
  // The signature covers a hash of exactly what is sent, so it cannot be altered in transit.
  const payloadHash = await sha256Hex(new Blob([JSON.stringify({ ctx, answers })]));
  const { issued, signature } = await signed(signer, { action: "submit", applicant, application, sha256: payloadHash });
  return parse(await fetch(`/api/applications/${application}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ applicant, ctx, answers, issued, signature }),
  }));
}

export async function linkApplication(signer, applicant, application, policyId) {
  const { issued, signature } = await signed(signer, { action: "link", applicant, application, document: `policy-${Number(policyId)}` });
  return parse(await fetch(`/api/applications/${application}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ applicant, policyId, issued, signature }),
  }));
}

// Open a document that is stored on the server (e.g. the ID already on file) in a new tab.
export async function viewStored(signer, applicant, application, document) {
  const { issued, signature } = await signed(signer, { action: "view", applicant, application, document });
  const q = new URLSearchParams({ applicant, issued: String(issued), signature });
  const res = await fetch(`/api/applications/${application}/documents/${document}?${q}`, { cache: "no-store" });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not open the document.");
  window.open(URL.createObjectURL(await res.blob()), "_blank", "noopener");
}
