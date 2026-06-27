import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import {
  getFirestore,
  serverTimestamp,
  collection,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  doc,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  writeBatch,
  runTransaction,
  increment,
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyD5OUeGjmqJGOv-xW65aPM4YcFDTWgFxcQ",
  authDomain: "quiz-lms-d8f96.firebaseapp.com",
  projectId: "quiz-lms-d8f96",
  storageBucket: "quiz-lms-d8f96.firebasestorage.app",
  messagingSenderId: "821083018581",
  appId: "1:821083018581:web:3fef68439ab5d5805d8bdc",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

export {
  app,
  auth,
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
  doc,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  writeBatch,
  runTransaction,
  increment,
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
};
