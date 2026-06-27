import { requireStudentSession, logoutStudent, changeStudentPassword } from "./auth.js";
import { EVALUATION_SECTIONS, BADGE_RULES, POINTS } from "./constants.js";
import { qs, qsa, fmtDate, escapeHtml } from "./utils.js";
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
  doc,
  query,
  where,
  limit,
  startAfter,
  writeBatch,
  increment,
  ref,
  uploadBytes,
  getDownloadURL,
} from "./firebase.js";
import { uploadFileToFirestore } from "./fileStore.js";

const state = {
  student: null,
  studentId: "",
  classes: [],
  enrollments: [],
  quizzes: [],
  quizAttempts: [],
  assignments: [],
  submissions: [],
  threads: [],
  lastThreadDoc: null,
  threadPage: 0,
  threadCursors: [],
};

let quizRuntime = null;
let antiCheatHandlers = null;

function promptToText(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  return div.textContent || div.innerText || "";
}

function normalizeMcqKey(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n)) return null;
  if (n >= 1 && n <= 4) return n;
  if (n >= 0 && n <= 3) return n + 1;
  return null;
}

function keyForDoc(raw) {
  return (raw || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function classOptions(withAll = false) {
  const base = withAll ? ['<option value="">All classes</option>'] : ['<option value="">Select class</option>'];
  return base.concat(state.classes.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}${c.subject ? ` - ${escapeHtml(c.subject)}` : ""}</option>`)).join("");
}

function fillSelectors() {
  qs("#lectureClassFilter").innerHTML = classOptions(true);
  qs("#quizClassFilter").innerHTML = classOptions(true);
  qs("#assignmentClassFilter").innerHTML = classOptions(true);
  qs("#threadClassId").innerHTML = classOptions(false);
  qs("#certificateClassId").innerHTML = classOptions(false);
}

function renderMyClasses() {
  qs("#myClassesList").innerHTML = state.classes
    .map((c) => `<article class="item"><h4>${escapeHtml(c.name)}</h4><p class="meta">${escapeHtml(c.subject || "No subject")} | ${escapeHtml(c.semester)}</p></article>`)
    .join("") || "<p>No enrolled classes.</p>";
}

async function loadLectures() {
  const classId = qs("#lectureClassFilter").value;
  const classes = classId ? [classId] : state.classes.map((c) => c.id);
  const rows = [];
  for (const id of classes) {
    const snap = await getDocs(query(collection(db, "lectures"), where("classId", "==", id)));
    rows.push(...snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }
  rows.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  qs("#studentLecturesList").innerHTML = rows
    .map((l) => {
      const className = state.classes.find((c) => c.id === l.classId)?.name || l.classId;
      const files = (l.files || []).map((f) => `<a href="${f.url}" target="_blank" rel="noopener">${escapeHtml(f.name)}</a>`).join(" | ");
      return `<article class="item">
        <h4>${escapeHtml(l.title)}</h4>
        <p class="meta">${escapeHtml(className)} | ${escapeHtml(l.date)}</p>
        <p>${files || "No files"}</p>
        <p>${l.videoLink ? `<a href="${l.videoLink}" target="_blank" rel="noopener">Video Link</a>` : "No video link"}</p>
      </article>`;
    })
    .join("") || "<p>No lectures available.</p>";
}

function renderResultView(quiz, attempt) {
  if (!attempt) return "<p class='meta'>No attempt data found.</p>";
  const detail = quiz.questions.map((q, i) => {
    const chosen = attempt.answers[i];
    if (q.type === "theory") {
      const awarded = attempt.theoryMarks && attempt.theoryMarks[i] != null
        ? `Marks: ${Number(attempt.theoryMarks[i])}/${Number(q.maxMarks || 5)}`
        : `Marks pending (${Number(q.maxMarks || 5)} max)`;
      return `<div class="item">
        <strong>Q${i + 1}: ${escapeHtml(promptToText(q.promptHtml || q.text || ""))}</strong>
        <p>Your response: ${escapeHtml(String(chosen || "Not answered"))}</p>
        <p class="meta">Theory response submitted (manual review only). ${awarded}</p>
      </div>`;
    }
    const chosenKey = normalizeMcqKey(chosen);
    const correctKey = normalizeMcqKey(q.correctIndex);
    const chosenIdx = chosenKey != null ? chosenKey - 1 : -1;
    const correctIdx = correctKey != null ? correctKey - 1 : -1;
    const ok = chosenKey != null && correctKey != null && chosenKey === correctKey;
    return `<div class="item">
      <strong>Q${i + 1}: ${escapeHtml(promptToText(q.promptHtml || q.text || ""))}</strong>
      <p class="${ok ? "ok" : "bad"}">Your answer: ${escapeHtml(q.options[chosenIdx] || "Not answered")} | Correct: ${escapeHtml(q.options[correctIdx] || "-")} | Marks: ${ok ? 1 : 0}/1</p>
    </div>`;
  }).join("");
  const mcqScore = Number(attempt.mcqScore ?? attempt.score ?? 0);
  const theoryScore = Number(attempt.theoryScore || 0);
  const finalScore = Number(attempt.finalScore ?? (mcqScore + theoryScore));
  const totalPossible = Number(attempt.totalPossible || attempt.totalGradable || 0);
  return `<div class="item">
    <h4>Result: ${finalScore}/${totalPossible} ${attempt.theoryPending ? "(Theory marks pending)" : ""}</h4>
    <p class="meta">MCQ auto: ${mcqScore} | Theory: ${theoryScore}</p>
    ${detail}
  </div>`;
}

function renderQuizzesList() {
  const classId = qs("#quizClassFilter").value;
  const rows = state.quizzes.filter((q) => (!classId || q.classId === classId) && q.status === "published");
  qs("#studentQuizzesList").innerHTML = rows.map((q) => {
    const attempts = state.quizAttempts.filter((a) => a.quizId === q.id);
    const attempt = attempts.sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0))[0];
    const attemptsUsed = attempts.filter((a) => !a.unlockedAt).length;
    const limitCount = Number(q.attemptLimit || 1);
    
    // Check if the latest attempt is locked
    const isLockedByTeacher = attempt?.locked === true;
    const canAttempt = q.acceptingAttempts && attemptsUsed < limitCount && !isLockedByTeacher;
    
    const className = state.classes.find((c) => c.id === q.classId)?.name || q.classId;
    const lockStatus = isLockedByTeacher ? ` | 🔒 Locked by teacher (contact instructor to unlock)` : "";
    
    return `<article class="item">
      <h4>${escapeHtml(q.title)} (Quiz ${q.quizNumber})</h4>
      <p class="meta">${escapeHtml(className)} | Duration: ${q.durationMin} mins | Attempts: ${attemptsUsed}/${limitCount} | ${q.acceptingAttempts ? "Open" : "Stopped by teacher"}${lockStatus} | Anti-cheat: ${q.antiCheatEnabled ? "On" : "Off"}</p>
      <div class="inline-actions">
        ${canAttempt ? `<button data-start-quiz="${q.id}" type="button">Attempt Quiz</button>` : `<button type="button" disabled>${isLockedByTeacher ? "Locked - Contact Teacher" : "Attempt Locked"}</button>`}
        ${attempt ? `<button data-view-result="${q.id}" type="button">View Latest Result</button>` : ""}
      </div>
      <div id="result_${q.id}"></div>
    </article>`;
  }).join("") || "<p>No published quizzes.</p>";

  qsa("[data-start-quiz]").forEach((btn) => btn.addEventListener("click", () => startQuiz(btn.dataset.startQuiz)));
  qsa("[data-view-result]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const quiz = state.quizzes.find((q) => q.id === btn.dataset.viewResult);
      const attempt = state.quizAttempts
        .filter((a) => a.quizId === quiz.id)
        .sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0))[0];
      qs(`#result_${quiz.id}`).innerHTML = renderResultView(quiz, attempt);
    });
  });
}

