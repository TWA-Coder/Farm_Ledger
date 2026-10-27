"use client";
import { useRef, useState } from "react";
import { Badge } from "./ui";
import { ACCEPT_ATTR, FORMATS, MAX_MB, formatBytes } from "../lib/documents";

// One upload control for one required/optional document.
//   item   : { file?: File, error?: string, stored?: {originalName,size,uploadedAt}, uploaded?: boolean }
//   onPick(file) / onRemove() / onViewStored()
export function UploadField({ def, item = {}, onPick, onRemove, onViewStored, disabled }) {
  const input = useRef(null);
  const [over, setOver] = useState(false);
  const has = Boolean(item.file || item.stored);
  const name = item.file?.name || item.stored?.originalName;
  const size = item.file?.size || item.stored?.size;
  const pick = (f) => { if (f) onPick(f); if (input.current) input.current.value = ""; };

  return (
    <div className={"upl" + (item.error ? " bad" : "")} data-doc={def.id}>
      <div className="upl-head">
        <label className="upl-label" htmlFor={`f-${def.id}`}>{def.label}</label>
        <Badge tone={def.required ? "a" : "n"}>{def.required ? "Required" : "Optional"}</Badge>
      </div>
      <p className="upl-help">{def.help}</p>

      <input ref={input} id={`f-${def.id}`} type="file" accept={ACCEPT_ATTR} hidden disabled={disabled} onChange={(e) => pick(e.target.files?.[0])} />

      {!has ? (
        <div
          className={"drop" + (over ? " over" : "")}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) pick(e.dataTransfer.files?.[0]); }}>
          <button type="button" className="btn sec sm" disabled={disabled} onClick={() => input.current?.click()}>Choose file</button>
          <span className="muted">or drop it here</span>
        </div>
      ) : (
        <div className="filerow">
          <span className="fileicon" aria-hidden>{/\.pdf$/i.test(name) ? "PDF" : "IMG"}</span>
          <div className="fileinfo">
            <div className="fname">{name}</div>
            <div className="muted">
              {formatBytes(size)} · {item.file ? (item.uploaded ? "Uploaded" : "Ready to upload") : `On file since ${new Date(item.stored.uploadedAt).toLocaleDateString("en-GB")}`}
            </div>
          </div>
          <div className="fileacts">
            {item.file && <button type="button" className="btn sec sm" onClick={() => window.open(URL.createObjectURL(item.file), "_blank", "noopener")}>View</button>}
            {!item.file && item.stored && onViewStored && <button type="button" className="btn sec sm" onClick={onViewStored}>View</button>}
            <button type="button" className="btn sec sm" disabled={disabled} onClick={() => input.current?.click()}>Replace</button>
            {item.file && <button type="button" className="btn sec sm" disabled={disabled} onClick={onRemove}>Remove</button>}
          </div>
        </div>
      )}
      <div className="upl-foot">
        <span className="muted">{FORMATS.replace(/, ([A-Z]+)$/, " or $1")} · max {MAX_MB} MB</span>
        {item.error && <span className="upl-err" role="alert">{item.error}</span>}
      </div>
    </div>
  );
}
