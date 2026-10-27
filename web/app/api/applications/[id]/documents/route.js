import http from "../../../../../server/http";
import core from "../../../../../server/documents-core";
import req from "../../../../../shared/requirements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const { store, json, fail, authenticate } = http;

// Upload or replace one document. multipart/form-data: file, applicant, document, sha256, issued, signature
export async function POST(request, { params }) {
  try {
    const length = Number(request.headers.get("content-length") || 0);
    if (length > req.LIMITS.maxBytes + 64 * 1024) throw new core.DocError(413, `The file is larger than ${req.LIMITS.maxBytes / 1024 / 1024} MB.`);
    const form = await request.formData();
    const file = form.get("file");
    const f = (k) => String(form.get(k) || "");
    if (!file || typeof file === "string") throw new core.DocError(400, "No file received.");
    const application = params.id;
    const applicant = f("applicant"), document = f("document"), sha256 = f("sha256");
    core.checkIds({ applicant, application, document });
    authenticate({ action: "upload", applicant, application, document, sha256, filename: file.name, issued: f("issued"), signature: f("signature") });
    const buffer = Buffer.from(await file.arrayBuffer());
    core.inspectUpload(buffer, sha256); // size, real content type, and hash must match what was signed
    const meta = store.put({ applicant, application, document, buffer, originalName: file.name });
    return json({ document: meta });
  } catch (e) { return fail(e); }
}

// Remove one document. JSON: applicant, document, issued, signature
export async function DELETE(request, { params }) {
  try {
    const b = await request.json();
    const application = params.id;
    core.checkIds({ applicant: b.applicant, application, document: b.document });
    authenticate({ action: "delete", applicant: b.applicant, application, document: b.document, issued: b.issued, signature: b.signature });
    return json({ removed: store.remove({ applicant: b.applicant, application, document: b.document }) });
  } catch (e) { return fail(e); }
}

// List what is on file for this application (plus the applicant's reusable profile documents).
export async function GET(request, { params }) {
  try {
    const q = new URL(request.url).searchParams;
    const application = params.id, applicant = q.get("applicant") || "";
    core.checkIds({ applicant, application });
    authenticate({ action: "list", applicant, application, issued: q.get("issued"), signature: q.get("signature") });
    return json({ documents: store.list({ applicant, application }).map(({ id, label, document, scope, originalName, mime, size, sha256, uploadedAt }) => ({ id, label, document, scope, originalName, mime, size, sha256, uploadedAt })) });
  } catch (e) { return fail(e); }
}
