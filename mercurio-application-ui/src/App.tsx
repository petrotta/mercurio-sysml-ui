import "./style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import MonacoEditor, { loader, type OnMount } from "@monaco-editor/react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RECENTS_KEY, ROOT_STORAGE_KEY, THEME_KEY } from "./app/constants";
import { useProjectTree } from "./app/useProjectTree";
import { readFileText } from "./app/fileOps";
import { useCompileRunner } from "./app/useCompileRunner";
import { useSemanticSelection } from "./app/useSemanticSelection";
import { getDefaultStdlib, getProjectModel } from "./app/services/semanticApi";
import { CombinedPropertiesPane } from "./app/components/CombinedPropertiesPane";
import { parseErrorLocation } from "./app/parseErrors";
import type { FileEntry, SymbolView } from "./app/types";

loader.config({ paths: { vs: "/monaco/vs" } });

type TextSelection = {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
};

type HarnessRun = {
  id: number;
  kind: "project" | "file";
  ok: boolean;
  budgetOk: boolean;
  durationMs: number;
  progressUpdates: number;
  at: string;
};

type SymbolTreeNode = {
  symbol: SymbolView;
  children: SymbolTreeNode[];
};

type EditorTab = {
  path: string;
  name: string;
  content: string;
  dirty: boolean;
};

type TabContextMenuState = {
  path: string;
  x: number;
  y: number;
};

type CacheClearSummary = {
  workspace_snapshot_entries: number;
  metamodel_entries: number;
  parsed_file_entries: number;
  file_mtime_entries: number;
  canceled_compile_entries: number;
  symbol_index_cleared?: boolean;
  project_ir_cache_deleted?: boolean;
};

type BackgroundJobView = {
  id: number;
  kind: string;
  detail?: string | null;
  started_at_ms: number;
  cancelable: boolean;
  compile_run_id?: number | null;
};

type BackgroundJobsSnapshot = {
  total: number;
  cancelable: number;
  jobs: BackgroundJobView[];
};

type BackgroundCancelSummary = {
  active_jobs: number;
  cancelable_jobs: number;
  compile_cancel_requests: number;
};

type StdlibPathOption = {
  id: string;
  name: string;
  path: string;
};

const FILE_SYMBOL_RENDER_LIMIT = 300;
const HARNESS_COMPILE_BUDGET_MS = 2000;
const HARNESS_PROGRESS_UPDATE_BUDGET = 24;
const SYSML_LANGUAGE_ID = "mercurio-sysml";
const LEFT_PANE_WIDTH_KEY = "mercurio.simpleUi.leftPaneWidth";
const DEFAULT_LEFT_PANE_WIDTH = 320;
const LEFT_PANE_MIN_WIDTH = 220;
const LEFT_PANE_MAX_WIDTH = 760;
const RIGHT_PANE_WIDTH_KEY = "mercurio.simpleUi.rightPaneWidth";
const DEFAULT_RIGHT_PANE_WIDTH = 420;
const RIGHT_PANE_MIN_WIDTH = 300;
const RIGHT_PANE_MAX_WIDTH = 820;
const CENTER_PANE_MIN_WIDTH = 480;
const MAIN_LAYOUT_NON_CONTENT_WIDTH = 32;
const MAX_RECENT_PROJECTS = 12;
const RECENT_PROJECT_BROWSE_VALUE = "__browse__";
const BUILD_PROGRESS_VISIBLE_KEY = "mercurio.simpleUi.buildProgressVisible";
const HARNESS_COLLAPSED_KEY = "mercurio.simpleUi.harnessCollapsed";
const STDLIB_PATH_OPTIONS_KEY = "mercurio.simpleUi.stdlibPathOptions";
const PARSE_MARKER_OWNER = "mercurio.parse";
let sysmlLanguageRegistered = false;

function createStdlibOptionId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function normalizePath(path: string | null | undefined): string {
  return (path || "").replace(/\//g, "\\").toLowerCase();
}

function symbolIdentity(symbol: SymbolView): string {
  return `${normalizePath(symbol.file_path)}|${symbol.qualified_name || symbol.name}|${symbol.start_line}|${symbol.start_col}`;
}

function clampLeftPaneWidth(next: number, viewportWidth: number, rightPaneWidth: number): number {
  const safeViewport = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1280;
  const maxByViewport = Math.max(
    LEFT_PANE_MIN_WIDTH,
    safeViewport - MAIN_LAYOUT_NON_CONTENT_WIDTH - CENTER_PANE_MIN_WIDTH - rightPaneWidth,
  );
  const maxWidth = Math.max(LEFT_PANE_MIN_WIDTH, Math.min(LEFT_PANE_MAX_WIDTH, maxByViewport));
  const value = Number.isFinite(next) ? next : DEFAULT_LEFT_PANE_WIDTH;
  return Math.max(LEFT_PANE_MIN_WIDTH, Math.min(maxWidth, Math.round(value)));
}

function clampRightPaneWidth(next: number, viewportWidth: number, leftPaneWidth: number): number {
  const safeViewport = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1280;
  const maxByViewport = Math.max(
    RIGHT_PANE_MIN_WIDTH,
    safeViewport - MAIN_LAYOUT_NON_CONTENT_WIDTH - CENTER_PANE_MIN_WIDTH - leftPaneWidth,
  );
  const maxWidth = Math.max(RIGHT_PANE_MIN_WIDTH, Math.min(RIGHT_PANE_MAX_WIDTH, maxByViewport));
  const value = Number.isFinite(next) ? next : DEFAULT_RIGHT_PANE_WIDTH;
  return Math.max(RIGHT_PANE_MIN_WIDTH, Math.min(maxWidth, Math.round(value)));
}

function parseLeftPaneWidth(raw: string | null, viewportWidth: number, rightPaneWidth: number): number {
  const parsed = Number(raw || "");
  return clampLeftPaneWidth(parsed, viewportWidth, rightPaneWidth);
}

function parseRightPaneWidth(raw: string | null, viewportWidth: number, leftPaneWidth: number): number {
  const parsed = Number(raw || "");
  return clampRightPaneWidth(parsed, viewportWidth, leftPaneWidth);
}

function readRecentProjects(): string[] {
  try {
    const raw = window.localStorage?.getItem(RECENTS_KEY) || "[]";
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of parsed) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed) continue;
      const key = normalizePath(trimmed);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
      if (out.length >= MAX_RECENT_PROJECTS) break;
    }
    return out;
  } catch {
    return [];
  }
}

function pushRecentProject(path: string, previous: string[]): string[] {
  const trimmed = (path || "").trim();
  if (!trimmed) return previous;
  const next = [trimmed, ...previous.filter((entry) => normalizePath(entry) !== normalizePath(trimmed))];
  return next.slice(0, MAX_RECENT_PROJECTS);
}

function readStdlibPathOptions(): StdlibPathOption[] {
  try {
    const raw = window.localStorage?.getItem(STDLIB_PATH_OPTIONS_KEY) || "[]";
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seenIds = new Set<string>();
    const out: StdlibPathOption[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const name = typeof item.name === "string" ? item.name.trim() : "";
      const path = typeof item.path === "string" ? item.path.trim() : "";
      if (!name && !path) continue;
      let id = typeof item.id === "string" ? item.id.trim() : "";
      if (!id || seenIds.has(id)) {
        id = createStdlibOptionId();
      }
      seenIds.add(id);
      out.push({
        id,
        name: name || displayNameForPath(path) || `Stdlib ${out.length + 1}`,
        path,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function persistStdlibPathOptions(options: StdlibPathOption[]): void {
  try {
    const normalized = options
      .map((item) => ({
        id: `${item.id || ""}`.trim() || createStdlibOptionId(),
        name: `${item.name || ""}`.trim(),
        path: `${item.path || ""}`.trim(),
      }))
      .filter((item) => item.name || item.path);
    window.localStorage?.setItem(STDLIB_PATH_OPTIONS_KEY, JSON.stringify(normalized));
  } catch {
    // best-effort persistence
  }
}

function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return "-";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below.
  }
  try {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.setAttribute("readonly", "true");
    textArea.style.position = "fixed";
    textArea.style.left = "-10000px";
    textArea.style.top = "-10000px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textArea);
    return copied;
  } catch {
    return false;
  }
}

function compareSymbols(a: SymbolView, b: SymbolView): number {
  const lineDelta = (a.start_line || 0) - (b.start_line || 0);
  if (lineDelta !== 0) return lineDelta;
  const colDelta = (a.start_col || 0) - (b.start_col || 0);
  if (colDelta !== 0) return colDelta;
  const nameDelta = (a.name || "").localeCompare(b.name || "");
  if (nameDelta !== 0) return nameDelta;
  return (a.kind || "").localeCompare(b.kind || "");
}

function parentQualifiedName(qualifiedName: string | null | undefined): string {
  const value = (qualifiedName || "").trim();
  if (!value) return "";
  const idx = value.lastIndexOf("::");
  if (idx <= 0) return "";
  return value.slice(0, idx);
}

function buildSymbolOwnershipTree(symbols: SymbolView[]): SymbolTreeNode[] {
  if (!symbols.length) return [];
  const nodes: SymbolTreeNode[] = symbols.map((symbol) => ({ symbol, children: [] }));
  const qnameToIndices = new Map<string, number[]>();
  symbols.forEach((symbol, index) => {
    const qname = (symbol.qualified_name || "").trim();
    if (!qname) return;
    const bucket = qnameToIndices.get(qname);
    if (bucket) {
      bucket.push(index);
    } else {
      qnameToIndices.set(qname, [index]);
    }
  });

  const rootIndices: number[] = [];
  symbols.forEach((symbol, index) => {
    const parentQname = parentQualifiedName(symbol.qualified_name);
    if (!parentQname) {
      rootIndices.push(index);
      return;
    }
    const candidates = qnameToIndices.get(parentQname) || [];
    let parentIndex = -1;
    const childLine = symbol.start_line || 0;
    for (const candidateIndex of candidates) {
      if (candidateIndex === index) continue;
      const candidateLine = symbols[candidateIndex]?.start_line || 0;
      if (candidateLine <= childLine) {
        if (parentIndex < 0) {
          parentIndex = candidateIndex;
        } else {
          const previousLine = symbols[parentIndex]?.start_line || 0;
          if (candidateLine >= previousLine) {
            parentIndex = candidateIndex;
          }
        }
      }
    }
    if (parentIndex < 0 && candidates.length) {
      const fallback = candidates[candidates.length - 1];
      if (fallback !== undefined && fallback !== index) {
        parentIndex = fallback;
      }
    }
    if (parentIndex >= 0) {
      nodes[parentIndex]?.children.push(nodes[index]);
    } else {
      rootIndices.push(index);
    }
  });

  const sortNodes = (items: SymbolTreeNode[]) => {
    items.sort((a, b) => compareSymbols(a.symbol, b.symbol));
    items.forEach((item) => sortNodes(item.children));
  };
  const roots = rootIndices
    .map((index) => nodes[index])
    .filter((node): node is SymbolTreeNode => !!node);
  sortNodes(roots);
  return roots;
}

function fileExtension(path: string | null | undefined): string {
  const value = path || "";
  const idx = value.lastIndexOf(".");
  return idx >= 0 ? value.slice(idx).toLowerCase() : "";
}

function displayNameForPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function parseErrorToMarker(
  monaco: Parameters<OnMount>[1],
  message: string,
): {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  message: string;
  severity: number;
} {
  const loc = parseErrorLocation(message);
  const line = Math.max(1, loc?.line || 1);
  const col = Math.max(1, loc?.col || 1);
  return {
    startLineNumber: line,
    startColumn: col,
    endLineNumber: line,
    endColumn: col + 1,
    message,
    severity: monaco.MarkerSeverity.Error,
  };
}

function editorLanguageForPath(path: string | null | undefined): string {
  const ext = fileExtension(path);
  if (ext === ".sysml" || ext === ".kerml") return SYSML_LANGUAGE_ID;
  if (ext === ".json") return "json";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  if (ext === ".xml") return "xml";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".rs") return "rust";
  if (ext === ".ts") return "typescript";
  if (ext === ".tsx") return "typescript";
  if (ext === ".js") return "javascript";
  if (ext === ".jsx") return "javascript";
  if (ext === ".toml") return "ini";
  return "plaintext";
}

function ensureSysmlLanguage(monaco: Parameters<OnMount>[1]): void {
  if (sysmlLanguageRegistered) return;
  monaco.languages.register({
    id: SYSML_LANGUAGE_ID,
    extensions: [".sysml", ".kerml"],
    aliases: ["SysML", "KerML"],
  });
  monaco.languages.setLanguageConfiguration(SYSML_LANGUAGE_ID, {
    comments: {
      lineComment: "//",
      blockComment: ["/*", "*/"],
    },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"" },
    ],
  });
  monaco.languages.setMonarchTokensProvider(SYSML_LANGUAGE_ID, {
    keywords: [
      "package", "private", "public", "import", "part", "attribute", "port", "item",
      "action", "state", "transition", "connection", "connector", "interface", "enum",
      "requirement", "constraint", "allocation", "satisfy", "verify", "perform", "flow",
      "return", "if", "then", "else", "for", "while", "true", "false", "null",
      "specializes", "redefines", "subsets", "extends", "abstract",
    ],
    operators: ["=", ":", "::", "->", ".", ",", ";", "+", "-", "*", "/", "%", "<", ">", "<=", ">="],
    symbols: /[=><!~?:&|+\-*\/\^%]+/,
    tokenizer: {
      root: [
        [/[a-zA-Z_][\w-]*/, {
          cases: {
            "@keywords": "keyword",
            "@default": "identifier",
          },
        }],
        [/[{}()[\]]/, "@brackets"],
        [/@symbols/, {
          cases: {
            "@operators": "operator",
            "@default": "",
          },
        }],
        [/\d+(\.\d+)?/, "number"],
        [/".*?"/, "string"],
        [/'[^']*'/, "string"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/./, "comment"],
      ],
    },
  });
  sysmlLanguageRegistered = true;
}