function clearQuizRuntime() {
  if (quizRuntime?.timer) clearInterval(quizRuntime.timer);
  detachAntiCheat();
  quizRuntime = null;
}

function getQuestionTimerSeconds(question) {
  return Math.max(0, Number(question?.questionTimeSec || 0));
}

function attachAntiCheat() {
  if (!quizRuntime?.quiz?.antiCheatEnabled) return;
  const reportViolation = (reason) => {
    if (!quizRuntime) return;
    quizRuntime.violations = Number(quizRuntime.violations || 0) + 1;
    qs("#quizAntiCheatMsg").textContent = `Anti-cheat warning ${quizRuntime.violations}/3: ${reason} Switching/turning off screen can stop your quiz.`;
    if (quizRuntime.violations >= 3) {
      qs("#quizAntiCheatMsg").textContent = "Quiz stopped and auto-submitted: repeated screen/tab switching detected.";
      submitQuiz({ skipConfirm: true, reason: "anti_cheat" });
    }
  };
  antiCheatHandlers = {
    visibility: () => {
      if (document.visibilityState !== "visible") reportViolation("Screen turned off or tab switched.");
    },
    blur: () => reportViolation("Window focus lost (possible app switch)."),
    copy: (e) => {
      e.preventDefault();
      reportViolation("Copy is not allowed during quiz.");
    },
    paste: (e) => {
      e.preventDefault();
      reportViolation("Paste is not allowed during quiz.");
    },
    contextmenu: (e) => {
      e.preventDefault();
      reportViolation("Right click is blocked during quiz.");
    },
  };
  document.addEventListener("visibilitychange", antiCheatHandlers.visibility);
  window.addEventListener("blur", antiCheatHandlers.blur);
  document.addEventListener("copy", antiCheatHandlers.copy);
  document.addEventListener("paste", antiCheatHandlers.paste);
  document.addEventListener("contextmenu", antiCheatHandlers.contextmenu);
}

