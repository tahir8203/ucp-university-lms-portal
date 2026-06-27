import { requireStaffRole, logoutStaff, generateStudentPassword, setStudentPasswordRecord } from "./auth.js";
import { qs, fmtDate, escapeHtml } from "./utils.js";
import {
  db,
  collection,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  updateDoc,
  doc,
} from "./firebase.js";

const state = {
  me: null,
  teachers: [],
  pendingTeachers: [],
  classes: [],
  studentAccounts: [],
};

async function loadAdmin() {
  const me = await requireStaffRole(["admin"]);
  state.me = me;
  qs("#whoami").textContent = `${me.name} (${me.email})`;
  qs("#logoutBtn").addEventListener("click", async () => {
    await logoutStaff();
    window.location.href = "./index.html";
  });

  const [teacherSnap, pendingSnap, classSnap, lectureSnap, evalSnap, evalAuditSnap, enrollSnap, studentAuthSnap] = await Promise.all([
    getDocs(query(collection(db, "users"), where("role", "==", "teacher"))),
    getDocs(query(collection(db, "users"), where("role", "==", "pending_teacher"))),
    getDocs(collection(db, "classes")),
    getDocs(collection(db, "lectures")),
    getDocs(query(collection(db, "evaluations"), orderBy("submittedAt", "desc"), limit(200))),
    getDocs(collection(db, "evaluationAudits")),
    getDocs(collection(db, "enrollments")),
    getDocs(collection(db, "studentAuth")),
  ]);

  state.teachers = teacherSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.pendingTeachers = pendingSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.classes = classSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const lectures = lectureSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const evaluations = evalSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const evaluationAudits = evalAuditSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const enrollments = enrollSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const studentAuth = studentAuthSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const auditByEvaluationId = new Map(evaluationAudits.map((a) => [a.id, a]));
  const classById = new Map(state.classes.map((c) => [c.id, c]));
  const teacherById = new Map(state.teachers.map((t) => [t.id, t]));
  const authByStudentId = new Map(studentAuth.map((a) => [a.studentId || a.id, a]));
  const auditsByClassTeacher = new Map();
  evaluationAudits.forEach((a) => {
    const key = `${a.classId || ""}::${a.teacherId || ""}`;
    if (!auditsByClassTeacher.has(key)) auditsByClassTeacher.set(key, []);
    auditsByClassTeacher.get(key).push(a);
  });
  const usedAuditIds = new Set();

  qs("#teachersCount").textContent = String(state.teachers.length);
  qs("#classesCount").textContent = String(state.classes.length);
  qs("#lecturesCount").textContent = String(lectures.length);

  qs("#teachersTable tbody").innerHTML = state.teachers
    .map((t) => `<tr><td>${escapeHtml(t.name)}</td><td>${escapeHtml(t.email)}</td></tr>`)
    .join("");

  qs("#pendingTeachersTable tbody").innerHTML = state.pendingTeachers
    .map((t) => `<tr>
      <td>${escapeHtml(t.name)}</td>
      <td>${escapeHtml(t.email)}</td>
      <td>${fmtDate(t.createdAt)}</td>
      <td>
        <button data-approve-teacher="${t.id}" type="button">Approve</button>
        <button data-reject-teacher="${t.id}" type="button">Reject</button>
      </td>
    </tr>`)
    .join("") || "<tr><td colspan='4'>No pending requests</td></tr>";

  qs("#classesTable tbody").innerHTML = state.classes
    .map((c) => {
      const teacher = state.teachers.find((t) => t.id === c.teacherId);
      return `<tr>
        <td>${escapeHtml(c.name)}</td>
        <td>${escapeHtml(c.semester)}</td>
        <td>${escapeHtml(teacher?.name || c.teacherId)}</td>
        <td>${fmtDate(c.createdAt)}</td>
      </tr>`;
    })
    .join("");

  qs("#lecturesTable tbody").innerHTML = lectures
    .map((l) => {
      const klass = state.classes.find((c) => c.id === l.classId);
      const teacher = state.teachers.find((t) => t.id === l.teacherId);
      return `<tr>
        <td>${escapeHtml(klass?.name || l.classId)}</td>
        <td>${escapeHtml(l.title)}</td>
        <td>${escapeHtml(l.date)}</td>
        <td>${escapeHtml(teacher?.name || l.teacherId)}</td>
      </tr>`;
    })
    .join("");

  qs("#evaluationsTable tbody").innerHTML = evaluations
    .map((ev) => {
      const klass = state.classes.find((c) => c.id === ev.classId);
      const teacher = state.teachers.find((t) => t.id === ev.teacherId);
      const scores = Object.values(ev.questionScores || {});
      const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2) : "0.00";
      let audit = auditByEvaluationId.get(ev.id);
      if (!audit) {
        const key = `${ev.classId || ""}::${ev.teacherId || ""}`;
        const pool = (auditsByClassTeacher.get(key) || []).filter((a) => !usedAuditIds.has(a.id));
        if (pool.length === 1) {
          [audit] = pool;
        } else if (pool.length > 1 && ev.submittedAt?.seconds) {
          audit = pool
            .slice()
            .sort((a, b) => {
              const aSec = Number(a.submittedAt?.seconds || 0);
              const bSec = Number(b.submittedAt?.seconds || 0);
              return Math.abs(aSec - ev.submittedAt.seconds) - Math.abs(bSec - ev.submittedAt.seconds);
            })[0];
        }
      }
      if (audit?.id) usedAuditIds.add(audit.id);
      const studentLabel = audit?.studentName || audit?.studentKey || ev.studentName || ev.studentKey || "Unknown";
      return `<tr>
        <td>${escapeHtml(klass?.name || ev.classId)}</td>
        <td>${escapeHtml(teacher?.name || ev.teacherId)}</td>
        <td>${ev.anonymous ? "Yes" : "No"}</td>
        <td>${escapeHtml(studentLabel)}</td>
        <td>${avg}</td>
        <td>${fmtDate(ev.submittedAt)}</td>
      </tr>`;
    })
    .join("");

  state.studentAccounts = enrollments.map((en) => {
    const klass = classById.get(en.classId);
    const teacher = teacherById.get(en.teacherId);
    const authRow = authByStudentId.get(en.studentId) || null;
    return {
      enrollmentId: en.id,
      studentId: en.studentId,
      classId: en.classId,
      className: en.className || klass?.name || en.classId,
      teacherName: teacher?.name || en.teacherId || "-",
      studentName: en.studentName || authRow?.studentName || "-",
      rollNo: en.rollNo || authRow?.rollNo || "-",
      passwordPlain: authRow?.passwordPlain || "-",
      mustChangePassword: authRow?.mustChangePassword !== false,
    };
  }).sort((a, b) => `${a.className}_${a.studentName}`.localeCompare(`${b.className}_${b.studentName}`));

  qs("#studentAccountsTable tbody").innerHTML = state.studentAccounts
    .map((s) => `<tr>
      <td>${escapeHtml(s.className)}</td>
      <td>${escapeHtml(s.teacherName)}</td>
      <td>${escapeHtml(s.studentName)}</td>
      <td>${escapeHtml(s.rollNo)}</td>
      <td><code>${escapeHtml(s.passwordPlain)}</code></td>
      <td>${s.mustChangePassword ? "Yes" : "No"}</td>
      <td><input data-admin-reset-pass="${s.enrollmentId}" type="text" placeholder="Leave blank for auto password" /></td>
      <td><button data-admin-reset-btn="${s.enrollmentId}" type="button">Reset</button></td>
    </tr>`)
    .join("") || "<tr><td colspan='8'>No student accounts found.</td></tr>";

  wireApprovalActions();
  wireStudentResetActions();
}

