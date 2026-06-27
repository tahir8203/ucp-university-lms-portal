import { requireStaffRole, logoutStaff, generateStudentPassword, setStudentPasswordRecord } from "./auth.js";
import { parseCSV, qs, qsa, fmtDate, escapeHtml, studentKey } from "./utils.js";
import {
  db,
  storage,
  serverTimestamp,
  collection,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  writeBatch,
  doc,
  query,
  where,
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
} from "./firebase.js";
import { uploadFileToFirestore, fileHref, loadFilePayload } from "./fileStore.js";

const state = {
  me: null,
  classes: [],
  lectures: [],
  quizzes: [],
  quizDrafts: [],
  assignments: [],
  evalStats: [],
  announcements: [],
  quizQuestions: [],
  activeQuestionIndex: 0,
  draftTimer: null,
  draftDirty: false,
  lastDraftHash: "",
  quizAttemptsReview: [],
  quizAnalyticsRows: [],
  analyticsClassFilter: "",
  reviewClassFilter: "",
  analyticsQuizFilter: "",
  reviewQuizFilter: "",
  assignmentClassFilter: "",
  assignmentNumberFilter: "",
  evaluationClassFilter: "",
  lastEnrollCredentials: [],
};

function normalizeMcqKey(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n)) return 1;
  if (n >= 1 && n <= 4) return n;
  if (n >= 0 && n <= 3) return n + 1;
  return 1;
}

function normalizeQuestion(raw = {}) {
  const type = raw.type === "theory" ? "theory" : "mcq";
  const parsedMarks = Number(raw.maxMarks);
  const maxMarks = type === "mcq" ? 1 : (Number.isFinite(parsedMarks) && parsedMarks > 0 ? parsedMarks : 5);
  return {
    type,
    promptHtml: raw.promptHtml || raw.text || "",
    options: Array.isArray(raw.options) ? raw.options.slice(0, 4).concat(["", "", "", ""]).slice(0, 4) : ["", "", "", ""],
    correctIndex: normalizeMcqKey(raw.correctIndex),
    theoryAnswer: raw.theoryAnswer || "",
    imageDataUrl: raw.imageDataUrl || "",
    imageName: raw.imageName || "",
    questionTimeSec: Number(raw.questionTimeSec || 0),
    maxMarks,
  };
}

function buildQuizPayload() {
  return {
    teacherId: state.me.uid,
    classId: qs("#quizClassId").value,
    quizNumber: Number(qs("#quizNumber").value),
    title: qs("#quizTitle").value.trim(),
    durationMin: Number(qs("#quizDuration").value || 1),
    attemptLimit: Number(qs("#quizAttemptLimit").value || 1),
    antiCheatEnabled: !!qs("#quizAntiCheat").checked,
    questions: state.quizQuestions.map(normalizeQuestion),
  };
}

function setDraftStatus(text) {
  qs("#draftStatus").textContent = text;
}

function draftPayloadHash(payload) {
  return JSON.stringify({
    classId: payload.classId,
    quizNumber: payload.quizNumber,
    title: payload.title,
    durationMin: payload.durationMin,
    attemptLimit: payload.attemptLimit,
    antiCheatEnabled: payload.antiCheatEnabled,
    questions: payload.questions,
  });
}

function markDraftDirty() {
  state.draftDirty = true;
  setDraftStatus("Draft has unsaved changes.");
}

function renderQuizBuilderStats() {
  const total = state.quizQuestions.length;
  const mcq = state.quizQuestions.filter((q) => q.type === "mcq").length;
  const theory = total - mcq;
  const active = total ? state.activeQuestionIndex + 1 : 0;
  qs("#quizBuilderStats").innerHTML = `
    <span class="chip chip-blue">Questions: ${total}</span>
    <span class="chip chip-green">MCQ: ${mcq}</span>
    <span class="chip chip-amber">Theory: ${theory}</span>
    <span class="chip chip-slate">Editing: ${active}/${Math.max(total, 1)}</span>
  `;
}

function setClassEnrollMsg(text) {
  const el = qs("#classEnrollMsg");
  if (el) el.textContent = text;
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function classNameById(classId) {
  return state.classes.find((c) => c.id === classId)?.name || classId;
}

function timestampToText(ts) {
  return ts ? fmtDate(ts) : "-";
}

function effectiveQuizAttemptCount(attempts = []) {
  return attempts.filter((a) => !a.unlockedAt).length;
}

function canUnlockAttempt(attempt, quiz) {
  if (!attempt || attempt.unlockedAt) return false;
  const quizAttempts = state.quizAttemptsReview.filter((a) => a.quizId === attempt.quizId && a.studentKey === attempt.studentKey);
  return !!attempt.locked || effectiveQuizAttemptCount(quizAttempts) >= Number(quiz?.attemptLimit || 1);
}

function quizHasTheoryQuestions(quiz) {
  return !!(quiz?.questions || []).some((q) => q.type === "theory");
}

function canExportQuizResults(quizId, classId = "") {
  const quiz = state.quizzes.find((q) => q.id === quizId);
  if (!quiz) return false;
  if (!quizHasTheoryQuestions(quiz)) return true;
  const attempts = state.quizAttemptsReview.filter((a) => a.quizId === quizId && (!classId || a.classId === classId));
  if (!attempts.length) return true;
  return attempts.every((a) => !a.theoryPending);
}

const STOPWORDS = new Set(["a","an","the","is","are","was","were","be","been","being","to","of","in","on","at","for","and","or","but","with","as","by","it","this","that","these","those","its","from","into","than","then","so","such","if","not","no","do","does","did","has","have","had","can","could","should","would","will","shall","may","might","also","there","their","they","them","i","we","you","he","she"]);

function tokenizeAnswer(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
}

function answerSimilarityScore(studentAnswer, referenceAnswer) {
  const refTokens = tokenizeAnswer(referenceAnswer);
  if (!refTokens.length) return null;
  const studentTokens = new Set(tokenizeAnswer(studentAnswer));
  if (!studentTokens.size) return 0;
  const refSet = new Set(refTokens);
  let overlap = 0;
  for (const w of refSet) if (studentTokens.has(w)) overlap++;
  return overlap / refSet.size;
}

function aiGradeTheoryQuestions(attempt, quiz) {
  const theoryQuestions = (quiz?.questions || []).map((q, i) => ({ q, i })).filter((x) => x.q.type === "theory");
  const marks = {};
  for (const { q, i } of theoryQuestions) {
    const ans = String(attempt.answers?.[i] || "").trim();
    const max = Number(q.maxMarks || 5);
    const score = answerSimilarityScore(ans, q.theoryAnswer);
    if (score === null) continue;
    marks[i] = Math.round(score * max * 2) / 2;
  }
  return marks;
}

function downloadCsvFile(lines, filename) {
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

function sanitizeFileName(value, fallback = "file") {
  const clean = String(value || fallback)
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ");
  return clean || fallback;
}

function dataUrlToUint8Array(dataUrl) {
  const [, body = ""] = String(dataUrl || "").split(",", 2);
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function u16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function makeZipBlob(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosDate, dosTime } = dosDateTime();

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const data = file.bytes;
    const crc = crc32(data);
    const localHeader = [
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(dosTime), u16(dosDate),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes,
    ];
    const localSize = localHeader.reduce((sum, part) => sum + part.length, 0) + data.length;
    localParts.push(...localHeader, data);

    centralParts.push(
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(dosTime), u16(dosDate),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBytes,
    );
    offset += localSize;
  });

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endRecord = [
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralSize), u32(offset), u16(0),
  ];
  return new Blob([...localParts, ...centralParts, ...endRecord], { type: "application/zip" });
}

async function loadSubmissionFileBytes(submission) {
  if (submission.fileId) {
    const { dataUrl } = await loadFilePayload(submission.fileId);
    return dataUrlToUint8Array(dataUrl);
  }
  if (submission.fileUrl) {
    const response = await fetch(submission.fileUrl);
    if (!response.ok) throw new Error(`Could not download ${submission.fileName || "file"}.`);
    return new Uint8Array(await response.arrayBuffer());
  }
  throw new Error(`No downloadable file found for ${submission.studentName || "student"}.`);
}

function triggerBlobDownload(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

function exportQuizAttemptsCsv({ classId = "", quizId = "" } = {}) {
  const attempts = state.quizAttemptsReview
    .filter((a) => (!classId || a.classId === classId) && (!quizId || a.quizId === quizId))
    .sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0));
  if (!attempts.length) {
    alert("No quiz submissions found for export.");
    return;
  }

  const quizzes = new Map(state.quizzes.map((q) => [q.id, q]));
  const pendingTheory = attempts.filter((a) => {
    const quiz = quizzes.get(a.quizId);
    return quizHasTheoryQuestions(quiz) && a.theoryPending;
  });
  if (pendingTheory.length) {
    alert("Theory grading is pending for some submissions. Export after all theory marks are saved.");
    return;
  }

  const lines = [
    "className,quizTitle,quizNumber,studentName,studentRollNo,attemptNo,submittedAt,mcqScore,theoryScore,finalScore,totalPossible,theoryPending",
    ...attempts.map((a) => {
      const quiz = quizzes.get(a.quizId);
      const className = classNameById(a.classId);
      return [
        escapeCsvCell(className),
        escapeCsvCell(quiz?.title || a.quizId),
        escapeCsvCell(quiz?.quizNumber ?? ""),
        escapeCsvCell(a.studentName || ""),
        escapeCsvCell(a.studentRollNo || ""),
        escapeCsvCell(a.attemptNo ?? ""),
        escapeCsvCell(timestampToText(a.submittedAt)),
        escapeCsvCell(Number(a.mcqScore ?? a.score ?? 0)),
        escapeCsvCell(Number(a.theoryScore || 0)),
        escapeCsvCell(Number(a.finalScore ?? Number(a.mcqScore ?? a.score ?? 0) + Number(a.theoryScore || 0))),
        escapeCsvCell(Number(a.totalPossible || a.totalGradable || 0)),
        escapeCsvCell(a.theoryPending ? "Yes" : "No"),
      ].join(",");
    }),
  ];

  const stamp = new Date().toISOString().replaceAll(":", "-");
  const classSuffix = classId ? `-${classNameById(classId).replace(/[^a-zA-Z0-9_-]/g, "_")}` : "-all-classes";
  const quizSuffix = quizId ? `-quiz-${(state.quizzes.find((q) => q.id === quizId)?.quizNumber || quizId)}` : "";
  downloadCsvFile(lines, `quiz-results${classSuffix}${quizSuffix}-${stamp}.csv`);
}

function quizFilterLabel(q) {
  return `Quiz ${q.quizNumber ?? "?"}: ${q.title || "Untitled"}`;
}

function renderQuizClassFilterControls() {
  const classes = [{ id: "", name: "All Classes" }, ...state.classes.map((c) => ({ id: c.id, name: c.name || c.id }))];
  const analyticsHtml = classes
    .map((row) => `<button type="button" class="filter-chip-btn ${state.analyticsClassFilter === row.id ? "active" : ""}" data-quiz-analytics-class="${row.id}">${escapeHtml(row.name)}</button>`)
    .join("");
  const reviewHtml = classes
    .map((row) => `<button type="button" class="filter-chip-btn ${state.reviewClassFilter === row.id ? "active" : ""}" data-quiz-review-class="${row.id}">${escapeHtml(row.name)}</button>`)
    .join("");

  const analyticsQuizzes = state.quizzes.filter((q) => !state.analyticsClassFilter || q.classId === state.analyticsClassFilter);
  const reviewQuizzes = state.quizzes.filter((q) => !state.reviewClassFilter || q.classId === state.reviewClassFilter);
  const analyticsQuizHtml = [{ id: "", label: "All Quizzes" }, ...analyticsQuizzes.map((q) => ({ id: q.id, label: quizFilterLabel(q) }))]
    .map((row) => `<button type="button" class="filter-chip-btn ${state.analyticsQuizFilter === row.id ? "active" : ""}" data-quiz-analytics-quiz="${row.id}">${escapeHtml(row.label)}</button>`)
    .join("");
  const reviewQuizHtml = [{ id: "", label: "All Quizzes" }, ...reviewQuizzes.map((q) => ({ id: q.id, label: quizFilterLabel(q) }))]
    .map((row) => `<button type="button" class="filter-chip-btn ${state.reviewQuizFilter === row.id ? "active" : ""}" data-quiz-review-quiz="${row.id}">${escapeHtml(row.label)}</button>`)
    .join("");

  const analyticsEl = qs("#quizAnalyticsClassFilters");
  const reviewEl = qs("#quizAttemptClassFilters");
  if (analyticsEl) analyticsEl.innerHTML = `<div class="inline-actions filter-chip-wrap">${analyticsHtml}</div>
    <div class="inline-actions filter-chip-wrap quiz-pick-row">${analyticsQuizHtml}</div>
    ${state.analyticsClassFilter ? `<div><button type="button" data-download-quiz-class-results="${state.analyticsClassFilter}">Download Class Result CSV (Excel)</button></div>` : ""}`;
  if (reviewEl) reviewEl.innerHTML = `<div class="inline-actions filter-chip-wrap">${reviewHtml}</div>
    <div class="inline-actions filter-chip-wrap quiz-pick-row">${reviewQuizHtml}</div>
    ${state.reviewClassFilter ? `<div><button type="button" data-download-quiz-class-results="${state.reviewClassFilter}">Download Class Result CSV (Excel)</button></div>` : ""}`;
}

