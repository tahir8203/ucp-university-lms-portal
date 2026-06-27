import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  createUserWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import { auth, db, doc, getDoc, collection, getDocs, query, where, setDoc, updateDoc, serverTimestamp } from "./firebase.js";
import { studentKey } from "./utils.js";

const STUDENT_SESSION_KEY = "lms_student_session";
const PW_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#$%";
const encoder = new TextEncoder();

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomString(length = 16) {
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((v) => PW_CHARS[v % PW_CHARS.length]).join("");
}

async function digestHex(text) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return bytesToHex(new Uint8Array(hash));
}

async function passwordHashWithSalt(password, salt) {
  return digestHex(`${salt}::${String(password || "")}`);
}

export function generateStudentPassword(length = 10) {
  return randomString(Math.max(8, Number(length) || 10));
}

export async function createStudentPasswordPayload(password) {
  const cleanPassword = String(password || "").trim();
  if (cleanPassword.length < 6) throw new Error("Password must be at least 6 characters.");
  const salt = randomString(20);
  const passwordHash = await passwordHashWithSalt(cleanPassword, salt);
  return {
    passwordSalt: salt,
    passwordHash,
    passwordPlain: cleanPassword,
  };
}

export async function setStudentPasswordRecord(studentId, {
  rollNo,
  studentName,
  password,
  mustChangePassword = true,
  changedByRole = "teacher",
  changedById = "",
}) {
  const payload = await createStudentPasswordPayload(password);
  await setDoc(doc(db, "studentAuth", studentId), {
    studentId,
    rollNo: (rollNo || "").trim(),
    studentName: (studentName || "").trim(),
    nameLower: (studentName || "").trim().toLowerCase(),
    ...payload,
    mustChangePassword: !!mustChangePassword,
    lastChangedByRole: changedByRole,
    lastChangedById: changedById || "",
    passwordChangedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
  }, { merge: true });
}

export async function verifyStudentPassword(password, authDoc) {
  if (!authDoc?.passwordSalt || !authDoc?.passwordHash) return false;
  const digest = await passwordHashWithSalt(password, authDoc.passwordSalt);
  return digest === authDoc.passwordHash;
}

export async function loginStaff(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  const profileSnap = await getDoc(doc(db, "users", cred.user.uid));
  if (!profileSnap.exists()) {
    await signOut(auth);
    throw new Error(`Role profile not found. Create Firestore document users/${cred.user.uid} with role admin or teacher.`);
  }
  const profile = profileSnap.data();
  if (!["admin", "teacher"].includes(profile.role)) {
    await signOut(auth);
    if (profile.role === "pending_teacher") {
      throw new Error("Your teacher account is pending admin approval.");
    }
    if (profile.role === "rejected_teacher") {
      throw new Error("Your teacher request was rejected by admin.");
    }
    throw new Error("Only approved admin/teacher accounts can login.");
  }
  return { uid: cred.user.uid, ...profile };
}

export function getCurrentStaff() {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) return resolve(null);
      const profileSnap = await getDoc(doc(db, "users", user.uid));
      if (!profileSnap.exists()) return resolve(null);
      resolve({ uid: user.uid, ...profileSnap.data() });
    });
  });
}

export async function requireStaffRole(roles) {
  const me = await getCurrentStaff();
  if (!me || !roles.includes(me.role)) {
    window.location.href = "./index.html";
    throw new Error("Not authorized.");
  }
  return me;
}

export async function logoutStaff() {
  await signOut(auth);
}

export async function loginStudentByRollName(rollNo, name, password) {
  const roll = (rollNo || "").trim();
  const cleanName = (name || "").trim();
  const cleanPassword = String(password || "").trim();
  if (!cleanPassword) throw new Error("Password is required.");
  const studentQ = query(
    collection(db, "students"),
    where("rollNo", "==", roll),
    where("nameLower", "==", cleanName.toLowerCase())
  );
  const snap = await getDocs(studentQ);
  if (snap.empty) throw new Error("Student not found. Ask teacher to enroll you.");
  const studentDoc = snap.docs[0];
  const authDocRef = doc(db, "studentAuth", studentDoc.id);
  const authSnap = await getDoc(authDocRef);
  if (!authSnap.exists()) {
    throw new Error("Password profile not found. Ask teacher/admin to reset your account.");
  }
  const authData = authSnap.data();
  const ok = await verifyStudentPassword(cleanPassword, authData);
  if (!ok) throw new Error("Invalid student password.");
  const session = {
    id: studentDoc.id,
    rollNo: studentDoc.data().rollNo,
    name: studentDoc.data().name,
    key: studentKey(studentDoc.data().rollNo, studentDoc.data().name),
    mustChangePassword: !!authData.mustChangePassword,
    loggedAt: Date.now(),
  };
  setStudentSession(session);
  return session;
}

export async function changeStudentPassword(studentId, currentPassword, nextPassword) {
  const authRef = doc(db, "studentAuth", studentId);
  const authSnap = await getDoc(authRef);
  if (!authSnap.exists()) throw new Error("Account password record not found.");
  const authData = authSnap.data();
  const valid = await verifyStudentPassword(currentPassword, authData);
  if (!valid) throw new Error("Current password is incorrect.");
  const payload = await createStudentPasswordPayload(nextPassword);
  await updateDoc(authRef, {
    ...payload,
    mustChangePassword: false,
    lastChangedByRole: "student",
    lastChangedById: studentId,
    passwordChangedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  const currentSession = getStudentSession();
  if (currentSession?.id === studentId) {
    setStudentSession({ ...currentSession, mustChangePassword: false });
  }
}

export async function createTeacherRequest(name, email, password) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await setDoc(doc(db, "users", cred.user.uid), {
    role: "pending_teacher",
    name: (name || "").trim(),
    email: (email || "").trim(),
    approved: false,
    createdAt: serverTimestamp(),
  });
  await signOut(auth);
}

export function explainAuthError(err) {
  const code = String(err?.code || "");
  if (code === "auth/invalid-credential") {
    return "Invalid email/password or account does not exist. Create the user in Firebase Authentication first.";
  }
  if (code === "auth/invalid-email") {
    return "Email format is invalid.";
  }
  if (code === "auth/user-disabled") {
    return "This account is disabled in Firebase Authentication.";
  }
  if (code === "auth/too-many-requests") {
    return "Too many failed attempts. Please wait and try again.";
  }
  if (code === "auth/network-request-failed") {
    return "Network error. Check internet connection and try again.";
  }
  if (code === "auth/operation-not-allowed") {
    return "Email/Password login is disabled in Firebase Authentication settings.";
  }
  if (code === "auth/unauthorized-domain") {
    return "Current domain is not authorized in Firebase Authentication.";
  }
  if (code === "permission-denied" || code === "auth/insufficient-permission") {
    return "Firestore rules blocked this operation. Re-publish firestore.rules.";
  }
  return err?.message || "Authentication failed.";
}

export function getStudentSession() {
  try {
    const raw = sessionStorage.getItem(STUDENT_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setStudentSession(value) {
  sessionStorage.setItem(STUDENT_SESSION_KEY, JSON.stringify(value));
}

export function requireStudentSession() {
  const s = getStudentSession();
  if (!s) {
    window.location.href = "./index.html";
    throw new Error("Student session missing");
  }
  return s;
}

export function logoutStudent() {
  sessionStorage.removeItem(STUDENT_SESSION_KEY);
}
