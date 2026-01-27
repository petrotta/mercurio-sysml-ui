const { invoke } = window.__TAURI__.core;
const dialog = window.__TAURI__.dialog;
const eventApi = window.__TAURI__.event;
const windowApi = window.__TAURI__.window;


let editor;
let rootApplyButton;
let newFileButton;
let recentProjectsEl;
let newFileDialogEl;
let newFileNameEl;
let newFileTypeEl;
let newFileCreateBtn;
let rootPathEl;
let compileButton;
let currentFileEl;
let fileTreeEl;
let modelTreeEl;
let compileStatusEl;
let titlebarProjectEl;
let modelTreeMenuEl;
let appEl;
let appBodyEl;
let contextMenuEl;
let windowMinimizeBtn;
let windowMaximizeBtn;
let windowCloseBtn;
let statusMessageEl;
let statusFileEl;
let statusPositionEl;
let statusUnresolvedEl;
let compileFloatEl;
let compileFloatMessageEl;
let compileFloatDetailEl;
let compileFloatCancelBtn;
let errorsFileEl;
let errorsListEl;
let errorsEmptyEl;
let errorsSectionEl;
let parseToggleEl;
let toggleProjectBtn;
let toggleModelTreeBtn;
let restoreProjectBtn;
let restoreModelTreeBtn;
let editorTabsEl;
let editorTabsMenuEl;
let editorPanelEl;
let editorTabsOverflowMenuEl;
let modelExpandAllBtn;
let modelCollapseAllBtn;
let modelGroupToggleBtn;
let appMenuEl;
let menuToggleBtn;
let newProjectDialogEl;
let newProjectLocationEl;
let newProjectLocationPickEl;
let newProjectNameEl;
let newProjectFolderEl;
let newProjectFolderStatusEl;
let newProjectDefaultLibEl;
let newProjectCreateBtn;
let logDialogEl;
let logOutputEl;
let logRefreshBtn;
let projectInfoButton;
let projectInfoDialogEl;
let projectInfoFileEl;
let projectInfoLibraryEl;
let projectInfoSrcEl;
let projectInfoErrorEl;
let projectInfoCreateBlockEl;
let projectInfoTemplateEl;
let projectInfoCreateBtn;
let fsRefreshTimer = null;
let parseRefreshTimer = null;
let parseErrorDecorations = [];
let isSettingEditorValue = false;
let modelTreeSelectionEl = null;
let parseErrorsExpanded = false;
const modelSectionState = { Project: false, Library: false };
let modelGroupByFile = true;
let modelUnresolvedSectionEl = null;
let compileRunId = 0;
let activeCompileId = 0;
const canceledCompileIds = new Set();
let settingsDialogEl;
let settingsThemeEl;
let currentTheme = "vs-dark";
let modelLibraryToggleBtn;
let showLibrarySymbols = true;
let modelPropertiesToggleBtn;
let modelPropertiesEl;
let modelPropertiesBodyEl;
let modelPropertiesCloseBtn;
let showPropertiesPane = true;
const modelRowSymbolMap = new WeakMap();
let modelPropertiesSplitEl;

const state = {
  rootPath: "",
  projectConfig: null,
  projectConfigPath: "",
  projectConfigError: "",
  currentFile: null,
  openFiles: [],
  fileHistory: [],
  dirtyFiles: new Set(),
  lastSavedContent: new Map(),
  bufferedContent: new Map(),
};

const ROOT_STORAGE_KEY = "mercurio.rootPath";
const RECENT_PROJECTS_KEY = "mercurio.recentProjects";
const PROJECT_LOCATION_KEY = "mercurio.projectDefaultLocation";
const THEME_STORAGE_KEY = "mercurio.theme";
const lastCompile = { symbols: [], files: [], unresolved: [], durationMs: null, libraryPath: "" };

const MIN_LEFT = 200;
const MIN_RIGHT = 240;
const MIN_CENTER = 360;

let contextTarget = null;
let editorTabsMenuTarget = null;
let editorTabsOverflowItems = [];
let newFileParentPath = null;
let pendingOpen = null;
let modelTreeMenuTarget = null;
let modelNodeIndex = new Map();
let modelNodeNameIndex = new Map();
let editorReadyResolve;
const editorReady = new Promise((resolve) => {
  editorReadyResolve = resolve;
});

function loadMonaco() {
  return new Promise((resolve, reject) => {
    if (window.monaco) {
      resolve();
      return;
    }

    const loader = document.createElement("script");
    loader.src = "/assets/monaco/vs/loader.js";
    loader.onload = () => {
      window.require.config({
        paths: {
          vs: "/assets/monaco/vs",
        },
      });
      window.require(["vs/editor/editor.main"], () => resolve());
    };
    loader.onerror = () => reject(new Error("Failed to load Monaco"));
    document.body.appendChild(loader);
  });
}