function detachAntiCheat() {
  if (!antiCheatHandlers) return;
  document.removeEventListener("visibilitychange", antiCheatHandlers.visibility);
  window.removeEventListener("blur", antiCheatHandlers.blur);
  document.removeEventListener("copy", antiCheatHandlers.copy);
  document.removeEventListener("paste", antiCheatHandlers.paste);
  document.removeEventListener("contextmenu", antiCheatHandlers.contextmenu);
  antiCheatHandlers = null;
}

function startQuiz(quizId) {
  const quiz = state.quizzes.find((q) => q.id === quizId);
  if (!quiz) return;
  const quizAttempts = state.quizAttempts.filter((a) => a.quizId === quiz.id);
  const attempts = quizAttempts.filter((a) => !a.unlockedAt).length;
  if (!quiz.acceptingAttempts) return alert("Teacher has not started this quiz yet.");
  if (attempts >= Number(quiz.attemptLimit || 1)) return alert("Attempt limit reached.");
  const totalSeconds = Number(quiz.durationMin || 1) * 60;
  quizRuntime = {
    quiz,
    idx: 0,
    answers: Array(quiz.questions.length).fill(null),
    lockedMcq: Array(quiz.questions.length).fill(false),
    attemptNo: attempts + 1,
    questionSecondsLeft: quiz.questions.map((q) => getQuestionTimerSeconds(q)),
    violations: 0,
    secondsLeft: totalSeconds,
    timer: null,
  };
  renderQuizAttemptArea();
  attachAntiCheat();
  quizRuntime.timer = setInterval(() => {
    quizRuntime.secondsLeft -= 1;
    if (quizRuntime.questionSecondsLeft[quizRuntime.idx] > 0) {
      quizRuntime.questionSecondsLeft[quizRuntime.idx] -= 1;
    }
    if (quizRuntime.secondsLeft <= 0) {
      submitQuiz({ skipConfirm: true, reason: "timer" });
      return;
    }
    if (quizRuntime.questionSecondsLeft[quizRuntime.idx] === 0 && getQuestionTimerSeconds(quizRuntime.quiz.questions[quizRuntime.idx]) > 0) {
      if (quizRuntime.idx < quizRuntime.quiz.questions.length - 1) {
        quizRuntime.idx += 1;
        renderQuizAttemptArea();
      } else {
        submitQuiz({ skipConfirm: true, reason: "question_timer" });
      }
    } else {
      qs("#quizTimeLeft").textContent = String(quizRuntime.secondsLeft);
      const qTimer = qs("#questionTimeLeft");
      if (qTimer) qTimer.textContent = String(quizRuntime.questionSecondsLeft[quizRuntime.idx]);
    }
  }, 1000);
}

function renderQuizAttemptArea() {
  if (!quizRuntime) {
    qs("#quizAttemptArea").innerHTML = "";
    return;
  }
  const q = quizRuntime.quiz.questions[quizRuntime.idx];
  const prompt = q.promptHtml || q.text || "";
  const options = q.type === "theory"
    ? `<textarea id="theoryAnswer" rows="5" placeholder="Write your answer here...">${escapeHtml(String(quizRuntime.answers[quizRuntime.idx] || ""))}</textarea>`
    : q.options.map((opt, i) => {
      const key = i + 1;
      const checked = quizRuntime.answers[quizRuntime.idx] === key ? "checked" : "";
      const disabled = quizRuntime.lockedMcq[quizRuntime.idx] ? "disabled" : "";
      return `<label><input type="radio" name="qopt" value="${key}" ${checked} ${disabled}/> ${escapeHtml(opt)}</label>`;
    }).join("");
  qs("#quizAttemptArea").innerHTML = `<article class="item">
    <h4>${escapeHtml(quizRuntime.quiz.title)} | Time Left: <span id="quizTimeLeft">${quizRuntime.secondsLeft}</span>s</h4>
    <p id="quizAntiCheatMsg" class="bad"></p>
    <p class="meta">Warning: If you switch tab/app or turn off/minimize screen repeatedly, quiz can be stopped automatically.</p>
    <p>${getQuestionTimerSeconds(q) > 0 ? `Question Time Left: <span id="questionTimeLeft">${quizRuntime.questionSecondsLeft[quizRuntime.idx]}</span>s` : "No per-question timer"}</p>
    ${q.type !== "theory" && quizRuntime.lockedMcq[quizRuntime.idx] ? "<p class='meta'>Option locked for this question (one-time selection).</p>" : ""}
    <p><strong>Q${quizRuntime.idx + 1}/${quizRuntime.quiz.questions.length}:</strong></p>
    <div>${prompt}</div>
    ${q.imageDataUrl ? `<p><img src="${q.imageDataUrl}" alt="question image" style="max-width:260px;border:1px solid #d9e0e6;"></p>` : ""}
    <div class="grid">${options}</div>
    <div class="inline-actions">
      <button id="prevQBtn" type="button">Previous</button>
      <button id="nextQBtn" type="button">Next</button>
      <button id="submitQuizBtn" type="button">Submit Quiz</button>
    </div>
  </article>`;
  if (q.type === "theory") {
    qs("#theoryAnswer")?.addEventListener("input", (e) => {
      quizRuntime.answers[quizRuntime.idx] = e.target.value;
    });
  } else {
    qsa('input[name="qopt"]').forEach((r) => r.addEventListener("change", (e) => {
      if (quizRuntime.lockedMcq[quizRuntime.idx]) return;
      quizRuntime.answers[quizRuntime.idx] = normalizeMcqKey(e.target.value);
      quizRuntime.lockedMcq[quizRuntime.idx] = true;
      renderQuizAttemptArea();
    }));
  }
  qs("#prevQBtn").addEventListener("click", () => {
    if (quizRuntime.idx > 0) quizRuntime.idx -= 1;
    renderQuizAttemptArea();
  });
  qs("#nextQBtn").addEventListener("click", () => {
    if (quizRuntime.idx < quizRuntime.quiz.questions.length - 1) quizRuntime.idx += 1;
    renderQuizAttemptArea();
  });
  qs("#submitQuizBtn").addEventListener("click", submitQuiz);
}

