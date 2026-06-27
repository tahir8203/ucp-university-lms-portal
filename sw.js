const CACHE_NAME = "university-lms-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./admin.html",
  "./teacher.html",
  "./student.html",
  "./certificate.html",
  "./file.html",
  "./css/styles.css",
  "./js/firebase.js",
  "./js/auth.js",
  "./js/constants.js",
  "./js/utils.js",
  "./js/index.js",
  "./js/admin.js",
  "./js/teacher.js",
  "./js/student.js",
  "./js/certificate.js",
  "./js/fileStore.js",
  "./js/file-viewer.js",
  "./js/pwa.js",
  "./assets/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
  );
});
