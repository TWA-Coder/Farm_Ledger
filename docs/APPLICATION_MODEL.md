# Policy application model and how to extend it

This is the structure that will absorb the requirements of the standard policy contract once it is provided.
**No assumption has been made about the contract's mandatory fields.** The documents and fields below exist only
because the booking process already collects the related information (identity, plot, animal).

## Where things live

| Concern | File |
|---|---|
| What an application must contain (documents, questions, limits, required/optional) | `web/shared/requirements.js` |
| Wizard (steps, validation, submit sequence) | `web/views/booking.js` |
| Upload control (formats, size, required badge, replace/remove) | `web/components/upload.js` |
| Browser helpers (file checks, signed API calls) | `web/lib/documents.js` |
| Server rules (content checks, storage, completeness, hash) | `web/server/documents-core.js` |
| HTTP endpoints | `web/app/api/applications/...` |
| On-chain anchor | `FarmLedger.recordApplication(policyId, hash)` |

The same `requirements.js` is loaded by the browser, the server and the tests, so they cannot disagree.

## Stored application record (JSON, schema version 1)

```json
{
  "schemaVersion": 1,
  "application": "<uuid>",
  "applicant": "0x...",
  "ctx": { "cover": 3, "productId": 4, "assetId": 1, "sumInsured": "300000" },
  "answers": { },
  "documents": [ { "document": "health_cert", "sha256": "...", "size": 123456, "mime": "application/pdf" } ],
  "extra": { },
  "applicationHash": "0x...",
  "policyId": 12
}
```

`answers` is a free-form object keyed by field id and `extra` is reserved, so new contract data needs no
migration. The hash covers everything in the record (except `applicationHash`, `policyId` and timestamps).

## Adding a requirement once the contract is available

1. **A new supporting document**: add an entry to `DOCUMENTS` (label, help text, `scope`, `required`, `appliesTo`).
   The wizard, server checks, review table and hash pick it up automatically.
2. **A new question or declaration**: add an entry to `FIELDS` (`id`, `label`, `type`, `required`, optional
   `options`, `appliesTo`, `validate`). The wizard renders it under "Additional information" and the server
   validates it with the same function. Example: a mandatory declaration checkbox.
3. **A rule that depends on other answers**: use `validate(value, answers)`.
4. **Contract text, signatures, generated policy document**: not built yet. The record above is the input for it.
5. Bump `SCHEMA_VERSION` when the shape changes.
6. Add test cases to `test/documents.test.js` (there is already one showing a field being added and enforced).

## Assumptions to confirm (see the hand-over notes)

* Which documents are mandatory vs optional (current choices are listed in the README table).
* Retention period, who may view documents (`FARMLEDGER_REVIEWERS`), and whether documents must be encrypted at rest.
* Whether national ID should be re-collected per application or reused (currently reused).