async function updateProgress(classId, delta) {
  const progressId = `${classId}_${keyForDoc(state.student.key)}`;
  const progressRef = doc(db, "studentProgress", progressId);
  const snap = await getDoc(progressRef);
  const base = snap.exists() ? snap.data() : { points: 0, quizCount: 0, assignmentCount: 0, badges: [] };
  const next = {
    classId,
    studentKey: state.student.key,
    studentName: state.student.name,
    points: Number(base.points || 0) + Number(delta.points || 0),
    quizCount: Number(base.quizCount || 0) + Number(delta.quizCount || 0),
    assignmentCount: Number(base.assignmentCount || 0) + Number(delta.assignmentCount || 0),
    badges: [],
    updatedAt: serverTimestamp(),
  };
  next.badges = BADGE_RULES.filter((r) => r.when(next)).map((r) => r.title);
  return { progressRef, next };
}

async function submitQuiz({ skipConfirm = false } = {}) {
  if (!quizRuntime || quizRuntime.submitting) return;
  const runtime = quizRuntime;
  if (!skipConfirm) {
    const ok = confirm("Are you sure you want to submit this quiz now? You cannot edit answers after submission.");
    if (!ok) return;
  }
  runtime.submitting = true;
  const quiz = runtime.quiz;
  const answers = [...runtime.answers];
  try {
    let score = 0;
    const questionResults = quiz.questions.map((q, i) => {
      if (q.type === "theory") return { correct: 0, total: 0, theory: true };
      const chosenKey = normalizeMcqKey(answers[i]);
      const correctKey = normalizeMcqKey(q.correctIndex);
      const ok = chosenKey != null && correctKey != null && chosenKey === correctKey;
      if (ok) score += 1;
      return { correct: ok ? 1 : 0, total: 1, theory: false };
    });
    const totalGradable = questionResults.filter((r) => !r.theory).length;
    const totalTheoryPossible = quiz.questions
      .filter((q) => q.type === "theory")
      .reduce((sum, q) => sum + Number(q.maxMarks || 5), 0);
    const totalPossible = totalGradable + totalTheoryPossible;
    const mcqScore = score;

    const attemptRef = doc(collection(db, "quizAttempts"));
    const analyticsRef = doc(db, "quizAnalytics", quiz.id);

    const progress = await updateProgress(quiz.classId, { points: POINTS.QUIZ_SUBMISSION, quizCount: 1 });
    const batch = writeBatch(db);
    
    // If anti-cheat is enabled, lock the quiz for this student if violations detected
    const antiCheatTriggered = Number(runtime.violations || 0) > 0;
    const shouldLock = quiz.antiCheatEnabled && antiCheatTriggered;
    
    batch.set(attemptRef, {
      quizId: quiz.id,
      classId: quiz.classId,
      teacherId: quiz.teacherId,
      attemptNo: runtime.attemptNo,
      studentKey: state.student.key,
      studentName: state.student.name,
      studentRollNo: state.student.rollNo,
      answers,
      score: mcqScore,
      mcqScore,
      theoryScore: 0,
      finalScore: mcqScore,
      theoryPending: totalTheoryPossible > 0,
      totalGradable,
      totalTheoryPossible,
      totalPossible,
      submittedAt: serverTimestamp(),
      antiCheatEnabled: quiz.antiCheatEnabled,
      antiCheatTriggered,
      locked: shouldLock,
      antiCheatViolationCount: runtime.violations || 0,
      focusLossCount: runtime.violations || 0,
    });
    batch.set(progress.progressRef, progress.next, { merge: true });
    await batch.commit();

    try {
      await setDoc(analyticsRef, {
        quizId: quiz.id,
        classId: quiz.classId,
        teacherId: quiz.teacherId,
        attempts: increment(1),
        totalScore: increment(score),
        totalGradable,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    } catch (err) {
      console.warn("Quiz analytics update failed:", err);
    }

    clearQuizRuntime();
    state.quizAttempts = [...state.quizAttempts, {
      id: attemptRef.id,
      quizId: quiz.id,
      answers,
      score: mcqScore,
      mcqScore,
      theoryScore: 0,
      finalScore: mcqScore,
      theoryPending: totalTheoryPossible > 0,
      totalGradable,
      totalTheoryPossible,
      totalPossible,
      attemptNo: runtime.attemptNo,
      submittedAt: { seconds: Math.floor(Date.now() / 1000) },
      antiCheatEnabled: quiz.antiCheatEnabled,
      antiCheatTriggered,
      locked: shouldLock,
    }];
    renderQuizzesList();
    qs("#quizAttemptArea").innerHTML = "<p class='ok'>Quiz submitted successfully.</p>";
    await loadGamification();
  } catch (err) {
    runtime.submitting = false;
    alert(err?.message || "Could not submit quiz.");
    renderQuizAttemptArea();
  }
}

async function loadQuizzesAndAttempts() {
  const classes = state.classes.map((c) => c.id);
  const quizzes = [];
  const attempts = [];
  for (const classId of classes) {
    const qSnap = await getDocs(query(collection(db, "quizzes"), where("classId", "==", classId)));
    quizzes.push(...qSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
    const aSnap = await getDocs(query(collection(db, "quizAttempts"), where("classId", "==", classId), where("studentKey", "==", state.student.key)));
    attempts.push(...aSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }
  state.quizzes = quizzes.filter((q) => q.status !== "archived");
  state.quizAttempts = attempts;
  renderQuizzesList();
}

async function loadAssignments() {
  const classes = state.classes.map((c) => c.id);
  const assignments = [];
  const submissions = [];
  for (const classId of classes) {
    const aSnap = await getDocs(query(collection(db, "assignments"), where("classId", "==", classId)));
    assignments.push(...aSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
    const sSnap = await getDocs(query(collection(db, "assignmentSubmissions"), where("classId", "==", classId), where("studentKey", "==", state.student.key)));
    submissions.push(...sSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }
  state.assignments = assignments.sort((a, b) => (a.assignmentNumber || 0) - (b.assignmentNumber || 0));
  state.submissions = submissions;
  renderAssignments();
}

function renderAssignments() {
  const classId = qs("#assignmentClassFilter").value;
  const rows = state.assignments.filter((a) => !classId || a.classId === classId);
  qs("#studentAssignmentsList").innerHTML = rows.map((a) => {
    const subId = `${a.id}_${keyForDoc(state.student.key)}`;
    const submitted = state.submissions.find((s) => s.id === subId);
    const className = state.classes.find((c) => c.id === a.classId)?.name || a.classId;
    return `<article class="item">
      <h4>${escapeHtml(a.title)} (A${a.assignmentNumber})</h4>
      <p class="meta">${escapeHtml(className)} | Deadline: ${fmtDate(a.deadline)}</p>
      ${submitted ? `<p class="ok">Submitted (${fmtDate(submitted.submittedAt)}) | Grade: ${submitted.grade ?? "-"}</p>` : `
        <input data-ass-file="${a.id}" type="file" />
        <button data-ass-submit="${a.id}" type="button">Upload Assignment</button>
      `}
    </article>`;
  }).join("") || "<p>No assignments available.</p>";

  qsa("[data-ass-submit]").forEach((btn) => btn.addEventListener("click", async () => {
    const assignmentId = btn.dataset.assSubmit;
    const assignment = state.assignments.find((a) => a.id === assignmentId);
    const fileInput = qs(`[data-ass-file="${assignmentId}"]`);
    const file = fileInput?.files?.[0];
    if (!assignment) return alert("Assignment not found.");
    if (!file) return alert("Choose a file first.");
    if (file.size > 10 * 1024 * 1024) return alert("Max file size is 10MB.");
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Uploading...";
    try {
      const withTimeout = async (promise, ms, label) => {
        let timer = null;
        try {
          return await Promise.race([
            promise,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      let fileUrl = null;
      let filePath = null;
      let fileId = null;
      try {
        btn.textContent = "Uploading to storage...";
        const storageRef = ref(storage, `assignments/${assignmentId}/${Date.now()}_${file.name}`);
        await withTimeout(uploadBytes(storageRef, file), 15000, "Storage upload");
        fileUrl = await withTimeout(getDownloadURL(storageRef), 10000, "Get download URL");
        filePath = storageRef.fullPath;
      } catch {
        btn.textContent = "Storage failed, using fallback...";
        const firestoreFile = await uploadFileToFirestore(file, {
          module: "assignment",
          assignmentId,
          classId: assignment.classId,
          studentKey: state.student.key,
        });
        fileId = firestoreFile.fileId;
      }

      if (!fileUrl && !fileId) {
        throw new Error("Could not upload file to storage or fallback.");
      }

      btn.textContent = "Saving submission...";
      const subId = `${assignmentId}_${keyForDoc(state.student.key)}`;
      await setDoc(doc(db, "assignmentSubmissions", subId), {
        assignmentId,
        classId: assignment.classId,
        teacherId: assignment.teacherId,
        studentKey: state.student.key,
        studentName: state.student.name,
        studentRollNo: state.student.rollNo,
        fileName: file.name,
        fileUrl,
        filePath,
        fileId,
        status: "submitted",
        submittedAt: serverTimestamp(),
      });
      const progress = await updateProgress(assignment.classId, { points: POINTS.ASSIGNMENT_SUBMISSION, assignmentCount: 1 });
      await setDoc(progress.progressRef, progress.next, { merge: true });
      btn.textContent = "Done";
      await loadAssignments();
      await loadGamification();
    } catch (err) {
      alert(`Assignment upload failed: ${err.message || "Unknown error"}`);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }));
}

async function postThread(e) {
  e.preventDefault();
  const classId = qs("#threadClassId").value;
  await addDoc(collection(db, "discussionThreads"), {
    classId,
    title: qs("#threadTitle").value.trim(),
    body: qs("#threadBody").value.trim(),
    createdByRole: "student",
    createdByName: state.student.name,
    studentKey: state.student.key,
    isAnnouncement: false,
    createdAt: serverTimestamp(),
  });
  e.target.reset();
  state.threadPage = 0;
  state.threadCursors = [];
  await loadThreads();
}

async function loadThreads(direction = "first") {
  const classId = qs("#threadClassId").value;
  if (!classId) return;
  let q = query(
    collection(db, "discussionThreads"),
    where("classId", "==", classId),
    limit(20)
  );
  if (direction === "next" && state.lastThreadDoc) {
    q = query(
      collection(db, "discussionThreads"),
      where("classId", "==", classId),
      startAfter(state.lastThreadDoc),
      limit(20)
    );
  }
  if (direction === "prev" && state.threadPage > 0) {
    state.threadPage -= 1;
    const cursor = state.threadCursors[state.threadPage - 1];
    q = cursor
      ? query(collection(db, "discussionThreads"), where("classId", "==", classId), startAfter(cursor), limit(20))
      : query(collection(db, "discussionThreads"), where("classId", "==", classId), limit(20));
  }

  const snap = await getDocs(q);
  if (direction === "next" && !snap.empty) {
    state.threadPage += 1;
    state.threadCursors[state.threadPage - 1] = state.lastThreadDoc;
  }
  state.threads = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  state.lastThreadDoc = snap.docs[snap.docs.length - 1] || null;
  renderThreads();
}

async function renderThreads() {
  const repliesSnap = await getDocs(query(collection(db, "discussionReplies"), where("classId", "==", qs("#threadClassId").value)));
  const replies = repliesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  qs("#threadsList").innerHTML = state.threads.map((t) => {
    const threadReplies = replies.filter((r) => r.threadId === t.id);
    const replyHtml = threadReplies.map((r) => `<p class="meta">${escapeHtml(r.createdByName)}: ${escapeHtml(r.body)}</p>`).join("");
    return `<article class="item">
      <h4>${t.isAnnouncement ? "[Announcement] " : ""}${escapeHtml(t.title)}</h4>
      <p>${escapeHtml(t.body)}</p>
      <p class="meta">${escapeHtml(t.createdByName)} | ${fmtDate(t.createdAt)}</p>
      <div>${replyHtml || "<p class='meta'>No replies</p>"}</div>
      <input data-reply-input="${t.id}" placeholder="Write a reply" />
      <button data-reply-btn="${t.id}" type="button">Reply</button>
    </article>`;
  }).join("") || "<p>No threads found.</p>";

  qsa("[data-reply-btn]").forEach((btn) => btn.addEventListener("click", async () => {
    const threadId = btn.dataset.replyBtn;
    const body = qs(`[data-reply-input="${threadId}"]`)?.value?.trim();
    if (!body) return;
    await addDoc(collection(db, "discussionReplies"), {
      threadId,
      classId: qs("#threadClassId").value,
      body,
      createdByRole: "student",
      createdByName: state.student.name,
      studentKey: state.student.key,
      createdAt: serverTimestamp(),
    });
    await loadThreads();
  }));
}

function buildEvaluationForm() {
  const cls = `<label class="eval-control">Class<select id="evalClassId" required>${classOptions(false)}</select></label>`;
  const identityChoice = `<label class="eval-anon"><input id="evalRevealIdentity" type="checkbox" /> Show my identity to teacher</label>`;
  const wantedOrder = ["professional", "availability", "evaluation", "general"];
  const orderedSections = wantedOrder
    .map((k) => EVALUATION_SECTIONS.find((sec) => sec.key === k))
    .filter(Boolean);
  const questionBlocks = orderedSections.map((sec) => {
    const qsHtml = sec.questions.map((q, i) => {
      const key = `${sec.key}_${i}`;
      const num = i + 1;
      return `<label class="eval-row">
        <span class="eval-q-index">${num}</span>
        <span class="eval-q-text">${escapeHtml(q)}</span>
        <select data-eval-q="${key}" required>
          <option value="">Select rating</option>
          <option value="1">Poor</option>
          <option value="2">Satisfactory</option>
          <option value="3">Average</option>
          <option value="4">Good</option>
          <option value="5">Excellent</option>
        </select>
      </label>`;
    }).join("");
    return `<section class="eval-block">
      <h4>${escapeHtml(sec.title)}</h4>
      ${qsHtml}
    </section>`;
  }).join("");
  const commentBlock = `<label class="eval-comment">Final Comment (Required)
    <textarea id="evalComment" rows="4" placeholder="You may add any suggestions to improve quality of course and teacher." required></textarea>
  </label>
  <p class="meta eval-note">Evaluation is optional and separate from quiz submission.</p>`;
  qs("#evaluationForm").innerHTML = `<div class="eval-top">
    ${cls}
    ${identityChoice}
  </div>
  <div class="eval-grid eval-grid-4">${questionBlocks}</div>
  ${commentBlock}
  <button class="eval-submit-btn" type="submit">Submit Evaluation</button>`;
  qs("#evaluationForm").addEventListener("submit", submitEvaluation);
}

async function submitEvaluation(e) {
  e.preventDefault();
  try {
    const classId = qs("#evalClassId").value;
    const klass = state.classes.find((c) => c.id === classId);
    if (!klass) return;
    const questionScores = {};
    qsa("[data-eval-q]").forEach((el) => {
      questionScores[el.dataset.evalQ] = Number(el.value);
    });
    if (Object.values(questionScores).some((v) => !v)) return alert("Rate every question.");
    const comment = qs("#evalComment").value.trim();
    if (!comment) return alert("Comment is required.");
    const evalId = `${classId}_${keyForDoc(state.student.key)}`;
    const evalRef = doc(db, "evaluations", evalId);
    const auditRef = doc(db, "evaluationAudits", evalId);
    const statsRef = doc(db, "evaluationStats", classId);

    const revealIdentity = !!qs("#evalRevealIdentity")?.checked;
    const anonymous = !revealIdentity;
    const batch = writeBatch(db);
    batch.set(evalRef, {
      classId,
      teacherId: klass.teacherId,
      anonymous,
      studentKey: anonymous ? null : state.student.key,
      studentName: anonymous ? null : state.student.name,
      studentRollNo: anonymous ? null : state.student.rollNo,
      questionScores,
      comment,
      submittedAt: serverTimestamp(),
    });
    batch.set(auditRef, {
      evaluationId: evalId,
      classId,
      teacherId: klass.teacherId,
      studentKey: state.student.key,
      studentName: state.student.name,
      studentRollNo: state.student.rollNo,
      submittedAt: serverTimestamp(),
    });
    const questionTotalsUpdate = {};
    for (const [k, v] of Object.entries(questionScores)) {
      questionTotalsUpdate[k] = increment(Number(v) || 0);
    }
    const statsUpdate = {
      classId,
      teacherId: klass.teacherId,
      count: increment(1),
      questionTotals: questionTotalsUpdate,
      updatedAt: serverTimestamp(),
    };
    batch.set(statsRef, statsUpdate, { merge: true });
    await batch.commit();
    qs("#evaluationMsg").textContent = "Evaluation submitted.";
    e.target.reset();
  } catch (err) {
    if (String(err?.code || "").includes("permission-denied")) {
      qs("#evaluationMsg").textContent = "You already submitted evaluation for this class.";
      return;
    }
    qs("#evaluationMsg").textContent = err?.message || "Could not submit evaluation.";
  }
}

async function generateCertificate() {
  const classId = qs("#certificateClassId").value;
  const classInfo = state.classes.find((c) => c.id === classId);
  if (!classInfo) return;
  const publishedQuizSnap = await getDocs(query(collection(db, "quizzes"), where("classId", "==", classId), where("status", "==", "published")));
  const attemptsSnap = await getDocs(query(collection(db, "quizAttempts"), where("classId", "==", classId), where("studentKey", "==", state.student.key)));
  const assignmentSnap = await getDocs(query(collection(db, "assignments"), where("classId", "==", classId)));
  const submissionSnap = await getDocs(query(collection(db, "assignmentSubmissions"), where("classId", "==", classId), where("studentKey", "==", state.student.key)));

  const eligible = attemptsSnap.size >= publishedQuizSnap.size && submissionSnap.size >= assignmentSnap.size && (publishedQuizSnap.size + assignmentSnap.size) > 0;
  if (!eligible) {
    qs("#certificateMsg").textContent = "Not eligible yet. Complete all published quizzes and assignments.";
    return;
  }
  const certId = `${classId}_${keyForDoc(state.student.key)}`;
  await setDoc(doc(db, "certificates", certId), {
    classId,
    className: classInfo.name,
    studentKey: state.student.key,
    studentName: state.student.name,
    studentRollNo: state.student.rollNo,
    issuedAt: serverTimestamp(),
  }, { merge: true });
  qs("#certificateMsg").innerHTML = `Certificate generated. <a target="_blank" href="./certificate.html?certId=${encodeURIComponent(certId)}">Open Certificate</a>`;
}

async function loadGamification() {
  const ids = state.classes.map((c) => `${c.id}_${keyForDoc(state.student.key)}`);
  let points = 0;
  const badges = new Set();
  for (const id of ids) {
    const snap = await getDoc(doc(db, "studentProgress", id));
    if (!snap.exists()) continue;
    const p = snap.data();
    points += Number(p.points || 0);
    (p.badges || []).forEach((b) => badges.add(b));
  }
  qs("#gamificationView").innerHTML = `<p><strong>Points:</strong> ${points}</p><p><strong>Badges:</strong> ${Array.from(badges).join(", ") || "None"}</p>`;
}

function wirePasswordChange() {
  const form = qs("#studentPasswordForm");
  const msg = qs("#studentPasswordMsg");
  const note = qs("#passwordPolicyNote");
  if (!form || !msg) return;
  if (state.student.mustChangePassword && note) {
    note.innerHTML = "<strong>Action required:</strong> change your temporary password before continuing regular usage.";
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const current = qs("#currentStudentPassword").value;
    const next = qs("#newStudentPassword").value;
    const confirm = qs("#confirmStudentPassword").value;
    if (next.length < 6) {
      msg.textContent = "New password must be at least 6 characters.";
      return;
    }
    if (next !== confirm) {
      msg.textContent = "New password and confirmation do not match.";
      return;
    }
    if (next === current) {
      msg.textContent = "Use a different password than current.";
      return;
    }
    try {
      msg.textContent = "Updating password...";
      await changeStudentPassword(state.student.id, current, next);
      state.student.mustChangePassword = false;
      msg.textContent = "Password updated successfully.";
      form.reset();
    } catch (err) {
      msg.textContent = err?.message || "Could not change password.";
    }
  });
}

async function boot() {
  state.student = requireStudentSession();
  state.studentId = state.student.rollNo.trim().toLowerCase().replaceAll(" ", "_");
  qs("#whoami").textContent = `${state.student.name} (${state.student.rollNo})`;
  qs("#logoutBtn").addEventListener("click", () => {
    logoutStudent();
    window.location.href = "./index.html";
  });

  const enrollmentSnap = await getDocs(query(collection(db, "enrollments"), where("studentId", "==", state.studentId)));
  state.enrollments = enrollmentSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const allClasses = await getDocs(collection(db, "classes"));
  const allowed = new Set(state.enrollments.map((e) => e.classId));
  state.classes = allClasses.docs.map((d) => ({ id: d.id, ...d.data() })).filter((c) => allowed.has(c.id));

  fillSelectors();
  renderMyClasses();
  buildEvaluationForm();
  await loadLectures();
  await loadQuizzesAndAttempts();
  await loadAssignments();
  await loadThreads();
  await loadGamification();

  qs("#lectureClassFilter").addEventListener("change", loadLectures);
  qs("#quizClassFilter").addEventListener("change", renderQuizzesList);
  qs("#assignmentClassFilter").addEventListener("change", renderAssignments);
  qs("#threadClassId").addEventListener("change", async () => {
    state.threadPage = 0;
    state.threadCursors = [];
    state.lastThreadDoc = null;
    await loadThreads();
  });
  qs("#threadForm").addEventListener("submit", postThread);
  qs("#prevThreadsBtn").addEventListener("click", async () => loadThreads("prev"));
  qs("#nextThreadsBtn").addEventListener("click", async () => loadThreads("next"));
  qs("#announceBtn").classList.add("hidden");
  qs("#generateCertificateBtn").addEventListener("click", generateCertificate);
  wirePasswordChange();
}

boot().catch((err) => alert(err.message));
