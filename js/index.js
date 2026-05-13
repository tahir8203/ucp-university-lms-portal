import { loginStaff, loginStudentByRollName, createTeacherRequest, explainAuthError } from "./auth.js";
import { qs, setText } from "./utils.js";
import { db, collection, getDocs, query, where } from "./firebase.js";

const staffTabBtn = qs("#staffTabBtn");
const studentTabBtn = qs("#studentTabBtn");
const staffLoginForm = qs("#staffLoginForm");
const studentLoginForm = qs("#studentLoginForm");
const teacherRequestForm = qs("#teacherRequestForm");
const msg = qs("#authMessage");
const teacherStatusBanner = qs("#teacherStatusBanner");
const studentTeacher = qs("#studentTeacher");
const studentCourse = qs("#studentCourse");
const studentNameSelect = qs("#studentNameSelect");
const studentRollSelect = qs("#studentRollSelect");
const studentPassword = qs("#studentPassword");

const studentPicker = {
  classes: [],
  classStudents: new Map(),
  selectedStudents: [],
};

function setTeacherStatus(kind, text) {
  teacherStatusBanner.classList.remove("hidden", "status-pending", "status-approved", "status-rejected");
  if (kind === "pending") teacherStatusBanner.classList.add("status-pending");
  if (kind === "approved") teacherStatusBanner.classList.add("status-approved");
  if (kind === "rejected") teacherStatusBanner.classList.add("status-rejected");
  teacherStatusBanner.textContent = text;
}

function showStaffTab(staff) {
  staffTabBtn.classList.toggle("active", staff);
  studentTabBtn.classList.toggle("active", !staff);
  staffLoginForm.classList.toggle("hidden", !staff);
  studentLoginForm.classList.toggle("hidden", staff);
  teacherStatusBanner.classList.toggle("hidden", !staff || !teacherStatusBanner.textContent);
  setText(msg, "");
}

function setSelect(el, options, placeholder, disabled = false) {
  el.innerHTML = [`<option value="">${placeholder}</option>`, ...options].join("");
  el.disabled = disabled;
}

function renderTeacherOptions() {
  const uniq = new Map();
  studentPicker.classes.forEach((c) => {
    if (!c.teacherId) return;
    if (!uniq.has(c.teacherId)) uniq.set(c.teacherId, c.teacherName || "Teacher");
  });
  const opts = Array.from(uniq.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => `<option value="${t.id}">${t.name}</option>`);
  setSelect(studentTeacher, opts, "Select teacher", false);
}

function renderCourseOptions(teacherId) {
  const rows = studentPicker.classes
    .filter((c) => c.teacherId === teacherId)
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    .map((c) => `<option value="${c.id}">${c.name} (${c.semester || "-"})</option>`);
  setSelect(studentCourse, rows, "Select class", !teacherId || rows.length === 0);
  setSelect(studentNameSelect, [], "Select student", true);
  setSelect(studentRollSelect, [], "Select roll number", true);
  studentPassword.value = "";
  studentPicker.selectedStudents = [];
}

function renderStudentOptions(students) {
  const sorted = [...students].sort((a, b) => (a.studentName || "").localeCompare(b.studentName || ""));
  const names = sorted.map((s) => `<option value="${s.studentId}">${s.studentName}</option>`);
  const rolls = sorted.map((s) => `<option value="${s.studentId}">${s.rollNo}</option>`);
  setSelect(studentNameSelect, names, "Select student", sorted.length === 0);
  setSelect(studentRollSelect, rolls, "Select roll number", sorted.length === 0);
  studentPicker.selectedStudents = sorted;
}

async function loadClassStudents(classId) {
  if (!classId) {
    renderStudentOptions([]);
    return;
  }
  if (studentPicker.classStudents.has(classId)) {
    renderStudentOptions(studentPicker.classStudents.get(classId));
    return;
  }
  const snap = await getDocs(query(collection(db, "enrollments"), where("classId", "==", classId)));
  const uniq = new Map();
  snap.docs.forEach((d) => {
    const row = d.data();
    if (!row.studentId || !row.studentName || !row.rollNo) return;
    if (!uniq.has(row.studentId)) {
      uniq.set(row.studentId, {
        studentId: row.studentId,
        studentName: row.studentName,
        rollNo: row.rollNo,
      });
    }
  });
  const students = Array.from(uniq.values());
  studentPicker.classStudents.set(classId, students);
  renderStudentOptions(students);
}

async function initStudentLoginPicker() {
  const classSnap = await getDocs(collection(db, "classes"));
  studentPicker.classes = classSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderTeacherOptions();
}

staffTabBtn.addEventListener("click", () => showStaffTab(true));
studentTabBtn.addEventListener("click", () => showStaffTab(false));

studentTeacher.addEventListener("change", () => {
  renderCourseOptions(studentTeacher.value);
});

studentCourse.addEventListener("change", async () => {
  try {
    setText(msg, "Loading students...");
    await loadClassStudents(studentCourse.value);
    setText(msg, "");
  } catch (err) {
    setText(msg, explainAuthError(err));
  }
});

studentNameSelect.addEventListener("change", () => {
  if (!studentNameSelect.value) return;
  studentRollSelect.value = studentNameSelect.value;
  studentPassword.value = "";
});

studentRollSelect.addEventListener("change", () => {
  if (!studentRollSelect.value) return;
  studentNameSelect.value = studentRollSelect.value;
  studentPassword.value = "";
});

staffLoginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setText(msg, "Signing in...");
  try {
    const profile = await loginStaff(qs("#staffEmail").value, qs("#staffPassword").value);
    setTeacherStatus("approved", "Approved: your account is active.");
    setTimeout(() => {
      window.location.href = profile.role === "admin" ? "./admin.html" : "./teacher.html";
    }, 500);
  } catch (err) {
    const m = String(err.message || "");
    if (m.toLowerCase().includes("pending")) {
      setTeacherStatus("pending", "Pending: your teacher request is waiting for admin approval.");
    } else if (m.toLowerCase().includes("rejected")) {
      setTeacherStatus("rejected", "Rejected: your teacher request was not approved.");
    }
    setText(msg, explainAuthError(err));
  }
});

studentLoginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setText(msg, "Signing in...");
  try {
    const selectedId = studentNameSelect.value || studentRollSelect.value;
    const selected = studentPicker.selectedStudents.find((s) => s.studentId === selectedId);
    if (!studentTeacher.value) throw new Error("Select teacher.");
    if (!studentCourse.value) throw new Error("Select class.");
    if (!selected) throw new Error("Select student name and roll number.");
    await loginStudentByRollName(selected.rollNo, selected.studentName, studentPassword.value);
    window.location.href = "./student.html";
  } catch (err) {
    setText(msg, explainAuthError(err));
  }
});

teacherRequestForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setText(msg, "Creating teacher request...");
  try {
    await createTeacherRequest(
      qs("#teacherReqName").value,
      qs("#teacherReqEmail").value,
      qs("#teacherReqPassword").value
    );
    e.target.reset();
    setTeacherStatus("pending", "Pending: teacher request submitted. Wait for admin approval.");
    setText(msg, "Request submitted. Wait for admin approval.");
  } catch (err) {
    setText(msg, explainAuthError(err));
  }
});

initStudentLoginPicker().catch((err) => {
  setText(msg, explainAuthError(err));
});
