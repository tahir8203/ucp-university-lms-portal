export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function setText(el, value) {
  if (el) el.textContent = value ?? "";
}

export function fmtDate(value) {
  if (!value) return "-";
  const d = typeof value === "string" ? new Date(value) : value?.toDate?.() ?? new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

export function studentKey(rollNo, name) {
  return `${(rollNo || "").trim().toLowerCase()}__${(name || "").trim().toLowerCase()}`;
}

export function parseCSV(text) {
  const input = String(text ?? "").replace(/^\uFEFF/, "");
  if (!input.trim()) return [];

  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') {
      if (inQuotes && input[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      row.push(cell.trim());
      cell = "";
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
      row.push(cell.trim());
      cell = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  row.push(cell.trim());
  if (row.some((v) => v !== "")) rows.push(row);
  if (!rows.length) return [];

  const [header, ...body] = rows;
  const cols = header.map((v) => v.trim().toLowerCase());
  return body.map((vals) => {
    const obj = {};
    cols.forEach((c, i) => {
      obj[c] = vals[i] ?? "";
    });
    return obj;
  });
}

export function escapeHtml(value) {
  return (value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function uniqueById(items) {
  return Array.from(new Map(items.map((i) => [i.id, i])).values());
}
