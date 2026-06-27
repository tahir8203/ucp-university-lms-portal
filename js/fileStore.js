import {
  db,
  serverTimestamp,
  doc,
  setDoc,
  getDoc,
  collection,
  getDocs,
  query,
  orderBy,
  writeBatch,
} from "./firebase.js";

const CHUNK_SIZE = 700000;

function toDocSafeId(input) {
  return String(input || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_");
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(fr.error || new Error("Failed to read file"));
    fr.readAsDataURL(file);
  });
}

export function fileHref(file) {
  if (file?.url) return file.url;
  if (file?.fileId) {
    return `./file.html?id=${encodeURIComponent(file.fileId)}&name=${encodeURIComponent(file.name || "download")}`;
  }
  return "#";
}

export async function uploadFileToFirestore(file, context = {}) {
  const dataUrl = await readFileAsDataUrl(file);
  const chunks = [];
  for (let i = 0; i < dataUrl.length; i += CHUNK_SIZE) {
    chunks.push(dataUrl.slice(i, i + CHUNK_SIZE));
  }
  const fileId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const metaRef = doc(db, "filePayloads", toDocSafeId(fileId));
  await setDoc(metaRef, {
    fileId,
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    chunkCount: chunks.length,
    context,
    createdAt: serverTimestamp(),
  });

  let start = 0;
  while (start < chunks.length) {
    const batch = writeBatch(db);
    const end = Math.min(start + 400, chunks.length);
    for (let i = start; i < end; i += 1) {
      const chunkRef = doc(db, "filePayloads", toDocSafeId(fileId), "chunks", String(i).padStart(4, "0"));
      batch.set(chunkRef, {
        idx: i,
        data: chunks[i],
      });
    }
    await batch.commit();
    start = end;
  }

  return {
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    fileId: toDocSafeId(fileId),
    source: "firestore",
  };
}

export async function loadFilePayload(fileId) {
  const metaSnap = await getDoc(doc(db, "filePayloads", toDocSafeId(fileId)));
  if (!metaSnap.exists()) {
    throw new Error("File not found.");
  }
  const meta = metaSnap.data();
  const chunkSnap = await getDocs(
    query(collection(db, "filePayloads", toDocSafeId(fileId), "chunks"), orderBy("idx"))
  );
  const dataUrl = chunkSnap.docs.map((d) => d.data().data || "").join("");
  if (!dataUrl) {
    throw new Error("File chunks missing.");
  }
  return { meta, dataUrl };
}
