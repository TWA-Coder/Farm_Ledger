// Canonical text that the applicant's wallet signs for every document request.
// Shared by the browser (to sign) and the server (to verify) so they always agree byte for byte.
function message({ action, applicant, application, document = "-", sha256 = "-", filename = "-", issued }) {
  return [
    "FarmLedger document request",
    `action: ${action}`,
    `applicant: ${String(applicant).toLowerCase()}`,
    `application: ${application}`,
    `document: ${document}`,
    `sha256: ${sha256}`,
    `filename: ${filename}`,
    `issued: ${issued}`,
  ].join("\n");
}
module.exports = { message };