function registerSysmlLanguage() {
  if (!window.monaco) return;
  if (window.monaco.languages.getLanguages().some((lang) => lang.id === "sysml")) {
    return;
  }

  window.monaco.languages.register({ id: "sysml" });
  window.monaco.languages.setMonarchTokensProvider("sysml", {
    keywords: [
      "package",
      "import",
      "part",
      "item",
      "action",
      "port",
      "attribute",
      "connection",
      "interface",
      "allocation",
      "requirement",
      "constraint",
      "state",
      "calculation",
      "usecase",
      "analysis",
      "concern",
      "view",
      "viewpoint",
      "rendering",
      "enum",
      "definition",
      "def",
      "usage",
      "alias",
      "private",
      "public",
      "specializes",
      "subsets",
      "redefines",
      "satisfies",
      "perform",
      "performs",
      "exhibits",
      "include",
      "assert",
      "verify",
    ],
    typeKeywords: ["Boolean", "Integer", "Real", "String", "Natural"],
    operators: [":", "::", "=", "->", "<-", ":>", ":>>", "::>"],
    tokenizer: {
      root: [
        [/[a-zA-Z_][\w$]*/, {
          cases: {
            "@keywords": "keyword",
            "@typeKeywords": "type",
            "@default": "identifier",
          },
        }],
        { include: "@whitespace" },
        [/\d+\.?\d*/, "number"],
        [/\"([^\"\\]|\\.)*$/, "string.invalid"],
        [/\"/, { token: "string.quote", bracket: "@open", next: "@string" }],
        [/[{}()[\]]/, "@brackets"],
        [/[;,.]/, "delimiter"],
        [/(::>|\:>>|\:>|\:\:|->|<-|=|:)/, "operator"],
      ],
      whitespace: [
        [/[ \t\r\n]+/, "white"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, { token: "comment", next: "@comment" }],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, { token: "comment", next: "@pop" }],
        [/[/\*]/, "comment"],
      ],
      string: [
        [/[^\\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/\"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
      ],
    },
  });

  window.monaco.languages.register({ id: "kerml" });
  window.monaco.languages.setMonarchTokensProvider("kerml", {
    keywords: [
      "package",
      "import",
      "class",
      "feature",
      "type",
      "datatype",
      "alias",
      "private",
      "public",
      "specializes",
      "subsets",
      "redefines",
      "dependency",
    ],
    tokenizer: {
      root: [
        [/[a-zA-Z_][\w$]*/, {
          cases: {
            "@keywords": "keyword",
            "@default": "identifier",
          },
        }],
        { include: "@whitespace" },
        [/\d+\.?\d*/, "number"],
        [/\"([^\"\\]|\\.)*$/, "string.invalid"],
        [/\"/, { token: "string.quote", bracket: "@open", next: "@string" }],
        [/[{}()[\]]/, "@brackets"],
        [/[;,.]/, "delimiter"],
        [/[:=><]/, "operator"],
      ],
      whitespace: [
        [/[ \t\r\n]+/, "white"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, { token: "comment", next: "@comment" }],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, { token: "comment", next: "@pop" }],
        [/[/\*]/, "comment"],
      ],
      string: [
        [/[^\\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/\"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
      ],
    },
  });
}

function setCompileStatus(text) {
  if (compileStatusEl) {
    compileStatusEl.textContent = text;
  }
  if (statusMessageEl) {
    statusMessageEl.textContent = text;
  }
}

function setRootPath(path) {
  state.rootPath = path;
  if (rootPathEl) {
    if (!path) {
      rootPathEl.textContent = "No project";
      rootPathEl.title = "";
    } else {
      const clean = path.replace(/[\\/]+$/, "");
      const name = clean.split(/[\\/]/).pop() || clean;
      rootPathEl.textContent = name;
      rootPathEl.title = path;
    }
  }
  if (titlebarProjectEl) {
    if (!path) {
      titlebarProjectEl.textContent = "No project";
    } else {
      const clean = path.replace(/[\\/]+$/, "");
      const name = clean.split(/[\\/]/).pop();
      titlebarProjectEl.textContent = name || path;
    }
  }
  if (path) {
    window.localStorage?.setItem(ROOT_STORAGE_KEY, path);
  } else {
    window.localStorage?.removeItem(ROOT_STORAGE_KEY);
  }
}

function loadRecentProjects() {
  const raw = window.localStorage?.getItem(RECENT_PROJECTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecentProjects(list) {
  window.localStorage?.setItem(RECENT_PROJECTS_KEY, JSON.stringify(list));
}

function updateRecentProjectsMenu(list) {
  if (!recentProjectsEl) return;
  recentProjectsEl.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Recent projects";
  recentProjectsEl.appendChild(placeholder);
  list.forEach((path) => {
    const option = document.createElement("option");
    option.value = path;
    option.textContent = path;
    recentProjectsEl.appendChild(option);
  });
}

function addRecentProject(path) {
  if (!path) return;
  const list = loadRecentProjects().filter((item) => item !== path);
  list.unshift(path);
  const trimmed = list.slice(0, 8);
  saveRecentProjects(trimmed);
  updateRecentProjectsMenu(trimmed);
}

function updateEditorEmptyState() {
  if (!editorPanelEl) return;
  editorPanelEl.classList.toggle("empty", !state.currentFile);
}

function syncPanelToggles() {
  const projectHidden = appEl?.classList.contains("hide-project");
  if (toggleProjectBtn) {
    toggleProjectBtn.textContent = projectHidden ? "<<" : "<<";
  }
  if (restoreProjectBtn) {
    restoreProjectBtn.textContent = ">>";
    restoreProjectBtn.hidden = !projectHidden;
  }
  const modelHidden = appEl?.classList.contains("hide-model-tree");
  if (toggleModelTreeBtn) {
    toggleModelTreeBtn.textContent = modelHidden ? ">>" : ">>";
  }
  if (restoreModelTreeBtn) {
    restoreModelTreeBtn.textContent = "<<";
    restoreModelTreeBtn.hidden = !modelHidden;
  }
}

function updateModelGroupToggle() {
  if (!modelGroupToggleBtn) return;
  modelGroupToggleBtn.title = modelGroupByFile
    ? "Group by file"
    : "List symbols without file grouping";
  modelGroupToggleBtn.classList.toggle("active", modelGroupByFile);
}

function updateModelLibraryToggle() {
  if (!modelLibraryToggleBtn) return;
  modelLibraryToggleBtn.title = showLibrarySymbols ? "Hide library symbols" : "Show library symbols";
  modelLibraryToggleBtn.classList.toggle("active", showLibrarySymbols);
}

function updatePropertiesToggle() {
  if (!modelPropertiesToggleBtn || !modelPropertiesEl) return;
  modelPropertiesToggleBtn.title = showPropertiesPane ? "Hide properties" : "Show properties";
  modelPropertiesToggleBtn.classList.toggle("active", showPropertiesPane);
  modelPropertiesEl.hidden = !showPropertiesPane;
  if (modelPropertiesSplitEl) {
    modelPropertiesSplitEl.hidden = !showPropertiesPane;
  }
}

function clearPropertiesPane() {
  if (!modelPropertiesBodyEl) return;
  modelPropertiesBodyEl.innerHTML = '<p class="muted">Select a model element to see its properties.</p>';
}

function setPropertiesForSymbol(symbol) {
  if (!modelPropertiesBodyEl) return;
  if (!symbol) {
    clearPropertiesPane();
    return;
  }
  const rows = [];
  const parseRows = [];
  const addRow = (key, value) => {
    rows.push({ key, value: value === "" || value == null ? "—" : value });
  };
  const addParseRow = (key, value) => {
    parseRows.push({ key, value: value === "" || value == null ? "—" : value });
  };
  addRow("name", symbol.name);
  addRow("short_name", symbol.short_name || "");
  addRow("qualified_name", symbol.qualified_name);
  addRow("kind", symbol.kind);
  addRow("file_path", symbol.file_path);
  addParseRow("file_id", symbol.file);
  addParseRow("start_line", symbol.start_line + 1);
  addParseRow("start_col", symbol.start_col + 1);
  addParseRow("end_line", symbol.end_line + 1);
  addParseRow("end_col", symbol.end_col + 1);
  addRow("public", symbol.is_public ? "true" : "false");
  addRow("doc", symbol.doc || "");
  addRow("supertypes", Array.isArray(symbol.supertypes) && symbol.supertypes.length ? symbol.supertypes.join(", ") : "");
  if (Array.isArray(symbol.relationships) && symbol.relationships.length) {
    const rels = symbol.relationships.map((rel) => {
      const target = rel.resolved_target || rel.target;
      return `${rel.kind} -> ${target}`;
    });
    addRow("relationships", rels.join(", "));
  } else {
    addRow("relationships", "");
  }
  if (Array.isArray(symbol.type_refs) && symbol.type_refs.length) {
    const refs = symbol.type_refs.map((ref) => {
      if (ref.type === "simple" && ref.part) {
        return ref.part.resolved_target || ref.part.target || "";
      }
      if (ref.type === "chain" && Array.isArray(ref.parts)) {
        const last = ref.parts[ref.parts.length - 1];
        return last?.resolved_target || last?.target || "";
      }
      return "";
    });
    addRow("type_refs", refs.filter(Boolean).join(", "));
  } else {
    addRow("type_refs", "");
  }

  const list = document.createElement("div");
  list.className = "model-properties-list";
  rows.forEach((row) => {
    const item = document.createElement("div");
    item.className = "model-properties-row";
    const key = document.createElement("div");
    key.className = "model-properties-key";
    key.textContent = row.key;
    const value = document.createElement("div");
    value.className = "model-properties-value";
    value.textContent = String(row.value);
    item.appendChild(key);
    item.appendChild(value);
    list.appendChild(item);
  });
  if (parseRows.length) {
    const details = document.createElement("details");
    details.className = "model-properties-details";
    const summary = document.createElement("summary");
    summary.textContent = "Parse info";
    details.appendChild(summary);
    const parseList = document.createElement("div");
    parseList.className = "model-properties-list";
    parseRows.forEach((row) => {
      const item = document.createElement("div");
      item.className = "model-properties-row";
      const key = document.createElement("div");
      key.className = "model-properties-key";
      key.textContent = row.key;
      const value = document.createElement("div");
      value.className = "model-properties-value";
      value.textContent = String(row.value);
      item.appendChild(key);
      item.appendChild(value);
      parseList.appendChild(item);
    });
    details.appendChild(parseList);
    list.appendChild(details);
  }
  modelPropertiesBodyEl.innerHTML = "";
  modelPropertiesBodyEl.appendChild(list);
}

function loadStoredTheme() {
  const stored = window.localStorage?.getItem(THEME_STORAGE_KEY);
  if (!stored) return "vs-dark";
  return stored;
}

function applyTheme(themeId) {
  const theme = themeId || "vs-dark";
  currentTheme = theme;
  if (settingsThemeEl) {
    settingsThemeEl.value = theme;
  }
  const isLight = theme === "vs" || theme === "hc-light";
  document.body.classList.toggle("theme-light", isLight);
  window.localStorage?.setItem(THEME_STORAGE_KEY, theme);
  if (window.monaco?.editor?.setTheme) {
    window.monaco.editor.setTheme(theme);
  }
}

function setCompileFloat(state, message, detail) {
  if (!compileFloatEl || !compileFloatMessageEl || !compileFloatDetailEl || !compileFloatCancelBtn) {
    return;
  }
  compileFloatEl.hidden = false;
  compileFloatEl.classList.toggle("error", state === "error");
  compileFloatEl.classList.toggle("done", state === "done");
  compileFloatMessageEl.textContent = message || "";
  compileFloatDetailEl.innerHTML = "";
  if (detail) {
    if (detail.nodeType) {
      compileFloatDetailEl.appendChild(detail);
    } else {
      compileFloatDetailEl.textContent = detail;
    }
    compileFloatDetailEl.hidden = false;
  } else {
    compileFloatDetailEl.hidden = true;
  }
  compileFloatCancelBtn.textContent = state === "running" ? "Cancel" : "Close";
}

function hideCompileFloat() {
  if (!compileFloatEl) return;
  compileFloatEl.hidden = true;
  compileFloatEl.classList.remove("error", "done");
}

function updateCompileProgress(payload) {
  if (!payload || payload.run_id !== activeCompileId) return;
  if (!compileFloatEl || compileFloatEl.hidden) return;
  const stage = payload.stage;
  if (stage === "parsing") {
    const total = payload.total || 0;
    const index = payload.index || 0;
    const file = payload.file ? payload.file.split(/[\\/]/).pop() : null;
    const detail = file ? `${file} ${index}/${total || "?"}` : `${index}/${total || "?"}`;
    setCompileFloat("running", "Parsing…", detail);
  } else if (stage === "analysis") {
    setCompileFloat("running", "Analyzing…", "");
  } else if (stage === "semantic") {
    const total = payload.total || 0;
    const index = payload.index || 0;
    const detail = total ? `${index}/${total}` : `${index}`;
    setCompileFloat("running", "Semantic analysis…", detail);
  }
}

function getTypeTarget(symbol) {
  if (!symbol || !Array.isArray(symbol.type_refs)) return "";
  for (const typeRef of symbol.type_refs) {
    if (typeRef.type === "simple" && typeRef.part) {
      return typeRef.part.resolved_target || typeRef.part.target || "";
    }
    if (typeRef.type === "chain" && Array.isArray(typeRef.parts) && typeRef.parts.length) {
      const last = typeRef.parts[typeRef.parts.length - 1];
      return last.resolved_target || last.target || "";
    }
  }
  return "";
}

function expandModelAncestors(row) {
  let node = row.closest(".model-node");
  while (node) {
    if (node.classList.contains("collapsed")) {
      node.classList.remove("collapsed");
      const caret = node.querySelector(":scope > .model-row .model-caret");
      if (caret) {
        caret.textContent = "v";
      }
    }
    node = node.parentElement?.closest(".model-node");
  }
}

function selectModelRow(row) {
  if (!row) return;
  modelTreeSelectionEl?.classList.remove("selected");
  modelTreeSelectionEl = row;
  modelTreeSelectionEl.classList.add("selected");
  expandModelAncestors(row);
  row.scrollIntoView({ block: "center" });
  const symbol = modelRowSymbolMap.get(row);
  if (showPropertiesPane) {
    setPropertiesForSymbol(symbol);
  }
}

function setCurrentFile(path) {
  state.currentFile = path;
  if (currentFileEl) {
    currentFileEl.textContent = path || "No file open";
  }
  if (statusFileEl) {
    statusFileEl.textContent = path ? path.split(/[\\/]/).pop() : "No file";
  }
  if (path) {
    state.fileHistory = state.fileHistory.filter((item) => item !== path);
    state.fileHistory.push(path);
  }
  renderEditorTabs();
  updateEditorEmptyState();
}

function updateDirtyIndicator(path, isDirty) {
  if (!path || !fileTreeEl) return;
  const row = fileTreeEl.querySelector(`.tree-row[data-path=\"${CSS.escape(path)}\"]`);
  if (row) {
    row.classList.toggle("dirty", isDirty);
  }
  if (path === state.currentFile && statusFileEl) {
    const name = path.split(/[\\/]/).pop() || "No file";
    statusFileEl.textContent = isDirty ? `${name} *` : name;
  }
  renderEditorTabs();
  updateEditorEmptyState();
}

function addOpenFile(path) {
  if (!path) return;
  if (!state.openFiles.includes(path)) {
    state.openFiles.push(path);
    renderEditorTabs();
  }
}

function removeOpenFile(path) {
  if (!path) return;
  const index = state.openFiles.indexOf(path);
  if (index >= 0) {
    state.openFiles.splice(index, 1);
    renderEditorTabs();
  }
  state.fileHistory = state.fileHistory.filter((item) => item !== path);
}

function renderEditorTabs() {
  if (!editorTabsEl) return;
  editorTabsEl.innerHTML = "";
  if (!state.openFiles.length) {
    editorTabsEl.classList.add("empty");
    return;
  }
  editorTabsEl.classList.remove("empty");
  const tabsList = document.createElement("div");
  tabsList.className = "editor-tabs-list";
  const overflowButton = document.createElement("button");
  overflowButton.type = "button";
  overflowButton.className = "editor-tabs-overflow-btn";
  overflowButton.title = "More tabs";
  overflowButton.textContent = "v";
  overflowButton.hidden = true;
  overflowButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!editorTabsOverflowItems.length) return;
    const rect = overflowButton.getBoundingClientRect();
    showEditorTabsOverflowMenu(rect.left, rect.bottom + 4, editorTabsOverflowItems);
  });
  editorTabsEl.appendChild(tabsList);
  editorTabsEl.appendChild(overflowButton);

  const tabNodes = state.openFiles.map((path) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "editor-tab";
    if (path === state.currentFile) {
      tab.classList.add("active");
    }
    const name = path.split(/[\\/]/).pop() || path;
    tab.textContent = state.dirtyFiles.has(path) ? `${name} *` : name;
    tab.title = path;
    tab.addEventListener("click", async () => {
      if (path === state.currentFile) return;
      await openFile(path);
    });
    tab.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showEditorTabsMenu(event.clientX, event.clientY, path);
    });
    tabsList.appendChild(tab);
    return { path, tab, label: tab.textContent };
  });
  queueMicrotask(() => layoutEditorTabs(tabsList, overflowButton, tabNodes));
}

function layoutEditorTabs(tabsList, overflowButton, tabNodes) {
  if (!editorTabsEl || !tabsList || !overflowButton) return;
  editorTabsOverflowItems = [];
  overflowButton.hidden = true;
  tabNodes.forEach(({ tab }) => {
    if (tab.parentElement !== tabsList) {
      tabsList.appendChild(tab);
    }
  });

  const available = editorTabsEl.clientWidth;
  if (!available) return;

  overflowButton.hidden = false;
  const overflowWidth = overflowButton.getBoundingClientRect().width || 28;
  overflowButton.hidden = true;

  const maxWidth = Math.max(0, available - overflowWidth - 6);
  let used = 0;
  const overflowed = [];

  tabNodes.forEach((node) => {
    const width = node.tab.getBoundingClientRect().width;
    if (used + width <= maxWidth || used === 0) {
      used += width;
    } else {
      overflowed.push(node);
    }
  });

  if (!overflowed.length) {
    overflowButton.hidden = true;
    hideEditorTabsOverflowMenu();
    return;
  }
  overflowButton.hidden = false;
  overflowed.forEach((node) => {
    if (node.tab.parentElement === tabsList) {
      tabsList.removeChild(node.tab);
    }
  });
  editorTabsOverflowItems = overflowed;
}

function normalizePathForCompare(path) {
  return path.replace(/[\\/]+/g, "\\").toLowerCase();
}

function relativeToRoot(root, target) {
  if (!target) return "";
  const rootNorm = normalizePathForCompare(root).replace(/\\+$/, "");
  const targetNorm = normalizePathForCompare(target);
  if (targetNorm === rootNorm) return "";
  const prefix = `${rootNorm}\\`;
  if (targetNorm.startsWith(prefix)) {
    return targetNorm.slice(prefix.length);
  }
  return target;
}

function joinPath(root, name) {
  if (!root) return name;
  const trimmed = root.replace(/[\\/]+$/, "");
  const sep = trimmed.includes("/") ? "/" : "\\";
  return `${trimmed}${sep}${name}`;
}

function normalizeProjectConfig(config) {
  if (!config || typeof config !== "object") {
    return { library: { type: "default" }, src: [] };
  }
  const normalized = { library: { type: "default" }, src: [] };
  if (typeof config.library === "string") {
    if (config.library.toLowerCase() === "default") {
      normalized.library = { type: "default" };
    }
  } else if (config.library && typeof config.library === "object") {
    if (typeof config.library.path === "string" && config.library.path.trim()) {
      normalized.library = { type: "path", path: config.library.path.trim() };
    }
  }
  if (Array.isArray(config.src)) {
    normalized.src = config.src.filter((item) => typeof item === "string" && item.trim());
  }
  return normalized;
}

async function getDefaultProjectLocation() {
  const stored = window.localStorage?.getItem(PROJECT_LOCATION_KEY);
  if (stored) return stored;
  try {
    const base = await invoke("get_user_projects_root");
    return base || "";
  } catch {
    return "";
  }
}

function rememberProjectLocation(path) {
  if (!path) return;
  window.localStorage?.setItem(PROJECT_LOCATION_KEY, path);
}

function slugifyName(name) {
  return (name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function buildProjectConfigText(useDefaultLibrary) {
  const base = {
    src: ["**/*.sysml", "**/*.kerml"],
  };
  if (useDefaultLibrary) {
    base.library = "default";
  }
  return JSON.stringify(base, null, 2);
}

async function showNewProjectDialog() {
  if (!newProjectDialogEl || !newProjectLocationEl || !newProjectNameEl || !newProjectFolderEl) {
    return;
  }
  newProjectDialogEl.hidden = false;
  newProjectNameEl.value = "";
  newProjectFolderEl.textContent = "";
  newProjectDefaultLibEl.checked = true;
  newProjectLocationEl.value = await getDefaultProjectLocation();
  updateProjectFolderStatus();
  setTimeout(() => newProjectNameEl.focus(), 0);
}

function hideNewProjectDialog() {
  if (!newProjectDialogEl) return;
  newProjectDialogEl.hidden = true;
}

async function createNewProject() {
  if (!newProjectLocationEl || !newProjectNameEl || !newProjectFolderEl) return;
  const location = newProjectLocationEl.value.trim();
  const name = newProjectNameEl.value.trim();
  const folder = newProjectFolderEl.textContent.trim();
  if (!location || !name || !folder) {
    setCompileStatus("Enter location, project name, and folder name");
    return;
  }
  const projectPath = joinPath(location, folder);
  const projectFile = joinPath(projectPath, ".project.json");
  const config = buildProjectConfigText(newProjectDefaultLibEl.checked);
  try {
    const exists = await invoke("path_exists", { path: projectPath });
    if (exists) {
      setCompileStatus("Project folder already exists");
      updateProjectFolderStatus(true);
      return;
    }
    await invoke("write_file", { path: projectFile, content: config });
    rememberProjectLocation(location);
    hideNewProjectDialog();
    await loadRoot(projectPath);
    setCompileStatus("Project created");
  } catch (error) {
    setCompileStatus(`Create project failed: ${error}`);
  }
}

async function showLogDialog() {
  if (!logDialogEl || !logOutputEl) return;
  const lines = await invoke("get_logs");
  logOutputEl.textContent = Array.isArray(lines) ? lines.join("\n") : "";
  logOutputEl.scrollTop = logOutputEl.scrollHeight;
  logDialogEl.hidden = false;
}

function hideLogDialog() {
  if (!logDialogEl) return;
  logDialogEl.hidden = true;
}

function showSettingsDialog() {
  if (!settingsDialogEl || !settingsThemeEl) return;
  settingsThemeEl.value = currentTheme;
  settingsDialogEl.hidden = false;
}

function hideSettingsDialog() {
  if (!settingsDialogEl) return;
  settingsDialogEl.hidden = true;
}

function updateProjectFolderStatus(forceError = false) {
  if (!newProjectFolderStatusEl || !newProjectLocationEl || !newProjectFolderEl) return;
  const location = newProjectLocationEl.value.trim();
  const folder = newProjectFolderEl.textContent.trim();
  if (!location || !folder) {
    newProjectFolderStatusEl.textContent = "";
    newProjectFolderStatusEl.classList.remove("error");
    if (newProjectCreateBtn) {
      newProjectCreateBtn.disabled = true;
    }
    return;
  }
  const projectPath = joinPath(location, folder);
  invoke("path_exists", { path: projectPath })
    .then((exists) => {
      if (exists || forceError) {
        newProjectFolderStatusEl.textContent = "Folder already exists";
        newProjectFolderStatusEl.classList.add("error");
        if (newProjectCreateBtn) {
          newProjectCreateBtn.disabled = true;
        }
      } else {
        newProjectFolderStatusEl.textContent = "Folder available";
        newProjectFolderStatusEl.classList.remove("error");
        if (newProjectCreateBtn) {
          newProjectCreateBtn.disabled = false;
        }
      }
    })
    .catch(() => {
      newProjectFolderStatusEl.textContent = "";
      newProjectFolderStatusEl.classList.remove("error");
      if (newProjectCreateBtn) {
        newProjectCreateBtn.disabled = true;
      }
    });
}

async function loadProjectConfig(root) {
  state.projectConfig = null;
  state.projectConfigPath = "";
  state.projectConfigError = "";
  updateProjectInfoIndicator();
  if (!root) return;
  const configPath = joinPath(root, ".project.json");
  try {
    const exists = await invoke("path_exists", { path: configPath });
    if (!exists) return;
    const content = await invoke("read_file", { path: configPath });
    const parsed = JSON.parse(content);
    state.projectConfig = normalizeProjectConfig(parsed);
    state.projectConfigPath = configPath;
  } catch (error) {
    state.projectConfigError = `Invalid .project.json: ${error}`;
    state.projectConfigPath = configPath;
  } finally {
    updateProjectInfoIndicator();
  }
}

function updateProjectInfoIndicator() {
  if (!projectInfoButton) return;
  projectInfoButton.classList.toggle("active", Boolean(state.projectConfigPath));
}

function updateProjectInfoDialog() {
  if (
    !projectInfoFileEl ||
    !projectInfoLibraryEl ||
    !projectInfoSrcEl ||
    !projectInfoErrorEl ||
    !projectInfoCreateBlockEl ||
    !projectInfoTemplateEl ||
    !projectInfoCreateBtn
  ) {
    return;
  }
  if (projectInfoDialogEl) {
    projectInfoDialogEl.dataset.hasProject = state.projectConfigPath ? "1" : "0";
  }
  projectInfoCreateBlockEl.hidden = true;
  projectInfoErrorEl.textContent = state.projectConfigError || "";
  if (projectInfoTemplateEl) {
    projectInfoTemplateEl.value = "";
  }
  if (projectInfoCreateBlockEl) {
    projectInfoCreateBlockEl.hidden = true;
  }
  if (!state.rootPath) {
    projectInfoFileEl.textContent = "No project selected";
    projectInfoLibraryEl.textContent = "Default (built-in)";
    projectInfoSrcEl.textContent = "All .sysml / .kerml files (recursive)";
    return;
  }
  if (!state.projectConfigPath) {
    projectInfoFileEl.textContent = "No .project.json found";
    projectInfoLibraryEl.textContent = "Default (built-in)";
    projectInfoSrcEl.textContent = "All .sysml / .kerml files (recursive)";
    projectInfoCreateBlockEl.hidden = false;
    projectInfoTemplateEl.disabled = false;
    projectInfoCreateBtn.disabled = false;
    if (!projectInfoTemplateEl.value) {
      projectInfoTemplateEl.value = getDefaultProjectConfigText();
    }
    return;
  }
  if (state.projectConfigError) {
    projectInfoFileEl.textContent = state.projectConfigPath;
    projectInfoLibraryEl.textContent = "Default (built-in)";
    projectInfoSrcEl.textContent = "All .sysml / .kerml files (recursive)";
    return;
  }
  if (!state.projectConfig) {
    projectInfoFileEl.textContent = state.projectConfigPath;
    projectInfoLibraryEl.textContent = "Default (built-in)";
    projectInfoSrcEl.textContent = "All .sysml / .kerml files (recursive)";
    return;
  }
  projectInfoFileEl.textContent = state.projectConfigPath;
  if (state.projectConfig.library?.type === "path") {
    projectInfoLibraryEl.textContent = state.projectConfig.library.path;
  } else {
    projectInfoLibraryEl.textContent = "Default (built-in)";
  }
  projectInfoSrcEl.innerHTML = "";
  if (state.projectConfig.src && state.projectConfig.src.length) {
    const list = document.createElement("ul");
    list.className = "project-info-list";
    state.projectConfig.src.forEach((entry) => {
      const item = document.createElement("li");
      item.textContent = entry;
      list.appendChild(item);
    });
    projectInfoSrcEl.appendChild(list);
  } else {
    projectInfoSrcEl.textContent = "All .sysml / .kerml files (recursive)";
  }
}

async function showProjectInfoDialog() {
  if (!projectInfoDialogEl) return;
  if (state.rootPath) {
    await loadProjectConfig(state.rootPath);
  }
  updateProjectInfoDialog();
  projectInfoDialogEl.hidden = false;
}

function hideProjectInfoDialog() {
  if (!projectInfoDialogEl) return;
  projectInfoDialogEl.hidden = true;
}

function getDefaultProjectConfigText() {
  return `{
  "library": "default",
  "src": [
    "**/*.sysml",
    "**/*.kerml"
  ]
}`;
}


function showNewFileDialog(parentPath) {
  if (!newFileDialogEl || !newFileNameEl || !newFileTypeEl) return;
  if (!state.rootPath) {
    setCompileStatus("Select a root folder first");
    return;
  }
  const root = state.rootPath;
  const rootNorm = normalizePathForCompare(root).replace(/\\+$/, "") + "\\";
  const parent = parentPath || root;
  const parentNorm = normalizePathForCompare(parent);
  newFileParentPath = parentNorm.startsWith(rootNorm) ? parent : root;
  newFileDialogEl.hidden = false;
  newFileNameEl.value = "";
  newFileTypeEl.value = "sysml";
  setTimeout(() => newFileNameEl.focus(), 0);
}


function hideNewFileDialog() {
  if (!newFileDialogEl) return;
  newFileDialogEl.hidden = true;
  newFileParentPath = null;
}

async function createNewFileFromDialog() {
  if (!newFileNameEl || !newFileTypeEl) return;
  const nameRaw = newFileNameEl.value.trim();
  if (!nameRaw) {
    setCompileStatus("Enter a file name");
    return;
  }
  const ext = newFileTypeEl.value === "kerml" ? ".kerml" : ".sysml";
  const hasExt = /\.[^./\\\\]+$/.test(nameRaw);
  const name = hasExt ? nameRaw : `${nameRaw}${ext}`;
  try {
    const parent = newFileParentPath || state.rootPath;
    const parentRelative = relativeToRoot(state.rootPath, parent);
    await invoke("create_file", { root: state.rootPath, parent: parentRelative, name });
    hideNewFileDialog();
    await loadRoot(state.rootPath);
  } catch (error) {
    setCompileStatus(`Create file failed: ${error}`);
  }
}


function closeTabs(paths) {
  if (!paths || !paths.length) return;
  const closingCurrent = state.currentFile && paths.includes(state.currentFile);

  paths.forEach((path) => {
    removeOpenFile(path);
    state.lastSavedContent.delete(path);
    state.bufferedContent.delete(path);
    setDirty(path, false);
  });

  if (closingCurrent) {
    const next = [...state.fileHistory].reverse().find((item) => state.openFiles.includes(item));
    if (next) {
      void openFile(next);
    } else {
      editor?.setValue("");
      setCurrentFile(null);
      renderParseErrors({ path: "", errors: [] });
    }
  }
}

function setDirty(path, isDirty) {
  if (!path) return;
  if (isDirty) {
    state.dirtyFiles.add(path);
  } else {
    state.dirtyFiles.delete(path);
  }
  updateDirtyIndicator(path, isDirty);
}

function scheduleParseRefresh(path) {
  if (!path) return;
  if (parseRefreshTimer) {
    clearTimeout(parseRefreshTimer);
  }
  parseRefreshTimer = setTimeout(async () => {
    parseRefreshTimer = null;
    await fetchParseErrors(path);
  }, 300);
}

async function saveCurrentFile() {
  if (!state.currentFile || !editor) return;
  try {
    const content = editor.getValue();
    await invoke("write_file", { path: state.currentFile, content });
    state.lastSavedContent.set(state.currentFile, content);
    state.bufferedContent.delete(state.currentFile);
    setDirty(state.currentFile, false);
    setCompileStatus("Saved");
  } catch (error) {
    setCompileStatus(`Save failed: ${error}`);
  }
}

async function saveAllOpenFiles() {
  if (!state.openFiles.length || !state.dirtyFiles.size) return;
  const targets = Array.from(state.dirtyFiles);
  for (const path of targets) {
    let content = null;
    if (path === state.currentFile && editor) {
      content = editor.getValue();
    } else {
      content = state.bufferedContent.get(path);
    }
    if (typeof content !== "string") {
      continue;
    }
    await invoke("write_file", { path, content });
    state.lastSavedContent.set(path, content);
    state.bufferedContent.delete(path);
    setDirty(path, false);
  }
}

function renderParseErrors(payload) {
  if (!errorsListEl || !errorsEmptyEl || !errorsFileEl) return;
  const { path, errors } = payload || {};
  errorsFileEl.textContent = path ? path.split(/[\\/]/).pop() : "No file";
  errorsListEl.innerHTML = "";

  if (editor && window.monaco) {
    const model = editor.getModel();
    if (model) {
      if (path && state.currentFile === path) {
        const markers = (errors || []).map((error) => {
          const line = (error.line ?? 0) + 1;
          const column = (error.column ?? 0) + 1;
          return {
            severity: window.monaco.MarkerSeverity.Error,
            message: error.message || "Parse error",
            startLineNumber: line,
            startColumn: column,
            endLineNumber: line,
            endColumn: column + 1,
          };
        });
        window.monaco.editor.setModelMarkers(model, "parse", markers);
        parseErrorDecorations = editor.deltaDecorations(
          parseErrorDecorations,
          markers.map((marker) => ({
            range: new window.monaco.Range(
              marker.startLineNumber,
              marker.startColumn,
              marker.endLineNumber,
              marker.endColumn
            ),
            options: {
              inlineClassName: "parse-error-inline",
              className: "parse-error-glyph",
              hoverMessage: { value: marker.message },
            },
          }))
        );
      } else {
        window.monaco.editor.setModelMarkers(model, "parse", []);
        parseErrorDecorations = editor.deltaDecorations(parseErrorDecorations, []);
      }
    }
  }

  const hasErrors = !!(errors && errors.length);
  if (!hasErrors) {
    errorsEmptyEl.style.display = "none";
    if (errorsSectionEl) {
      errorsSectionEl.classList.remove("expanded");
    }
    if (parseToggleEl) {
      parseToggleEl.hidden = true;
      parseToggleEl.setAttribute("aria-expanded", "false");
    }
    parseErrorsExpanded = false;
    return;
  }

  if (parseToggleEl) {
    parseToggleEl.hidden = false;
    parseToggleEl.setAttribute("aria-expanded", String(parseErrorsExpanded));
  }
  if (errorsSectionEl) {
    errorsSectionEl.classList.toggle("expanded", parseErrorsExpanded);
  }
  errors.forEach((error) => {
    const item = document.createElement("li");
    item.className = "error-item";
    item.dataset.path = path || "";
    item.dataset.line = error.line;
    item.dataset.column = error.column;

    const title = document.createElement("div");
    title.className = "error-title";
    title.textContent = error.message;

    const meta = document.createElement("div");
    meta.className = "error-meta";
    meta.textContent = `Line ${error.line + 1}, Col ${error.column + 1} \u00b7 ${error.kind}`;

    item.appendChild(title);
    item.appendChild(meta);
    errorsListEl.appendChild(item);
  });
}

async function fetchParseErrors(path) {
  if (!path) {
    renderParseErrors({ path: "", errors: [] });
    return 0;
  }
  try {
    let payload;
    if (path === state.currentFile && editor) {
      const content = editor.getValue();
      payload = await invoke("get_parse_errors_for_content", { path, content });
    } else {
      payload = await invoke("get_parse_errors", { path });
    }
    renderParseErrors(payload);
    return payload?.errors?.length || 0;
  } catch (error) {
    setCompileStatus(`Parse errors failed: ${error}`);
    renderParseErrors({ path, errors: [] });
    return 0;
  }
}

function getExtension(path) {
  const match = path.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : "";
}

function languageForPath(path) {
  const ext = getExtension(path);
  if (ext === "sysml") return "sysml";
  if (ext === "kerml") return "kerml";
  return "plaintext";
}

function iconClassForPath(path, isDir) {
  if (isDir) return "folder";
  const ext = getExtension(path);
  if (ext === "sysml") return "sysml";
  if (ext === "kerml") return "kerml";
  return "file";
}

async function chooseRoot() {
  if (dialog?.open) {
    const selected = await dialog.open({
      directory: true,
      multiple: false,
    });
    if (!selected) return;
    await loadRoot(selected);
    return;
  }

  setCompileStatus("Dialog API not available");
}

async function loadRoot(path) {
  setCompileStatus("Loading files...");
  try {
    const entries = await invoke("list_dir", { path });
    setRootPath(path);
    await loadProjectConfig(path);
    renderFileTree(entries);
    await invoke("set_watch_root", { root: path });
    addRecentProject(path);
    setCompileStatus("Idle");
  } catch (error) {
    setCompileStatus(`Failed to load root: ${error}`);
  }
}

function renderFileTree(entries) {
  fileTreeEl.innerHTML = "";
  if (state.rootPath) {
    const parent = getParentPath(state.rootPath);
    if (parent && parent !== state.rootPath) {
      fileTreeEl.appendChild(
        createTreeItem({
          name: "..",
          path: parent,
          is_dir: true,
          is_parent: true,
        })
      );
    }
  }
  entries.forEach((entry) => {
    fileTreeEl.appendChild(createTreeItem(entry));
  });
}

function createTreeItem(entry) {
  const item = document.createElement("li");
  item.className = `tree-item ${entry.is_dir ? "dir" : "file"}`;

  const row = document.createElement("button");
  row.className = "tree-row";
  row.type = "button";
  row.dataset.path = entry.path;
  row.dataset.isDir = entry.is_dir ? "1" : "0";
  if (!entry.is_dir && state.dirtyFiles.has(entry.path)) {
    row.classList.add("dirty");
  }

  const icon = document.createElement("span");
  const iconClass = iconClassForPath(entry.path, entry.is_dir);
  icon.className = `file-icon ${iconClass}`;
  icon.textContent = "";

  const label = document.createElement("span");
  label.textContent = entry.name;

  row.appendChild(icon);
  row.appendChild(label);

  item.appendChild(row);

  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (entry.is_action || entry.is_parent) return;
    showContextMenu(event.clientX, event.clientY, {
      path: entry.path,
      isDir: entry.is_dir,
    });
  });

  if (entry.is_action) {
    row.addEventListener("click", async () => {
      if (!state.rootPath) return;
      const name = window.prompt("New file name:");
      if (!name) return;
      try {
        await invoke("create_file", { root: state.rootPath, parent: state.rootPath, name });
        await loadRoot(state.rootPath);
      } catch (error) {
        setCompileStatus(`Create file failed: ${error}`);
      }
    });
    return item;
  }

  if (entry.is_parent) {
    row.addEventListener("click", async () => {
      await loadRoot(entry.path);
    });
    return item;
  }

  if (entry.is_dir) {
    const children = document.createElement("ul");
    children.className = "tree-children";
    item.appendChild(children);

    row.addEventListener("click", async () => {
      const isExpanded = item.classList.contains("expanded");
      if (isExpanded) {
        item.classList.remove("expanded");
        return;
      }
      item.classList.add("expanded");
      if (!children.hasChildNodes()) {
        try {
          const childEntries = await invoke("list_dir", { path: entry.path });
          childEntries.forEach((child) => {
            children.appendChild(createTreeItem(child));
          });
        } catch (error) {
          const errorRow = document.createElement("li");
          errorRow.textContent = `Failed to load: ${error}`;
          children.appendChild(errorRow);
        }
      }
    });
  } else {
    row.addEventListener("click", async () => {
      await openFile(entry.path);
    });
  }

  return item;
}

async function openFile(path) {
  if (!editor) {
    pendingOpen = { type: "file", path };
    setCompileStatus("Editor not ready yet");
  }
  await editorReady;
  if (!editor) {
    setCompileStatus("Editor failed to initialize");
    return false;
  }
  try {
    if (state.currentFile && editor) {
      const currentContent = editor.getValue();
      const saved = state.lastSavedContent.get(state.currentFile) ?? "";
      if (currentContent !== saved) {
        state.bufferedContent.set(state.currentFile, currentContent);
        setDirty(state.currentFile, true);
      } else {
        state.bufferedContent.delete(state.currentFile);
        setDirty(state.currentFile, false);
      }
    }
    let content = state.bufferedContent.get(path);
    if (content == null) {
      content = await invoke("read_file", { path });
      state.lastSavedContent.set(path, content);
      state.bufferedContent.delete(path);
    }
    isSettingEditorValue = true;
    editor.setValue(content);
    isSettingEditorValue = false;
    const model = editor.getModel();
    if (model) {
      window.monaco.editor.setModelLanguage(model, languageForPath(path));
    }
    const saved = state.lastSavedContent.get(path) ?? content;
    setDirty(path, content !== saved);
    addOpenFile(path);
    setCurrentFile(path);
    updateCursorStatus();
    await fetchParseErrors(path);
    return true;
  } catch (error) {
    setCompileStatus(`Failed to open file: ${error}`);
    return false;
  }
}

async function openFileAt(path, line, column, endLine, endColumn) {
  if (!editor) {
    pendingOpen = { type: "range", path, line, column, endLine, endColumn };
    setCompileStatus("Editor not ready yet");
  }
  await editorReady;
  if (!editor) {
    setCompileStatus("Editor failed to initialize");
    return;
  }
  const opened = await openFile(path);
  if (!opened || !editor || !window.monaco) return;

  const targetLine = Math.max(1, (line ?? 0) + 1);
  const targetColumn = Math.max(1, (column ?? 0) + 1);
  const targetEndLine = Math.max(1, (endLine ?? line ?? 0) + 1);
  const targetEndColumn = Math.max(1, (endColumn ?? column ?? 0) + 1);
  const range = new window.monaco.Range(
    targetLine,
    targetColumn,
    targetEndLine,
    targetEndColumn
  );
  editor.setPosition({ lineNumber: targetLine, column: targetColumn });
  editor.revealRangeInCenter(range);
  editor.setSelection(range);
  editor.focus();
  updateCursorStatus();
}

function normalizeKind(kind) {
  return kind
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function kindBadgeLabel(kind) {
  const map = {
    Package: "Pkg",
    "Part def": "Part",
    Part: "Part",
    "Requirement def": "Req",
    Requirement: "Req",
    "Attribute def": "Attr",
    Attribute: "Attr",
    Import: "Imp",
    Alias: "Als",
    Comment: "Cmt",
    Dependency: "Dep",
  };
  return map[kind] || "Sym";
}

function buildModelTree(symbols) {
  const roots = new Map();
  if (!symbols.length) return roots;
  if (modelGroupByFile) {
    symbols.forEach((symbol) => {
      const fileKey = symbol.file_path || "<unknown>";
      if (!roots.has(fileKey)) {
        roots.set(fileKey, { name: fileKey, children: new Map(), symbol: null });
      }
      const fileNode = roots.get(fileKey);
      const parts = (symbol.qualified_name || symbol.name || "").split("::").filter(Boolean);
      let cursor = fileNode;
      parts.forEach((part) => {
        if (!cursor.children.has(part)) {
          cursor.children.set(part, { name: part, children: new Map(), symbol: null });
        }
        cursor = cursor.children.get(part);
      });
      if (!cursor.symbol) {
        cursor.symbol = symbol;
      }
    });
    return roots;
  }

  symbols.forEach((symbol) => {
    const parts = (symbol.qualified_name || symbol.name || "").split("::").filter(Boolean);
    if (!parts.length) return;
    let cursorMap = roots;
    let cursor = null;
    parts.forEach((part) => {
      if (!cursorMap.has(part)) {
        cursorMap.set(part, { name: part, children: new Map(), symbol: null });
      }
      cursor = cursorMap.get(part);
      cursorMap = cursor.children;
    });
    if (cursor && !cursor.symbol) {
      cursor.symbol = symbol;
    }
  });
  return roots;
}

function isPathUnderRoot(path, root) {
  if (!path || !root) return false;
  const rootNorm = normalizePathForCompare(root).replace(/\\+$/, "");
  const pathNorm = normalizePathForCompare(path);
  if (!rootNorm) return false;
  if (pathNorm === rootNorm) return true;
  return pathNorm.startsWith(`${rootNorm}\\`);
}

function formatCount(value, singular, plural) {
  const label = value === 1 ? singular : plural;
  return `${value} ${label}`;
}

function renderModelTree(symbols, files, unresolved, libraryPath) {
  modelTreeEl.innerHTML = "";
  modelNodeIndex = new Map();
  modelNodeNameIndex = new Map();
  const filteredSymbols = symbols;
  const unresolvedRefs = Array.isArray(unresolved) ? unresolved : [];
  if (statusUnresolvedEl) {
    const count = unresolvedRefs.length;
    statusUnresolvedEl.hidden = count === 0;
    statusUnresolvedEl.title = count
      ? `Unresolved references (${count})`
      : "Unresolved references";
  }
  modelUnresolvedSectionEl = null;
  const libraryRoot = libraryPath || "";
  const projectSymbols = [];
  const librarySymbols = [];

  filteredSymbols.forEach((symbol) => {
    const path = symbol?.file_path || "";
    if (libraryRoot && isPathUnderRoot(path, libraryRoot)) {
      librarySymbols.push(symbol);
    } else {
      projectSymbols.push(symbol);
    }
  });

  if (!projectSymbols.length && !librarySymbols.length && !unresolvedRefs.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No symbols found in this workspace.";
    modelTreeEl.appendChild(empty);
    return;
  }

  const renderSection = (title, sectionSymbols) => {
    if (!sectionSymbols.length) return;
    const section = document.createElement("div");
    section.className = "model-section";
    section.classList.toggle("collapsed", modelGroupByFile && modelSectionState[title]);
    section.classList.toggle("compact", !modelGroupByFile && modelSectionState[title]);
    const header = document.createElement("div");
    header.className = "model-section-header";
    const caret = document.createElement("span");
    caret.className = "model-section-caret";
    caret.textContent = modelSectionState[title] ? ">" : "v";
    const label = document.createElement("span");
    label.className = "model-section-label";
    label.textContent = title;
    const count = document.createElement("span");
    count.className = "model-section-count";
    count.textContent = `${sectionSymbols.length}`;
    header.appendChild(caret);
    header.appendChild(label);
    header.appendChild(count);
    header.addEventListener("click", () => {
      const next = !modelSectionState[title];
      modelSectionState[title] = next;
      section.classList.toggle("collapsed", modelGroupByFile && next);
      section.classList.toggle("compact", !modelGroupByFile && next);
      caret.textContent = next ? ">" : "v";
    });
    section.appendChild(header);

    const fileSet = new Set();
    sectionSymbols.forEach((symbol) => {
      if (symbol?.file_path) {
        fileSet.add(symbol.file_path);
      }
    });
    const meta = document.createElement("div");
    meta.className = "model-section-meta";
    meta.textContent = `${formatCount(fileSet.size, "file", "files")} • ${formatCount(
      sectionSymbols.length,
      "symbol",
      "symbols"
    )}`;
    section.appendChild(meta);

    const list = document.createElement("ul");
    list.className = "model-tree-list";
    const fileNodes = buildModelTree(sectionSymbols);
    Array.from(fileNodes.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((node) => {
        list.appendChild(renderModelNode(node, modelGroupByFile));
      });
    section.appendChild(list);
    modelTreeEl.appendChild(section);
  };

  if (projectSymbols.length) {
    renderSection("Project", projectSymbols);

    modelTreeSelectionEl?.classList.remove("selected");
    modelTreeSelectionEl = null;
  } else if (!librarySymbols.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No symbols found in this workspace.";
    modelTreeEl.appendChild(empty);
  }

  if (showLibrarySymbols && librarySymbols.length) {
    renderSection("Library", librarySymbols);
  }

  if (unresolvedRefs.length) {
    const section = document.createElement("div");
    section.className = "model-unresolved";
    modelUnresolvedSectionEl = section;

    const header = document.createElement("div");
    header.className = "model-section-title";
    header.textContent = `Unresolved references (${unresolvedRefs.length})`;
    section.appendChild(header);

    const list = document.createElement("ul");
    list.className = "unresolved-list";
    unresolvedRefs.forEach((item) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "unresolved-row";
      const name = item.file_path ? item.file_path.split(/[\\/]/).pop() : "Unknown";
      const line = item.line ?? 0;
      const col = item.column ?? 0;
      const displayLine = line + 1;
      const displayCol = col + 1;
      row.textContent = `${item.message} (${name}:${displayLine}:${displayCol})`;
      row.title = item.file_path || "";
      row.addEventListener("click", async () => {
        if (!item.file_path) return;
        await openFileAt(item.file_path, line, col, line, col + 1);
      });
      list.appendChild(row);
    });

    section.appendChild(list);
    modelTreeEl.appendChild(section);
  }

  if (showPropertiesPane) {
    clearPropertiesPane();
  }
}

function renderModelNode(node, isFile) {
  const item = document.createElement("li");
  item.className = `model-node${isFile ? " model-file" : ""}`;

  const row = document.createElement("div");
  row.className = "model-row";

  const caret = document.createElement("button");
  caret.className = "model-caret";
  caret.type = "button";
  caret.textContent = node.children.size ? ">" : "";
  caret.disabled = !node.children.size;

  const badge = document.createElement("span");
  if (isFile) {
    badge.className = "kind-badge kind-file";
  } else if (node.symbol) {
    badge.className = `kind-badge kind-${normalizeKind(node.symbol.kind)}`;
  } else {
    badge.className = "kind-badge kind-other";
  }

  const label = document.createElement("span");
  if (node.symbol) {
    label.textContent = node.symbol.name;
  } else if (isFile) {
    const fileName = node.name.split(/[\\/]/).pop() || node.name;
    label.textContent = fileName;
  } else {
    label.textContent = node.name;
  }

  const tooltipLines = [];
  if (node.symbol) {
    tooltipLines.push(`Kind: ${node.symbol.kind}`);
    tooltipLines.push(`Qualified: ${node.symbol.qualified_name}`);
    tooltipLines.push(`File: ${node.symbol.file_path}`);
    tooltipLines.push(
      `Range: ${node.symbol.start_line + 1}:${node.symbol.start_col + 1} - ${node.symbol.end_line + 1}:${node.symbol.end_col + 1}`
    );
  } else {
    tooltipLines.push(`Name: ${node.name}`);
    if (isFile) {
      tooltipLines.push(`File: ${node.name}`);
    }
  }
  row.title = tooltipLines.join("\n");

  row.appendChild(caret);
  row.appendChild(badge);
  row.appendChild(label);
  item.appendChild(row);

  if (node.symbol?.qualified_name) {
    modelNodeIndex.set(node.symbol.qualified_name, row);
  }
  if (node.symbol?.name && !modelNodeNameIndex.has(node.symbol.name)) {
    modelNodeNameIndex.set(node.symbol.name, row);
  }
  if (node.symbol) {
    modelRowSymbolMap.set(row, node.symbol);
  }

  if (node.symbol) {
    const typeTarget = getTypeTarget(node.symbol);
    if (typeTarget) {
      row.dataset.typeTarget = typeTarget;
    }
  }

  row.addEventListener("contextmenu", (event) => {
    if (!row.dataset.typeTarget || !modelTreeMenuEl) return;
    event.preventDefault();
    modelTreeMenuTarget = row.dataset.typeTarget;
    modelTreeMenuEl.hidden = false;
    const rect = modelTreeMenuEl.getBoundingClientRect();
    const left = Math.min(event.clientX, window.innerWidth - rect.width - 8);
    const top = Math.min(event.clientY, window.innerHeight - rect.height - 8);
    modelTreeMenuEl.style.left = `${Math.max(8, left)}px`;
    modelTreeMenuEl.style.top = `${Math.max(8, top)}px`;
  });

  if (node.children.size) {
    const children = document.createElement("ul");
    children.className = "model-children";
    Array.from(node.children.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((child) => {
        children.appendChild(renderModelNode(child, false));
      });
    item.appendChild(children);

    const toggleCollapsed = (event) => {
      event?.stopPropagation();
      item.classList.toggle("collapsed");
      caret.textContent = item.classList.contains("collapsed") ? ">" : "v";
    };

    caret.addEventListener("click", toggleCollapsed);
    row.addEventListener("dblclick", toggleCollapsed);
  }

  if (node.symbol && node.symbol.file_path) {
    row.addEventListener("click", async (event) => {
      if (event.target === caret) return;
      selectModelRow(row);
      await openFileAt(
        node.symbol.file_path,
        node.symbol.start_line,
        node.symbol.start_col,
        node.symbol.end_line,
        node.symbol.end_col
      );
    });
  } else {
    row.addEventListener("click", () => {
      if (showPropertiesPane) {
        setPropertiesForSymbol(null);
      }
    });
  }

  return item;
}

function setModelTreeCollapsed(collapsed) {
  if (!modelTreeEl) return;
  const selector = modelGroupByFile ? ".model-node.model-file" : ".model-tree-list > .model-node";
  modelTreeEl.querySelectorAll(selector).forEach((node) => {
    if (collapsed) {
      node.classList.add("collapsed");
    } else {
      node.classList.remove("collapsed");
    }
    const caret = node.querySelector(":scope > .model-row .model-caret");
    if (caret) {
      caret.textContent = collapsed ? ">" : "v";
    }
  });
}

async function compileWorkspace() {
  if (!state.rootPath) {
    setCompileStatus("Select a root folder first");
    return;
  }
  if (activeCompileId) {
    setCompileStatus("Compile already running");
    return;
  }
  compileButton.disabled = true;
  setCompileStatus("Saving...");
  const runId = ++compileRunId;
  activeCompileId = runId;
  canceledCompileIds.delete(runId);
  setCompileFloat("running", "Saving...", "");

  const start = performance.now();
  try {
    await saveAllOpenFiles();
    setCompileStatus("Compiling...");
    setCompileFloat("running", "Compiling...", "");
    const result = await invoke("compile_workspace", {
      payload: { root: state.rootPath, run_id: runId },
    });
    if (canceledCompileIds.has(runId)) {
      return;
    }
    if (result.parse_failed) {
      const firstError = Array.isArray(result.files)
        ? result.files.find((file) => !file.ok)
        : null;
      const detail = document.createElement("div");
      if (firstError?.path) {
        const fileName = firstError.path.split(/[\\/]/).pop() || firstError.path;
        detail.textContent = `Syntax error in ${fileName}. `;
        const link = document.createElement("button");
        link.type = "button";
        link.className = "compile-float-link";
        link.textContent = "Open file";
        link.addEventListener("click", async () => {
          await openFile(firstError.path);
        });
        detail.appendChild(link);
      } else {
        detail.textContent = "Syntax errors found.";
      }
      setCompileFloat("error", "Build failed", detail);
      setCompileStatus("Compile failed: syntax errors found.");
      return;
    }
    lastCompile.symbols = result.symbols || [];
    lastCompile.files = result.files || [];
    lastCompile.unresolved = result.unresolved || [];
    lastCompile.libraryPath = result.library_path || "";
    lastCompile.durationMs = performance.now() - start;
    renderModelTree(
      lastCompile.symbols,
      lastCompile.files,
      lastCompile.unresolved,
      lastCompile.libraryPath
    );
    const totalSymbols = lastCompile.symbols.length;
    const durationMs = lastCompile.durationMs;
    const perSymbol = totalSymbols ? (durationMs / totalSymbols).toFixed(2) : "0.00";
    setCompileStatus(`Compiled ${totalSymbols} symbols - ${durationMs.toFixed(0)} ms - ${perSymbol} ms/symbol`);
    setCompileFloat("done", "Build complete", "");
    setTimeout(() => {
      if (compileRunId === runId && !canceledCompileIds.has(runId)) {
        hideCompileFloat();
      }
    }, 700);
  } catch (error) {
    if (!canceledCompileIds.has(runId)) {
      lastCompile.durationMs = null;
      setCompileStatus(`Compile failed: ${error}`);
      setCompileFloat("error", "Build failed", String(error || ""));
    }
  } finally {
    compileButton.disabled = false;
    canceledCompileIds.delete(runId);
    if (activeCompileId === runId) {
      activeCompileId = 0;
    }
  }
}

function setupSplitters() {
  let active = null;

  const onPointerMove = (event) => {
    if (!active) return;
    const rect = appBodyEl.getBoundingClientRect();
    const splitSize = parseFloat(getComputedStyle(appEl).getPropertyValue("--split-size")) || 8;

    if (active === "left") {
      const maxLeft = rect.width - MIN_CENTER - MIN_RIGHT - splitSize * 2;
      const leftWidth = Math.min(Math.max(event.clientX - rect.left, MIN_LEFT), maxLeft);
      appEl.style.setProperty("--left-width", `${leftWidth}px`);
    } else if (active === "right") {
      const maxRight = rect.width - MIN_CENTER - MIN_LEFT - splitSize * 2;
      const rightWidth = Math.min(Math.max(rect.right - event.clientX, MIN_RIGHT), maxRight);
      appEl.style.setProperty("--right-width", `${rightWidth}px`);
    }
  };

  const stopDrag = () => {
    active = null;
    appEl.classList.remove("dragging");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopDrag);
  };

  document.querySelectorAll(".split").forEach((split) => {
    split.addEventListener("pointerdown", (event) => {
      active = split.dataset.split;
      appEl.classList.add("dragging");
      split.setPointerCapture(event.pointerId);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", stopDrag);
    });
  });
}

function getParentPath(path) {
  const clean = path.replace(/[\\/]+$/, "");
  const lastSlash = Math.max(clean.lastIndexOf("\\"), clean.lastIndexOf("/"));
  if (lastSlash === -1) return clean;
  return clean.slice(0, lastSlash);
}

function showContextMenu(x, y, target) {
  if (!contextMenuEl) return;
  contextTarget = target;

  const isDir = target.isDir;
  contextMenuEl.querySelector('[data-action="set-root"]').disabled = !isDir;
  contextMenuEl.querySelector('[data-action="new-file"]').disabled = !isDir;
  contextMenuEl.querySelector('[data-action="new-folder"]').disabled = !isDir;
  const openInExplorer = contextMenuEl.querySelector('[data-action="open-in-explorer"]');
  if (openInExplorer) {
    openInExplorer.disabled = !target.path;
  }

  contextMenuEl.hidden = false;
  const rect = contextMenuEl.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  contextMenuEl.style.left = `${Math.max(8, left)}px`;
  contextMenuEl.style.top = `${Math.max(8, top)}px`;
}

function hideContextMenu() {
  if (!contextMenuEl) return;
  contextMenuEl.hidden = true;
  contextTarget = null;
}

async function handleContextAction(action) {
  if (!contextTarget || !state.rootPath) return;

  const targetPath = contextTarget.path;
  const targetIsDir = contextTarget.isDir;

  try {
    if (action === "set-root") {
      if (!targetIsDir) return;
      await loadRoot(targetPath);
      return;
    }

    if (action === "new-file") {
      const parent = targetIsDir ? targetPath : getParentPath(targetPath);
      showNewFileDialog(parent);
    }

    if (action === "new-folder") {
      const name = window.prompt("New folder name:");
      if (!name) return;
      const parent = targetIsDir ? targetPath : getParentPath(targetPath);
      await invoke("create_dir", { root: state.rootPath, parent, name });
      await loadRoot(state.rootPath);
    }

    if (action === "rename") {
      const currentName = targetPath.split(/[\\/]/).pop();
      const name = window.prompt("Rename to:", currentName || "");
      if (!name) return;
      await invoke("rename_path", { root: state.rootPath, path: targetPath, new_name: name });
      await loadRoot(state.rootPath);
    }

    if (action === "delete") {
      const ok = window.confirm("Delete this item? This cannot be undone.");
      if (!ok) return;
      await invoke("delete_path", { root: state.rootPath, path: targetPath });
      removeOpenFile(targetPath);
      state.lastSavedContent.delete(targetPath);
      setDirty(targetPath, false);
      if (state.currentFile === targetPath) {
        editor.setValue("");
        setCurrentFile(null);
        renderParseErrors({ path: "", errors: [] });
      }
      await loadRoot(state.rootPath);
    }

    if (action === "open-in-explorer") {
      await invoke("open_in_explorer", { path: targetPath });
    }
  } catch (error) {
    setCompileStatus(`Action failed: ${error}`);
  } finally {
    hideContextMenu();
  }
}

function showEditorTabsMenu(x, y, targetPath) {
  if (!editorTabsMenuEl) return;
  editorTabsMenuTarget = targetPath;

  const closeOthers = editorTabsMenuEl.querySelector('[data-action="close-others"]');
  if (closeOthers) {
    closeOthers.disabled = state.openFiles.length <= 1;
  }

  editorTabsMenuEl.hidden = false;
  const rect = editorTabsMenuEl.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  editorTabsMenuEl.style.left = `${Math.max(8, left)}px`;
  editorTabsMenuEl.style.top = `${Math.max(8, top)}px`;
}

function showEditorTabsOverflowMenu(x, y, items) {
  if (!editorTabsOverflowMenuEl) return;
  editorTabsOverflowMenuEl.innerHTML = "";
  items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.label;
    button.dataset.path = item.path;
    editorTabsOverflowMenuEl.appendChild(button);
  });
  editorTabsOverflowMenuEl.hidden = false;
  const rect = editorTabsOverflowMenuEl.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  editorTabsOverflowMenuEl.style.left = `${Math.max(8, left)}px`;
  editorTabsOverflowMenuEl.style.top = `${Math.max(8, top)}px`;
}

function hideEditorTabsOverflowMenu() {
  if (!editorTabsOverflowMenuEl) return;
  editorTabsOverflowMenuEl.hidden = true;
}

function hideEditorTabsMenu() {
  if (!editorTabsMenuEl) return;
  editorTabsMenuEl.hidden = true;
  editorTabsMenuTarget = null;
}

async function handleEditorTabsMenuAction(action) {
  if (!action) return;

  if (action === "close") {
    if (state.currentFile) {
      closeTabs([state.currentFile]);
    }
    hideEditorTabsMenu();
    return;
  }

  if (action === "close-all") {
    const toClose = [...state.openFiles];
    closeTabs(toClose);
    hideEditorTabsMenu();
    return;
  }

  if (action === "close-others") {
    const keep = editorTabsMenuTarget;
    if (!keep) {
      hideEditorTabsMenu();
      return;
    }
    if (keep !== state.currentFile) {
      await openFile(keep);
    }
    const toClose = state.openFiles.filter((path) => path !== keep);
    closeTabs(toClose);
    hideEditorTabsMenu();
  }
}

function setupEditorTabsMenu() {
  if (!editorTabsMenuEl) return;
  hideEditorTabsMenu();

  editorTabsMenuEl.addEventListener("click", async (event) => {
    const action = event.target?.dataset?.action;
    if (!action) return;
    await handleEditorTabsMenuAction(action);
  });

  document.addEventListener("click", (event) => {
    if (!editorTabsMenuEl.contains(event.target)) {
      hideEditorTabsMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideEditorTabsMenu();
    }
  });

  window.addEventListener("blur", hideEditorTabsMenu);
}

function showAppMenu(x, y) {
  if (!appMenuEl || !menuToggleBtn) return;
  appMenuEl.hidden = false;
  const rect = appMenuEl.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  appMenuEl.style.left = `${Math.max(8, left)}px`;
  appMenuEl.style.top = `${Math.max(8, top)}px`;
  menuToggleBtn.setAttribute("aria-expanded", "true");
}

function hideAppMenu() {
  if (!appMenuEl) return;
  appMenuEl.hidden = true;
  menuToggleBtn?.setAttribute("aria-expanded", "false");
}

function setupAppMenu() {
  if (!appMenuEl || !menuToggleBtn) return;
  hideAppMenu();

  menuToggleBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!appMenuEl.hidden) {
      hideAppMenu();
      return;
    }
    const rect = menuToggleBtn.getBoundingClientRect();
    showAppMenu(rect.left, rect.bottom + 4);
  });

  appMenuEl.addEventListener("click", async (event) => {
    const action = event.target?.dataset?.action;
    if (!action) return;
    await handleMenuAction(action);
    hideAppMenu();
  });

  document.addEventListener("click", (event) => {
    if (!appMenuEl.contains(event.target) && event.target !== menuToggleBtn) {
      hideAppMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideAppMenu();
    }
  });

  window.addEventListener("blur", hideAppMenu);
}

