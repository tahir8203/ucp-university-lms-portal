import { qs } from "./utils.js";
import { loadFilePayload } from "./fileStore.js";

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const fileId = params.get("id");
  const requestedName = params.get("name");
  if (!fileId) throw new Error("Missing file id.");

  const { meta, dataUrl } = await loadFilePayload(fileId);
  const name = requestedName || meta.name || "download.bin";
  qs("#fileMsg").textContent = `Ready: ${name} (${Math.round((meta.size || 0) / 1024)} KB)`;
  const btn = qs("#downloadBtn");
  btn.classList.remove("hidden");
  btn.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = name;
    a.click();
  });
}

boot().catch((err) => {
  qs("#fileMsg").textContent = err.message;
});