function renderAssignmentClassFilterControls() {
  const classes = [{ id: "", name: "All Classes" }, ...state.classes.map((c) => ({ id: c.id, name: c.name || c.id }))];
  const html = classes
    .map((row) => `<button type="button" class="filter-chip-btn ${state.assignmentClassFilter === row.id ? "active" : ""}" data-assignment-class-filter="${row.id}">${escapeHtml(row.name)}</button>`)
    .join("");
  const numberHtml = [{ id: "", label: "All Assignments" }, ...[1, 2, 3, 4].map((n) => ({ id: String(n), label: `Assignment ${n}` }))]
    .map((row) => `<button type="button" class="filter-chip-btn ${state.assignmentNumberFilter === row.id ? "active" : ""}" data-assignment-number-filter="${row.id}">${escapeHtml(row.label)}</button>`)
    .join("");
  const el = qs("#assignmentClassFilters");
  if (el) el.innerHTML = `<div class="inline-actions filter-chip-wrap">${html}</div>
    <div class="inline-actions filter-chip-wrap quiz-pick-row">${numberHtml}</div>`;
}

function renderEvaluationClassFilterControls() {
  const classes = [{ id: "", name: "All Classes" }, ...state.classes.map((c) => ({ id: c.id, name: c.name || c.id }))];
  const html = classes
    .map((row) => `<button type="button" class="filter-chip-btn ${state.evaluationClassFilter === row.id ? "active" : ""}" data-evaluation-class-filter="${row.id}">${escapeHtml(row.name)}</button>`)
    .join("");
  const el = qs("#evaluationClassFilters");
  if (el) el.innerHTML = `<div class="inline-actions filter-chip-wrap">${html}</div>`;
}

function renderEnrollCredentials() {
  const panel = qs("#enrollCredentialsPanel");
  const list = qs("#enrollCredentialsList");
  if (!panel || !list) return;
  if (!state.lastEnrollCredentials.length) {
    panel.classList.add("hidden");
    list.innerHTML = "";
    return;
  }
  panel.classList.remove("hidden");
  list.innerHTML = `<table>
    <thead><tr><th>Class</th><th>Student</th><th>Roll No</th><th>Password</th></tr></thead>
    <tbody>
      ${state.lastEnrollCredentials.map((r) => `<tr>
        <td>${escapeHtml(r.className || "-")}</td>
        <td>${escapeHtml(r.studentName)}</td>
        <td>${escapeHtml(r.rollNo)}</td>
        <td><code>${escapeHtml(r.password)}</code></td>
      </tr>`).join("")}
    </tbody>
  </table>`;
}

