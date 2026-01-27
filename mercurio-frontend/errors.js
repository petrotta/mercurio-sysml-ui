const eventApi = window.__TAURI__.event;

const fileEl = document.querySelector("#errors-file");
const listEl = document.querySelector("#errors-list");
const emptyEl = document.querySelector("#errors-empty");

function renderErrors(payload) {
  const { path, errors } = payload || {};
  fileEl.textContent = path || "No file";
  listEl.innerHTML = "";

  if (!errors || errors.length === 0) {
    emptyEl.style.display = "block";
    return;
  }

  emptyEl.style.display = "none";
  errors.forEach((error) => {
    const item = document.createElement("li");
    item.className = "error-item";
    item.dataset.path = path;
    item.dataset.line = error.line;
    item.dataset.column = error.column;

    const title = document.createElement("div");
    title.className = "error-title";
    title.textContent = error.message;

    const meta = document.createElement("div");
    meta.className = "error-meta";
    meta.textContent = `Line ${error.line + 1}, Col ${error.column + 1} · ${error.kind}`;

    item.appendChild(title);
    item.appendChild(meta);
    listEl.appendChild(item);
  });
}

listEl.addEventListener("click", (event) => {
  const item = event.target.closest(".error-item");
  if (!item) return;
  const payload = {
    path: item.dataset.path,
    line: Number(item.dataset.line),
    column: Number(item.dataset.column),
  };
  eventApi.emit("parse-error-select", payload);
});

eventApi.listen("parse-errors", (event) => {
  renderErrors(event?.payload);
});
