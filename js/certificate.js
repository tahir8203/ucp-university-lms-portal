import { db, doc, getDoc } from "./firebase.js";
import { qs, fmtDate } from "./utils.js";

async function loadCertificate() {
  const params = new URLSearchParams(window.location.search);
  const certId = params.get("certId");
  if (!certId) throw new Error("Missing certId");
  const snap = await getDoc(doc(db, "certificates", certId));
  if (!snap.exists()) throw new Error("Certificate not found");
  const c = snap.data();
  qs("#certStudent").textContent = `${c.studentName} (${c.studentRollNo})`;
  qs("#certClass").textContent = c.className || c.classId;
  qs("#certDate").textContent = fmtDate(c.issuedAt);
  qs("#certCode").textContent = `Certificate ID: ${certId}`;
}

loadCertificate().catch((err) => {
  qs("#certificateView").innerHTML = `<p>${err.message}</p>`;
});
