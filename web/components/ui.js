"use client";
import { useEffect, useMemo, useState } from "react";

const ICONS = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  pulse: "M3 12h4l3-8 4 16 3-8h4",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 4-6 8-6s8 2 8 6",
  lock: "M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z",
  sliders: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M14 4v4M8 10v4M16 16v4",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5",
  flask: "M9 3h6M10 3v6L4 20h16l-6-11V3",
  phone: "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4",
  menu: "M4 6h16M4 12h16M4 18h16",
  box: "M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10",
  check: "M5 13l4 4L19 7",
};
export function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={ICONS[name] || ICONS.file} />
    </svg>
  );
}

export function Badge({ tone = "n", children }) { return <span className={`bdg b-${tone}`}>{children}</span>; }

export function Stat({ value, label, tone }) {
  return <div className={"stat" + (tone ? " " + tone : "")}><b>{value}</b><small>{label}</small></div>;
}

export function Box({ title, sub, children, right }) {
  return (
    <section className="box">
      {(title || right) && <div style={{ display: "flex", gap: 10, alignItems: "start" }}><div style={{ flex: 1 }}>{title && <h2>{title}</h2>}{sub && <p className="sub">{sub}</p>}</div>{right}</div>}
      {children}
    </section>
  );
}

// steps: [{label, state: "done" | "cur" | "bad" | ""}]
export function Stepper({ steps }) {
  return (
    <div className="steps" role="list">
      {steps.map((s, i) => (
        <div key={i} className={"st " + (s.state || "")} role="listitem">
          <i>{s.state === "done" ? "✓" : s.state === "bad" ? "✕" : i + 1}</i>{s.label}
        </div>
      ))}
    </div>
  );
}

export function Timeline({ items }) {
  if (!items.length) return <p className="muted">No activity yet.</p>;
  return <div className="tl">{items.map((t, i) => <div key={i} className={t.bad ? "bad" : ""}>{t.text}{t.meta && <span className="muted"> · {t.meta}</span>}</div>)}</div>;
}

export function Quorum({ approvals, rejections, needed }) {
  const slots = Math.max(needed, approvals + rejections);
  return (
    <span className="quorum" title={`${approvals} approve, ${rejections} reject, ${needed} needed`}>
      {Array.from({ length: slots }, (_, i) => <span key={i} className={i < approvals ? "y" : i < approvals + rejections ? "n" : ""} />)}
      <span className="muted" style={{ width: "auto", height: "auto", background: "none", marginLeft: 4 }}>{approvals}/{needed}</span>
    </span>
  );
}

export function Dialog({ title, sub, children, actions, onClose }) {
  useEffect(() => {
    const h = (e) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="ov" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="dlg" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>{sub && <p className="sub">{sub}</p>}
        {children}
        <div className="acts">{actions}</div>
      </div>
    </div>
  );
}

export function Toasts({ items }) {
  return <div id="toasts" aria-live="polite">{items.map((t) => <div key={t.id} className={"ts" + (t.err ? " err" : "")}>{t.msg}</div>)}</div>;
}

export function KV({ rows }) {
  return <dl className="kv">{rows.map(([k, v], i) => <div key={i} style={{ display: "contents" }}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

// Searchable, filterable, sortable, paginated table (same interaction model as the portal prototype).
// columns: [{key, label, render?(row), sort?(row) -> comparable, text?(row) -> searchable}]
export function DataTable({ rows, columns, filters, filterFn, onRow, pageSize = 8, empty = "Nothing to show.", initialSort }) {
  const [q, setQ] = useState("");
  const [f, setF] = useState("all");
  const [sort, setSort] = useState(initialSort || null);
  const [page, setPage] = useState(0);

  const shown = useMemo(() => {
    let r = rows;
    if (f !== "all" && filterFn) r = r.filter((x) => filterFn(x, f));
    if (q.trim()) {
      const n = q.trim().toLowerCase();
      r = r.filter((x) => columns.some((c) => String(c.text ? c.text(x) : x[c.key] ?? "").toLowerCase().includes(n)));
    }
    if (sort) {
      const c = columns.find((x) => x.key === sort.key);
      const val = (x) => (c.sort ? c.sort(x) : x[c.key]);
      r = [...r].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * (sort.dir === "asc" ? 1 : -1));
    }
    return r;
  }, [rows, q, f, sort, columns, filterFn]);

  const pages = Math.max(1, Math.ceil(shown.length / pageSize));
  useEffect(() => { if (page >= pages) setPage(0); }, [pages, page]);
  const view = shown.slice(page * pageSize, page * pageSize + pageSize);

  return (
    <div>
      <div className="tools">
        <input aria-label="Search" placeholder="Search…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        {filters && (
          <select aria-label="Filter by status" value={f} onChange={(e) => { setF(e.target.value); setPage(0); }}>
            <option value="all">All statuses</option>
            {filters.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
        )}
      </div>
      <div className="tbl">
        <table>
          <thead><tr>{columns.map((c) => (
            <th key={c.key} onClick={() => setSort(sort?.key === c.key ? { key: c.key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key: c.key, dir: "asc" })}>
              {c.label}{sort?.key === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
            </th>))}</tr></thead>
          <tbody>
            {view.length === 0 && <tr><td colSpan={columns.length}><div className="empty">{empty}</div></td></tr>}
            {view.map((r, i) => (
              <tr key={r.id ?? r.address ?? i} className={onRow ? "click" : ""} onClick={() => onRow?.(r)}>
                {columns.map((c) => <td key={c.key}>{c.render ? c.render(r) : r[c.key]}</td>)}
              </tr>))}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <span>{shown.length} item{shown.length === 1 ? "" : "s"}</span>
        <button className="btn sec sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Prev</button>
        <span>{page + 1} / {pages}</span>
        <button className="btn sec sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}