async function handleMenuAction(action) {
  if (action === "open-folder") {
    await chooseRoot();
  }
  if (action === "open-file") {
    if (!dialog?.open) {
      setCompileStatus("Dialog API not available");
      return;
    }
    const selected = await dialog.open({
      multiple: false,
      filters: [
        { name: "Models", extensions: ["sysml", "kerml"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (selected) {
      await openFile(selected);
    }
  }
  if (action === "compile-workspace") {
    await compileWorkspace();
  }
  if (action === "settings") {
    showSettingsDialog();
  }
  if (action === "new-project") {
    await showNewProjectDialog();
  }
  if (action === "view-log") {
    await showLogDialog();
  }
  if (action === "about") {
    window.alert("Mercurio\nPowered by Tauri + Syster");
  }
}

function setupEditorTabsOverflowMenu() {
  if (!editorTabsOverflowMenuEl) return;
  hideEditorTabsOverflowMenu();

  editorTabsOverflowMenuEl.addEventListener("click", async (event) => {
    const path = event.target?.dataset?.path;
    if (!path) return;
    await openFile(path);
    hideEditorTabsOverflowMenu();
  });

  document.addEventListener("click", (event) => {
    if (!editorTabsOverflowMenuEl.contains(event.target)) {
      hideEditorTabsOverflowMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideEditorTabsOverflowMenu();
    }
  });

  window.addEventListener("blur", hideEditorTabsOverflowMenu);
}

function hideModelTreeMenu() {
  if (!modelTreeMenuEl) return;
  modelTreeMenuEl.hidden = true;
  modelTreeMenuTarget = null;
}

function setupModelTreeMenu() {
  if (!modelTreeMenuEl) return;
  hideModelTreeMenu();

  modelTreeMenuEl.addEventListener("click", (event) => {
    const action = event.target?.dataset?.action;
    if (action !== "go-to-type") return;
    const target = modelTreeMenuTarget;
    if (!target) {
      hideModelTreeMenu();
      return;
    }
    const lookup = target.includes("::")
      ? modelNodeIndex.get(target)
      : modelNodeNameIndex.get(target);
    if (lookup) {
      selectModelRow(lookup);
    } else {
      setCompileStatus(`Type not found: ${target}`);
    }
    hideModelTreeMenu();
  });

  document.addEventListener("click", (event) => {
    if (!modelTreeMenuEl.contains(event.target)) {
      hideModelTreeMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideModelTreeMenu();
    }
  });

  window.addEventListener("blur", hideModelTreeMenu);
}

function setupContextMenu() {
  if (!contextMenuEl) return;
  hideContextMenu();

  contextMenuEl.addEventListener("click", (event) => {
    const action = event.target?.dataset?.action;
    if (!action) return;
    handleContextAction(action);
  });

  document.addEventListener("click", (event) => {
    if (!contextMenuEl.contains(event.target)) {
      hideContextMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideContextMenu();
    }
  });

  window.addEventListener("blur", hideContextMenu);
}

async function getAppWindow() {
  if (!windowApi) return null;
  if (windowApi.getCurrentWindow) {
    const current = windowApi.getCurrentWindow();
    return typeof current?.then === "function" ? await current : current;
  }
  if (windowApi.getCurrent) {
    const current = windowApi.getCurrent();
    return typeof current?.then === "function" ? await current : current;
  }
  return null;
}

async function setupWindowControls() {
  windowMinimizeBtn.addEventListener("click", async () => {
    try {
      await invoke("window_minimize");
    } catch (error) {
      setCompileStatus(`Minimize failed: ${error}`);
    }
  });

  windowMaximizeBtn.addEventListener("click", async () => {
    try {
      await invoke("window_toggle_maximize");
    } catch (error) {
      setCompileStatus(`Maximize failed: ${error}`);
    }
  });

  windowCloseBtn.addEventListener("click", async () => {
    try {
      await invoke("window_close");
    } catch (error) {
      setCompileStatus(`Close failed: ${error}`);
    }
  });

  document.querySelector(".titlebar")?.addEventListener("dblclick", async () => {
    try {
      await invoke("window_toggle_maximize");
    } catch (error) {
      setCompileStatus(`Maximize failed: ${error}`);
    }
  });
}

function setupMenuEvents() {
  if (!eventApi?.listen) return;
  eventApi.listen("menu-action", async (event) => {
    const action = event?.payload;
    if (action === "toggle-project") {
      appEl.classList.toggle("hide-project");
      syncPanelToggles();
      return;
    }
    await handleMenuAction(action);
  });
  eventApi.listen("compile-progress", (event) => {
    updateCompileProgress(event?.payload);
  });
  eventApi.listen("parse-error-select", async (event) => {
    const payload = event?.payload;
    if (!payload?.path) return;
    await openFileAt(payload.path, payload.line, payload.column, payload.line, payload.column + 1);
  });
  eventApi.listen("fs-changed", (event) => {
    if (!state.rootPath) return;
    const path = event?.payload?.path;
    if (!path || !path.startsWith(state.rootPath)) return;
    if (fsRefreshTimer) {
      clearTimeout(fsRefreshTimer);
    }
    fsRefreshTimer = setTimeout(async () => {
      fsRefreshTimer = null;
      try {
        const entries = await invoke("list_dir", { path: state.rootPath });
        renderFileTree(entries);
        if (state.currentFile) {
          const exists = await invoke("path_exists", { path: state.currentFile });
          if (!exists) {
            const removedPath = state.currentFile;
            editor?.setValue("");
            removeOpenFile(removedPath);
            setCurrentFile(null);
            renderParseErrors({ path: "", errors: [] });
            state.lastSavedContent.delete(removedPath);
            setDirty(removedPath, false);
          }
        }
      } catch (error) {
        setCompileStatus(`Refresh failed: ${error}`);
      }
    }, 250);
  });
}

function updateCursorStatus() {
  if (!editor || !statusPositionEl) return;
  const pos = editor.getPosition();
  if (!pos) return;
  statusPositionEl.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`;
}

window.addEventListener("DOMContentLoaded", async () => {
  rootApplyButton = document.querySelector("#root-apply");
  newFileButton = document.querySelector("#new-file");
  recentProjectsEl = document.querySelector("#recent-projects");
  projectInfoButton = document.querySelector("#project-info");
  projectInfoDialogEl = document.querySelector("#project-info-dialog");
  projectInfoFileEl = document.querySelector("#project-info-file");
  projectInfoLibraryEl = document.querySelector("#project-info-library");
  projectInfoSrcEl = document.querySelector("#project-info-src");
  projectInfoErrorEl = document.querySelector("#project-info-error");
  projectInfoCreateBlockEl = document.querySelector("#project-info-create-block");
  projectInfoTemplateEl = document.querySelector("#project-info-template");
  projectInfoCreateBtn = document.querySelector("#project-info-create");
  newFileDialogEl = document.querySelector("#new-file-dialog");
  newFileNameEl = document.querySelector("#new-file-name");
  newFileTypeEl = document.querySelector("#new-file-type");
  newFileCreateBtn = document.querySelector("#new-file-create");
  newProjectDialogEl = document.querySelector("#new-project-dialog");
  newProjectLocationEl = document.querySelector("#new-project-location");
  newProjectLocationPickEl = document.querySelector("#new-project-location-pick");
  newProjectNameEl = document.querySelector("#new-project-name");
  newProjectFolderEl = document.querySelector("#new-project-folder");
  newProjectFolderStatusEl = document.querySelector("#new-project-folder-status");
  newProjectDefaultLibEl = document.querySelector("#new-project-default-lib");
  newProjectCreateBtn = document.querySelector("#new-project-create");
  logDialogEl = document.querySelector("#log-dialog");
  logOutputEl = document.querySelector("#log-output");
  logRefreshBtn = document.querySelector("#log-refresh");
  settingsDialogEl = document.querySelector("#settings-dialog");
  settingsThemeEl = document.querySelector("#settings-theme");
  rootPathEl = document.querySelector("#root-path");
  compileButton = document.querySelector("#compile-button");
  currentFileEl = document.querySelector("#current-file");
  fileTreeEl = document.querySelector("#file-tree");
  modelTreeEl = document.querySelector("#model-tree");
  compileStatusEl = document.querySelector("#compile-status");
  titlebarProjectEl = document.querySelector("#titlebar-project");
  modelTreeMenuEl = document.querySelector("#model-tree-menu");
  appEl = document.querySelector(".app");
  appBodyEl = document.querySelector(".app-body");
  contextMenuEl = document.querySelector("#context-menu");
  windowMinimizeBtn = document.querySelector("#window-minimize");
  windowMaximizeBtn = document.querySelector("#window-maximize");
  windowCloseBtn = document.querySelector("#window-close");
  statusMessageEl = document.querySelector("#status-message");
  statusFileEl = document.querySelector("#status-file");
  statusPositionEl = document.querySelector("#status-position");
  statusUnresolvedEl = document.querySelector("#status-unresolved");
  compileFloatEl = document.querySelector("#compile-float");
  compileFloatMessageEl = document.querySelector("#compile-float-message");
  compileFloatDetailEl = document.querySelector("#compile-float-detail");
  compileFloatCancelBtn = document.querySelector("#compile-float-cancel");
  errorsFileEl = document.querySelector("#errors-file");
  errorsListEl = document.querySelector("#errors-list");
  errorsEmptyEl = document.querySelector("#errors-empty");
  errorsSectionEl = document.querySelector("#parse-errors");
  parseToggleEl = document.querySelector("#parse-toggle");
  editorTabsEl = document.querySelector("#editor-tabs");
  editorTabsMenuEl = document.querySelector("#editor-tabs-menu");
  editorTabsOverflowMenuEl = document.querySelector("#editor-tabs-overflow-menu");
  editorPanelEl = document.querySelector(".editor-panel");
  modelExpandAllBtn = document.querySelector("#model-expand-all");
  modelCollapseAllBtn = document.querySelector("#model-collapse-all");
  modelGroupToggleBtn = document.querySelector("#model-group-toggle");
  modelLibraryToggleBtn = document.querySelector("#model-library-toggle");
  modelPropertiesToggleBtn = document.querySelector("#model-properties-toggle");
  modelPropertiesEl = document.querySelector("#model-properties");
  modelPropertiesBodyEl = document.querySelector("#model-properties-body");
  modelPropertiesCloseBtn = document.querySelector("#model-properties-close");
  modelPropertiesSplitEl = document.querySelector("#model-properties-split");
  appMenuEl = document.querySelector("#app-menu");
  menuToggleBtn = document.querySelector("#menu-toggle");
  toggleProjectBtn = document.querySelector("#toggle-project");
  toggleModelTreeBtn = document.querySelector("#toggle-model-tree");
  restoreProjectBtn = document.querySelector("#restore-project");
  restoreModelTreeBtn = document.querySelector("#restore-model-tree");
  updateEditorEmptyState();
  updateRecentProjectsMenu(loadRecentProjects());
  syncPanelToggles();
  updateModelGroupToggle();
  updateModelLibraryToggle();
  updatePropertiesToggle();
  currentTheme = loadStoredTheme();
  applyTheme(currentTheme);
  modelTreeEl?.addEventListener("contextmenu", (event) => {
    if (!event.target.closest(".model-row")) {
      event.preventDefault();
    }
  });

  rootApplyButton.addEventListener("click", async () => {
    await chooseRoot();
  });
  recentProjectsEl?.addEventListener("change", async (event) => {
    const value = event.target.value;
    if (!value) return;
    await loadRoot(value);
    event.target.value = "";
  });
  toggleProjectBtn?.addEventListener("click", () => {
    appEl.classList.toggle("hide-project");
    syncPanelToggles();
  });
  toggleModelTreeBtn?.addEventListener("click", () => {
    appEl.classList.toggle("hide-model-tree");
    syncPanelToggles();
  });
  restoreProjectBtn?.addEventListener("click", () => {
    appEl.classList.remove("hide-project");
    syncPanelToggles();
  });
  restoreModelTreeBtn?.addEventListener("click", () => {
    appEl.classList.remove("hide-model-tree");
    syncPanelToggles();
  });
  newFileButton?.addEventListener("click", () => {
    showNewFileDialog(state.rootPath);
  });
  projectInfoButton?.addEventListener("click", async () => {
    await showProjectInfoDialog();
  });
  projectInfoCreateBtn?.addEventListener("click", async () => {
    if (!state.rootPath || !projectInfoTemplateEl) return;
    const content = projectInfoTemplateEl.value || getDefaultProjectConfigText();
    try {
      const path = joinPath(state.rootPath, ".project.json");
      await invoke("write_file", { path, content });
      await loadProjectConfig(state.rootPath);
      updateProjectInfoDialog();
      setCompileStatus("Created .project.json");
    } catch (error) {
      setCompileStatus(`Create .project.json failed: ${error}`);
      state.projectConfigError = `Invalid .project.json: ${error}`;
      updateProjectInfoDialog();
    }
  });
  newFileCreateBtn?.addEventListener("click", async () => {
    await createNewFileFromDialog();
  });
  newProjectCreateBtn?.addEventListener("click", async () => {
    await createNewProject();
  });
  logRefreshBtn?.addEventListener("click", async () => {
    await showLogDialog();
  });
  newFileDialogEl?.addEventListener("click", (event) => {
    const action = event.target?.dataset?.action;
    if (action === "close") {
      hideNewFileDialog();
    }
  });
  logDialogEl?.addEventListener("click", (event) => {
    const action = event.target?.dataset?.action;
    if (action === "close") {
      hideLogDialog();
    }
  });
  settingsDialogEl?.addEventListener("click", (event) => {
    const action = event.target?.dataset?.action;
    if (action === "close") {
      hideSettingsDialog();
    }
  });
  newProjectDialogEl?.addEventListener("click", (event) => {
    const action = event.target?.dataset?.action;
    if (action === "close") {
      hideNewProjectDialog();
    }
  });
  projectInfoDialogEl?.addEventListener("click", (event) => {
    const action = event.target?.dataset?.action;
    if (action === "close") {
      hideProjectInfoDialog();
    }
  });
  newFileNameEl?.addEventListener("keydown", async (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      await createNewFileFromDialog();
    }
    if (event.key === "Escape") {
      hideNewFileDialog();
    }
  });
  newFileDialogEl?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideNewFileDialog();
    }
  });
  newProjectDialogEl?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideNewProjectDialog();
    }
  });
  logDialogEl?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideLogDialog();
    }
  });
  settingsDialogEl?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideSettingsDialog();
    }
  });
  newProjectLocationPickEl?.addEventListener("click", async () => {
    if (!dialog?.open) {
      setCompileStatus("Dialog API not available");
      return;
    }
    const selected = await dialog.open({
      directory: true,
      multiple: false,
      defaultPath: newProjectLocationEl?.value || undefined,
    });
    if (selected && newProjectLocationEl) {
      newProjectLocationEl.value = selected;
      updateProjectFolderStatus();
    }
  });
  newProjectNameEl?.addEventListener("input", () => {
    const slug = slugifyName(newProjectNameEl.value);
    newProjectFolderEl.textContent = slug || "";
    updateProjectFolderStatus();
  });
  newProjectLocationEl?.addEventListener("input", () => {
    updateProjectFolderStatus();
  });
  projectInfoDialogEl?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideProjectInfoDialog();
    }
  });
  settingsThemeEl?.addEventListener("change", (event) => {
    const next = event.target.value;
    applyTheme(next);
  });
  parseToggleEl?.addEventListener("click", () => {
    parseErrorsExpanded = !parseErrorsExpanded;
    parseToggleEl.setAttribute("aria-expanded", String(parseErrorsExpanded));
    if (errorsSectionEl) {
      errorsSectionEl.classList.toggle("expanded", parseErrorsExpanded);
    }
  });
  modelExpandAllBtn?.addEventListener("click", () => {
    setModelTreeCollapsed(false);
  });
  modelCollapseAllBtn?.addEventListener("click", () => {
    setModelTreeCollapsed(true);
  });
  modelGroupToggleBtn?.addEventListener("click", () => {
    modelGroupByFile = !modelGroupByFile;
    updateModelGroupToggle();
    renderModelTree(
      lastCompile.symbols,
      lastCompile.files,
      lastCompile.unresolved,
      lastCompile.libraryPath
    );
  });
  modelLibraryToggleBtn?.addEventListener("click", () => {
    showLibrarySymbols = !showLibrarySymbols;
    updateModelLibraryToggle();
    renderModelTree(
      lastCompile.symbols,
      lastCompile.files,
      lastCompile.unresolved,
      lastCompile.libraryPath
    );
  });
  modelPropertiesToggleBtn?.addEventListener("click", () => {
    showPropertiesPane = !showPropertiesPane;
    updatePropertiesToggle();
  });
  modelPropertiesCloseBtn?.addEventListener("click", () => {
    showPropertiesPane = false;
    updatePropertiesToggle();
  });
  modelPropertiesSplitEl?.addEventListener("pointerdown", (event) => {
    if (!modelPropertiesEl) return;
    const startY = event.clientY;
    const startHeight = modelPropertiesEl.getBoundingClientRect().height;
    const minHeight = 120;
    const maxHeight = Math.max(minHeight, appEl.getBoundingClientRect().height / 2);
    appEl.classList.add("dragging");
    modelPropertiesSplitEl.setPointerCapture(event.pointerId);

    const onMove = (moveEvent) => {
      const delta = startY - moveEvent.clientY;
      const next = Math.min(maxHeight, Math.max(minHeight, startHeight + delta));
      appEl.style.setProperty("--model-props-height", `${next}px`);
    };

    const onUp = () => {
      appEl.classList.remove("dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  window.addEventListener("resize", () => {
    if (state.openFiles.length) {
      renderEditorTabs();
    }
  });
  compileButton.addEventListener("click", compileWorkspace);
  compileFloatCancelBtn?.addEventListener("click", () => {
    if (activeCompileId) {
      const runId = activeCompileId;
      canceledCompileIds.add(runId);
      invoke("cancel_compile", { run_id: runId }).catch(() => {});
      setCompileStatus("Compile canceled");
      hideCompileFloat();
      return;
    }
    hideCompileFloat();
  });
  statusUnresolvedEl?.addEventListener("click", () => {
    if (!modelUnresolvedSectionEl) return;
    appEl?.classList.remove("hide-model-tree");
    syncPanelToggles();
    modelUnresolvedSectionEl.scrollIntoView({ block: "start", behavior: "smooth" });
  });
  errorsListEl?.addEventListener("click", async (event) => {
    const item = event.target.closest(".error-item");
    if (!item) return;
    const path = item.dataset.path;
    if (!path) return;
    await openFileAt(
      path,
      Number(item.dataset.line),
      Number(item.dataset.column),
      Number(item.dataset.line),
      Number(item.dataset.column) + 1
    );
  });
  document.addEventListener("keydown", async (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      await saveCurrentFile();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
      event.preventDefault();
      await compileWorkspace();
    }
  });

  await loadMonaco();
  registerSysmlLanguage();
  editor = window.monaco.editor.create(document.querySelector("#editor"), {
    value: "",
    language: "sysml",
    theme: currentTheme,
    automaticLayout: true,
    minimap: { enabled: false },
    selectionHighlight: false,
    occurrencesHighlight: "off",
    matchBrackets: "always",
    fontFamily: "IBM Plex Mono, Consolas, 'Courier New', monospace",
    fontSize: 14,
    lineNumbers: "on",
    renderLineHighlight: "line",
  });
  editor.onDidChangeCursorPosition(() => updateCursorStatus());
  editor.onDidChangeModelContent(() => {
    if (!editor || isSettingEditorValue) return;
    if (!state.currentFile) return;
    const saved = state.lastSavedContent.get(state.currentFile) ?? "";
    const current = editor.getValue();
    setDirty(state.currentFile, current !== saved);
    scheduleParseRefresh(state.currentFile);
  });
  updateCursorStatus();
  editorReadyResolve?.();

  if (pendingOpen) {
    const pending = pendingOpen;
    pendingOpen = null;
    if (pending.type === "range") {
      await openFileAt(
        pending.path,
        pending.line,
        pending.column,
        pending.endLine,
        pending.endColumn
      );
    } else if (pending.type === "file") {
      await openFile(pending.path);
    }
  }

  setupSplitters();
  setupEditorTabsMenu();
  setupEditorTabsOverflowMenu();
  setupModelTreeMenu();
  setupContextMenu();
  setupMenuEvents();
  setupAppMenu();
  await setupWindowControls();

  try {
    let startup = null;
    try {
      startup = await invoke("get_startup_path");
    } catch (error) {
      setCompileStatus(`Startup path failed: ${error}`);
    }
    if (startup?.path) {
      if (startup.kind === "dir") {
        await loadRoot(startup.path);
      } else {
        const parent = getParentPath(startup.path);
        if (parent) {
          await loadRoot(parent);
        }
        await openFile(startup.path);
      }
      return;
    }
    const savedRoot = window.localStorage?.getItem(ROOT_STORAGE_KEY);
    if (savedRoot) {
      await loadRoot(savedRoot);
    } else {
      const defaultRoot = await invoke("get_default_root");
      await loadRoot(defaultRoot);
    }
  } catch (error) {
    setCompileStatus(`Failed to initialize: ${error}`);
  }
});