function wireApprovalActions() {
  document.querySelectorAll("[data-approve-teacher]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const uid = btn.dataset.approveTeacher;
      await updateDoc(doc(db, "users", uid), {
        role: "teacher",
        approved: true,
        approvedBy: state.me.uid,
      });
      await loadAdmin();
    });
  });

  document.querySelectorAll("[data-reject-teacher]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const uid = btn.dataset.rejectTeacher;
      await updateDoc(doc(db, "users", uid), {
        role: "rejected_teacher",
        approved: false,
        approvedBy: state.me.uid,
      });
      await loadAdmin();
    });
  });
}

function wireStudentResetActions() {
  document.querySelectorAll("[data-admin-reset-btn]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const enrollmentId = btn.dataset.adminResetBtn;
      const row = state.studentAccounts.find((s) => s.enrollmentId === enrollmentId);
      if (!row) return;
      const input = document.querySelector(`[data-admin-reset-pass="${enrollmentId}"]`);
      const manual = String(input?.value || "").trim();
      const nextPassword = manual || generateStudentPassword();
      if (nextPassword.length < 6) {
        alert("Password must be at least 6 characters.");
        return;
      }
      await setStudentPasswordRecord(row.studentId, {
        rollNo: row.rollNo,
        studentName: row.studentName,
        password: nextPassword,
        mustChangePassword: true,
        changedByRole: "admin",
        changedById: state.me.uid,
      });
      alert(`Password reset for ${row.studentName}. New password: ${nextPassword}`);
      await loadAdmin();
    });
  });
}

loadAdmin().catch((err) => {
  alert(err.message);
});