function isSemanticSource(path: string | null | undefined): boolean {
  const value = (path || "").toLowerCase();
  return value.endsWith(".sysml") || value.endsWith(".kerml");
}

function symbolSelection(symbol: SymbolView): TextSelection {
  const startLine = Math.max(1, symbol.start_line || 1);
  const startCol = Math.max(1, symbol.start_col || 1);
  const endLine = Math.max(startLine, symbol.end_line || symbol.start_line || 1);
  let endCol = Math.max(1, symbol.end_col || symbol.start_col || 1);
  if (endLine === startLine && endCol <= startCol) {
    endCol = startCol + 1;
  }
  return { startLine, startCol, endLine, endCol };
}

export function App() {
  const initialViewportWidth =
    window.innerWidth
    || document.documentElement?.clientWidth
    || DEFAULT_LEFT_PANE_WIDTH + DEFAULT_RIGHT_PANE_WIDTH + CENTER_PANE_MIN_WIDTH + MAIN_LAYOUT_NON_CONTENT_WIDTH;
  const initialRightPaneWidth = parseRightPaneWidth(
    window.localStorage?.getItem(RIGHT_PANE_WIDTH_KEY) || null,
    initialViewportWidth,
    DEFAULT_LEFT_PANE_WIDTH,
  );
  const [rootPath, setRootPath] = useState<string>(() => window.localStorage?.getItem(ROOT_STORAGE_KEY) || "");
  const [recentProjects, setRecentProjects] = useState<string[]>(() => readRecentProjects());
  const [recentPickerValue, setRecentPickerValue] = useState("");
  const [treeError, setTreeError] = useState("");
  const [appTheme, setAppTheme] = useState<"dark" | "light">(
    (window.localStorage?.getItem(THEME_KEY) as "dark" | "light") || "dark",
  );
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<EditorTab[]>([]);
  const [dirty, setDirty] = useState(false);
  const [cursorPos, setCursorPos] = useState<{ line: number; col: number } | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<SymbolView | null>(null);
  const [semanticSelectedQname, setSemanticSelectedQname] = useState("");
  const [harnessRuns, setHarnessRuns] = useState<HarnessRun[]>([]);
  const [harnessRunning, setHarnessRunning] = useState(false);
  const [harnessCollapsed, setHarnessCollapsed] = useState<boolean>(() =>
    window.localStorage?.getItem(HARNESS_COLLAPSED_KEY) === "1",
  );
  const [backgroundJobs, setBackgroundJobs] = useState<BackgroundJobsSnapshot>({
    total: 0,
    cancelable: 0,
    jobs: [],
  });
  const [expandedFileSymbols, setExpandedFileSymbols] = useState<Record<string, boolean>>({});
  const [expandedLibraryFiles, setExpandedLibraryFiles] = useState<Record<string, boolean>>({});
  const [projectFilesExpanded, setProjectFilesExpanded] = useState(true);
  const [libraryFilesExpanded, setLibraryFilesExpanded] = useState(true);
  const [menuOpen, setMenuOpen] = useState<"file" | "build" | "settings" | "help" | null>(null);
  const [stdlibManagerOpen, setStdlibManagerOpen] = useState(false);
  const [stdlibPathOptions, setStdlibPathOptions] = useState<StdlibPathOption[]>(() => readStdlibPathOptions());
  const [dialogActiveStdlibPath, setDialogActiveStdlibPath] = useState("");
  const [dialogDefaultStdlibId, setDialogDefaultStdlibId] = useState<string | null>(null);
  const [dialogStdlibMetaLoading, setDialogStdlibMetaLoading] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState | null>(null);
  const [tabsOverflow, setTabsOverflow] = useState(false);
  const [tabsOverflowMenuOpen, setTabsOverflowMenuOpen] = useState(false);
  const [dragTabPath, setDragTabPath] = useState<string | null>(null);
  const [dragOverTabPath, setDragOverTabPath] = useState<string | null>(null);
  const [buildProgressVisible, setBuildProgressVisible] = useState<boolean>(() =>
    window.localStorage?.getItem(BUILD_PROGRESS_VISIBLE_KEY) !== "0",
  );
  const [rightPaneWidth, setRightPaneWidth] = useState<number>(() => initialRightPaneWidth);
  const [leftPaneWidth, setLeftPaneWidth] = useState<number>(() =>
    parseLeftPaneWidth(
      window.localStorage?.getItem(LEFT_PANE_WIDTH_KEY) || null,
      initialViewportWidth,
      initialRightPaneWidth,
    ),
  );
  const [leftPaneDragging, setLeftPaneDragging] = useState(false);
  const [rightPaneDragging, setRightPaneDragging] = useState(false);

  const {
    treeEntries,
    expanded,
    refreshRoot,
    toggleExpand,
  } = useProjectTree();

  const {
    compileStatus,
    setCompileStatus,
    compileRunId,
    compileToast,
    runCompile,
    symbols,
    unresolved,
    parsedFiles,
    parseErrorPaths,
    progressUiUpdates,
    droppedCompileRequests,
    buildLogEntries,
    clearBuildLogs,
    buildProgress,
    activeLibraryPath,
  } = useCompileRunner({ rootPath });
  const [buildClockTick, setBuildClockTick] = useState(0);

  const {
    selectedSemanticRow,
    selectedSemanticLoading,
    selectedSemanticError,
  } = useSemanticSelection({
    rootPath,
    semanticSelectedQname,
    selectedSymbol,
  });

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const cursorListenerRef = useRef<{ dispose: () => void } | null>(null);
  const suppressDirtyRef = useRef(false);
  const dirtyRef = useRef(false);
  const fileOpenReqRef = useRef(0);
  const contentRef = useRef("");
  const harnessRunIdRef = useRef(0);
  const harnessActiveRef = useRef(false);
  const progressUiUpdatesRef = useRef(0);
  const cursorFlushTimerRef = useRef<number | undefined>(undefined);
  const pendingCursorRef = useRef<{ line: number; col: number } | null>(null);
  const leftPaneWidthRef = useRef(leftPaneWidth);
  const rightPaneWidthRef = useRef(rightPaneWidth);
  const tabsStripRef = useRef<HTMLDivElement | null>(null);
  const leftPaneDragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const rightPaneDragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    progressUiUpdatesRef.current = progressUiUpdates;
  }, [progressUiUpdates]);

  useEffect(() => {
    leftPaneWidthRef.current = leftPaneWidth;
  }, [leftPaneWidth]);

  useEffect(() => {
    rightPaneWidthRef.current = rightPaneWidth;
  }, [rightPaneWidth]);

  useEffect(() => {
    if (!buildProgress.running) return;
    const timer = window.setInterval(() => {
      setBuildClockTick((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [buildProgress.running]);

  useEffect(() => {
    window.localStorage?.setItem(THEME_KEY, appTheme);
    document.body.classList.toggle("theme-light", appTheme === "light");
    const monaco = monacoRef.current;
    if (monaco) {
      monaco.editor.setTheme(appTheme === "light" ? "vs" : "vs-dark");
    }
  }, [appTheme]);

  const toggleTheme = useCallback(() => {
    setAppTheme((prev) => (prev === "light" ? "dark" : "light"));
  }, []);

  useEffect(() => {
    window.localStorage?.setItem(RECENTS_KEY, JSON.stringify(recentProjects));
  }, [recentProjects]);

  useEffect(() => {
    if (!rootPath) {
      setTreeError("");
      return;
    }
    let active = true;
    setTreeError("");
    void refreshRoot(rootPath).catch((error) => {
      if (!active) return;
      setTreeError(`Failed to load project tree: ${String(error)}`);
    });
    return () => {
      active = false;
    };
  }, [rootPath, refreshRoot]);

  useEffect(() => {
    setActiveFilePath(null);
    setOpenTabs([]);
    setSelectedSymbol(null);
    setSemanticSelectedQname("");
    setExpandedFileSymbols({});
    setExpandedLibraryFiles({});
    contentRef.current = "";
    dirtyRef.current = false;
    setDirty(false);
    if (editorRef.current) {
      suppressDirtyRef.current = true;
      editorRef.current.setValue("");
    }
  }, [rootPath]);

  useEffect(() => {
    return () => {
      if (cursorListenerRef.current) {
        cursorListenerRef.current.dispose();
        cursorListenerRef.current = null;
      }
      if (cursorFlushTimerRef.current !== undefined) {
        window.clearTimeout(cursorFlushTimerRef.current);
        cursorFlushTimerRef.current = undefined;
      }
    };
  }, []);

  useEffect(() => {
    window.localStorage?.setItem(LEFT_PANE_WIDTH_KEY, String(leftPaneWidth));
  }, [leftPaneWidth]);

  useEffect(() => {
    window.localStorage?.setItem(RIGHT_PANE_WIDTH_KEY, String(rightPaneWidth));
  }, [rightPaneWidth]);

  useEffect(() => {
    window.localStorage?.setItem(BUILD_PROGRESS_VISIBLE_KEY, buildProgressVisible ? "1" : "0");
  }, [buildProgressVisible]);

  useEffect(() => {
    window.localStorage?.setItem(HARNESS_COLLAPSED_KEY, harnessCollapsed ? "1" : "0");
  }, [harnessCollapsed]);

  useEffect(() => {
    let active = true;
    const pollJobs = async () => {
      try {
        const snapshot = await invoke<BackgroundJobsSnapshot>("get_background_jobs");
        if (!active) return;
        setBackgroundJobs(snapshot || { total: 0, cancelable: 0, jobs: [] });
      } catch {
        if (!active) return;
      }
    };
    void pollJobs();
    const timer = window.setInterval(() => {
      void pollJobs();
    }, 1200);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
      const nextRight = clampRightPaneWidth(rightPaneWidthRef.current, viewportWidth, leftPaneWidthRef.current);
      const nextLeft = clampLeftPaneWidth(leftPaneWidthRef.current, viewportWidth, nextRight);
      setRightPaneWidth(nextRight);
      setLeftPaneWidth(nextLeft);
      editorRef.current?.layout();
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("simple-ui-resizing", leftPaneDragging || rightPaneDragging);
    return () => {
      document.body.classList.remove("simple-ui-resizing");
    };
  }, [leftPaneDragging, rightPaneDragging]);

  useEffect(() => {
    const syncLayout = () => {
      const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
      const nextRight = clampRightPaneWidth(rightPaneWidthRef.current, viewportWidth, leftPaneWidthRef.current);
      const nextLeft = clampLeftPaneWidth(leftPaneWidthRef.current, viewportWidth, nextRight);
      if (nextRight !== rightPaneWidthRef.current) {
        setRightPaneWidth(nextRight);
      }
      if (nextLeft !== leftPaneWidthRef.current) {
        setLeftPaneWidth(nextLeft);
      }
      editorRef.current?.layout();
    };
    const frame = window.requestAnimationFrame(syncLayout);
    const timer = window.setTimeout(syncLayout, 120);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, []);

  const measureTabsOverflow = useCallback(() => {
    const strip = tabsStripRef.current;
    if (!strip) {
      setTabsOverflow(false);
      return;
    }
    const isOverflowing = strip.scrollWidth > strip.clientWidth + 4;
    setTabsOverflow(isOverflowing);
    if (!isOverflowing) {
      setTabsOverflowMenuOpen(false);
    }
  }, []);

  useEffect(() => {
    measureTabsOverflow();
  }, [measureTabsOverflow, openTabs, leftPaneWidth, rightPaneWidth]);

  useEffect(() => {
    const strip = tabsStripRef.current;
    if (!strip) return;
    const onResize = () => measureTabsOverflow();
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(onResize)
      : null;
    if (observer) observer.observe(strip);
    window.addEventListener("resize", onResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [measureTabsOverflow]);

  useEffect(() => {
    if (!tabContextMenu && !tabsOverflowMenuOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (
        target.closest(".simple-tab-context-menu")
        || target.closest(".simple-editor-tabs-overflow")
      ) {
        return;
      }
      setTabContextMenu(null);
      setTabsOverflowMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setTabContextMenu(null);
      setTabsOverflowMenuOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [tabContextMenu, tabsOverflowMenuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".menu-bar")) return;
      setMenuOpen(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(null);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    persistStdlibPathOptions(stdlibPathOptions);
  }, [stdlibPathOptions]);

  useEffect(() => {
    if (!stdlibManagerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setStdlibManagerOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [stdlibManagerOpen]);

  useEffect(() => {
    if (!stdlibManagerOpen) return;
    let active = true;
    setDialogStdlibMetaLoading(true);
    void (async () => {
      const requests = await Promise.allSettled([
        rootPath ? getProjectModel(rootPath) : Promise.resolve(null),
        getDefaultStdlib(),
      ]);
      if (!active) return;
      const projectModel = requests[0].status === "fulfilled" ? requests[0].value : null;
      const defaultStdlib = requests[1].status === "fulfilled" ? requests[1].value : null;
      const fromModel = (projectModel?.stdlib_path || "").trim();
      setDialogActiveStdlibPath(fromModel || activeLibraryPath || "");
      setDialogDefaultStdlibId((defaultStdlib || "").trim() || null);
      setDialogStdlibMetaLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [stdlibManagerOpen, rootPath]);

  useEffect(() => {
    if (!stdlibManagerOpen) return;
    const resolved = (activeLibraryPath || "").trim();
    if (!resolved) return;
    setDialogActiveStdlibPath(resolved);
  }, [stdlibManagerOpen, activeLibraryPath]);

  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    const model = editor.getModel();
    if (!model) return;
    const activeKey = normalizePath(activeFilePath);
    if (!activeKey) {
      monaco.editor.setModelMarkers(model, PARSE_MARKER_OWNER, []);
      return;
    }
    const bucket = compileToast.parseErrors.find((entry) => normalizePath(entry.path) === activeKey);
    const parseMessages = (bucket?.errors || []).filter((message) => !message.trim().toLowerCase().startsWith("[semantic "));
    const markers = parseMessages.map((message) => parseErrorToMarker(monaco, message));
    monaco.editor.setModelMarkers(model, PARSE_MARKER_OWNER, markers);
  }, [activeFilePath, compileToast.parseErrors]);

  const applySelection = useCallback((selection: TextSelection | null | undefined) => {
    if (!selection || !editorRef.current) return;
    editorRef.current.setSelection({
      startLineNumber: selection.startLine,
      startColumn: selection.startCol,
      endLineNumber: selection.endLine,
      endColumn: selection.endCol,
    });
    editorRef.current.revealLineInCenter(selection.startLine);
    editorRef.current.focus();
  }, []);

  const activateEditorTab = useCallback((tab: EditorTab, selection?: TextSelection) => {
    setActiveFilePath(tab.path);
    contentRef.current = tab.content;
    dirtyRef.current = tab.dirty;
    setDirty(tab.dirty);
    if (editorRef.current) {
      suppressDirtyRef.current = true;
      editorRef.current.setValue(tab.content);
      if (selection) {
        applySelection(selection);
      } else {
        editorRef.current.setPosition({ lineNumber: 1, column: 1 });
        editorRef.current.revealLine(1);
      }
    }
  }, [applySelection]);

  const persistActiveEditorBuffer = useCallback(() => {
    if (!activeFilePath) return;
    const activeKey = normalizePath(activeFilePath);
    const nextContent = contentRef.current;
    const nextDirty = dirtyRef.current;
    setOpenTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        if (normalizePath(tab.path) !== activeKey) return tab;
        if (tab.content === nextContent && tab.dirty === nextDirty) return tab;
        changed = true;
        return { ...tab, content: nextContent, dirty: nextDirty };
      });
      return changed ? next : prev;
    });
  }, [activeFilePath]);

  const openFilePath = useCallback(async (
    path: string,
    selection?: TextSelection,
    options?: { preserveSymbolSelection?: boolean },
  ) => {
    if (!path) return;
    const pathKey = normalizePath(path);
    if (activeFilePath && normalizePath(activeFilePath) === pathKey) {
      if (!options?.preserveSymbolSelection) {
        setSelectedSymbol(null);
        setSemanticSelectedQname("");
      }
      if (selection) {
        applySelection(selection);
      }
      return;
    }
    persistActiveEditorBuffer();
    const existing = openTabs.find((tab) => normalizePath(tab.path) === pathKey);
    if (existing) {
      if (!options?.preserveSymbolSelection) {
        setSelectedSymbol(null);
        setSemanticSelectedQname("");
      }
      activateEditorTab(existing, selection);
      return;
    }
    const reqId = ++fileOpenReqRef.current;
    try {
      const text = await readFileText(path);
      if (reqId !== fileOpenReqRef.current) return;
      const tab: EditorTab = {
        path,
        name: displayNameForPath(path),
        content: text,
        dirty: false,
      };
      setOpenTabs((prev) => {
        if (prev.some((entry) => normalizePath(entry.path) === pathKey)) return prev;
        return [...prev, tab];
      });
      if (!options?.preserveSymbolSelection) {
        setSelectedSymbol(null);
        setSemanticSelectedQname("");
      }
      activateEditorTab(tab, selection);
    } catch (error) {
      setCompileStatus(`Open failed: ${String(error)}`);
    }
  }, [activeFilePath, persistActiveEditorBuffer, openTabs, applySelection, activateEditorTab, setCompileStatus]);

  const openEntry = useCallback(async (entry: FileEntry) => {
    if (entry.is_dir) {
      await toggleExpand(entry);
      return;
    }
    await openFilePath(entry.path);
  }, [toggleExpand, openFilePath]);

  const activateOpenTab = useCallback((path: string) => {
    const pathKey = normalizePath(path);
    if (activeFilePath && normalizePath(activeFilePath) === pathKey) return;
    persistActiveEditorBuffer();
    const tab = openTabs.find((entry) => normalizePath(entry.path) === pathKey);
    if (!tab) return;
    setSelectedSymbol(null);
    setSemanticSelectedQname("");
    activateEditorTab(tab);
  }, [activeFilePath, persistActiveEditorBuffer, openTabs, activateEditorTab]);

  const closeEditorTab = useCallback((path: string) => {
    const pathKey = normalizePath(path);
    const index = openTabs.findIndex((tab) => normalizePath(tab.path) === pathKey);
    if (index < 0) return;
    const tab = openTabs[index];
    if (!tab) return;
    if (tab.dirty) {
      const proceed = window.confirm(`Discard unsaved changes in ${tab.name}?`);
      if (!proceed) return;
    }
    const nextTabs = openTabs.filter((_, tabIndex) => tabIndex !== index);
    setOpenTabs(nextTabs);
    const wasActive = !!activeFilePath && normalizePath(activeFilePath) === pathKey;
    setTabContextMenu(null);
    setTabsOverflowMenuOpen(false);
    if (!wasActive) return;
    const fallback = nextTabs[Math.max(0, index - 1)] || nextTabs[0] || null;
    if (fallback) {
      setSelectedSymbol(null);
      setSemanticSelectedQname("");
      activateEditorTab(fallback);
      return;
    }
    setActiveFilePath(null);
    setSelectedSymbol(null);
    setSemanticSelectedQname("");
    contentRef.current = "";
    dirtyRef.current = false;
    setDirty(false);
    if (editorRef.current) {
      suppressDirtyRef.current = true;
      editorRef.current.setValue("");
    }
  }, [openTabs, activeFilePath, activateEditorTab]);

  const closeOtherTabs = useCallback((keepPath: string) => {
    persistActiveEditorBuffer();
    const keepKey = normalizePath(keepPath);
    const keepTab = openTabs.find((tab) => normalizePath(tab.path) === keepKey);
    if (!keepTab) return;
    const closingTabs = openTabs.filter((tab) => normalizePath(tab.path) !== keepKey);
    if (!closingTabs.length) return;
    const dirtyCount = closingTabs.filter((tab) => tab.dirty).length;
    if (dirtyCount > 0) {
      const proceed = window.confirm(
        `Discard unsaved changes in ${dirtyCount} other tab${dirtyCount === 1 ? "" : "s"}?`,
      );
      if (!proceed) return;
    }
    setOpenTabs([keepTab]);
    if (!activeFilePath || normalizePath(activeFilePath) !== keepKey) {
      setSelectedSymbol(null);
      setSemanticSelectedQname("");
      activateEditorTab(keepTab);
    }
    setTabContextMenu(null);
    setTabsOverflowMenuOpen(false);
  }, [persistActiveEditorBuffer, openTabs, activeFilePath, activateEditorTab]);

  const closeAllTabs = useCallback(() => {
    persistActiveEditorBuffer();
    if (!openTabs.length) return;
    const dirtyCount = openTabs.filter((tab) => tab.dirty).length;
    if (dirtyCount > 0) {
      const proceed = window.confirm(
        `Discard unsaved changes in ${dirtyCount} tab${dirtyCount === 1 ? "" : "s"}?`,
      );
      if (!proceed) return;
    }
    setOpenTabs([]);
    setActiveFilePath(null);
    setSelectedSymbol(null);
    setSemanticSelectedQname("");
    contentRef.current = "";
    dirtyRef.current = false;
    setDirty(false);
    if (editorRef.current) {
      suppressDirtyRef.current = true;
      editorRef.current.setValue("");
    }
    setTabContextMenu(null);
    setTabsOverflowMenuOpen(false);
  }, [persistActiveEditorBuffer, openTabs]);

  const reorderOpenTabs = useCallback((fromPath: string, toPath: string) => {
    const fromKey = normalizePath(fromPath);
    const toKey = normalizePath(toPath);
    if (!fromKey || !toKey || fromKey === toKey) return;
    setOpenTabs((prev) => {
      const fromIndex = prev.findIndex((tab) => normalizePath(tab.path) === fromKey);
      const toIndex = prev.findIndex((tab) => normalizePath(tab.path) === toKey);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return prev;
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  const collectUnsavedCompileInputs = useCallback(() => {
    const byPath = new Map<string, { path: string; content: string }>();
    for (const tab of openTabs) {
      if (!tab.dirty || !isSemanticSource(tab.path)) continue;
      byPath.set(normalizePath(tab.path), { path: tab.path, content: tab.content });
    }
    if (activeFilePath && dirtyRef.current && isSemanticSource(activeFilePath)) {
      byPath.set(normalizePath(activeFilePath), { path: activeFilePath, content: contentRef.current });
    }
    return Array.from(byPath.values());
  }, [openTabs, activeFilePath]);

  const applyRootPath = useCallback((candidatePath: string) => {
    const next = candidatePath.trim();
    setRootPath(next);
    if (next) {
      window.localStorage?.setItem(ROOT_STORAGE_KEY, next);
      setRecentProjects((prev) => pushRecentProject(next, prev));
    }
  }, []);

  const saveActiveFile = useCallback(async (): Promise<boolean> => {
    if (!activeFilePath) return false;
    try {
      await invoke("write_file", { path: activeFilePath, content: contentRef.current });
      dirtyRef.current = false;
      setDirty(false);
      const activeKey = normalizePath(activeFilePath);
      setOpenTabs((prev) => prev.map((tab) => (
        normalizePath(tab.path) === activeKey
          ? { ...tab, content: contentRef.current, dirty: false }
          : tab
      )));
      setCompileStatus(`Saved ${displayNameForPath(activeFilePath)}`);
      return true;
    } catch (error) {
      setCompileStatus(`Save failed: ${String(error)}`);
      return false;
    }
  }, [activeFilePath, setCompileStatus]);

  const addHarnessRun = useCallback((
    kind: "project" | "file",
    ok: boolean,
    durationMs: number,
    progressUpdates: number,
  ) => {
    const budgetOk =
      durationMs <= HARNESS_COMPILE_BUDGET_MS
      && progressUpdates <= HARNESS_PROGRESS_UPDATE_BUDGET;
    harnessRunIdRef.current += 1;
    const run: HarnessRun = {
      id: harnessRunIdRef.current,
      kind,
      ok,
      budgetOk,
      durationMs,
      progressUpdates,
      at: new Date().toLocaleTimeString(),
    };
    setHarnessRuns((prev) => [run, ...prev].slice(0, 16));
  }, []);

  const compileProject = useCallback(async (): Promise<boolean> => {
    if (!rootPath) {
      setCompileStatus("Compile requires a project root");
      return false;
    }
    const unsaved = collectUnsavedCompileInputs();
    const progressBefore = progressUiUpdatesRef.current;
    const start = typeof performance !== "undefined" ? performance.now() : Date.now();
    const ok = await runCompile(undefined, unsaved);
    const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - start;
    const progressAfter = progressUiUpdatesRef.current;
    addHarnessRun("project", ok, elapsed, Math.max(0, progressAfter - progressBefore));
    return ok;
  }, [rootPath, runCompile, setCompileStatus, collectUnsavedCompileInputs, addHarnessRun]);

  const compileActiveFile = useCallback(async (): Promise<boolean> => {
    if (!rootPath) {
      setCompileStatus("Compile requires a project root");
      return false;
    }
    if (!activeFilePath || !isSemanticSource(activeFilePath)) {
      return compileProject();
    }
    const unsaved = collectUnsavedCompileInputs();
    const progressBefore = progressUiUpdatesRef.current;
    const start = typeof performance !== "undefined" ? performance.now() : Date.now();
    const ok = await runCompile(activeFilePath, unsaved);
    const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - start;
    const progressAfter = progressUiUpdatesRef.current;
    addHarnessRun("file", ok, elapsed, Math.max(0, progressAfter - progressBefore));
    return ok;
  }, [rootPath, activeFilePath, runCompile, compileProject, setCompileStatus, collectUnsavedCompileInputs, addHarnessRun]);

  const clearAllCaches = useCallback(async () => {
    if (compileRunId) {
      setCompileStatus("Cannot clear caches while compile is running");
      return;
    }
    try {
      const summary = await invoke<CacheClearSummary>("clear_all_caches", {
        root: rootPath || null,
      });
      setCompileStatus(
        `Caches cleared (snapshot ${summary.workspace_snapshot_entries}, metamodel ${summary.metamodel_entries}, parsed ${summary.parsed_file_entries}${summary.symbol_index_cleared ? ", symbol index" : ""}${summary.project_ir_cache_deleted ? ", project IR" : ""})`,
      );
    } catch (error) {
      setCompileStatus(`Clear caches failed: ${String(error)}`);
    }
  }, [compileRunId, rootPath, setCompileStatus]);

  const addStdlibPathOption = useCallback(() => {
    setStdlibPathOptions((prev) => [
      ...prev,
      {
        id: createStdlibOptionId(),
        name: `Stdlib ${prev.length + 1}`,
        path: "",
      },
    ]);
  }, []);

  const updateStdlibPathOption = useCallback((id: string, patch: Partial<StdlibPathOption>) => {
    setStdlibPathOptions((prev) => prev.map((option) => (
      option.id === id ? { ...option, ...patch } : option
    )));
  }, []);

  const removeStdlibPathOption = useCallback((id: string) => {
    setStdlibPathOptions((prev) => prev.filter((option) => option.id !== id));
  }, []);

  const browseStdlibPathOption = useCallback(async (id: string) => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    setStdlibPathOptions((prev) => prev.map((option) => (
      option.id === id
        ? {
            ...option,
            path: selected,
            name: option.name.trim() || displayNameForPath(selected),
          }
        : option
    )));
  }, []);

  const applyStdlibPathOption = useCallback(async (option: StdlibPathOption) => {
    if (!rootPath) {
      setCompileStatus("Select a project root before applying stdlib path");
      return;
    }
    const selectedPath = option.path.trim();
    if (!selectedPath) {
      setCompileStatus("Select a stdlib path before applying");
      return;
    }
    try {
      const applied = await invoke<string>("set_project_stdlib_path", {
        root: rootPath,
        stdlibPath: selectedPath,
      });
      setDialogActiveStdlibPath(applied);
      setCompileStatus(`Project stdlib path set: ${applied}. Refreshing library files...`);
      await compileProject();
    } catch (error) {
      const message = String(error);
      if (message.includes("stdlib_path")) {
        try {
          const applied = await invoke<string>("set_project_stdlib_path", {
            root: rootPath,
            stdlib_path: selectedPath,
          });
          setDialogActiveStdlibPath(applied);
          setCompileStatus(`Project stdlib path set: ${applied}. Refreshing library files...`);
          await compileProject();
          return;
        } catch {
          // fall through to primary error
        }
      }
      setCompileStatus(`Set stdlib path failed: ${message}`);
    }
  }, [rootPath, setCompileStatus, compileProject]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const lowered = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && lowered === "s") {
        event.preventDefault();
        void saveActiveFile();
        return;
      }
      if (event.key === "F5") {
        event.preventDefault();
        if (compileRunId) return;
        void compileProject();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveActiveFile, compileProject, compileRunId]);

  const runMenuAction = useCallback(async (action: string) => {
    switch (action) {
      case "open-folder": {
        const selected = await open({ directory: true, multiple: false });
        if (typeof selected === "string") {
          applyRootPath(selected);
        }
        return;
      }
      case "open-file": {
        const selected = await open({ directory: false, multiple: false });
        if (typeof selected === "string") {
          await openFilePath(selected);
        }
        return;
      }
      case "save-active":
        await saveActiveFile();
        return;
      case "compile-workspace":
        await compileProject();
        return;
      case "compile-file":
        await compileActiveFile();
        return;
      case "clear-caches":
        await clearAllCaches();
        return;
      case "select-stdlib-path": {
        setStdlibManagerOpen(true);
        return;
      }
      case "theme-toggle":
        toggleTheme();
        return;
      case "theme-light":
        setAppTheme("light");
        return;
      case "theme-dark":
        setAppTheme("dark");
        return;
      case "close-window":
        await invoke("window_close").catch((error) => {
          setCompileStatus(`Window close failed: ${String(error)}`);
        });
        return;
      case "about":
        setCompileStatus("Mercurio SysML UI");
        return;
      default:
        return;
    }
  }, [
    applyRootPath,
    openFilePath,
    saveActiveFile,
    compileProject,
    compileActiveFile,
    clearAllCaches,
    setStdlibManagerOpen,
    toggleTheme,
    setCompileStatus,
  ]);

  useEffect(() => {
    const unlistenPromise = listen<string>("menu-action", (event) => {
      const action = `${event.payload || ""}`;
      if (!action) return;
      void runMenuAction(action);
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [runMenuAction]);

  const runHarness = useCallback(async (iterations: number) => {
    if (harnessActiveRef.current) return;
    harnessActiveRef.current = true;
    setHarnessRunning(true);
    try {
      for (let i = 0; i < iterations; i += 1) {
        // Keep loop deterministic: always compile full project for repeatability.
        await compileProject();
      }
    } finally {
      harnessActiveRef.current = false;
      setHarnessRunning(false);
    }
  }, [compileProject]);

  const projectSymbols = useMemo(
    () => symbols.filter((symbol) => symbol.source_scope !== "library"),
    [symbols],
  );

  const librarySymbols = useMemo(
    () => symbols.filter((symbol) => symbol.source_scope === "library"),
    [symbols],
  );

  const symbolsByFile = useMemo(() => {
    const map = new Map<string, SymbolView[]>();
    for (const symbol of projectSymbols) {
      const key = normalizePath(symbol.file_path);
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(symbol);
      } else {
        map.set(key, [symbol]);
      }
    }
    for (const bucket of map.values()) {
      bucket.sort(compareSymbols);
    }
    return map;
  }, [projectSymbols]);

  const librarySymbolsByFile = useMemo(() => {
    const map = new Map<string, SymbolView[]>();
    for (const symbol of librarySymbols) {
      const key = normalizePath(symbol.file_path);
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(symbol);
      } else {
        map.set(key, [symbol]);
      }
    }
    for (const bucket of map.values()) {
      bucket.sort(compareSymbols);
    }
    return map;
  }, [librarySymbols]);

  const libraryFilePaths = useMemo(() => {
    return Array.from(librarySymbolsByFile.values())
      .map((bucket) => bucket[0]?.file_path)
      .filter((value): value is string => !!value)
      .sort((a, b) => a.localeCompare(b));
  }, [librarySymbolsByFile]);
  const activeStdlibPath = useMemo(
    () => (dialogActiveStdlibPath || activeLibraryPath || "").trim(),
    [dialogActiveStdlibPath, activeLibraryPath],
  );
  const activeStdlibPathKey = useMemo(
    () => normalizePath(activeStdlibPath),
    [activeStdlibPath],
  );

  const selectedSymbolId = useMemo(
    () => (selectedSymbol ? symbolIdentity(selectedSymbol) : ""),
    [selectedSymbol],
  );

  const activeFileSymbols = useMemo(() => {
    if (!activeFilePath) return [] as SymbolView[];
    return symbolsByFile.get(normalizePath(activeFilePath)) || [];
  }, [activeFilePath, symbolsByFile]);

  const selectSymbol = useCallback(async (symbol: SymbolView) => {
    setSelectedSymbol(symbol);
    setSemanticSelectedQname(symbol.qualified_name || "");
    await openFilePath(symbol.file_path, symbolSelection(symbol), { preserveSymbolSelection: true });
  }, [openFilePath]);

  const selectQualifiedName = useCallback((qualifiedName: string) => {
    const target = projectSymbols.find((symbol) => symbol.qualified_name === qualifiedName)
      || symbols.find((symbol) => symbol.qualified_name === qualifiedName);
    if (!target) return;
    void selectSymbol(target);
  }, [projectSymbols, selectSymbol, symbols]);

  const openParseError = useCallback((path: string, message: string) => {
    const loc = parseErrorLocation(message);
    const selection: TextSelection | undefined = loc
      ? {
          startLine: loc.line,
          startCol: loc.col,
          endLine: loc.line,
          endCol: loc.col + 1,
        }
      : undefined;
    void openFilePath(path, selection);
  }, [openFilePath]);

  const toggleProjectFileSymbols = useCallback((filePath: string) => {
    const key = normalizePath(filePath);
    setExpandedFileSymbols((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const toggleLibraryFileSymbols = useCallback((filePath: string) => {
    const key = normalizePath(filePath);
    setExpandedLibraryFiles((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleLeftPaneResizerPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    leftPaneDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: leftPaneWidth,
    };
    setLeftPaneDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [leftPaneWidth]);

  const handleLeftPaneResizerPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = leftPaneDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = event.clientX - drag.startX;
    const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
    setLeftPaneWidth(clampLeftPaneWidth(drag.startWidth + delta, viewportWidth, rightPaneWidthRef.current));
    editorRef.current?.layout();
  }, []);

  const stopLeftPaneResizerDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = leftPaneDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    leftPaneDragRef.current = null;
    setLeftPaneDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleRightPaneResizerPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    rightPaneDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: rightPaneWidth,
    };
    setRightPaneDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [rightPaneWidth]);

  const handleRightPaneResizerPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = rightPaneDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = drag.startX - event.clientX;
    const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
    setRightPaneWidth(clampRightPaneWidth(drag.startWidth + delta, viewportWidth, leftPaneWidthRef.current));
    editorRef.current?.layout();
  }, []);

  const stopRightPaneResizerDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = rightPaneDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    rightPaneDragRef.current = null;
    setRightPaneDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const editorLanguage = useMemo(
    () => editorLanguageForPath(activeFilePath),
    [activeFilePath],
  );

  const handleEditorMount: OnMount = (editorInstance, monaco) => {
    editorRef.current = editorInstance;
    monacoRef.current = monaco;
    ensureSysmlLanguage(monaco);
    monaco.editor.setTheme(appTheme === "light" ? "vs" : "vs-dark");
    editorInstance.updateOptions({
      minimap: { enabled: false },
      wordWrap: "off",
      scrollBeyondLastLine: false,
      renderLineHighlight: "line",
      fontSize: 13,
      automaticLayout: true,
    });
    if (cursorListenerRef.current) {
      cursorListenerRef.current.dispose();
      cursorListenerRef.current = null;
    }
    const flushCursor = () => {
      cursorFlushTimerRef.current = undefined;
      const pending = pendingCursorRef.current;
      if (!pending) return;
      setCursorPos((prev) => {
        if (prev?.line === pending.line && prev?.col === pending.col) {
          return prev;
        }
        return pending;
      });
    };
    cursorListenerRef.current = editorInstance.onDidChangeCursorPosition((event) => {
      pendingCursorRef.current = { line: event.position.lineNumber, col: event.position.column };
      if (cursorFlushTimerRef.current !== undefined) return;
      cursorFlushTimerRef.current = window.setTimeout(flushCursor, 60);
    });
    suppressDirtyRef.current = true;
    editorInstance.setValue(contentRef.current || "");
  };

  const renderContainedSymbols = useCallback((
    symbolRoots: SymbolTreeNode[],
    basePaddingLeft: number,
    budget: { remaining: number },
  ): ReactNode[] => {
    const renderNodes = (nodes: SymbolTreeNode[], depth: number): ReactNode[] => {
      const rows: ReactNode[] = [];
      for (const node of nodes) {
        if (budget.remaining <= 0) break;
        budget.remaining -= 1;
        const symbol = node.symbol;
        const symbolId = symbolIdentity(symbol);
        const selected = selectedSymbolId === symbolId;
        rows.push(
          <button
            key={symbolId}
            type="button"
            className={`ghost simple-tree-symbol-row ${selected ? "active" : ""}`}
            style={{ paddingLeft: `${basePaddingLeft + depth * 14}px` }}
            onClick={() => {
              void selectSymbol(symbol);
            }}
            title={`${symbol.qualified_name}\n${symbol.file_path}`}
          >
            <span className="simple-tree-symbol-kind">{symbol.kind || "?"}</span>
            <span className="simple-tree-symbol-name">{symbol.name || "<anonymous>"}</span>
            <span className="simple-tree-symbol-line">L{symbol.start_line || 1}</span>
          </button>,
        );
        if (node.children.length && budget.remaining > 0) {
          rows.push(...renderNodes(node.children, depth + 1));
        }
      }
      return rows;
    };
    return renderNodes(symbolRoots, 0);
  }, [selectedSymbolId, selectSymbol]);

  const renderTree = useCallback((entries: FileEntry[], depth = 0): ReactNode => {
    return entries.map((entry) => {
      const key = entry.path;
      const isDir = entry.is_dir;
      const isOpen = !!expanded[entry.path];
      const fileKey = normalizePath(entry.path);
      const active = !isDir && normalizePath(activeFilePath) === fileKey;
      const hasParseError = parseErrorPaths.has(fileKey);
      const fileSymbols = isDir ? [] : (symbolsByFile.get(fileKey) || []);
      const symbolCount = fileSymbols.length;
      const isSymbolOpen = !isDir && !!expandedFileSymbols[fileKey];
      const symbolRoots = isSymbolOpen ? buildSymbolOwnershipTree(fileSymbols) : [];
      const renderBudget = { remaining: FILE_SYMBOL_RENDER_LIMIT };
      const shownSymbols = isSymbolOpen
        ? renderContainedSymbols(symbolRoots, 30 + depth * 14, renderBudget)
        : [];
      const shownSymbolCount = FILE_SYMBOL_RENDER_LIMIT - renderBudget.remaining;

      return (
        <div key={key}>
          <div
            className={`simple-tree-row ${active ? "active" : ""}`}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
          >
            {isDir ? (
              <button
                type="button"
                className="ghost simple-tree-toggle"
                onClick={() => {
                  void toggleExpand(entry);
                }}
                title={isOpen ? "Collapse" : "Expand"}
              >
                {isOpen ? "v" : ">"}
              </button>
            ) : (
              symbolCount > 0 ? (
                <button
                  type="button"
                  className="ghost simple-tree-toggle"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleProjectFileSymbols(entry.path);
                  }}
                  title={isSymbolOpen ? "Hide symbols" : "Show symbols"}
                >
                  {isSymbolOpen ? "v" : ">"}
                </button>
              ) : (
                <span className="simple-tree-toggle-placeholder" />
              )
            )}
            <button
              type="button"
              className="ghost simple-tree-entry"
              onClick={() => {
                void openEntry(entry);
              }}
              title={entry.path}
            >
              <span className={`simple-tree-icon ${isDir ? "dir" : "file"}`}>{isDir ? "DIR" : "FILE"}</span>
              <span className="simple-tree-label">{entry.name}</span>
              {!isDir && symbolCount > 0 ? <span className="simple-tree-count">{symbolCount}</span> : null}
              {!isDir && hasParseError ? <span className="simple-tree-error">error</span> : null}
            </button>
          </div>
          {isDir && isOpen && expanded[entry.path]?.length
            ? renderTree(expanded[entry.path], depth + 1)
            : null}
          {!isDir && isSymbolOpen && shownSymbols.length ? (
            <div className="simple-tree-symbols">
              {shownSymbols}
              {symbolCount > shownSymbolCount ? (
                <div
                  className="simple-tree-symbol-more muted"
                  style={{ paddingLeft: `${30 + depth * 14}px` }}
                >
                  +{symbolCount - shownSymbolCount} more symbols
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      );
    });
  }, [
    expanded,
    activeFilePath,
    parseErrorPaths,
    symbolsByFile,
    expandedFileSymbols,
    toggleExpand,
    openEntry,
    toggleProjectFileSymbols,
    renderContainedSymbols,
  ]);

  const renderLibraryTree = useCallback((): ReactNode => {
    return libraryFilePaths.map((libraryFilePath) => {
      const fileKey = normalizePath(libraryFilePath);
      const fileSymbols = librarySymbolsByFile.get(fileKey) || [];
      const isOpen = !!expandedLibraryFiles[fileKey];
      const symbolRoots = isOpen ? buildSymbolOwnershipTree(fileSymbols) : [];
      const renderBudget = { remaining: FILE_SYMBOL_RENDER_LIMIT };
      const shownSymbols = isOpen
        ? renderContainedSymbols(symbolRoots, 30, renderBudget)
        : [];
      const shownSymbolCount = FILE_SYMBOL_RENDER_LIMIT - renderBudget.remaining;
      const displayName = libraryFilePath.split(/[\\/]/).pop() || libraryFilePath;

      return (
        <div key={libraryFilePath}>
          <div className="simple-tree-row library">
            <button
              type="button"
              className="ghost simple-tree-toggle"
              onClick={() => {
                toggleLibraryFileSymbols(libraryFilePath);
              }}
              title={isOpen ? "Hide symbols" : "Show symbols"}
            >
              {isOpen ? "v" : ">"}
            </button>
            <button
              type="button"
              className="ghost simple-tree-entry"
              onClick={() => {
                const first = fileSymbols[0];
                if (first) {
                  void selectSymbol(first);
                }
              }}
              title={libraryFilePath}
            >
              <span className="simple-tree-icon file">LIB</span>
              <span className="simple-tree-label">{displayName}</span>
              <span className="simple-tree-count">{fileSymbols.length}</span>
            </button>
          </div>
          {isOpen && shownSymbols.length ? (
            <div className="simple-tree-symbols">
              {shownSymbols}
              {fileSymbols.length > shownSymbolCount ? (
                <div className="simple-tree-symbol-more muted" style={{ paddingLeft: "30px" }}>
                  +{fileSymbols.length - shownSymbolCount} more symbols
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      );
    });
  }, [
    libraryFilePaths,
    librarySymbolsByFile,
    expandedLibraryFiles,
    toggleLibraryFileSymbols,
    renderContainedSymbols,
  ]);

  const harnessMaxDuration = useMemo(
    () => Math.max(1, ...harnessRuns.map((run) => run.durationMs)),
    [harnessRuns],
  );
  const harnessAvgDuration = useMemo(
    () =>
      harnessRuns.length
        ? harnessRuns.reduce((sum, run) => sum + run.durationMs, 0) / harnessRuns.length
        : 0,
    [harnessRuns],
  );
  const harnessBudgetFailures = useMemo(
    () => harnessRuns.filter((run) => !run.budgetOk).length,
    [harnessRuns],
  );

  const activeTab = useMemo(() => {
    if (!activeFilePath) return null;
    const key = normalizePath(activeFilePath);
    return openTabs.find((tab) => normalizePath(tab.path) === key) || null;
  }, [openTabs, activeFilePath]);
  const contextTab = useMemo(() => {
    if (!tabContextMenu) return null;
    const key = normalizePath(tabContextMenu.path);
    return openTabs.find((tab) => normalizePath(tab.path) === key) || null;
  }, [openTabs, tabContextMenu]);
  const tabContextMenuStyle = useMemo((): CSSProperties | null => {
    if (!tabContextMenu) return null;
    const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 1280;
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 800;
    const menuWidth = 164;
    const menuHeight = 90;
    const left = Math.max(8, Math.min(tabContextMenu.x, viewportWidth - menuWidth - 8));
    const top = Math.max(8, Math.min(tabContextMenu.y, viewportHeight - menuHeight - 8));
    return { left, top };
  }, [tabContextMenu]);
  const contextMenuHasOtherTabs = useMemo(() => {
    if (!contextTab) return false;
    const keepKey = normalizePath(contextTab.path);
    return openTabs.some((tab) => normalizePath(tab.path) !== keepKey);
  }, [openTabs, contextTab]);
  const activeFileName = activeTab?.name || (activeFilePath ? displayNameForPath(activeFilePath) : "No file selected");
  const showCenterWelcome = !activeFilePath && openTabs.length === 0;
  const projectFolderLabel = rootPath ? (rootPath.split(/[\\/]/).filter(Boolean).pop() || rootPath) : "none";
  const mainLayoutStyle = useMemo(
    () => ({
      "--simple-left-pane-width": `${leftPaneWidth}px`,
      "--simple-right-pane-width": `${rightPaneWidth}px`,
    } as CSSProperties),
    [leftPaneWidth, rightPaneWidth],
  );
  const buildElapsedMs = useMemo(() => {
    if (!buildProgress.startedAtMs) return null;
    return Date.now() - buildProgress.startedAtMs;
  }, [buildProgress.startedAtMs, buildClockTick]);
  const buildIdleMs = useMemo(() => {
    if (!buildProgress.lastEventAtMs) return null;
    return Date.now() - buildProgress.lastEventAtMs;
  }, [buildProgress.lastEventAtMs, buildClockTick]);
  const buildStalled = !!buildProgress.running && (buildIdleMs ?? 0) >= 10_000;
  const buildStalledHint = useMemo(() => {
    if (!buildStalled) return null;
    const where = buildProgress.file
      ? `${buildProgress.stage}: ${buildProgress.file}`
      : buildProgress.stage;
    return `No progress for ${formatDurationMs(buildIdleMs)} at ${where}`;
  }, [buildStalled, buildProgress.stage, buildProgress.file, buildIdleMs]);
  const buildProgressText = useMemo(() => {
    const lines: string[] = [];
    lines.push(`status: ${compileStatus}`);
    lines.push(`run: ${buildProgress.runId ?? "-"}`);
    lines.push(`stage: ${buildProgress.stage}${buildProgress.file ? ` | ${buildProgress.file}` : ""}`);
    lines.push(`elapsed: ${formatDurationMs(buildElapsedMs)}`);
    lines.push(`last_event_age: ${formatDurationMs(buildIdleMs)}`);
    lines.push(`event_count: ${buildProgress.eventCount}`);
    if (buildStalledHint) {
      lines.push(`stalled: ${buildStalledHint}`);
    }
    lines.push("");
    for (const entry of buildLogEntries) {
      lines.push(`${entry.at}\t${entry.level.toUpperCase()}\t${entry.message}`);
    }
    return lines.join("\n");
  }, [
    compileStatus,
    buildProgress.runId,
    buildProgress.stage,
    buildProgress.file,
    buildProgress.eventCount,
    buildElapsedMs,
    buildIdleMs,
    buildStalledHint,
    buildLogEntries,
  ]);
  const copyBuildProgress = useCallback(async () => {
    const copied = await copyTextToClipboard(buildProgressText);
    if (copied) {
      setCompileStatus("Build progress copied");
    } else {
      setCompileStatus("Copy failed");
    }
  }, [buildProgressText, setCompileStatus]);

  const backgroundJobsTitle = useMemo(() => {
    if (!backgroundJobs.jobs.length) {
      return "No active backend jobs";
    }
    return backgroundJobs.jobs
      .map((job) => {
        const detail = (job.detail || "").trim();
        const cancelable = job.cancelable ? " (cancelable)" : "";
        return detail
          ? `${job.kind}: ${detail}${cancelable}`
          : `${job.kind}${cancelable}`;
      })
      .join("\n");
  }, [backgroundJobs]);

  const cancelAllBackgroundJobs = useCallback(async () => {
    try {
      const summary = await invoke<BackgroundCancelSummary>("cancel_background_jobs");
      setCompileStatus(
        `Background cancel requested (active=${summary.active_jobs}, compile=${summary.compile_cancel_requests})`,
      );
    } catch (error) {
      setCompileStatus(`Background cancel failed: ${String(error)}`);
    }
  }, [setCompileStatus]);

  const minimizeWindow = useCallback(() => {
    void invoke("window_minimize").catch((error) => {
      setCompileStatus(`Window minimize failed: ${String(error)}`);
    });
  }, [setCompileStatus]);

  const toggleMaximizeWindow = useCallback(() => {
    void invoke("window_toggle_maximize").catch((error) => {
      setCompileStatus(`Window maximize/restore failed: ${String(error)}`);
    });
  }, [setCompileStatus]);

  const closeWindow = useCallback(() => {
    void invoke("window_close").catch((error) => {
      setCompileStatus(`Window close failed: ${String(error)}`);
    });
  }, [setCompileStatus]);

  const toggleBuildProgressVisibility = useCallback(() => {
    setBuildProgressVisible((prev) => !prev);
  }, []);

  return (
    <div className="app-shell simple-ui-shell">
      <header className="native-titlebar">
        <div className="native-titlebar-left">
          <span className="app-mark">
            <img src="/app-icon.png" alt="Mercurio" className="app-mark-image" />
          </span>
          <span className="native-titlebar-name">Mercurio SysML</span>
          <nav className="menu-bar menu-bar-inline" aria-label="Application menu">
            <div className="menu-bar-item">
              <button
                type="button"
                className={`ghost menu-bar-trigger ${menuOpen === "file" ? "active" : ""}`}
                onClick={() => setMenuOpen((prev) => (prev === "file" ? null : "file"))}
              >
                File
              </button>
              {menuOpen === "file" ? (
                <div className="menu-bar-dropdown">
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); void runMenuAction("open-folder"); }}>Open Folder...</button>
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); void runMenuAction("open-file"); }}>Open File...</button>
                  <div className="menu-bar-sep" />
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); void runMenuAction("save-active"); }}>Save</button>
                  <div className="menu-bar-sep" />
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); void runMenuAction("close-window"); }}>Close Window</button>
                </div>
              ) : null}
            </div>
            <div className="menu-bar-item">
              <button
                type="button"
                className={`ghost menu-bar-trigger ${menuOpen === "build" ? "active" : ""}`}
                onClick={() => setMenuOpen((prev) => (prev === "build" ? null : "build"))}
              >
                Build
              </button>
              {menuOpen === "build" ? (
                <div className="menu-bar-dropdown">
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); void runMenuAction("compile-workspace"); }}>Compile Project</button>
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); void runMenuAction("compile-file"); }}>Compile Active File</button>
                  <div className="menu-bar-sep" />
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); void runMenuAction("clear-caches"); }}>Clear Caches</button>
                </div>
              ) : null}
            </div>
            <div className="menu-bar-item">
              <button
                type="button"
                className={`ghost menu-bar-trigger ${menuOpen === "settings" ? "active" : ""}`}
                onClick={() => setMenuOpen((prev) => (prev === "settings" ? null : "settings"))}
              >
                Settings
              </button>
              {menuOpen === "settings" ? (
                <div className="menu-bar-dropdown">
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); void runMenuAction("select-stdlib-path"); }}>Select Stdlib Path...</button>
                  <div className="menu-bar-sep" />
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); void runMenuAction("theme-toggle"); }}>Toggle Theme</button>
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); void runMenuAction("theme-light"); }}>Light Theme</button>
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); void runMenuAction("theme-dark"); }}>Dark Theme</button>
                </div>
              ) : null}
            </div>
            <div className="menu-bar-item">
              <button
                type="button"
                className={`ghost menu-bar-trigger ${menuOpen === "help" ? "active" : ""}`}
                onClick={() => setMenuOpen((prev) => (prev === "help" ? null : "help"))}
              >
                Help
              </button>
              {menuOpen === "help" ? (
                <div className="menu-bar-dropdown">
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); void runMenuAction("about"); }}>About</button>
                </div>
              ) : null}
            </div>
          </nav>
        </div>
        <div className="native-titlebar-center" data-tauri-drag-region />
        <div className="native-titlebar-right">
          <button type="button" className="ghost native-window-btn" onClick={minimizeWindow} title="Minimize" aria-label="Minimize window">-</button>
          <button type="button" className="ghost native-window-btn" onClick={toggleMaximizeWindow} title="Maximize" aria-label="Maximize or restore window">[]</button>
          <button type="button" className="ghost native-window-btn close" onClick={closeWindow} title="Close" aria-label="Close window">X</button>
        </div>
      </header>
      <header className="titlebar simple-ui-titlebar">
        <div className="simple-ui-root-picker">
          <select
            value={recentPickerValue}
            onChange={(event) => {
              const value = event.target.value;
              setRecentPickerValue("");
              if (!value) return;
              if (value === RECENT_PROJECT_BROWSE_VALUE) {
                void (async () => {
                  const selected = await open({ directory: true, multiple: false });
                  if (typeof selected !== "string") return;
                  applyRootPath(selected);
                })();
                return;
              }
              applyRootPath(value);
            }}
            title="Recent projects"
            aria-label="Recent projects"
          >
            <option value="">Recent projects...</option>
            {recentProjects.map((path) => {
              const name = path.split(/[\\/]/).pop() || path;
              return (
                <option key={path} value={path}>
                  {name} - {path}
                </option>
              );
            })}
            <option value={RECENT_PROJECT_BROWSE_VALUE}>Choose Folder...</option>
          </select>
        </div>
      </header>

      <main className="simple-ui-main" style={mainLayoutStyle}>
        <aside className="panel simple-ui-left">
          <div className="panel-header simple-tree-panel-header">
            <button
              type="button"
              className="ghost simple-tree-section-toggle"
              onClick={() => setProjectFilesExpanded((prev) => !prev)}
              title={projectFilesExpanded ? "Collapse project files" : "Expand project files"}
              aria-label={projectFilesExpanded ? "Collapse project files" : "Expand project files"}
            >
              <span className="simple-tree-section-caret">{projectFilesExpanded ? "v" : ">"}</span>
              <span className="simple-tree-section-title">Project Files</span>
              <span className="simple-tree-section-meta">{projectFolderLabel}</span>
            </button>
            {treeError ? <span className="error">{treeError}</span> : null}
          </div>
          <div className="simple-ui-scroll">
            {rootPath ? (
              <>
                <div className="simple-tree-section">
                  {projectFilesExpanded ? (
                    treeEntries.length ? renderTree(treeEntries) : <div className="muted">No files in root.</div>
                  ) : null}
                </div>
                <div className="simple-tree-section">
                  <div className="simple-tree-subheader">
                    <button
                      type="button"
                      className="ghost simple-tree-section-toggle"
                      onClick={() => setLibraryFilesExpanded((prev) => !prev)}
                      title={libraryFilesExpanded ? "Collapse library files" : "Expand library files"}
                      aria-label={libraryFilesExpanded ? "Collapse library files" : "Expand library files"}
                    >
                      <span className="simple-tree-section-caret">{libraryFilesExpanded ? "v" : ">"}</span>
                      <span className="simple-tree-section-title">Library Files</span>
                    </button>
                    <span className="simple-tree-count">{libraryFilePaths.length}</span>
                  </div>
                  {libraryFilesExpanded ? (
                    libraryFilePaths.length ? (
                      renderLibraryTree()
                    ) : (
                      <div className="muted">No library files indexed.</div>
                    )
                  ) : null}
                </div>
              </>
            ) : (
              <div className="muted">Select a project root to begin.</div>
            )}
          </div>
          <div
            className={`simple-ui-left-resizer ${leftPaneDragging ? "active" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize project panel"
            onPointerDown={handleLeftPaneResizerPointerDown}
            onPointerMove={handleLeftPaneResizerPointerMove}
            onPointerUp={stopLeftPaneResizerDrag}
            onPointerCancel={stopLeftPaneResizerDrag}
          />
        </aside>

        <section className="panel editor simple-ui-center">
          <div className="simple-editor-tabs">
            <div ref={tabsStripRef} className="simple-editor-tabs-strip">
              {openTabs.length ? (
                openTabs.map((tab) => {
                  const tabKey = normalizePath(tab.path);
                  const isActive = !!activeFilePath && normalizePath(activeFilePath) === tabKey;
                  const tabDirty = isActive ? dirty : tab.dirty;
                  const isDragSource = !!dragTabPath && normalizePath(dragTabPath) === tabKey;
                  const isDropTarget = !!dragOverTabPath && normalizePath(dragOverTabPath) === tabKey;
                  return (
                    <div
                      key={tab.path}
                      className={`simple-editor-tab ${isActive ? "active" : ""} ${isDragSource ? "drag-source" : ""} ${isDropTarget ? "drop-target" : ""}`}
                      draggable
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setTabsOverflowMenuOpen(false);
                        setTabContextMenu({
                          path: tab.path,
                          x: event.clientX,
                          y: event.clientY,
                        });
                      }}
                      onDragStart={(event) => {
                        setDragTabPath(tab.path);
                        setDragOverTabPath(tab.path);
                        setTabsOverflowMenuOpen(false);
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", tab.path);
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        if (dragOverTabPath !== tab.path) {
                          setDragOverTabPath(tab.path);
                        }
                        event.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const fromPath = dragTabPath || event.dataTransfer.getData("text/plain");
                        if (!fromPath) return;
                        reorderOpenTabs(fromPath, tab.path);
                        setDragTabPath(null);
                        setDragOverTabPath(null);
                      }}
                      onDragEnd={() => {
                        setDragTabPath(null);
                        setDragOverTabPath(null);
                      }}
                    >
                      <button
                        type="button"
                        className="ghost simple-editor-tab-main"
                        draggable={false}
                        onClick={() => activateOpenTab(tab.path)}
                        title={tab.path}
                      >
                        {tab.name}
                        {tabDirty ? " *" : ""}
                      </button>
                      <button
                        type="button"
                        className="ghost simple-editor-tab-close"
                        draggable={false}
                        onClick={(event) => {
                          event.stopPropagation();
                          closeEditorTab(tab.path);
                        }}
                        title={`Close ${tab.name}`}
                      >
                        x
                      </button>
                    </div>
                  );
                })
              ) : (
                <div className="simple-editor-tabs-empty muted">No open files</div>
              )}
            </div>
            {tabsOverflow ? (
              <div className="simple-editor-tabs-overflow">
                <button
                  type="button"
                  className={`ghost simple-editor-tabs-overflow-btn ${tabsOverflowMenuOpen ? "active" : ""}`}
                  onClick={() => {
                    setTabContextMenu(null);
                    setTabsOverflowMenuOpen((prev) => !prev);
                  }}
                  title="Open tab list"
                  aria-label="Open tab list"
                >
                  v
                </button>
                {tabsOverflowMenuOpen ? (
                  <div className="simple-editor-tabs-dropdown">
                    {openTabs.map((tab) => {
                      const tabKey = normalizePath(tab.path);
                      const isActive = !!activeFilePath && normalizePath(activeFilePath) === tabKey;
                      const tabDirty = isActive ? dirty : tab.dirty;
                      return (
                        <div key={`dropdown:${tab.path}`} className={`simple-editor-tabs-dropdown-row ${isActive ? "active" : ""}`}>
                          <button
                            type="button"
                            className="ghost simple-editor-tabs-dropdown-item"
                            onClick={() => {
                              activateOpenTab(tab.path);
                              setTabsOverflowMenuOpen(false);
                            }}
                            title={tab.path}
                          >
                            {tab.name}
                            {tabDirty ? " *" : ""}
                          </button>
                          <button
                            type="button"
                            className="ghost simple-editor-tabs-dropdown-close"
                            onClick={() => closeEditorTab(tab.path)}
                            title={`Close ${tab.name}`}
                          >
                            x
                          </button>
                        </div>
                      );
                    })}
                    <div className="simple-editor-tabs-dropdown-footer">
                      <button type="button" className="ghost" onClick={() => closeAllTabs()}>Close All</button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          {tabContextMenu && contextTab && tabContextMenuStyle ? (
            <div className="simple-tab-context-menu" style={tabContextMenuStyle}>
              <button
                type="button"
                className="ghost"
                onClick={() => closeEditorTab(contextTab.path)}
              >
                Close
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => closeOtherTabs(contextTab.path)}
                disabled={!contextMenuHasOtherTabs}
              >
                Close Others
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => closeAllTabs()}
                disabled={!openTabs.length}
              >
                Close All
              </button>
            </div>
          ) : null}
          {showCenterWelcome ? (
            <div className="simple-editor-welcome">
              <div className="simple-editor-welcome-card">
                <div className="simple-editor-welcome-title">Welcome to Mercurio SysML</div>
                <div className="simple-editor-welcome-text">
                  Choose a recent project or open a root folder, then select a file from the project tree.
                </div>
                <div className="simple-editor-welcome-hints muted">
                  <div>Ctrl+Shift+O: Open Folder</div>
                  <div>Ctrl+O: Open File</div>
                  <div>Ctrl+S: Save</div>
                  <div>Ctrl+B: Compile Project</div>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="panel-header simple-editor-header">
                <div className="simple-editor-title">{activeFileName}{dirty ? " *" : ""}</div>
                <div className="simple-editor-meta">
                  <span>Symbols in file: {activeFileSymbols.length}</span>
                  <span>Parsed files: {parsedFiles.length}</span>
                  <span>Unresolved: {unresolved.length}</span>
                </div>
              </div>
              <div className="editor-host" id="monaco-root">
                <MonacoEditor
                  defaultValue=""
                  onChange={(value) => {
                    if (suppressDirtyRef.current) {
                      suppressDirtyRef.current = false;
                      return;
                    }
                    contentRef.current = value ?? "";
                    if (!dirtyRef.current) {
                      dirtyRef.current = true;
                      setDirty(true);
                      if (activeFilePath) {
                        const activeKey = normalizePath(activeFilePath);
                        setOpenTabs((prev) => prev.map((tab) => (
                          normalizePath(tab.path) === activeKey
                            ? { ...tab, dirty: true }
                            : tab
                        )));
                      }
                    }
                  }}
                  language={editorLanguage}
                  theme={appTheme === "light" ? "vs" : "vs-dark"}
                  onMount={handleEditorMount}
                  options={{
                    minimap: { enabled: false },
                    wordWrap: "off",
                    scrollBeyondLastLine: false,
                    renderLineHighlight: "line",
                    fontSize: 13,
                    automaticLayout: true,
                  }}
                />
              </div>
              <div className="simple-harness">
                <div className="panel-header simple-harness-header">
                  <button
                    type="button"
                    className="ghost simple-harness-toggle"
                    onClick={() => setHarnessCollapsed((prev) => !prev)}
                    title={harnessCollapsed ? "Expand harness" : "Collapse harness"}
                    aria-label={harnessCollapsed ? "Expand graphical test harness" : "Collapse graphical test harness"}
                  >
                    <span className="simple-harness-caret">{harnessCollapsed ? ">" : "v"}</span>
                    <strong>Graphical Test Harness</strong>
                  </button>
                  {!harnessCollapsed ? (
                    <div className="simple-harness-actions">
                      <button type="button" className="ghost" disabled={!rootPath || harnessRunning} onClick={() => void runHarness(1)}>
                        Run 1x
                      </button>
                      <button type="button" className="ghost" disabled={!rootPath || harnessRunning} onClick={() => void runHarness(5)}>
                        Run 5x
                      </button>
                      {harnessRunning ? <span className="muted">running...</span> : null}
                    </div>
                  ) : null}
                </div>
                {!harnessCollapsed ? (
                  <div className="simple-harness-runs">
                    <div className="muted">
                      avg {Math.round(harnessAvgDuration)} ms | max {Math.round(harnessMaxDuration)} ms | ui updates {progressUiUpdates} | dropped requests {droppedCompileRequests} | budget failures {harnessBudgetFailures}
                    </div>
                    {harnessRuns.length ? (
                      harnessRuns.map((run) => {
                        const width = `${Math.max(6, Math.round((run.durationMs / harnessMaxDuration) * 100))}%`;
                        const runOk = run.ok && run.budgetOk;
                        return (
                          <div key={run.id} className="simple-harness-row">
                            <span>{run.at}</span>
                            <span>{run.kind}</span>
                            <span className={runOk ? "ok" : "error"}>{runOk ? "ok" : "fail"}</span>
                            <span>{Math.round(run.durationMs)} ms</span>
                            <span>{run.progressUpdates} ui</span>
                            <div className="simple-harness-bar">
                              <div className={`simple-harness-bar-fill ${runOk ? "ok" : "error"}`} style={{ width }} />
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="muted">No runs yet.</div>
                    )}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </section>

        <aside className="panel simple-ui-right">
          <div
            className={`simple-ui-right-resizer ${rightPaneDragging ? "active" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize properties panel"
            onPointerDown={handleRightPaneResizerPointerDown}
            onPointerMove={handleRightPaneResizerPointerMove}
            onPointerUp={stopRightPaneResizerDrag}
            onPointerCancel={stopRightPaneResizerDrag}
          />
          <div className="panel-header"><strong>Properties</strong></div>
          <div className="simple-ui-scroll simple-properties-host">
            <CombinedPropertiesPane
              selectedSymbols={selectedSymbol ? [selectedSymbol] : null}
              selectedSemanticRow={selectedSemanticRow}
              selectedSemanticLoading={selectedSemanticLoading}
              selectedSemanticError={selectedSemanticError}
              onSelectQualifiedName={selectQualifiedName}
            />
          </div>

          <div className="panel-header"><strong>Parse Errors</strong></div>
          <div className="simple-ui-scroll simple-error-list">
            {compileToast.parseErrors.length ? (
              compileToast.parseErrors.slice(0, 30).map((entry) => (
                <div key={entry.path} className="simple-error-group">
                  <button
                    type="button"
                    className="ghost simple-error-path"
                    onClick={() => {
                      const first = entry.errors[0] || "";
                      openParseError(entry.path, first);
                    }}
                    title={entry.path}
                  >
                    {entry.path}
                  </button>
                  {entry.errors.slice(0, 3).map((message, idx) => (
                    <button
                      key={`${entry.path}:${idx}`}
                      type="button"
                      className="ghost simple-error-message"
                      onClick={() => openParseError(entry.path, message)}
                      title={message}
                    >
                      {message}
                    </button>
                  ))}
                </div>
              ))
            ) : (
              <div className="muted">No parse errors from latest compile.</div>
            )}
          </div>
        </aside>
      </main>

      {stdlibManagerOpen ? (
        <div
          className="simple-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setStdlibManagerOpen(false);
            }
          }}
        >
          <section
            className="simple-modal simple-stdlib-manager"
            role="dialog"
            aria-modal="true"
            aria-label="Stdlib path options"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="simple-modal-header">
              <strong>Stdlib Path Options</strong>
              <div className="simple-modal-header-actions">
                <button type="button" className="ghost" onClick={addStdlibPathOption}>
                  Add
                </button>
                <button type="button" className="ghost" onClick={() => setStdlibManagerOpen(false)}>
                  Done
                </button>
              </div>
            </div>
            <div className="simple-modal-body">
              <div className="simple-stdlib-meta muted">
                <span>
                  Active stdlib path: {activeStdlibPath || "-"}
                </span>
                <span>
                  Active default stdlib: {dialogDefaultStdlibId || "-"}
                  {dialogStdlibMetaLoading ? " (loading...)" : ""}
                </span>
              </div>
              <div className="simple-stdlib-grid-head">
                <span>Name</span>
                <span>Path</span>
                <span>Actions</span>
              </div>
              {stdlibPathOptions.length ? (
                <div className="simple-stdlib-grid">
                  {stdlibPathOptions.map((option) => {
                    const optionPathKey = normalizePath(option.path);
                    const isActive = !!optionPathKey && optionPathKey === activeStdlibPathKey;
                    return (
                    <div key={option.id} className={`simple-stdlib-grid-row ${isActive ? "active" : ""}`}>
                      <input
                        value={option.name}
                        onChange={(event) => updateStdlibPathOption(option.id, { name: event.target.value })}
                        placeholder="Option name"
                        aria-label="Stdlib option name"
                      />
                      <input
                        value={option.path}
                        onChange={(event) => updateStdlibPathOption(option.id, { path: event.target.value })}
                        placeholder="C:\\path\\to\\sysml.library"
                        aria-label="Stdlib option path"
                      />
                      <div className="simple-stdlib-grid-actions">
                        {isActive ? <span className="simple-stdlib-active-tag">Active</span> : null}
                        <button type="button" className="ghost" onClick={() => void browseStdlibPathOption(option.id)}>
                          Browse...
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          disabled={!rootPath || !option.path.trim() || !!compileRunId}
                          onClick={() => void applyStdlibPathOption(option)}
                        >
                          Apply
                        </button>
                        <button type="button" className="ghost" onClick={() => removeStdlibPathOption(option.id)}>
                          Delete
                        </button>
                      </div>
                    </div>
                    );
                  })}
                </div>
              ) : (
                <div className="muted simple-stdlib-empty">No stdlib options yet. Add one to start.</div>
              )}
            </div>
            <div className="simple-modal-footer muted">
              {rootPath
                ? `Apply writes library.path for ${rootPath}`
                : "Select a project root before applying a stdlib option."}
            </div>
          </section>
        </div>
      ) : null}

      {buildProgressVisible ? (
        <section className="simple-build-progress-panel" aria-label="Build progress panel">
          <div className="simple-build-progress-header">
            <strong>Build Progress</strong>
            <span className={`simple-build-progress-state ${compileRunId ? "running" : "idle"} ${buildStalled ? "stalled" : ""}`}>
              {buildStalled ? "stalled" : (compileRunId ? "running" : "idle")}
            </span>
            <button
              type="button"
              className="ghost"
              onClick={toggleBuildProgressVisibility}
              title="Hide Build Progress"
              aria-label="Hide Build Progress"
            >
              -
            </button>
            <button type="button" className="ghost" onClick={() => void copyBuildProgress()}>
              Copy Logs
            </button>
            <button type="button" className="ghost" onClick={clearBuildLogs}>
              Clear
            </button>
          </div>
          <div className="simple-build-progress-status muted">{compileStatus}</div>
          <div className="simple-build-progress-meta muted">
            <span>run {buildProgress.runId ?? "-"}</span>
            <span>stage {buildProgress.stage}</span>
            <span>events {buildProgress.eventCount}</span>
            <span>elapsed {formatDurationMs(buildElapsedMs)}</span>
            <span>last event {formatDurationMs(buildIdleMs)} ago</span>
          </div>
          {buildStalledHint ? (
            <div className="simple-build-progress-stalled">{buildStalledHint}</div>
          ) : null}
          {buildProgress.file ? (
            <div className="simple-build-progress-file">{buildProgress.file}</div>
          ) : null}
          <div className="simple-build-progress-list">
            {buildLogEntries.length ? (
              buildLogEntries.slice(-120).map((entry) => (
                <div key={entry.id} className={`simple-build-progress-row ${entry.level}`}>
                  <span className="simple-build-progress-at">{entry.at}</span>
                  <span className="simple-build-progress-level">{entry.level}</span>
                  <span className="simple-build-progress-message">{entry.message}</span>
                </div>
              ))
            ) : (
              <div className="muted">No build events yet.</div>
            )}
          </div>
        </section>
      ) : null}

      <footer className="statusbar">
        <div className="status-left">
          <span>Root: {rootPath || "<none>"}</span>
        </div>
        <div className="status-right">
          <button
            type="button"
            className={`ghost status-build-progress-toggle ${buildProgressVisible ? "active" : ""}`}
            onClick={toggleBuildProgressVisibility}
            title={buildProgressVisible ? "Hide Build Progress" : "Show Build Progress"}
            aria-label={buildProgressVisible ? "Hide Build Progress" : "Show Build Progress"}
          >
            BP
          </button>
          <button
            type="button"
            className={`ghost status-build-progress-toggle ${backgroundJobs.cancelable ? "active" : ""}`}
            onClick={() => void cancelAllBackgroundJobs()}
            title={backgroundJobs.cancelable ? "Cancel active cancelable backend jobs" : "No cancelable backend jobs"}
            aria-label={backgroundJobs.cancelable ? "Cancel active cancelable backend jobs" : "No cancelable backend jobs"}
            disabled={!backgroundJobs.cancelable}
          >
            CX
          </button>
          {cursorPos && activeFilePath ? <span>Ln {cursorPos.line}, Col {cursorPos.col}</span> : null}
          <span title={backgroundJobsTitle}>Jobs: {backgroundJobs.total}</span>
          <span>Project symbols: {projectSymbols.length}</span>
          <span>Unresolved: {unresolved.length}</span>
          <span>UI updates: {progressUiUpdates}</span>
          <span>Dropped compiles: {droppedCompileRequests}</span>
        </div>
      </footer>
    </div>
  );
}
