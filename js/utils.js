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

export function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (!Number.isFinite(size) || size <= 0) return "0 bytes";
  if (size < 1024) return `${size} bytes`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function lectureSortTime(row) {
  const seconds = Number(row?.createdAt?.seconds ?? row?.createdAt?._seconds ?? 0);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const date = Date.parse(row?.date || "");
  return Number.isFinite(date) ? date : 0;
}

export function withLectureSequence(items = []) {
  const groups = new Map();
  items.forEach((item) => {
    const classId = String(item?.classId || "");
    if (!groups.has(classId)) groups.set(classId, []);
    groups.get(classId).push(item);
  });

  const numbered = [];
  groups.forEach((group) => {
    const chronological = [...group].sort((a, b) =>
      lectureSortTime(a) - lectureSortTime(b) || String(a.id || "").localeCompare(String(b.id || ""))
    );
    const reserved = new Set(chronological
      .map((row) => Number(row.lectureNumber))
      .filter((value) => Number.isInteger(value) && value > 0));
    const assigned = new Set();
    let next = 1;

    chronological.forEach((row) => {
      let number = Number(row.lectureNumber);
      if (!Number.isInteger(number) || number < 1 || assigned.has(number)) {
        while (reserved.has(next) || assigned.has(next)) next += 1;
        number = next;
      }
      assigned.add(number);
      numbered.push({ ...row, displayLectureNumber: number });
    });
  });

  return numbered.sort((a, b) =>
    String(a.classId || "").localeCompare(String(b.classId || ""))
    || Number(a.displayLectureNumber || 0) - Number(b.displayLectureNumber || 0)
    || lectureSortTime(a) - lectureSortTime(b)
  );
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
