// Single source of truth for what a policy application must contain.
// Used by the browser (wizard, validation) AND the server (upload checks, completeness check), so the two can
// never disagree. CommonJS on purpose: the Hardhat tests and the Next.js server both load it.
//
// HOW TO EXTEND (contract-compliance phase)
//   * New supporting document  -> add an entry to DOCUMENTS.
//   * New question/declaration -> add an entry to FIELDS (type, required, validate, appliesTo).
//   * Nothing else needs to change: the wizard renders FIELDS and DOCUMENTS generically, the server stores
//     answers as a free-form JSON object, and the application hash covers whatever is stored.
//   * Bump SCHEMA_VERSION when the shape changes so old applications stay interpretable.
const SCHEMA_VERSION = 1;

const LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  accept: [
    { ext: "pdf", mime: "application/pdf", label: "PDF" },
    { ext: "jpg", mime: "image/jpeg", label: "JPG" },
    { ext: "png", mime: "image/png", label: "PNG" },
  ],
};

// Cover enum values mirror the contract: 0 Drought, 1 Flood, 2 Low NDVI, 3 Livestock.
const isLivestock = (ctx) => Number(ctx.cover) === 3;
const isCrop = (ctx) => Number(ctx.cover) !== 3;

// scope "applicant"   : belongs to the person, reused across their applications once uploaded.
// scope "application" : belongs to this application only.
const DOCUMENTS = {
  national_id: {
    label: "National ID (front and back)",
    field: "Applicant identity",
    help: "Both sides of the ID used at registration, readable and not expired.",
    scope: "applicant",
    required: true,
    appliesTo: () => true,
  },
  land_proof: {
    label: "Proof of land use",
    field: "Insured plot",
    help: "Land title, lease or a letter from the Sector land office showing you farm this plot.",
    scope: "application",
    required: true,
    appliesTo: isCrop,
  },
  field_photo: {
    label: "Recent photo of the plot",
    field: "Insured plot",
    help: "Helps the underwriter confirm the crop. Not required.",
    scope: "application",
    required: false,
    appliesTo: isCrop,
  },
  animal_photo: {
    label: "Photo of the animal showing the ear tag",
    field: "Insured animal",
    help: "The ear tag number must be readable. This is the reference photo for any later claim.",
    scope: "application",
    required: true,
    appliesTo: isLivestock,
  },
  health_cert: {
    label: "Veterinary health certificate",
    field: "Insured animal",
    help: "Issued by a registered veterinarian, dated within the last 6 months.",
    scope: "application",
    required: true,
    appliesTo: isLivestock,
  },
  ownership_proof: {
    label: "Proof of ownership",
    field: "Insured animal",
    help: "Purchase receipt or cattle registration. Not required.",
    scope: "application",
    required: false,
    appliesTo: isLivestock,
  },
};

// Additional questions / declarations. Empty until the standard policy contract is supplied.
// Shape: { id, label, type: "text"|"number"|"date"|"select"|"checkbox"|"textarea", required, options?, help?,
//          appliesTo?(ctx), validate?(value, answers) -> string|null }
const FIELDS = [];

const documentsFor = (ctx) =>
  Object.entries(DOCUMENTS).filter(([, d]) => d.appliesTo(ctx)).map(([id, d]) => ({ id, ...d, appliesTo: undefined }));

const fieldsFor = (ctx) => FIELDS.filter((f) => !f.appliesTo || f.appliesTo(ctx));

// have: array of document ids that are present (uploaded, queued or on file)
function missingDocuments(ctx, have) {
  const set = new Set(have);
  return documentsFor(ctx).filter((d) => d.required && !set.has(d.id)).map((d) => d.id);
}

function validateAnswers(ctx, answers = {}) {
  const errors = {};
  for (const f of fieldsFor(ctx)) {
    const v = answers[f.id];
    const empty = v === undefined || v === null || v === "" || v === false;
    if (f.required && empty) { errors[f.id] = `${f.label} is required.`; continue; }
    if (!empty && f.validate) { const m = f.validate(v, answers); if (m) errors[f.id] = m; }
  }
  return errors;
}

const acceptList = () => LIMITS.accept.map((a) => a.label).join(", ");
const acceptAttr = () => LIMITS.accept.map((a) => "." + a.ext + "," + a.mime).join(",");

module.exports = { SCHEMA_VERSION, LIMITS, DOCUMENTS, FIELDS, documentsFor, fieldsFor, missingDocuments, validateAnswers, acceptList, acceptAttr };