function downloadEnrollCredentialsCsv() {
  if (!state.lastEnrollCredentials.length) {
    alert("No generated credentials found.");
    return;
  }
  const lines = [
    "className,studentName,rollNo,password",
    ...state.lastEnrollCredentials.map((r) => [
      escapeCsvCell(r.className || ""),
      escapeCsvCell(r.studentName),
      escapeCsvCell(r.rollNo),
      escapeCsvCell(r.password),
    ].join(",")),
  ];
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `student-login-credentials-${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

function fillClassSelects() {
  const html = ['<option value="">Select class</option>']
    .concat(state.classes.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}${c.subject ? ` - ${escapeHtml(c.subject)}` : ""} (${escapeHtml(c.semester)})</option>`))
    .join("");
  ["#enrollClassId", "#lectureClassId", "#quizClassId", "#assignmentClassId", "#announcementClassId", "#quizPreviewClass"].forEach((s) => {
    const el = qs(s);
    if (el) el.innerHTML = html;
  });
  const semesters = Array.from(new Set(state.classes.map((c) => c.semester))).filter(Boolean);
  qs("#quizPreviewSemester").innerHTML = ['<option value="">Select semester</option>']
    .concat(semesters.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`))
    .join("");
  renderQuizClassFilterControls();
  renderAssignmentClassFilterControls();
  renderEvaluationClassFilterControls();
}

async function refreshData() {
  const [classSnap, lectureSnap, quizSnap, draftSnap, assignmentSnap, evalSnap, threadSnap] = await Promise.all([
    getDocs(query(collection(db, "classes"), where("teacherId", "==", state.me.uid))),
    getDocs(query(collection(db, "lectures"), where("teacherId", "==", state.me.uid))),
    getDocs(query(collection(db, "quizzes"), where("teacherId", "==", state.me.uid))),
    getDocs(query(collection(db, "quizDrafts"), where("teacherId", "==", state.me.uid))),
    getDocs(query(collection(db, "assignments"), where("teacherId", "==", state.me.uid))),
    getDocs(query(collection(db, "evaluationStats"), where("teacherId", "==", state.me.uid))),
    getDocs(query(collection(db, "discussionThreads"), where("teacherId", "==", state.me.uid), where("isAnnouncement", "==", true))),
  ]);

  state.classes = classSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  state.lectures = lectureSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  state.quizzes = quizSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.quizNumber || 0) - (b.quizNumber || 0));
  state.quizDrafts = draftSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0));
  state.assignments = assignmentSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.assignmentNumber || 0) - (b.assignmentNumber || 0));
  state.evalStats = evalSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.announcements = threadSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

  fillClassSelects();
  renderClasses();
  renderLectures();
  renderQuizDrafts();
  renderQuizzes();
  renderQuizPreview();
  await renderAssignments();
  await renderEvaluationStats();
  await renderQuizAttemptReviews();
  await renderQuizAnalytics();
  renderAnnouncements();
  wireDynamicEvents();
}

function renderQuizPreview() {
  const classId = qs("#quizPreviewClass")?.value || "";
  const semester = qs("#quizPreviewSemester")?.value || "";
  const classIds = new Set(state.classes
    .filter((c) => (!classId || c.id === classId) && (!semester || c.semester === semester))
    .map((c) => c.id));

  const drafts = state.quizDrafts.filter((d) => classIds.size === 0 || classIds.has(d.classId));
  const archived = state.quizzes.filter((q) => q.status === "archived" && (classIds.size === 0 || classIds.has(q.classId)));

  qs("#quizDraftPreview").innerHTML = drafts.map((d) => `<article class="item">
    <h4>${escapeHtml(d.title || "Untitled")} (Quiz ${d.quizNumber})</h4>
    <p class="meta">${escapeHtml(state.classes.find((c) => c.id === d.classId)?.name || d.classId)} | Questions: ${d.questions?.length || 0}</p>
  </article>`).join("") || "<p>Select class and semester.</p>";

  qs("#archivedQuizzesPreview").innerHTML = archived.map((q) => `<article class="item">
    <h4>${escapeHtml(q.title)} (Quiz ${q.quizNumber})</h4>
    <p class="meta">${escapeHtml(state.classes.find((c) => c.id === q.classId)?.name || q.classId)} | Archived</p>
  </article>`).join("") || "<p>No archived quizzes for selected class/semester.</p>";
}

function renderClasses() {
  qs("#classesList").innerHTML = state.classes
    .map((c) => `<article class="item">
      <h4>${escapeHtml(c.name)}</h4>
      <p class="meta">${escapeHtml(c.subject || "No subject")} | ${escapeHtml(c.semester)} | ${fmtDate(c.createdAt)}</p>
      <div class="inline-actions">
        <button data-del-class="${c.id}" type="button">Delete Class</button>
      </div>
    </article>`)
    .join("") || "<p>No classes yet.</p>";
}

function renderLectures() {
  qs("#lecturesList").innerHTML = state.lectures
    .map((l) => {
      const klass = state.classes.find((c) => c.id === l.classId);
      const files = (l.files || []).map((f) => `<a href="${fileHref(f)}" target="_blank" rel="noopener">${escapeHtml(f.name)}</a>`).join(" | ");
      return `<article class="item">
        <h4>${escapeHtml(l.title)}</h4>
        <p class="meta">${escapeHtml(klass?.name || l.classId)} | Date: ${escapeHtml(l.date)}</p>
        <p>${files || "No files"}</p>
        <p>${l.videoLink ? `<a href="${l.videoLink}" target="_blank" rel="noopener">Video Link</a>` : "No video link"}</p>
        <div class="inline-actions">
          <button data-edit-lecture="${l.id}" type="button">Edit</button>
          <button data-del-lecture="${l.id}" type="button">Delete</button>
        </div>
      </article>`;
    })
    .join("") || "<p>No lectures yet.</p>";
}

function renderQuestionBuilder() {
  renderQuizBuilderStats();
  renderAllQuestionsEditor();
  wireAllQuestionsEditor();
  if (!state.quizQuestions.length) {
    qs("#questionBuilder").innerHTML = "<p>No questions added yet.</p>";
    return;
  }
  state.activeQuestionIndex = Math.max(0, Math.min(state.activeQuestionIndex, state.quizQuestions.length - 1));
  const q = state.quizQuestions[state.activeQuestionIndex];
  if (q.type === "mcq" && Number(q.maxMarks) !== 1) q.maxMarks = 1;
  if (q.type === "theory" && (!Number.isFinite(Number(q.maxMarks)) || Number(q.maxMarks) < 1)) q.maxMarks = 5;
  const prevListScroll = qs(".question-list")?.scrollTop || 0;
  const rows = state.quizQuestions
    .map((item, i) => `<div class="question-row ${i === state.activeQuestionIndex ? "active" : ""}">
      <p class="question-row-head"><strong>Q${i + 1}</strong> <span class="q-type-pill">${item.type.toUpperCase()}</span> <span class="meta question-row-marks">${item.type === "mcq" ? 1 : Number(item.maxMarks || 5)} mark${(item.type === "mcq" ? 1 : Number(item.maxMarks || 5)) === 1 ? "" : "s"}</span></p>
      <p class="meta question-row-prompt">${escapeHtml((item.promptHtml || "").slice(0, 70) || "No prompt yet")}</p>
      <div class="question-row-actions">
        <button data-select-q="${i}" type="button" title="Edit">✏️</button>
        <button data-up-q="${i}" type="button" title="Move up" ${i === 0 ? "disabled" : ""}>⬆️</button>
        <button data-down-q="${i}" type="button" title="Move down" ${i === state.quizQuestions.length - 1 ? "disabled" : ""}>⬇️</button>
        <button data-dup-q="${i}" type="button" title="Duplicate">⧉</button>
        <button data-remove-q="${i}" type="button" title="Delete" class="question-row-del">🗑️</button>
      </div>
    </div>`)
    .join("");
  const mcqOptions = q.options
    .map((opt, oi) => `<label>Option ${oi + 1}<input data-current-opt="${oi}" value="${escapeHtml(opt)}" /></label>`)
    .join("");

  qs("#questionBuilder").innerHTML = `<div class="quiz-builder">
    <div class="question-list">${rows}</div>
    <div class="question-editor">
      <div class="inline-actions">
        <strong>Editing Q${state.activeQuestionIndex + 1}</strong>
        <select id="currentQuestionType">
          <option value="mcq" ${q.type === "mcq" ? "selected" : ""}>MCQ</option>
          <option value="theory" ${q.type === "theory" ? "selected" : ""}>Theory</option>
        </select>
      </div>
      <div class="toolbar">
        <button data-current-wrap="b" type="button"><b>B</b></button>
        <button data-current-wrap="i" type="button"><i>I</i></button>
        <button data-current-wrap="code" type="button">Code</button>
        <button data-current-wrap="latex" type="button">LaTeX</button>
      </div>
      <label>Prompt<textarea id="currentPrompt" rows="4">${escapeHtml(q.promptHtml || "")}</textarea></label>
      <label>Image<input id="currentImage" type="file" accept="image/*" /></label>
      ${q.imageDataUrl ? `<p><img src="${q.imageDataUrl}" alt="question image" style="max-width: 220px; border:1px solid #d9e0e6;" /></p>` : ""}
      ${q.type === "mcq" ? `
        ${mcqOptions}
        <label>Correct Option Index (1-4)<input id="currentCorrectIndex" type="number" min="1" max="4" value="${q.correctIndex}" /></label>
      ` : `
        <label>Model Answer<textarea id="currentTheoryAnswer" rows="3">${escapeHtml(q.theoryAnswer || "")}</textarea></label>
      `}
      <label>Question Marks
        <input id="currentQuestionMarks" type="number" min="1" step="1" value="${q.type === "mcq" ? 1 : Number(q.maxMarks || 5)}" ${q.type === "mcq" ? "disabled" : ""} />
      </label>
      <p class="meta">${q.type === "mcq" ? "MCQ marks are fixed to 1." : "Set marks for this short question."}</p>
      <label>Question Timer (seconds, optional)<input id="currentQuestionTimer" type="number" min="0" value="${Number(q.questionTimeSec || 0)}" /></label>
    </div>
  </div>`;
  const listEl = qs(".question-list");
  if (listEl) listEl.scrollTop = prevListScroll;
}

function renderAllQuestionsEditor() {
  const container = qs("#quizAllQuestionsEditor");
  if (!container) return;
  const countEl = qs("#importedCount");
  if (countEl) countEl.textContent = String(state.quizQuestions.length);
  if (!state.quizQuestions.length) {
    container.innerHTML = "<p class='meta'>No questions yet. Add questions above or import a CSV.</p>";
    return;
  }
  container.innerHTML = state.quizQuestions
    .map((q, i) => {
      const promptText = (q.promptHtml || "").replace(/<[^>]+>/g, "");
      const fields = q.type === "mcq"
        ? `<div class="quiz-allq-options">
            ${q.options.map((opt, oi) => `<input data-aq-opt="${i}:${oi}" value="${escapeHtml(opt)}" placeholder="${String.fromCharCode(65 + oi)}" />`).join("")}
          </div>
          <label class="quiz-allq-correct">Correct
            <select data-aq-correct="${i}">
              ${[1, 2, 3, 4].map((n) => `<option value="${n}" ${Number(q.correctIndex) === n ? "selected" : ""}>${String.fromCharCode(64 + n)}</option>`).join("")}
            </select>
          </label>`
        : `<textarea data-aq-theory="${i}" rows="2" placeholder="Model answer (used for AI auto-grading)">${escapeHtml(q.theoryAnswer || "")}</textarea>
          <label class="quiz-allq-marks">Marks
            <input data-aq-marks="${i}" type="number" min="1" step="1" value="${Number(q.maxMarks || 5)}" />
          </label>`;
      return `<div class="quiz-allq-card">
        <div class="quiz-allq-head">
          <span class="quiz-allq-no">Q${i + 1}</span>
          <span class="q-type-pill">${q.type.toUpperCase()}</span>
          <button type="button" data-aq-toggle-type="${i}" title="Switch question type">⇄ Switch</button>
          <button type="button" data-aq-del="${i}" title="Delete this question">🗑️</button>
        </div>
        <textarea data-aq-prompt="${i}" rows="2" placeholder="Question prompt">${escapeHtml(promptText)}</textarea>
        ${fields}
      </div>`;
    })
    .join("");
}

function wireAllQuestionsEditor() {
  qsa("[data-aq-prompt]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const i = Number(el.dataset.aqPrompt);
      if (!state.quizQuestions[i]) return;
      state.quizQuestions[i].promptHtml = e.target.value;
      scheduleDraftAutosave();
    });
  });
  qsa("[data-aq-opt]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const [i, oi] = el.dataset.aqOpt.split(":").map(Number);
      if (!state.quizQuestions[i]) return;
      state.quizQuestions[i].options[oi] = e.target.value;
      scheduleDraftAutosave();
    });
  });
  qsa("[data-aq-correct]").forEach((el) => {
    el.addEventListener("change", (e) => {
      const i = Number(el.dataset.aqCorrect);
      if (!state.quizQuestions[i]) return;
      state.quizQuestions[i].correctIndex = Number(e.target.value);
      scheduleDraftAutosave();
    });
  });
  qsa("[data-aq-theory]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const i = Number(el.dataset.aqTheory);
      if (!state.quizQuestions[i]) return;
      state.quizQuestions[i].theoryAnswer = e.target.value;
      scheduleDraftAutosave();
    });
  });
  qsa("[data-aq-marks]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const i = Number(el.dataset.aqMarks);
      if (!state.quizQuestions[i]) return;
      const n = Number(e.target.value || 0);
      state.quizQuestions[i].maxMarks = Number.isFinite(n) && n > 0 ? n : 1;
      scheduleDraftAutosave();
    });
  });
  qsa("[data-aq-toggle-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.aqToggleType);
      const q = state.quizQuestions[i];
      if (!q) return;
      q.type = q.type === "mcq" ? "theory" : "mcq";
      if (q.type === "mcq") q.maxMarks = 1;
      if (q.type === "theory" && (!Number.isFinite(Number(q.maxMarks)) || Number(q.maxMarks) < 1)) q.maxMarks = 5;
      renderQuestionBuilder();
      wireQuestionBuilderInputs();
      scheduleDraftAutosave();
    });
  });
  qsa("[data-aq-del]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.aqDel);
      state.quizQuestions.splice(i, 1);
      state.activeQuestionIndex = Math.max(0, state.activeQuestionIndex - 1);
      renderQuestionBuilder();
      wireQuestionBuilderInputs();
      scheduleDraftAutosave();
    });
  });
}

function wrapTextArea(el, type) {
  const start = el.selectionStart || 0;
  const end = el.selectionEnd || 0;
  const text = el.value;
  const selected = text.slice(start, end) || "text";
  const wrappers = {
    b: ["<b>", "</b>"],
    i: ["<i>", "</i>"],
    code: ["<pre><code>", "</code></pre>"],
    latex: ["$$", "$$"],
  };
  const [open, close] = wrappers[type] || ["", ""];
  const next = `${text.slice(0, start)}${open}${selected}${close}${text.slice(end)}`;
  el.value = next;
}

async function compressImageToDataUrl(file, maxWidth = 1200, quality = 0.72) {
  const img = await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = reject;
    image.src = url;
  });
  const scale = Math.min(1, maxWidth / img.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

async function autosaveDraft() {
  const payload = buildQuizPayload();
  if (!payload.classId || !payload.quizNumber) {
    setDraftStatus("Select class and quiz number to enable draft save.");
    return false;
  }
  if (payload.questions.length === 0) {
    setDraftStatus("Add at least one question to save draft.");
    return false;
  }
  const nextHash = draftPayloadHash(payload);
  if (!state.draftDirty && nextHash === state.lastDraftHash) return true;
  setDraftStatus("Saving draft...");
  const draftId = `${state.me.uid}_${payload.classId}_q${payload.quizNumber}`;
  try {
    await setDoc(doc(db, "quizDrafts", draftId), {
      ...payload,
      teacherId: state.me.uid,
      status: "draft",
      updatedAt: serverTimestamp(),
    }, { merge: true });
    qs("#quizDraftId").value = draftId;
    state.lastDraftHash = nextHash;
    state.draftDirty = false;
    setDraftStatus(`Draft saved at ${new Date().toLocaleTimeString()}`);
    return true;
  } catch (err) {
    setDraftStatus(`Draft save failed: ${err.message || "permission/network error"}`);
    throw err;
  }
}

function scheduleDraftAutosave() {
  clearTimeout(state.draftTimer);
  markDraftDirty();
  state.draftTimer = setTimeout(() => {
    autosaveDraft().catch(() => {});
  }, 1000);
}

function validateQuestions(questions, { strict = true } = {}) {
  if (!questions.length) throw new Error("Add at least one question.");
  if (!strict) return;
  for (let idx = 0; idx < questions.length; idx++) {
    const q = questions[idx];
    if (!String(q.promptHtml || "").trim()) {
      throw new Error(`Question ${idx + 1} is missing a prompt. Please add a question prompt/text.`);
    }
    if (q.type === "mcq") {
      const emptyOpt = (q.options || []).findIndex((o) => !String(o || "").trim());
      if (emptyOpt !== -1) {
        throw new Error(`Question ${idx + 1}, Option ${String.fromCharCode(65 + emptyOpt)} is empty. All MCQ options are required.`);
      }
      if (q.correctIndex < 1 || q.correctIndex > 4) {
        throw new Error(`Question ${idx + 1}: Correct answer must be between A-D.`);
      }
      if (Number(q.maxMarks) !== 1) throw new Error(`Question ${idx + 1}: MCQ marks must be 1.`);
    } else {
      if (!Number.isFinite(Number(q.maxMarks)) || Number(q.maxMarks) < 1) {
        throw new Error(`Question ${idx + 1}: Theory question marks must be >= 1.`);
      }
    }
  }
}

function wireQuestionBuilderInputs() {
  qsa("[data-select-q]").forEach((el) => {
    el.addEventListener("click", () => {
      state.activeQuestionIndex = Number(el.dataset.selectQ);
      renderQuestionBuilder();
      wireQuestionBuilderInputs();
    });
  });
  qsa("[data-remove-q]").forEach((el) => {
    el.addEventListener("click", () => {
      state.quizQuestions.splice(Number(el.dataset.removeQ), 1);
      state.activeQuestionIndex = Math.max(0, state.activeQuestionIndex - 1);
      renderQuestionBuilder();
      wireQuestionBuilderInputs();
      scheduleDraftAutosave();
    });
  });
  qsa("[data-up-q]").forEach((el) => {
    el.addEventListener("click", () => {
      const i = Number(el.dataset.upQ);
      if (i <= 0) return;
      const tmp = state.quizQuestions[i - 1];
      state.quizQuestions[i - 1] = state.quizQuestions[i];
      state.quizQuestions[i] = tmp;
      state.activeQuestionIndex = i - 1;
      renderQuestionBuilder();
      wireQuestionBuilderInputs();
      scheduleDraftAutosave();
    });
  });
  qsa("[data-down-q]").forEach((el) => {
    el.addEventListener("click", () => {
      const i = Number(el.dataset.downQ);
      if (i >= state.quizQuestions.length - 1) return;
      const tmp = state.quizQuestions[i + 1];
      state.quizQuestions[i + 1] = state.quizQuestions[i];
      state.quizQuestions[i] = tmp;
      state.activeQuestionIndex = i + 1;
      renderQuestionBuilder();
      wireQuestionBuilderInputs();
      scheduleDraftAutosave();
    });
  });
  qsa("[data-dup-q]").forEach((el) => {
    el.addEventListener("click", () => {
      const i = Number(el.dataset.dupQ);
      const src = state.quizQuestions[i];
      if (!src) return;
      state.quizQuestions.splice(i + 1, 0, normalizeQuestion(JSON.parse(JSON.stringify(src))));
      state.activeQuestionIndex = i + 1;
      renderQuestionBuilder();
      wireQuestionBuilderInputs();
      scheduleDraftAutosave();
    });
  });

  const current = state.quizQuestions[state.activeQuestionIndex];
  if (!current) return;
  qs("#currentQuestionType")?.addEventListener("change", (e) => {
    current.type = e.target.value === "theory" ? "theory" : "mcq";
    if (current.type === "mcq") current.maxMarks = 1;
    if (current.type === "theory" && (!Number.isFinite(Number(current.maxMarks)) || Number(current.maxMarks) < 1)) current.maxMarks = 5;
    renderQuestionBuilder();
    wireQuestionBuilderInputs();
    scheduleDraftAutosave();
  });
  qs("#currentPrompt")?.addEventListener("input", (e) => {
    current.promptHtml = e.target.value;
    scheduleDraftAutosave();
  });
  qsa("[data-current-wrap]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const textarea = qs("#currentPrompt");
      wrapTextArea(textarea, btn.dataset.currentWrap);
      textarea.dispatchEvent(new Event("input"));
    });
  });
  qsa("[data-current-opt]").forEach((el) => {
    el.addEventListener("input", (e) => {
      current.options[Number(e.target.dataset.currentOpt)] = e.target.value;
      scheduleDraftAutosave();
    });
  });
  qs("#currentCorrectIndex")?.addEventListener("input", (e) => {
    current.correctIndex = Number(e.target.value);
    scheduleDraftAutosave();
  });
  qs("#currentTheoryAnswer")?.addEventListener("input", (e) => {
    current.theoryAnswer = e.target.value;
    scheduleDraftAutosave();
  });
  qs("#currentQuestionMarks")?.addEventListener("input", (e) => {
    const n = Number(e.target.value || 0);
    current.maxMarks = Number.isFinite(n) && n > 0 ? n : 1;
    scheduleDraftAutosave();
  });
  qs("#currentQuestionTimer")?.addEventListener("input", (e) => {
    current.questionTimeSec = Number(e.target.value || 0);
    scheduleDraftAutosave();
  });
  qs("#currentImage")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    current.imageName = file.name;
    current.imageDataUrl = await compressImageToDataUrl(file);
    renderQuestionBuilder();
    wireQuestionBuilderInputs();
    scheduleDraftAutosave();
  });
}

function parsePastedQuestions(rawText) {
  const blocks = String(rawText || "").split(/\n\s*\n/g).map((b) => b.trim()).filter(Boolean);
  const out = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const prompt = lines[0].replace(/^q[\).\s:-]*/i, "").trim();
    if (!prompt) continue;
    const options = ["", "", "", ""];
    let answerRaw = "";
    const theoryParts = [];
    for (const line of lines.slice(1)) {
      const optMatch = line.match(/^([A-Da-d])[)\].:\s-]+(.+)$/);
      if (optMatch) {
        const idx = optMatch[1].toUpperCase().charCodeAt(0) - 65;
        options[idx] = optMatch[2].trim();
        continue;
      }
      const ansMatch = line.match(/^answer[\s:-]+(.+)$/i);
      if (ansMatch) {
        answerRaw = ansMatch[1].trim();
        continue;
      }
      theoryParts.push(line);
    }
    const isMcq = options.every((o) => o.trim());
    if (isMcq) {
      let correctIndex = 1;
      if (/^[A-Da-d]$/.test(answerRaw)) {
        correctIndex = (answerRaw.toUpperCase().charCodeAt(0) - 65) + 1;
      } else if (options.includes(answerRaw)) {
        correctIndex = options.indexOf(answerRaw) + 1;
      }
      out.push(normalizeQuestion({ type: "mcq", promptHtml: prompt, options, correctIndex }));
    } else {
      out.push(normalizeQuestion({ type: "theory", promptHtml: prompt, theoryAnswer: theoryParts.join(" ") || answerRaw }));
    }
  }
  return out;
}

function renderQuizDrafts() {
  qs("#quizDraftsList").innerHTML = state.quizDrafts
    .map((d) => {
      const className = state.classes.find((c) => c.id === d.classId)?.name || d.classId;
      return `<article class="item">
        <h4>${escapeHtml(d.title || "Untitled")} (Quiz ${d.quizNumber})</h4>
        <p class="meta">${escapeHtml(className)} | Updated ${fmtDate(d.updatedAt)} | ${d.questions?.length || 0} questions</p>
        <div class="inline-actions">
          <button data-edit-draft="${d.id}" type="button">Edit Draft</button>
          <button data-publish-draft="${d.id}" type="button">Publish Draft</button>
          <button data-del-draft="${d.id}" type="button">Delete Draft</button>
        </div>
      </article>`;
    })
    .join("") || "<p>No drafts yet.</p>";
}

async function renderQuizAnalytics() {
  const [snap, enrollSnap] = await Promise.all([
    getDocs(query(collection(db, "quizAnalytics"), where("teacherId", "==", state.me.uid))),
    getDocs(query(collection(db, "enrollments"), where("teacherId", "==", state.me.uid))),
  ]);
  state.quizAnalyticsRows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const enrollments = enrollSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderQuizClassFilterControls();
  const rows = state.quizAnalyticsRows
    .filter((a) => !state.analyticsClassFilter || a.classId === state.analyticsClassFilter)
    .filter((a) => !state.analyticsQuizFilter || a.quizId === state.analyticsQuizFilter)
    .sort((a, b) => Number(b.attempts || 0) - Number(a.attempts || 0));
  qs("#quizAnalyticsList").innerHTML = rows
    .map((a) => {
      const quiz = state.quizzes.find((q) => q.id === a.quizId);
      const className = classNameById(a.classId);
      const avg = a.attempts ? ((a.totalScore / a.attempts) * 100 / (a.totalGradable || 1)).toFixed(2) : "0.00";
      const questionBreakdown = (a.questionStats || [])
        .map((q, idx) => `Q${idx + 1}: ${q.correct}/${q.total}`)
        .join(" | ");
      const quizAttempts = state.quizAttemptsReview.filter((x) => x.quizId === a.quizId);
      const pendingTheory = quizAttempts.filter((x) => x.theoryPending).length;
      const latestSubmit = quizAttempts
        .slice()
        .sort((x, y) => (y.submittedAt?.seconds || 0) - (x.submittedAt?.seconds || 0))[0]?.submittedAt;
      const attemptRows = quizAttempts
        .slice()
        .sort((x, y) => {
          const byStudent = String(x.studentName || "").localeCompare(String(y.studentName || ""));
          if (byStudent) return byStudent;
          return (y.submittedAt?.seconds || 0) - (x.submittedAt?.seconds || 0);
        })
        .map((attempt) => {
          const isLocked = !!attempt.locked;
          const unlocked = !!attempt.unlockedAt;
          const unlockable = canUnlockAttempt(attempt, quiz);
          const status = unlocked
            ? `Unlocked ${timestampToText(attempt.unlockedAt)}`
            : isLocked
              ? "Locked"
              : "Submitted";
          return `<tr>
            <td>${escapeHtml(attempt.studentName || "Student")}</td>
            <td>${escapeHtml(attempt.studentRollNo || "-")}</td>
            <td>${Number(attempt.attemptNo || 1)}</td>
            <td>${timestampToText(attempt.submittedAt)}</td>
            <td>${escapeHtml(status)}</td>
            <td>${attempt.antiCheatTriggered ? "Yes" : "No"}</td>
            <td>${unlockable ? `<button data-unlock-attempt="${attempt.id}" type="button">Unlock Quiz</button>` : "-"}</td>
          </tr>`;
        })
        .join("");
      const canExport = canExportQuizResults(a.quizId, a.classId);
      const quizLabel = quiz?.quizNumber != null ? `Quiz ${quiz.quizNumber}` : "Quiz";
      const classEnrollments = enrollments.filter((e) => e.classId === a.classId);
      const attemptedKeys = new Set(quizAttempts.map((x) => x.studentKey || studentKey(x.studentRollNo, x.studentName)));
      const attemptedCount = classEnrollments.filter((e) => attemptedKeys.has(studentKey(e.rollNo, e.studentName))).length;
      const notAttempted = classEnrollments.filter((e) => !attemptedKeys.has(studentKey(e.rollNo, e.studentName)));
      const notAttemptedRows = notAttempted
        .sort((x, y) => String(x.rollNo || "").localeCompare(String(y.rollNo || "")))
        .map((e) => `<li>${escapeHtml(e.studentName)} (${escapeHtml(e.rollNo)})</li>`)
        .join("");
      return `<article class="item analytics-card">
        <h4>${escapeHtml(quiz?.title || a.quizId)} <span class="q-type-pill">${escapeHtml(quizLabel)}</span></h4>
        <p class="meta">${escapeHtml(className)}</p>
        <div class="analytics-stats">
          <span class="chip chip-blue">Attempts: ${a.attempts || 0}</span>
          <span class="chip chip-green">Avg MCQ: ${avg}%</span>
          <span class="chip chip-amber">Pending Theory: ${pendingTheory}</span>
          <span class="chip chip-slate">Last Submit: ${timestampToText(latestSubmit)}</span>
        </div>
        <p class="meta">Question Breakdown: ${escapeHtml(questionBreakdown || "No breakdown yet")}</p>
        <div class="inline-actions">
          <button type="button" data-download-quiz-results="${a.quizId}" ${canExport ? "" : "disabled"}>${canExport ? "Download Result CSV (Excel)" : "Export after theory review"}</button>
        </div>
        <details class="quiz-summary-toggle">
          <summary>📊 Summary: ${attemptedCount}/${classEnrollments.length} attempted, ${notAttempted.length} not attempted</summary>
          ${notAttemptedRows ? `<p class="meta">Did not attempt:</p><ul>${notAttemptedRows}</ul>` : "<p class='ok'>Everyone enrolled has attempted.</p>"}
        </details>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Student</th><th>Roll No</th><th>Attempt</th><th>Submitted</th><th>Status</th><th>Anti-cheat</th><th>Action</th></tr></thead>
            <tbody>${attemptRows || `<tr><td colspan="7">No student attempts yet.</td></tr>`}</tbody>
          </table>
        </div>
      </article>`;
    })
    .join("") || "<p>No analytics found for selected class.</p>";
}

async function renderQuizAttemptReviews() {
  const snap = await getDocs(query(collection(db, "quizAttempts"), where("teacherId", "==", state.me.uid)));
  state.quizAttemptsReview = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0));
  renderQuizClassFilterControls();
  const rows = state.quizAttemptsReview
    .filter((a) => !state.reviewClassFilter || a.classId === state.reviewClassFilter)
    .filter((a) => !state.reviewQuizFilter || a.quizId === state.reviewQuizFilter);
  const pendingCount = rows.filter((a) => a.theoryPending).length;
  const bulkToolbar = `<div class="inline-actions">
    <button data-ai-grade-all="1" type="button" ${pendingCount ? "" : "disabled"}>🤖 AI Auto-Grade All Pending (${pendingCount})</button>
  </div>`;
  const cardsHtml = rows.map((a) => {
    const quiz = state.quizzes.find((q) => q.id === a.quizId);
    const theoryQuestions = (quiz?.questions || [])
      .map((q, i) => ({ q, i }))
      .filter((x) => x.q.type === "theory");
    const title = quiz?.title || a.quizId;
    const className = classNameById(a.classId);
    const mcqScore = Number(a.mcqScore ?? a.score ?? 0);
    if (!theoryQuestions.length) {
      return `<article class="item">
        <h4>${escapeHtml(title)}</h4>
        <p class="meta">${escapeHtml(className)} | ${escapeHtml(a.studentName || "Student")} (${escapeHtml(a.studentRollNo || "-")})</p>
        <p class="meta">Submitted: ${timestampToText(a.submittedAt)}</p>
        <p class="meta">No short questions in this attempt. MCQ score: ${mcqScore}</p>
      </article>`;
    }
    const rowsHtml = theoryQuestions.map(({ q, i }) => {
      const ans = String(a.answers?.[i] || "").trim();
      const given = a.theoryMarks && a.theoryMarks[i] != null ? Number(a.theoryMarks[i]) : "";
      return `<div class="question">
        <p><strong>Q${i + 1}</strong> ${escapeHtml((q.promptHtml || "").replace(/<[^>]+>/g, "").slice(0, 180))}</p>
        <p class="meta">Student answer: ${escapeHtml(ans || "Not answered")}</p>
        <label>Marks (Max ${Number(q.maxMarks || 5)})
          <input data-review-attempt="${a.id}" data-qi="${i}" data-max="${Number(q.maxMarks || 5)}" type="number" min="0" step="0.5" value="${given}" />
        </label>
      </div>`;
    }).join("");
    const theoryScore = Number(a.theoryScore || 0);
    const finalScore = Number(a.finalScore ?? (mcqScore + theoryScore));
    const isLocked = a.locked ? ` | 🔒 LOCKED` : "";
    const unlockBtn = canUnlockAttempt(a, quiz) ? `<button data-unlock-attempt="${a.id}" type="button">Unlock Quiz</button>` : "";
    const hasModelAnswers = theoryQuestions.some(({ q }) => String(q.theoryAnswer || "").trim());
    const aiGradeBtn = hasModelAnswers
      ? `<button data-ai-grade-attempt="${a.id}" type="button">🤖 AI Auto-Grade</button>`
      : "";
    return `<article class="item">
      <h4>${escapeHtml(title)}</h4>
      <p class="meta">${escapeHtml(className)} | ${escapeHtml(a.studentName || "Student")} (${escapeHtml(a.studentRollNo || "-")})</p>
      <p class="meta">Submitted: ${timestampToText(a.submittedAt)} | Attempt #${Number(a.attemptNo || 1)}${isLocked}</p>
      <p class="meta">MCQ auto: ${mcqScore} | Theory: ${theoryScore} | Final: ${finalScore}</p>
      ${rowsHtml}
      <div class="inline-actions">
        ${aiGradeBtn}
        <button data-save-attempt-review="${a.id}" type="button">Save Theory Marks</button>
        ${unlockBtn}
      </div>
      ${hasModelAnswers ? "" : `<p class="meta">Tip: add a Model Answer when creating this question to enable AI Auto-Grade.</p>`}
    </article>`;
  }).join("");
  qs("#quizAttemptReviewsList").innerHTML = bulkToolbar + (cardsHtml || "<p>No quiz attempts for selected class.</p>");
}

function renderQuizzes() {
  qs("#quizzesList").innerHTML = state.quizzes
    .map((q) => {
      const className = state.classes.find((c) => c.id === q.classId)?.name || q.classId;
      const totalTheory = (q.questions || []).filter((x) => x.type === "theory").length;
      const totalMcq = (q.questions || []).filter((x) => x.type !== "theory").length;
      const totalMarks = (q.questions || []).reduce((sum, x) => sum + Number(x.type === "mcq" ? 1 : (x.maxMarks || 0)), 0);
      return `<article class="item">
      <h4>${escapeHtml(q.title)} (Quiz ${q.quizNumber})</h4>
        <p class="meta">${escapeHtml(className)} | status: ${q.status || "draft"} | ${q.durationMin} mins | attempts limit: ${q.attemptLimit || 1} | MCQ:${totalMcq} Theory:${totalTheory} | Total Marks:${totalMarks} | Anti-cheat: ${q.antiCheatEnabled ? "On" : "Off"}</p>
        <p class="meta">Attempts open: ${q.acceptingAttempts ? "Yes" : "No"}</p>
        <div class="inline-actions">
          <button data-edit-quiz="${q.id}" type="button">Edit</button>
          <button data-toggle-publish="${q.id}" type="button">${q.status === "published" ? "Move to Draft" : "Publish"}</button>
          <button data-toggle-start="${q.id}" type="button">${q.acceptingAttempts ? "Stop Attempts" : "Start Attempts"}</button>
          <button data-toggle-archive="${q.id}" type="button">${q.status === "archived" ? "Unarchive" : "Archive"}</button>
          <button data-del-quiz="${q.id}" type="button">Delete</button>
        </div>
      </article>`;
    })
    .join("") || "<p>No published/saved quizzes yet.</p>";
}

async function renderAssignments() {
  const [submissionsSnap, enrollmentSnap] = await Promise.all([
    getDocs(query(collection(db, "assignmentSubmissions"), where("teacherId", "==", state.me.uid))),
    getDocs(query(collection(db, "enrollments"), where("teacherId", "==", state.me.uid))),
  ]);
  const submissions = submissionsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const enrollments = enrollmentSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderAssignmentClassFilterControls();
  const rows = state.assignments
    .filter((a) => !state.assignmentClassFilter || a.classId === state.assignmentClassFilter)
    .filter((a) => !state.assignmentNumberFilter || Number(a.assignmentNumber) === Number(state.assignmentNumberFilter));
  qs("#assignmentsList").innerHTML = rows
    .map((a) => {
      const className = state.classes.find((c) => c.id === a.classId)?.name || a.classId;
      const subs = submissions.filter((s) => s.assignmentId === a.id);
      const classEnrollments = enrollments.filter((e) => e.classId === a.classId);
      const submittedKeys = new Set(subs.map((s) => s.studentKey || studentKey(s.studentRollNo, s.studentName)));
      const submittedCount = classEnrollments.filter((e) => submittedKeys.has(studentKey(e.rollNo, e.studentName))).length;
      const unsubmitted = classEnrollments.filter((e) => !submittedKeys.has(studentKey(e.rollNo, e.studentName)));
      const notSubmittedCount = unsubmitted.length;
      const downloadableCount = subs.filter((s) => s.fileUrl || s.fileId).length;
      const notSubmittedRows = unsubmitted
        .sort((x, y) => String(x.rollNo || "").localeCompare(String(y.rollNo || "")))
        .map((e) => `<li>${escapeHtml(e.studentName)} (${escapeHtml(e.rollNo)})</li>`)
        .join("");
      const reviewRows = subs
        .map((s) => `<tr>
          <td>${escapeHtml(s.studentName)}</td>
          <td><a href="${s.fileUrl || (s.fileId ? `./file.html?id=${encodeURIComponent(s.fileId)}&name=${encodeURIComponent(s.fileName || "download")}` : "#")}" target="_blank" rel="noopener">Download</a></td>
          <td>${escapeHtml(s.status || "submitted")}</td>
          <td><input data-grade="${s.id}" type="number" min="0" max="100" value="${s.grade ?? ""}" /></td>
          <td><input data-feedback="${s.id}" value="${escapeHtml(s.feedback || "")}" /></td>
          <td><button data-save-review="${s.id}" type="button">Save</button></td>
        </tr>`)
        .join("");
      return `<article class="item">
        <h4>${escapeHtml(a.title)} (A${a.assignmentNumber})</h4>
        <p class="meta">${escapeHtml(className)} | Deadline: ${fmtDate(a.deadline)}</p>
        <p class="meta">Summary: ${submittedCount}/${classEnrollments.length} submitted | ${notSubmittedCount} not submitted</p>
        <div class="inline-actions">
          <button data-bulk-download-assignment="${a.id}" type="button" ${downloadableCount ? "" : "disabled"}>Bulk Download Submissions (${downloadableCount})</button>
          <button data-del-assignment="${a.id}" type="button">Delete Assignment</button>
        </div>
        <details>
          <summary>Not submitted students (${notSubmittedCount})</summary>
          ${notSubmittedRows ? `<ul>${notSubmittedRows}</ul>` : "<p class='ok'>Everyone enrolled has submitted.</p>"}
        </details>
        <div class="table-wrap"><table><thead><tr><th>Student</th><th>File</th><th>Status</th><th>Grade</th><th>Feedback</th><th>Action</th></tr></thead><tbody>${reviewRows || "<tr><td colspan='6'>No submissions</td></tr>"}</tbody></table></div>
      </article>`;
    })
    .join("") || "<p>No assignments for selected class.</p>";
}

async function deleteFirestorePayload(fileId) {
  const safeId = String(fileId || "").trim();
  if (!safeId) return;
  const chunkSnap = await getDocs(collection(db, "filePayloads", safeId, "chunks"));
  for (const chunk of chunkSnap.docs) {
    await deleteDoc(doc(db, "filePayloads", safeId, "chunks", chunk.id));
  }
  await deleteDoc(doc(db, "filePayloads", safeId));
}

async function renderEvaluationStats() {
  const evalSnap = await getDocs(query(collection(db, "evaluations"), where("teacherId", "==", state.me.uid)));
  const evaluations = evalSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0));
  const evaluationsByClass = new Map();
  evaluations.forEach((row) => {
    const key = row.classId;
    if (!evaluationsByClass.has(key)) evaluationsByClass.set(key, []);
    evaluationsByClass.get(key).push({
      id: row.id,
      text: String(row.comment || "").trim(),
      name: row.anonymous ? "Anonymous" : (row.studentName || "Student"),
      submittedAt: row.submittedAt,
    });
  });

  renderEvaluationClassFilterControls();
  const filteredStats = state.evalStats.filter((s) => !state.evaluationClassFilter || s.classId === state.evaluationClassFilter);
  qs("#evaluationStatsList").innerHTML = filteredStats
    .map((s) => {
      const className = state.classes.find((c) => c.id === s.classId)?.name || s.classId;
      const qEntries = Object.entries(s.questionTotals || {}).map(([k, v]) => `${k}: ${(v / (s.count || 1)).toFixed(2)}`);
      const entries = (evaluationsByClass.get(s.classId) || [])
        .sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0))
        .map((c) => `<div class="inline-actions">
          <p class="meta"><strong>${escapeHtml(c.name)}:</strong> ${escapeHtml(c.text || "No comment")} | ${fmtDate(c.submittedAt)}</p>
          <button data-del-eval="${c.id}" type="button">Delete Evaluation</button>
        </div>`)
        .join("");
      return `<article class="item">
        <h4>${escapeHtml(className)}</h4>
        <p class="meta">Responses: ${s.count || 0}</p>
        <p>${escapeHtml(qEntries.join(" | "))}</p>
        <div>${entries || "<p class='meta'>No evaluations yet.</p>"}</div>
      </article>`;
    })
    .join("") || "<p>No evaluations for selected class.</p>";
}

async function deleteEvaluationAsTeacher(evaluationId) {
  const evaluationRef = doc(db, "evaluations", evaluationId);
  const evaluationSnap = await getDoc(evaluationRef);
  if (!evaluationSnap.exists()) return;
  const evaluation = evaluationSnap.data() || {};
  if (evaluation.teacherId !== state.me.uid) return;

  const classId = evaluation.classId;
  const statsRef = doc(db, "evaluationStats", classId);
  const statsSnap = await getDoc(statsRef);
  const stats = statsSnap.exists() ? (statsSnap.data() || {}) : null;
  const questionScores = evaluation.questionScores || {};
  const nextStats = {
    classId,
    teacherId: state.me.uid,
    count: 0,
    questionTotals: {},
    updatedAt: serverTimestamp(),
  };
  if (stats) {
    nextStats.count = Math.max(0, Number(stats.count || 0) - 1);
    const baseTotals = stats.questionTotals || {};
    for (const key of Object.keys(baseTotals)) {
      const remaining = Number(baseTotals[key] || 0) - Number(questionScores[key] || 0);
      if (remaining > 0) nextStats.questionTotals[key] = remaining;
    }
  }

  const batch = writeBatch(db);
  batch.delete(evaluationRef);
  batch.delete(doc(db, "evaluationAudits", evaluationId));
  batch.set(statsRef, nextStats, { merge: true });
  await batch.commit();
}

function renderAnnouncements() {
  qs("#announcementList").innerHTML = state.announcements
    .map((a) => {
      const className = state.classes.find((c) => c.id === a.classId)?.name || a.classId;
      return `<article class="item"><h4>${escapeHtml(a.title)}</h4><p>${escapeHtml(a.body)}</p><p class="meta">${escapeHtml(className)} | ${fmtDate(a.createdAt)}</p></article>`;
    })
    .join("") || "<p>No announcements yet.</p>";
}

function wireQuizFormAutosave() {
  ["#quizClassId", "#quizNumber", "#quizTitle", "#quizDuration", "#quizAttemptLimit"].forEach((id) => {
    qs(id).addEventListener("input", scheduleDraftAutosave);
    qs(id).addEventListener("change", scheduleDraftAutosave);
  });
  qs("#quizAntiCheat").addEventListener("change", scheduleDraftAutosave);
}

async function publishDraft(draftId) {
  try {
    const d = state.quizDrafts.find((x) => x.id === draftId);
    if (!d) {
      throw new Error("Draft not found.");
    }
    validateQuestions((d.questions || []).map(normalizeQuestion), { strict: true });
    const existing = state.quizzes.find((q) => q.classId === d.classId && Number(q.quizNumber) === Number(d.quizNumber));
    const payload = {
      teacherId: state.me.uid,
      classId: d.classId,
      quizNumber: d.quizNumber,
      title: d.title,
      durationMin: d.durationMin,
      attemptLimit: d.attemptLimit || 1,
      antiCheatEnabled: d.antiCheatEnabled !== false,
      questions: (d.questions || []).map(normalizeQuestion),
      status: "published",
      acceptingAttempts: true,
      startedAt: serverTimestamp(),
      publishedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    if (existing) {
      await updateDoc(doc(db, "quizzes", existing.id), payload);
    } else {
      await addDoc(collection(db, "quizzes"), { ...payload, createdAt: serverTimestamp() });
    }
    await deleteDoc(doc(db, "quizDrafts", draftId));
    setDraftStatus("✓ Draft published successfully.");
  } catch (err) {
    console.error("Publish draft error:", err);
    const errorMsg = err.message || err.code || "Unknown error";
    setDraftStatus(`✗ Publish failed: ${errorMsg}`);
    alert(`Failed to publish draft: ${errorMsg}\n\nCheck browser console for details.`);
    throw err;
  }
}

function resetQuizEditor() {
  qs("#quizForm").reset();
  qs("#quizId").value = "";
  qs("#quizDraftId").value = "";
  qs("#quizAttemptLimit").value = "1";
  qs("#quizAntiCheat").checked = true;
  state.quizQuestions = [];
  state.activeQuestionIndex = 0;
  state.draftDirty = false;
  state.lastDraftHash = "";
  renderQuestionBuilder();
  setDraftStatus("");
}

function wireStaticEvents() {
  qs("#logoutBtn").addEventListener("click", async () => {
    await logoutStaff();
    window.location.href = "./index.html";
  });
  qs("#downloadEnrollCredentialsBtn")?.addEventListener("click", downloadEnrollCredentialsCsv);

  qs("#classForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = qs("#className").value.trim();
    const subject = qs("#classSubject").value.trim();
    const semester = qs("#semester").value.trim();
    if (!name || !subject || !semester) {
      setClassEnrollMsg("Class name, subject, and semester are required.");
      return;
    }
    try {
      await addDoc(collection(db, "classes"), {
        teacherId: state.me.uid,
        teacherName: state.me.name,
        name,
        subject,
        semester,
        createdAt: serverTimestamp(),
      });
      e.target.reset();
      await refreshData();
      setClassEnrollMsg(`Class created: ${name} - ${subject} (${semester})`);
    } catch (err) {
      setClassEnrollMsg(err.message || "Failed to create class.");
    }
  });

  qs("#csvEnrollForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const classId = qs("#enrollClassId").value;
    const file = qs("#csvFile").files[0];
    if (!classId) {
      setClassEnrollMsg("Select a class first.");
      return;
    }
    if (!file) {
      setClassEnrollMsg("Select a CSV file first.");
      return;
    }
    try {
      const text = await file.text();
      const rows = parseCSV(text);
      if (!rows.length) {
        setClassEnrollMsg("CSV is empty or invalid.");
        return;
      }
      const selectedClass = state.classes.find((c) => c.id === classId);
      let enrolled = 0;
      const credentials = [];
      for (const row of rows) {
        const rollNo = row.rollno || row.roll_no || row.roll || row["roll number"] || "";
        const name = row.name || row.student || "";
        const rawPassword = row.password || row.pass || row["login password"] || "";
        if (!rollNo || !name) continue;
        const studentId = rollNo.trim().toLowerCase().replaceAll(" ", "_");
        const manualPassword = String(rawPassword || "").trim();
        const authRef = doc(db, "studentAuth", studentId);
        const existingAuthSnap = await getDoc(authRef);
        const existingAuth = existingAuthSnap.exists() ? existingAuthSnap.data() : null;
        const loginPassword = manualPassword || existingAuth?.passwordPlain || generateStudentPassword();
        await setDoc(doc(db, "students", studentId), {
          rollNo: rollNo.trim(),
          name: name.trim(),
          nameLower: name.trim().toLowerCase(),
        }, { merge: true });
        const shouldResetPassword = !existingAuth || !!manualPassword || !existingAuth?.passwordPlain;
        if (shouldResetPassword) {
          await setStudentPasswordRecord(studentId, {
            rollNo: rollNo.trim(),
            studentName: name.trim(),
            password: loginPassword,
            changedByRole: "teacher",
            changedById: state.me.uid,
            mustChangePassword: true,
          });
        }
        const enrollmentId = `${classId}_${studentId}`;
        await setDoc(doc(db, "enrollments", enrollmentId), {
          classId,
          className: selectedClass?.name || "",
          subject: selectedClass?.subject || "",
          teacherId: state.me.uid,
          studentId,
          rollNo: rollNo.trim(),
          studentName: name.trim(),
          createdAt: serverTimestamp(),
        });
        credentials.push({
          className: selectedClass?.name || "",
          studentName: name.trim(),
          rollNo: rollNo.trim(),
          password: loginPassword,
        });
        enrolled += 1;
      }
      state.lastEnrollCredentials = credentials;
      renderEnrollCredentials();
      e.target.reset();
      setClassEnrollMsg(`Enrollment upload complete. ${enrolled} student(s) processed. Login passwords are generated and stored.`);
    } catch (err) {
      setClassEnrollMsg(err.message || "Enrollment upload failed.");
    }
  });

  qs("#lectureForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const lectureId = qs("#lectureId").value;
    const classId = qs("#lectureClassId").value;
    const title = qs("#lectureTitle").value.trim();
    const date = qs("#lectureDate").value;
    const videoLink = qs("#lectureVideo").value.trim();
    const files = Array.from(qs("#lectureFiles").files || []);
    const uploaded = [];

    for (const file of files) {
      try {
        const storageRef = ref(storage, `teachers/${state.me.uid}/classes/${classId}/lectures/${Date.now()}_${file.name}`);
        await uploadBytes(storageRef, file);
        const url = await getDownloadURL(storageRef);
        uploaded.push({ name: file.name, url, path: storageRef.fullPath, type: file.type, size: file.size, source: "storage" });
      } catch {
        const firestoreFile = await uploadFileToFirestore(file, { module: "lecture", teacherId: state.me.uid, classId });
        uploaded.push(firestoreFile);
      }
    }

    if (lectureId) {
      const prev = state.lectures.find((l) => l.id === lectureId);
      await updateDoc(doc(db, "lectures", lectureId), {
        classId,
        title,
        date,
        videoLink,
        files: [...(prev?.files || []), ...uploaded],
      });
    } else {
      await addDoc(collection(db, "lectures"), {
        teacherId: state.me.uid,
        classId,
        title,
        date,
        videoLink,
        files: uploaded,
        createdAt: serverTimestamp(),
      });
    }
    e.target.reset();
    qs("#lectureId").value = "";
    await refreshData();
  });

  qs("#addQuestionBtn").addEventListener("click", () => {
    const mode = qs("#currentQuestionMode")?.value === "theory" ? "theory" : "mcq";
    state.quizQuestions.push(normalizeQuestion({ type: mode }));
    state.activeQuestionIndex = state.quizQuestions.length - 1;
    renderQuestionBuilder();
    wireQuestionBuilderInputs();
    scheduleDraftAutosave();
  });

  qs("#cancelQuestionEditBtn").addEventListener("click", () => {
    state.activeQuestionIndex = Math.max(0, state.quizQuestions.length - 1);
    renderQuestionBuilder();
  });

  qs("#parsePasteBtn").addEventListener("click", () => {
    const text = qs("#mcqPasteInput").value;
    const parsed = parsePastedQuestions(text);
    if (!parsed.length) return alert("Could not parse pasted content. Keep one question block per paragraph.");
    state.quizQuestions.push(...parsed);
    state.activeQuestionIndex = state.quizQuestions.length - parsed.length;
    renderQuestionBuilder();
    wireQuestionBuilderInputs();
    scheduleDraftAutosave();
    setDraftStatus(`${parsed.length} question(s) pasted and added.`);
  });

  qs("#quizImportForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = qs("#quizImportFile").files?.[0];
    if (!file) return;
    const mode = qs("#quizImportMode").value;
    const text = await file.text();
    const rows = parseCSV(text);
    const toText = (v) => String(v ?? "").trim();
    const keyNorm = (k) => String(k ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const pickFromRow = (row, ...aliases) => {
      const normalizedEntries = Object.entries(row || {}).map(([k, v]) => [keyNorm(k), v]);
      const normalized = Object.fromEntries(normalizedEntries);
      for (const alias of aliases) {
        const normAlias = keyNorm(alias);
        let value = toText(normalized[normAlias]);
        if (!value) {
          const fuzzy = normalizedEntries.find(([k]) => k.startsWith(normAlias) || normAlias.startsWith(k));
          value = toText(fuzzy?.[1]);
        }
        if (value) return value;
      }
      return "";
    };
    const parseCorrectIndex = (raw, options) => {
      const value = toText(raw);
      if (!value) return 1;
      if (/^[A-Da-d]$/.test(value)) return (value.toUpperCase().charCodeAt(0) - 65) + 1;
      const withLetter = value.match(/\b([A-Da-d])\b/);
      if (withLetter) return (withLetter[1].toUpperCase().charCodeAt(0) - 65) + 1;
      const optionLetter = value.match(/(?:option|opt)\s*([A-Da-d])/i);
      if (optionLetter) return (optionLetter[1].toUpperCase().charCodeAt(0) - 65) + 1;
      const optionNumber = value.match(/(?:option|opt|index|idx)\s*([1-4])/i);
      if (optionNumber) return Number(optionNumber[1]);
      const digit = value.match(/[1-4]/);
      if (digit) return Number(digit[0]);
      const num = Number(value);
      if (Number.isInteger(num) && num >= 1 && num <= 4) return num;
      if (Number.isInteger(num) && num >= 0 && num <= 3) return num + 1;
      const byText = options.findIndex((o) => o && o.toLowerCase() === value.toLowerCase());
      return byText >= 0 ? byText + 1 : 1;
    };
    const inferType = (row, options, theoryAnswer) => {
      if (mode !== "mixed") return mode;
      const raw = pickFromRow(row, "type", "question type", "questiontype", "kind", "format").toLowerCase();
      if (/(theory|short|subjective|open|descriptive|long)/.test(raw)) return "theory";
      if (/(mcq|multiple)/.test(raw)) return "mcq";
      const hasAllOptions = options.every((o) => toText(o));
      if (!hasAllOptions && toText(theoryAnswer)) return "theory";
      return "mcq";
    };
    const imported = rows.map((r) => {
      const options = [
        pickFromRow(r, "option1", "option 1", "opt1", "a"),
        pickFromRow(r, "option2", "option 2", "opt2", "b"),
        pickFromRow(r, "option3", "option 3", "opt3", "c"),
        pickFromRow(r, "option4", "option 4", "opt4", "d"),
      ].map(toText);
      const theoryAnswer = pickFromRow(r, "theoryanswer", "theory answer", "shortanswer", "short answer", "answer", "modelanswer", "model answer");
      const type = inferType(r, options, theoryAnswer);
      return normalizeQuestion({
        type,
        promptHtml: pickFromRow(r, "prompt", "question", "question text", "questiontext", "text"),
        options,
        correctIndex: parseCorrectIndex(pickFromRow(
          r,
          "correctindex",
          "correct index",
          "correct",
          "correctoption",
          "correct option",
          "answerkey",
          "answer key",
          "answer",
        ), options),
        theoryAnswer,
        maxMarks: Number(pickFromRow(r, "marks", "maxmarks", "max marks", "points", "score")) || undefined,
      });
    }).filter((q) => {
      if (!q.promptHtml.trim()) return false;
      if (q.type === "mcq") {
        return q.options.every((o) => String(o || "").trim());
      }
      return true;
    });
    if (!imported.length) {
      alert("No valid questions found for selected format. Check CSV headers.");
      return;
    }
    state.quizQuestions.push(...imported);
    state.activeQuestionIndex = state.quizQuestions.length - imported.length;
    renderQuestionBuilder();
    wireQuestionBuilderInputs();
    scheduleDraftAutosave();
    setDraftStatus(`${imported.length} question(s) imported as ${mode.toUpperCase()}.`);
    e.target.reset();
  });

  qs("#quizForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const quizId = qs("#quizId").value;
    const payload = buildQuizPayload();
    validateQuestions(payload.questions, { strict: true });

    if (quizId) {
      const old = state.quizzes.find((q) => q.id === quizId);
      await updateDoc(doc(db, "quizzes", quizId), {
        ...payload,
        status: old?.status || "draft",
        acceptingAttempts: old?.acceptingAttempts || false,
        updatedAt: serverTimestamp(),
      });
      setDraftStatus("Quiz updated.");
      state.draftDirty = false;
      state.lastDraftHash = draftPayloadHash(payload);
    } else {
      const draftId = `${state.me.uid}_${payload.classId}_q${payload.quizNumber}`;
      await setDoc(doc(db, "quizDrafts", draftId), {
        ...payload,
        teacherId: state.me.uid,
        status: "draft",
        updatedAt: serverTimestamp(),
      }, { merge: true });
      qs("#quizDraftId").value = draftId;
      setDraftStatus("Draft saved.");
      state.draftDirty = false;
      state.lastDraftHash = draftPayloadHash(payload);
    }
    await refreshData();
  });

  wireQuizFormAutosave();

  qs("#saveDraftBtn").addEventListener("click", async () => {
    try {
      const btn = qs("#saveDraftBtn");
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = "Saving...";
      
      validateQuestions(state.quizQuestions.map(normalizeQuestion), { strict: false });
      const ok = await autosaveDraft();
      if (ok) {
        const msg = `✓ Draft saved successfully at ${new Date().toLocaleTimeString()}`;
        setDraftStatus(msg);
        btn.classList.add("btn-success");
        setTimeout(() => {
          btn.classList.remove("btn-success");
          btn.textContent = originalText;
          btn.disabled = false;
        }, 2000);
      } else {
        btn.textContent = originalText;
        btn.disabled = false;
        alert("Draft was not saved. Select class/quiz and add questions first.");
      }
    } catch (err) {
      qs("#saveDraftBtn").disabled = false;
      qs("#saveDraftBtn").textContent = "Save Draft";
      alert(err.message || "Draft save failed.");
    }
  });

  qs("#loadDraftBtn").addEventListener("click", () => {
    const classId = qs("#quizClassId").value;
    const quizNumber = Number(qs("#quizNumber").value);
    const draft = state.quizDrafts.find((d) => d.classId === classId && Number(d.quizNumber) === quizNumber);
    if (!draft) return alert("No draft found for selected class/quiz.");
    qs("#quizDraftId").value = draft.id;
    qs("#quizTitle").value = draft.title || "";
    qs("#quizDuration").value = draft.durationMin || 10;
    qs("#quizAttemptLimit").value = draft.attemptLimit || 1;
    qs("#quizAntiCheat").checked = draft.antiCheatEnabled !== false;
    state.quizQuestions = (draft.questions || []).map(normalizeQuestion);
    state.activeQuestionIndex = 0;
    state.draftDirty = false;
    state.lastDraftHash = draftPayloadHash(buildQuizPayload());
    renderQuestionBuilder();
    wireQuestionBuilderInputs();
    setDraftStatus("Draft loaded.");
  });

  qs("#publishCurrentDraftBtn").addEventListener("click", async () => {
    try {
      const draftId = qs("#quizDraftId").value;
      let targetDraftId = draftId;
      
      if (!draftId) {
        const classId = qs("#quizClassId").value;
        const quizNumber = Number(qs("#quizNumber").value);
        const draft = state.quizDrafts.find((d) => d.classId === classId && Number(d.quizNumber) === quizNumber);
        if (!draft) throw new Error("No draft found to publish. Save the quiz as a draft first.");
        targetDraftId = draft.id;
      }
      
      const confirmed = confirm(
        "Are you sure you want to publish this quiz?\n\n" +
        "Once published, students will be able to attempt it.\n" +
        "You can still edit it after publishing."
      );
      
      if (!confirmed) return;
      
      const btn = qs("#publishCurrentDraftBtn");
      btn.disabled = true;
      btn.textContent = "Publishing...";
      
      await publishDraft(targetDraftId);
      await refreshData();
      
      alert("✓ Quiz published successfully!");
    } catch (err) {
      console.error("Error publishing draft:", err);
      alert(err.message || "Failed to publish draft. Check console for details.");
    } finally {
      const btn = qs("#publishCurrentDraftBtn");
      btn.disabled = false;
      btn.textContent = "Publish Draft";
    }
  });

  qs("#deleteCurrentDraftBtn").addEventListener("click", async () => {
    const draftId = qs("#quizDraftId").value;
    if (draftId) {
      await deleteDoc(doc(db, "quizDrafts", draftId));
      resetQuizEditor();
      await refreshData();
      return;
    }
    const classId = qs("#quizClassId").value;
    const quizNumber = Number(qs("#quizNumber").value);
    const draft = state.quizDrafts.find((d) => d.classId === classId && Number(d.quizNumber) === quizNumber);
    if (!draft) return alert("No draft found to delete.");
    await deleteDoc(doc(db, "quizDrafts", draft.id));
    resetQuizEditor();
    await refreshData();
  });

  qs("#archiveCurrentQuizBtn").addEventListener("click", async () => {
    const classId = qs("#quizClassId").value;
    const quizNumber = Number(qs("#quizNumber").value);
    const quiz = state.quizzes.find((q) => q.classId === classId && Number(q.quizNumber) === quizNumber);
    if (!quiz) return alert("No saved quiz found to archive.");
    await updateDoc(doc(db, "quizzes", quiz.id), {
      status: "archived",
      acceptingAttempts: false,
      archivedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await refreshData();
  });

  qs("#restoreCurrentQuizBtn").addEventListener("click", async () => {
    const classId = qs("#quizClassId").value;
    const quizNumber = Number(qs("#quizNumber").value);
    const quiz = state.quizzes.find((q) => q.classId === classId && Number(q.quizNumber) === quizNumber && q.status === "archived");
    if (!quiz) return alert("No archived quiz found to restore.");
    await updateDoc(doc(db, "quizzes", quiz.id), {
      status: "draft",
      updatedAt: serverTimestamp(),
    });
    await refreshData();
  });

  qs("#announcementForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    await addDoc(collection(db, "discussionThreads"), {
      classId: qs("#announcementClassId").value,
      title: qs("#announcementTitle").value.trim(),
      body: qs("#announcementBody").value.trim(),
      isAnnouncement: true,
      teacherId: state.me.uid,
      createdByRole: "teacher",
      createdByName: state.me.name,
      createdAt: serverTimestamp(),
    });
    e.target.reset();
    await refreshData();
  });

  qs("#quizPreviewClass").addEventListener("change", renderQuizPreview);
  qs("#quizPreviewSemester").addEventListener("change", renderQuizPreview);
}

function wireDynamicEvents() {
  qsa("[data-quiz-analytics-class]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.analyticsClassFilter = btn.dataset.quizAnalyticsClass || "";
      state.analyticsQuizFilter = "";
      renderQuizClassFilterControls();
      await renderQuizAnalytics();
      wireDynamicEvents();
    });
  });

  qsa("[data-quiz-review-class]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.reviewClassFilter = btn.dataset.quizReviewClass || "";
      state.reviewQuizFilter = "";
      renderQuizClassFilterControls();
      await renderQuizAttemptReviews();
      wireDynamicEvents();
    });
  });

  qsa("[data-quiz-analytics-quiz]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.analyticsQuizFilter = btn.dataset.quizAnalyticsQuiz || "";
      renderQuizClassFilterControls();
      await renderQuizAnalytics();
      wireDynamicEvents();
    });
  });

  qsa("[data-quiz-review-quiz]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.reviewQuizFilter = btn.dataset.quizReviewQuiz || "";
      renderQuizClassFilterControls();
      await renderQuizAttemptReviews();
      wireDynamicEvents();
    });
  });

  qsa("[data-download-quiz-results]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const quizId = btn.dataset.downloadQuizResults;
      exportQuizAttemptsCsv({ quizId });
    });
  });

  qsa("[data-download-quiz-class-results]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const classId = btn.dataset.downloadQuizClassResults || "";
      exportQuizAttemptsCsv({ classId });
    });
  });

  qsa("[data-assignment-class-filter]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.assignmentClassFilter = btn.dataset.assignmentClassFilter || "";
      state.assignmentNumberFilter = "";
      await renderAssignments();
      wireDynamicEvents();
    });
  });

  qsa("[data-assignment-number-filter]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.assignmentNumberFilter = btn.dataset.assignmentNumberFilter || "";
      await renderAssignments();
      wireDynamicEvents();
    });
  });

  qsa("[data-evaluation-class-filter]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.evaluationClassFilter = btn.dataset.evaluationClassFilter || "";
      await renderEvaluationStats();
      wireDynamicEvents();
    });
  });

  qsa("[data-del-class]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const classId = btn.dataset.delClass;
      const klass = state.classes.find((c) => c.id === classId);
      if (!klass) return;
      if (!confirm(`Delete class "${klass.name}" and related data?`)) return;
      try {
        const [enrollSnap, lectureSnap, quizSnap, draftSnap, assignSnap] = await Promise.all([
          getDocs(query(collection(db, "enrollments"), where("classId", "==", classId), where("teacherId", "==", state.me.uid))),
          getDocs(query(collection(db, "lectures"), where("classId", "==", classId), where("teacherId", "==", state.me.uid))),
          getDocs(query(collection(db, "quizzes"), where("classId", "==", classId), where("teacherId", "==", state.me.uid))),
          getDocs(query(collection(db, "quizDrafts"), where("classId", "==", classId), where("teacherId", "==", state.me.uid))),
          getDocs(query(collection(db, "assignments"), where("classId", "==", classId), where("teacherId", "==", state.me.uid))),
        ]);
        for (const d of enrollSnap.docs) await deleteDoc(doc(db, "enrollments", d.id));
        for (const d of lectureSnap.docs) await deleteDoc(doc(db, "lectures", d.id));
        for (const d of quizSnap.docs) await deleteDoc(doc(db, "quizzes", d.id));
        for (const d of draftSnap.docs) await deleteDoc(doc(db, "quizDrafts", d.id));
        for (const d of assignSnap.docs) await deleteDoc(doc(db, "assignments", d.id));
        await deleteDoc(doc(db, "classes", classId));
        setClassEnrollMsg(`Class deleted: ${klass.name}`);
        await refreshData();
      } catch (err) {
        setClassEnrollMsg(err.message || "Failed to delete class.");
      }
    });
  });

  qsa("[data-edit-lecture]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = state.lectures.find((x) => x.id === btn.dataset.editLecture);
      if (!row) return;
      qs("#lectureId").value = row.id;
      qs("#lectureClassId").value = row.classId;
      qs("#lectureTitle").value = row.title;
      qs("#lectureDate").value = row.date;
      qs("#lectureVideo").value = row.videoLink || "";
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  qsa("[data-del-lecture]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = state.lectures.find((x) => x.id === btn.dataset.delLecture);
      if (!row) return;
      if (!confirm("Delete this lecture?")) return;
      for (const f of row.files || []) {
        if (!f.path) continue;
        await deleteObject(ref(storage, f.path)).catch(() => {});
      }
      await deleteDoc(doc(db, "lectures", row.id));
      await refreshData();
    });
  });

  qsa("[data-edit-draft]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const d = state.quizDrafts.find((x) => x.id === btn.dataset.editDraft);
      if (!d) return;
      qs("#quizId").value = "";
      qs("#quizDraftId").value = d.id;
      qs("#quizClassId").value = d.classId;
      qs("#quizNumber").value = d.quizNumber;
      qs("#quizTitle").value = d.title || "";
      qs("#quizDuration").value = d.durationMin || 10;
      qs("#quizAttemptLimit").value = d.attemptLimit || 1;
      qs("#quizAntiCheat").checked = d.antiCheatEnabled !== false;
      state.quizQuestions = (d.questions || []).map(normalizeQuestion);
      state.activeQuestionIndex = 0;
      state.draftDirty = false;
      state.lastDraftHash = draftPayloadHash(buildQuizPayload());
      renderQuestionBuilder();
      wireQuestionBuilderInputs();
      setDraftStatus("Draft loaded.");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  qsa("[data-publish-draft]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const confirmed = confirm(
        "Are you sure you want to publish this quiz?\n\n" +
        "Once published, students will be able to attempt it."
      );
      if (!confirmed) return;
      
      try {
        btn.disabled = true;
        btn.textContent = "Publishing...";
        await publishDraft(btn.dataset.publishDraft);
        await refreshData();
        alert("✓ Quiz published successfully!");
      } catch (err) {
        console.error("Error publishing draft:", err);
        alert(err.message || "Failed to publish quiz.");
      } finally {
        btn.disabled = false;
        btn.textContent = "Publish Draft";
      }
    });
  });

  qsa("[data-del-draft]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this draft?")) return;
      await deleteDoc(doc(db, "quizDrafts", btn.dataset.delDraft));
      await refreshData();
    });
  });

  qsa("[data-edit-quiz]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = state.quizzes.find((x) => x.id === btn.dataset.editQuiz);
      if (!row) return;
      qs("#quizId").value = row.id;
      qs("#quizDraftId").value = "";
      qs("#quizClassId").value = row.classId;
      qs("#quizNumber").value = row.quizNumber;
      qs("#quizTitle").value = row.title;
      qs("#quizDuration").value = row.durationMin;
      qs("#quizAttemptLimit").value = row.attemptLimit || 1;
      qs("#quizAntiCheat").checked = row.antiCheatEnabled !== false;
      state.quizQuestions = (row.questions || []).map(normalizeQuestion);
      state.activeQuestionIndex = 0;
      state.draftDirty = false;
      state.lastDraftHash = draftPayloadHash(buildQuizPayload());
      renderQuestionBuilder();
      wireQuestionBuilderInputs();
      setDraftStatus("Published quiz loaded for editing.");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  qsa("[data-toggle-publish]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = state.quizzes.find((x) => x.id === btn.dataset.togglePublish);
      if (!row) return;
      const nextStatus = row.status === "published" ? "draft" : "published";
      await updateDoc(doc(db, "quizzes", row.id), {
        status: nextStatus,
        acceptingAttempts: nextStatus === "published",
        startedAt: nextStatus === "published" ? serverTimestamp() : null,
        updatedAt: serverTimestamp(),
      });
      await refreshData();
    });
  });

  qsa("[data-toggle-start]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = state.quizzes.find((x) => x.id === btn.dataset.toggleStart);
      if (!row) return;
      if (row.status !== "published") return alert("Publish quiz first.");
      await updateDoc(doc(db, "quizzes", row.id), {
        acceptingAttempts: !row.acceptingAttempts,
        startedAt: !row.acceptingAttempts ? serverTimestamp() : row.startedAt || null,
        updatedAt: serverTimestamp(),
      });
      await refreshData();
    });
  });

  qsa("[data-toggle-archive]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = state.quizzes.find((x) => x.id === btn.dataset.toggleArchive);
      if (!row) return;
      const archived = row.status === "archived";
      await updateDoc(doc(db, "quizzes", row.id), {
        status: archived ? "draft" : "archived",
        acceptingAttempts: false,
        archivedAt: archived ? null : serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await refreshData();
    });
  });

  qsa("[data-del-quiz]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this quiz?")) return;
      await deleteDoc(doc(db, "quizzes", btn.dataset.delQuiz));
      await refreshData();
      resetQuizEditor();
    });
  });

  qsa("[data-unlock-attempt]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const attemptId = btn.dataset.unlockAttempt;
      const attempt = state.quizAttemptsReview.find((a) => a.id === attemptId);
      if (!attempt) return alert("Attempt not found.");
      
      const confirmed = confirm(
        `Unlock ${attempt.studentName} (${attempt.studentRollNo}) to re-attempt this quiz?\n\n` +
        "They will be able to take this quiz again."
      );
      if (!confirmed) return;
      
      try {
        btn.disabled = true;
        btn.textContent = "Unlocking...";
        await updateDoc(doc(db, "quizAttempts", attemptId), {
          locked: false,
          unlockedAt: serverTimestamp(),
          unlockedBy: state.me.uid,
          unlockReason: attempt.locked ? "locked_attempt" : "extra_attempt_allowed",
        });
        await refreshData();
        alert(`✓ ${attempt.studentName} can now re-attempt this quiz.`);
      } catch (err) {
        console.error("Unlock error:", err);
        alert(`Failed to unlock: ${err.message}`);
        btn.disabled = false;
        btn.textContent = "🔓 Unlock for Re-attempt";
      }
    });
  });

  qsa("[data-ai-grade-attempt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const attemptId = btn.dataset.aiGradeAttempt;
      const attempt = state.quizAttemptsReview.find((a) => a.id === attemptId);
      const quiz = state.quizzes.find((q) => q.id === attempt?.quizId);
      if (!attempt || !quiz) return;
      const marks = aiGradeTheoryQuestions(attempt, quiz);
      qsa(`[data-review-attempt="${attemptId}"]`).forEach((el) => {
        const qi = Number(el.dataset.qi);
        if (marks[qi] != null) el.value = marks[qi];
      });
      alert("AI suggested marks filled in. Review them, then click 'Save Theory Marks'.");
    });
  });

  qsa("[data-ai-grade-all]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const pending = state.quizAttemptsReview.filter(
        (a) => a.theoryPending
          && (!state.reviewClassFilter || a.classId === state.reviewClassFilter)
          && (!state.reviewQuizFilter || a.quizId === state.reviewQuizFilter)
      );
      if (!pending.length) return;
      if (!confirm(`AI Auto-Grade ${pending.length} pending attempt(s) using each question's Model Answer? You can still review/edit marks afterward.`)) return;
      btn.disabled = true;
      btn.textContent = "Grading...";
      for (const attempt of pending) {
        const quiz = state.quizzes.find((q) => q.id === attempt.quizId);
        if (!quiz) continue;
        const marks = aiGradeTheoryQuestions(attempt, quiz);
        if (!Object.keys(marks).length) continue;
        const theoryScore = Object.values(marks).reduce((sum, v) => sum + Number(v || 0), 0);
        const mcqScore = Number(attempt.mcqScore ?? attempt.score ?? 0);
        await updateDoc(doc(db, "quizAttempts", attempt.id), {
          theoryMarks: marks,
          theoryScore,
          finalScore: mcqScore + theoryScore,
          theoryPending: false,
          reviewedBy: state.me.uid,
          reviewedAt: serverTimestamp(),
          aiGraded: true,
        });
      }
      await renderQuizAttemptReviews();
      await renderQuizAnalytics();
      wireDynamicEvents();
      alert("AI Auto-Grade complete. Marks were saved — you can still edit and re-save any attempt.");
    });
  });

  qsa("[data-save-attempt-review]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const attemptId = btn.dataset.saveAttemptReview;
      const attempt = state.quizAttemptsReview.find((a) => a.id === attemptId);
      if (!attempt) return;
      const quiz = state.quizzes.find((q) => q.id === attempt.quizId);
      if (!quiz) return;
      const theoryMarks = {};
      let theoryScore = 0;
      const inputs = qsa(`[data-review-attempt="${attemptId}"]`);
      for (const el of inputs) {
        const qi = Number(el.dataset.qi);
        const max = Number(el.dataset.max || 0);
        const raw = String(el.value || "").trim();
        const value = raw ? Number(raw) : 0;
        if (!Number.isFinite(value) || value < 0 || value > max) {
          alert(`Invalid marks for Q${qi + 1}. Use 0 to ${max}.`);
          return;
        }
        theoryMarks[qi] = value;
        theoryScore += value;
      }
      const mcqScore = Number(attempt.mcqScore ?? attempt.score ?? 0);
      const finalScore = mcqScore + theoryScore;
      await updateDoc(doc(db, "quizAttempts", attemptId), {
        theoryMarks,
        theoryScore,
        finalScore,
        theoryPending: false,
        reviewedBy: state.me.uid,
        reviewedAt: serverTimestamp(),
      });
      await renderQuizAttemptReviews();
      await renderQuizAnalytics();
      wireDynamicEvents();
    });
  });

  qsa("[data-save-review]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.saveReview;
      const grade = Number(qs(`[data-grade="${id}"]`)?.value || 0);
      const feedback = qs(`[data-feedback="${id}"]`)?.value || "";
      await updateDoc(doc(db, "assignmentSubmissions", id), {
        grade,
        feedback,
        status: "reviewed",
        reviewedAt: serverTimestamp(),
      });
      await renderAssignments();
      wireDynamicEvents();
    });
  });

  qsa("[data-bulk-download-assignment]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const assignmentId = btn.dataset.bulkDownloadAssignment;
      const assignment = state.assignments.find((a) => a.id === assignmentId);
      if (!assignment) return alert("Assignment not found.");

      const submissionsSnap = await getDocs(query(
        collection(db, "assignmentSubmissions"),
        where("assignmentId", "==", assignmentId),
        where("teacherId", "==", state.me.uid)
      ));
      const submissions = submissionsSnap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((s) => s.fileUrl || s.fileId)
        .sort((a, b) => String(a.studentRollNo || "").localeCompare(String(b.studentRollNo || "")));

      if (!submissions.length) return alert("No submitted assignment files found.");

      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Preparing ZIP...";
      try {
        const usedNames = new Set();
        const files = [];
        for (let i = 0; i < submissions.length; i += 1) {
          const s = submissions[i];
          btn.textContent = `Downloading ${i + 1}/${submissions.length}...`;
          const roll = sanitizeFileName(s.studentRollNo || `student-${i + 1}`);
          const name = sanitizeFileName(s.studentName || "student");
          const originalFile = sanitizeFileName(s.fileName || "submission");
          let zipName = `${roll} - ${name} - ${originalFile}`;
          if (usedNames.has(zipName)) zipName = `${roll} - ${name} - ${i + 1} - ${originalFile}`;
          usedNames.add(zipName);
          files.push({
            name: zipName,
            bytes: await loadSubmissionFileBytes(s),
          });
        }

        btn.textContent = "Creating ZIP...";
        const zipBlob = makeZipBlob(files);
        const className = state.classes.find((c) => c.id === assignment.classId)?.name || assignment.classId;
        const filename = `${sanitizeFileName(className)} - A${assignment.assignmentNumber} - ${sanitizeFileName(assignment.title)} submissions.zip`;
        triggerBlobDownload(zipBlob, filename);
      } catch (err) {
        alert(err.message || "Bulk download failed.");
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });

  qsa("[data-del-assignment]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const assignmentId = btn.dataset.delAssignment;
      const assignment = state.assignments.find((a) => a.id === assignmentId);
      if (!assignment) return;
      if (!confirm(`Delete assignment "${assignment.title}" and all submissions?`)) return;

      const submissionsSnap = await getDocs(query(
        collection(db, "assignmentSubmissions"),
        where("assignmentId", "==", assignmentId),
        where("teacherId", "==", state.me.uid)
      ));

      for (const s of submissionsSnap.docs) {
        const data = s.data() || {};
        if (data.filePath) {
          await deleteObject(ref(storage, data.filePath)).catch(() => {});
        }
        if (data.fileId) {
          await deleteFirestorePayload(data.fileId).catch(() => {});
        }
        await deleteDoc(doc(db, "assignmentSubmissions", s.id));
      }

      await deleteDoc(doc(db, "assignments", assignmentId));
      await refreshData();
    });
  });

  qsa("[data-del-eval]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const evaluationId = btn.dataset.delEval;
      if (!evaluationId) return;
      if (!confirm("Delete this evaluation? Student will be able to submit again.")) return;
      await deleteEvaluationAsTeacher(evaluationId);
      await refreshData();
    });
  });
}

async function initAssignmentCreate() {
  qs("#assignmentForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    await addDoc(collection(db, "assignments"), {
      teacherId: state.me.uid,
      classId: qs("#assignmentClassId").value,
      assignmentNumber: Number(qs("#assignmentNumber").value),
      title: qs("#assignmentTitle").value.trim(),
      deadline: new Date(qs("#assignmentDeadline").value).toISOString(),
      createdAt: serverTimestamp(),
    });
    e.target.reset();
    await refreshData();
  });
}

async function boot() {
  state.me = await requireStaffRole(["teacher"]);
  qs("#whoami").textContent = `${state.me.name} (${state.me.email})`;
  wireStaticEvents();
  await initAssignmentCreate();
  await refreshData();
}

boot().catch((err) => {
  alert(err.message);
});
