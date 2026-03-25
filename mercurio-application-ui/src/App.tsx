import "./style.css";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import MonacoEditor, { loader, type OnMount } from "@monaco-editor/react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RECENTS_KEY, ROOT_STORAGE_KEY, THEME_KEY } from "./app/constants";
import { formatFileDiagnostic } from "./app/compileShared";
import { DiagramCanvas } from "./app/components/DiagramCanvas";
import { ModelExplorerCanvas } from "./app/components/ModelExplorerCanvas";
import { isPathWithin, normalizePathKey as normalizePath } from "./app/pathUtils";
import { useFileTree, useProjectTree } from "./app/useProjectTree";
import { logFrontendEvent } from "./app/services/logger";
import {
  buildDiagramFileName,
  createDiagramDocument,
  isDiagramFilePath,
  parseDiagramDocument,
  prepareDiagramDocumentForSave,
  serializeDiagramDocument,
  type DiagramDocument,
  type DiagramPoint,
  type DiagramViewport,
} from "./app/diagrams/file";
import {
  buildDiagramGraph,
  mergeDiagramNodePositions,
  resolvePreferredDiagramRoot,
} from "./app/diagrams/graph";
import {
  DIAGRAM_TYPE_OPTIONS,
  type DiagramType,
} from "./app/diagrams/model";
import {
  buildExplorerGraph,
  canExpandExplorerNode,
  mergeExplorerNodePositions,
  resolvePreferredExplorerRoot,
} from "./app/explorer/graph";
import {
  applySemanticEdit,
  listSemanticEditActions,
  previewSemanticEdit,
} from "./app/services/semanticEditApi";
import {
  type ProjectFilesChangedEvent,
  createProject,
  createProjectFile,
  getUserProjectsRoot,
  readFileText,
  startProjectFileWatcher,
  stopProjectFileWatcher,
  writeFileText,
} from "./app/fileOps";
import { useCompileRunner } from "./app/useCompileRunner";
import {
  getDefaultStdlib,
  getExpressionsView,
  getProjectModel,
  getWorkspaceStartupSnapshot,
  getWorkspaceTreeSnapshot,
} from "./app/services/semanticApi";
import { PropertiesPanel } from "./app/components/PropertiesPanel";
import { ParseErrorsPanel } from "./app/components/ParseErrorsPanel";
import type {
  CacheClearSummary,
  FileDiagnosticView,
  SymbolView,
  ExpressionEvaluationResult,
  ProjectModelView,
} from "./app/contracts";
import type {
  SemanticEditAction,
  SemanticEditApplyResult,
  SemanticEditField,
  SemanticEditInputValues,
  SemanticEditPreviewResult,
  SemanticEditTargetWithLineage,
} from "./app/semanticEditTypes";
import type {
  FileEntry,
} from "./app/types";

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

type ToolTabId = "tooling" | "logs" | "expressions";

type SymbolTreeNode = {
  symbol: SymbolView;
  children: SymbolTreeNode[];
};

type TextEditorTab = {
  path: string;
  name: string;
  kind: "text";
  content: string;
  dirty: boolean;
};

type DiagramEditorTab = {
  path: string;
  name: string;
  kind: "diagram";
  content: string;
  document: DiagramDocument;
  dirty: boolean;
};

type ExplorerEditorTab = {
  path: string;
  name: string;
  kind: "explorer";
  content: string;
  rootQualifiedName: string;
  expandedQualifiedNames: string[];
  viewport: DiagramViewport | null;
  nodePositions: Record<string, DiagramPoint>;
  showDirectedRelationships: boolean;
  historyBack: string[];
  historyForward: string[];
  selectedQualifiedName: string | null;
  selectedEdgeId: string | null;
  dirty: false;
};

type EditorTab = TextEditorTab | DiagramEditorTab | ExplorerEditorTab;

type TabContextMenuState = {
  path: string;
  x: number;
  y: number;
};

type FileContextMenuState = {
  path: string;
  x: number;
  y: number;
  allowNewFile: boolean;
  allowNewDiagram: boolean;
};

type SemanticEditMenuState = {
  symbol: SymbolView;
  x: number;
  y: number;
  loading: boolean;
  actions: SemanticEditAction[];
  error: string;
};

type SemanticEditDialogState = {
  symbol: SymbolView;
  action: SemanticEditAction;
  values: SemanticEditInputValues;
  preview: SemanticEditPreviewResult | null;
  previewing: boolean;
  applying: boolean;
  previewError: string;
  dirtySincePreview: boolean;
};

type SymbolTreeDragState = {
  symbol: SymbolView;
};

type TreeRenameState = {
  symbol: SymbolView;
  value: string;
  submitting: boolean;
  error: string;
};

type NewFileExtension = ".sysml" | ".kerml";

type NewFileDialogState = {
  parentPath: string;
  name: string;
  extension: NewFileExtension;
  error: string;
  submitting: boolean;
};

type NewDiagramDialogState = {
  parentPath: string;
  fileName: string;
  name: string;
  diagramType: DiagramType;
  rootQualifiedName: string;
  rootFilePath: string;
  error: string;
  submitting: boolean;
};

type NewProjectDialogState = {
  parentPath: string;
  name: string;
  author: string;
  description: string;
  organization: string;
  createStarterFile: boolean;
  starterFileName: string;
  starterFileExtension: NewFileExtension;
  useDefaultLibrary: boolean;
  error: string;
  submitting: boolean;
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
const TAB_DROPDOWN_THRESHOLD = 12;
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
const RIGHT_PANEL_SPLIT_KEY = "mercurio.simpleUi.rightPanelSplitRatio";
const RIGHT_PANEL_SPLIT_MIN = 0.12;
const RIGHT_PANEL_SPLIT_MAX = 0.88;
const DEFAULT_RIGHT_PANEL_SPLIT = 0.66;
const CENTER_HARNESS_SPLIT_KEY = "mercurio.simpleUi.centerHarnessSplitRatio";
const CENTER_HARNESS_SPLIT_MIN = 0.08;
const CENTER_HARNESS_SPLIT_MAX = 0.94;
const DEFAULT_CENTER_HARNESS_SPLIT = 0.34;
const CENTER_PANE_MIN_WIDTH = 480;
const MAIN_LAYOUT_NON_CONTENT_WIDTH = 32;
const MAX_RECENT_PROJECTS = 12;
const RECENT_PROJECT_BROWSE_VALUE = "__browse__";
const STDLIB_PATH_OPTIONS_KEY = "mercurio.simpleUi.stdlibPathOptions";
const PROJECT_FILES_SHOW_BY_FILE_KEY = "mercurio.simpleUi.projectFilesShowByFile";
const AUTO_BUILD_ACTIVE_FILE_KEY = "mercurio.simpleUi.autoBuildActiveFile";
const AUTO_BUILD_DEBOUNCE_MS = 900;
const AUTO_BUILD_MIN_INTERVAL_MS = 2500;
const FILE_DIAGNOSTIC_MARKER_OWNER = "mercurio.diagnostics";
const INVALID_NEW_PROJECT_NAME_CHARS = /[<>:"/\\|?*]/;
const INVALID_NEW_FILE_NAME_CHARS = /[<>:"/\\|?*]/;
const SYMBOL_TREE_DRAG_MIME = "application/x-mercurio-symbol";
const MODEL_EXPLORER_TAB_PATH = "__model_explorer__";
const UI_ICON = {
  folder: String.fromCodePoint(0x1F4C1),
  file: String.fromCodePoint(0x1F4C4),
  package: String.fromCodePoint(0x1F4E6),
  namespace: String.fromCodePoint(0x1F9ED),
  part: String.fromCodePoint(0x1F9E9),
  action: "\u26A1",
  function: "\u0192",
  import: "\u2B07",
  connector: String.fromCodePoint(0x1F517),
  property: String.fromCodePoint(0x1F3F7),
  type: "\u25FC",
  bullet: "\u2022",
  settings: "\u2699",
  check: "\u2713",
  minimize: "\u2014",
  maximize: "\u25FB",
  close: "\u00D7",
} as const;

type TreeNodeIconKind = "dir" | "file" | "sysml" | "kerml" | "diagram";
let sysmlLanguageRegistered = false;

function createStdlibOptionId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function stdlibVersionFromPath(path: string | null | undefined): string {
  const trimmed = `${path || ""}`.trim();
  if (!trimmed) return "";
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function symbolIdentity(symbol: SymbolView): string {
  const backendId = `${symbol.symbol_id || ""}`.trim();
  if (backendId) return backendId;
  return `${normalizePath(symbol.file_path)}|${symbol.qualified_name || symbol.name}|${symbol.start_line}|${symbol.start_col}`;
}

function normalizeQualifiedName(value: string | null | undefined): string {
  return `${value || ""}`.trim();
}

function diagramPointsEqual(a: DiagramPoint | null | undefined, b: DiagramPoint | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y;
}

function diagramViewportsEqual(
  a: DiagramViewport | null | undefined,
  b: DiagramViewport | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}

function diagramNodePositionsEqual(
  a: Record<string, DiagramPoint> | null | undefined,
  b: Record<string, DiagramPoint> | null | undefined,
): boolean {
  const left = a || {};
  const right = b || {};
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!diagramPointsEqual(left[key], right[key])) {
      return false;
    }
  }
  return true;
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

function parseRightPanelSplitRatio(raw: string | null): number {
  const parsed = Number(raw || "");
  if (!Number.isFinite(parsed)) return DEFAULT_RIGHT_PANEL_SPLIT;
  const value = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
  if (!Number.isFinite(value)) return DEFAULT_RIGHT_PANEL_SPLIT;
  return Math.max(RIGHT_PANEL_SPLIT_MIN, Math.min(RIGHT_PANEL_SPLIT_MAX, value));
}

function parseCenterHarnessSplitRatio(raw: string | null): number {
  const parsed = Number(raw || "");
  if (!Number.isFinite(parsed)) return DEFAULT_CENTER_HARNESS_SPLIT;
  const value = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
  if (!Number.isFinite(value)) return DEFAULT_CENTER_HARNESS_SPLIT;
  return Math.max(CENTER_HARNESS_SPLIT_MIN, Math.min(CENTER_HARNESS_SPLIT_MAX, value));
}

function clampCenterHarnessSplitRatio(next: number): number {
  const value = Number.isFinite(next) ? next : DEFAULT_CENTER_HARNESS_SPLIT;
  return Math.max(CENTER_HARNESS_SPLIT_MIN, Math.min(CENTER_HARNESS_SPLIT_MAX, value));
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
    const parentQname = (symbol.parent_qualified_name || "").trim();
    if (!parentQname) {
      rootIndices.push(index);
      return;
    }
    const candidates = qnameToIndices.get(parentQname) || [];
    const parentIndex = candidates.find((candidateIndex) => candidateIndex !== index) ?? -1;
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

function parentPathForPath(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const parts = trimmed.split(/[\\/]+/);
  if (parts.length <= 1) return "";
  if (/^[A-Za-z]:$/.test(parts[0] || "")) {
    return `${parts[0]}\\${parts.slice(1, -1).join("\\")}`;
  }
  if (trimmed.startsWith("\\\\")) {
    return `\\\\${parts.slice(0, -1).join("\\")}`;
  }
  if (trimmed.startsWith("/")) {
    return `/${parts.slice(0, -1).join("/")}`;
  }
  return parts.slice(0, -1).join("\\");
}

function toFileEntry(path: string, name: string, isDir: boolean): FileEntry {
  return {
    path,
    name,
    is_dir: isDir,
  };
}

function treeNodeIconKind(path: string, isDir: boolean): TreeNodeIconKind {
  if (isDir) return "dir";
  const normalized = path.toLowerCase();
  if (normalized.endsWith(".sysml")) return "sysml";
  if (normalized.endsWith(".kerml")) return "kerml";
  if (normalized.endsWith(".diagram")) return "diagram";
  return "file";
}

function treeNodeIcon(kind: TreeNodeIconKind): string {
  if (kind === "dir") return UI_ICON.folder;
  return UI_ICON.file;
}

function symbolKindIcon(kind: string | null | undefined): string {
  const normalized = (kind || "").toLowerCase();
  if (normalized.includes("package")) return UI_ICON.package;
  if (normalized.includes("namespace")) return UI_ICON.namespace;
  if (normalized.includes("partdefinition") || normalized.includes("partusage") || normalized === "part") return UI_ICON.part;
  if (normalized.includes("actiondefinition") || normalized.includes("actionusage") || normalized === "action") return UI_ICON.action;
  if (normalized.includes("function")) return UI_ICON.function;
  if (normalized.includes("import")) return UI_ICON.import;
  if (
    normalized.includes("connector") ||
    normalized.includes("association") ||
    normalized.includes("associationend")
  ) {
    return UI_ICON.connector;
  }
  if (
    normalized.includes("attribute") ||
    normalized.includes("feature") ||
    normalized.includes("property") ||
    normalized.includes("reference")
  ) {
    return UI_ICON.property;
  }
  if (
    normalized.includes("interface") ||
    normalized.includes("definition") ||
    normalized.includes("usage") ||
    normalized.includes("type")
  ) {
    return UI_ICON.type;
  }
  return UI_ICON.bullet;
}

function shortMetatypeName(metatypeQname: string | null | undefined): string {
  const raw = (metatypeQname || "").trim();
  if (!raw) return "";
  const withoutRootPrefix = raw.replace(/^(sysml|kerml)::/i, "");
  const parts = withoutRootPrefix.split("::").filter(Boolean);
  if (!parts.length) return withoutRootPrefix;
  return parts[parts.length - 1] || withoutRootPrefix;
}

function symbolKindLabel(symbol: SymbolView): string {
  const metatypeLabel = shortMetatypeName(symbol.metatype_qname);
  if (metatypeLabel) return metatypeLabel;
  return symbol.kind || "?";
}

function fileDiagnosticToMarker(
  monaco: Parameters<OnMount>[1],
  diagnostic: FileDiagnosticView,
): {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  message: string;
  severity: number;
} {
  const line = Math.max(1, diagnostic.line || 1);
  const col = Math.max(1, diagnostic.column || 1);
  return {
    startLineNumber: line,
    startColumn: col,
    endLineNumber: line,
    endColumn: col + 1,
    message: formatFileDiagnostic(diagnostic),
    severity: monaco.MarkerSeverity.Error,
  };
}

function editorLanguageForPath(path: string | null | undefined): string {
  const ext = fileExtension(path);
  if (ext === ".sysml" || ext === ".kerml") return SYSML_LANGUAGE_ID;
  if (ext === ".json") return "json";
  if (ext === ".diagram") return "json";
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
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/@symbols/, {
          cases: {
            "@operators": "operator",
            "@default": "",
          },
        }],
        [/\d+(\.\d+)?/, "number"],
        [/".*?"/, "string"],
        [/'[^']*'/, "string"],
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

function isTextEditorTab(tab: EditorTab | null | undefined): tab is TextEditorTab {
  return !!tab && tab.kind === "text";
}

function isDiagramEditorTab(tab: EditorTab | null | undefined): tab is DiagramEditorTab {
  return !!tab && tab.kind === "diagram";
}

function isExplorerEditorTab(tab: EditorTab | null | undefined): tab is ExplorerEditorTab {
  return !!tab && tab.kind === "explorer";
}

function buildNewSemanticFileName(name: string, extension: NewFileExtension): string {
  const baseName = name.trim().replace(/\.(sysml|kerml)$/i, "").trim();
  return `${baseName}${extension}`;
}

function buildProjectPackageName(name: string): string {
  const compact = name
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part, index) => {
      const lower = part.toLowerCase();
      return index === 0 ? lower : `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
    })
    .join("")
    .replace(/^[^A-Za-z_]+/, "");
  return compact || "newProject";
}

function buildStarterProjectContent(projectName: string): string {
  const packageName = buildProjectPackageName(projectName);
  return `package ${packageName} {\n}\n`;
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

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  const tagName = element.tagName;
  return element.isContentEditable
    || tagName === "INPUT"
    || tagName === "TEXTAREA"
    || tagName === "SELECT";
}

function canRenameSymbol(symbol: SymbolView): boolean {
  return (symbol.source_scope || "project") === "project"
    && !!symbol.file_path.trim()
    && !!`${symbol.name || ""}`.trim();
}

function renamedQualifiedName(symbol: SymbolView, newName: string): string {
  const oldName = `${symbol.name || ""}`.trim();
  const qualifiedName = `${symbol.qualified_name || ""}`.trim();
  if (!qualifiedName || !oldName) return qualifiedName;
  if (qualifiedName === oldName) return newName;
  const suffix = `::${oldName}`;
  return qualifiedName.endsWith(suffix)
    ? `${qualifiedName.slice(0, -suffix.length)}::${newName}`
    : qualifiedName;
}

function renamedSymbolSnapshot(symbol: SymbolView, newName: string): SymbolView {
  return {
    ...symbol,
    name: newName,
    short_name: newName,
    qualified_name: renamedQualifiedName(symbol, newName),
  };
}

function semanticEditTarget(symbol: SymbolView): SemanticEditTargetWithLineage {
  const metatypeLineage = symbol.properties
    .find((property) => property.name === "metatype_lineage" || property.name === "mercurio::metatypeLineage");
  const metatypeSupertypes = symbol.properties
    .find((property) => property.name === "metatype_supertypes" || property.name === "mercurio::metatypeSupertypes");
  const lineageItems = metatypeLineage?.value.type === "list"
    ? metatypeLineage.value.items
    : [];
  const supertypeItems = metatypeSupertypes?.value.type === "list"
    ? metatypeSupertypes.value.items
    : (symbol.relationships || [])
      .filter((relationship) => relationship.kind === "metatypeSupertype")
      .map((relationship) => relationship.resolved_target || relationship.target)
      .filter((value): value is string => !!value);
  return {
    symbol_id: symbol.symbol_id || null,
    qualified_name: symbol.qualified_name,
    name: symbol.name,
    kind: symbol.kind,
    metatype_qname: symbol.metatype_qname || null,
    metatype_lineage: lineageItems,
    metatype_supertypes: supertypeItems,
    file_path: symbol.file_path,
    parent_qualified_name: symbol.parent_qualified_name || null,
    start_line: symbol.start_line,
    start_col: symbol.start_col,
    end_line: symbol.end_line,
    end_col: symbol.end_col,
    short_name_start_line: symbol.short_name_start_line,
    short_name_start_col: symbol.short_name_start_col,
    short_name_end_line: symbol.short_name_end_line,
    short_name_end_col: symbol.short_name_end_col,
    source_scope: symbol.source_scope || "project",
  } satisfies SemanticEditTargetWithLineage;
}

function buildSemanticEditInputValues(action: SemanticEditAction): SemanticEditInputValues {
  const values: SemanticEditInputValues = {};
  for (const field of action.fields) {
    if (field.field_type === "checkbox") {
      values[field.key] = !!field.default_bool;
    } else if (field.field_type === "select") {
      values[field.key] = field.default_text || field.options[0]?.value || "";
    } else {
      values[field.key] = field.default_text || "";
    }
  }
  return values;
}

function semanticEditFieldValue(field: SemanticEditField, value: string | boolean | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (field.field_type === "select" && field.options.length) {
    return field.options[0].value;
  }
  return "";
}

const DRAG_MOVE_TO_PACKAGE_ACTION: SemanticEditAction = {
  id: "package.move_symbol_here",
  label: "Move Here",
  description: "Move the dragged semantic element into this package.",
  applies_to: [{ type_name: "Package", include_subtypes: true }],
  fields: [
    {
      key: "source_qualified_name",
      label: "Source Element",
      field_type: "readonly",
      required: true,
      description: "The semantic element being moved.",
      options: [],
    },
    {
      key: "source_kind",
      label: "Source Kind",
      field_type: "readonly",
      required: true,
      description: "The kind/metatype of the dragged element.",
      options: [],
    },
    {
      key: "source_file_path",
      label: "Source File",
      field_type: "readonly",
      required: true,
      description: "Same-file tree moves are supported in this pass.",
      options: [],
    },
  ],
};

const TREE_RENAME_ACTION_ID = "element.rename";

function canDragSymbol(symbol: SymbolView): boolean {
  return (symbol.source_scope || "project") === "project";
}

function isPackageLike(symbol: SymbolView): boolean {
  const kind = `${symbol.kind || ""}`.toLowerCase();
  const metatype = `${symbol.metatype_qname || ""}`.toLowerCase();
  return kind.includes("package") || metatype.endsWith("::package") || metatype === "package";
}

function canDropSymbolOnPackage(source: SymbolView, target: SymbolView): boolean {
  if (!canDragSymbol(source)) return false;
  if (!isPackageLike(target)) return false;
  if (normalizePath(source.file_path) !== normalizePath(target.file_path)) return false;
  const sourceId = symbolIdentity(source);
  const targetId = symbolIdentity(target);
  if (sourceId === targetId) return false;
  const sourceParent = (source.parent_qualified_name || "").trim();
  const targetQname = (target.qualified_name || "").trim();
  const sourceQname = (source.qualified_name || "").trim();
  if (!targetQname || !sourceQname) return false;
  if (sourceParent === targetQname) return false;
  if (targetQname === sourceQname) return false;
  if (targetQname.startsWith(`${sourceQname}::`)) return false;
  return true;
}

const BuildLogList = memo(function BuildLogList({
  entries,
}: {
  entries: Array<{
    id: number;
    at: string;
    timestampUtc?: string;
    kind: string;
    level: "info" | "warn" | "error";
    message: string;
  }>;
}) {
  if (!entries.length) {
    return <div className="muted">No build events yet.</div>;
  }
  return (
    <>
      {entries.slice(-120).map((entry) => (
        <div key={entry.id} className={`simple-build-progress-row ${entry.level}`}>
          <span className="simple-build-progress-at" title={entry.timestampUtc || entry.at}>{entry.at}</span>
          <span className="simple-build-progress-level">{entry.level}</span>
          <span className="simple-build-progress-kind" title={entry.kind}>{entry.kind}</span>
          <span className="simple-build-progress-message">{entry.message}</span>
        </div>
      ))}
    </>
  );
});

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
  const [harnessRuns, setHarnessRuns] = useState<HarnessRun[]>([]);
  const [backgroundJobs, setBackgroundJobs] = useState<BackgroundJobsSnapshot>({
    total: 0,
    cancelable: 0,
    jobs: [],
  });
  const [expandedFileSymbols, setExpandedFileSymbols] = useState<Record<string, boolean>>({});
  const [expandedLibraryFiles, setExpandedLibraryFiles] = useState<Record<string, boolean>>({});
  const [collapsedSymbolNodes, setCollapsedSymbolNodes] = useState<Record<string, boolean>>({});
  const [expandedProjectElementsOverflow, setExpandedProjectElementsOverflow] = useState(false);
  const [expandedLibraryElementsOverflow, setExpandedLibraryElementsOverflow] = useState(false);
  const [expandedProjectFileSymbolOverflow, setExpandedProjectFileSymbolOverflow] = useState<Record<string, boolean>>({});
  const [expandedLibraryFileSymbolOverflow, setExpandedLibraryFileSymbolOverflow] = useState<Record<string, boolean>>({});
  const [collapsedParseErrorFiles, setCollapsedParseErrorFiles] = useState<Record<string, boolean>>({});
  const [projectFilesExpanded, setProjectFilesExpanded] = useState(true);
  const [projectFilesShowByFile, setProjectFilesShowByFile] = useState<boolean>(() =>
    window.localStorage?.getItem(PROJECT_FILES_SHOW_BY_FILE_KEY) !== "0",
  );
  const [libraryFilesExpanded, setLibraryFilesExpanded] = useState(true);
  const [menuOpen, setMenuOpen] = useState<"file" | "build" | "view" | "settings" | "help" | null>(null);
  const [stdlibManagerOpen, setStdlibManagerOpen] = useState(false);
  const [aboutWindowOpen, setAboutWindowOpen] = useState(false);
  const [metamodelSchemaVersion, setMetamodelSchemaVersion] = useState<string | null>(null);
  const [projectModel, setProjectModel] = useState<ProjectModelView | null>(null);
  const [projectFilesSettingsMenuOpen, setProjectFilesSettingsMenuOpen] = useState(false);
  const [stdlibPathOptions, setStdlibPathOptions] = useState<StdlibPathOption[]>(() => readStdlibPathOptions());
  const [dialogActiveStdlibPath, setDialogActiveStdlibPath] = useState("");
  const [dialogDefaultStdlibId, setDialogDefaultStdlibId] = useState<string | null>(null);
  const [dialogStdlibMetaLoading, setDialogStdlibMetaLoading] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState | null>(null);
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState | null>(null);
  const [semanticEditMenu, setSemanticEditMenu] = useState<SemanticEditMenuState | null>(null);
  const [semanticEditDialog, setSemanticEditDialog] = useState<SemanticEditDialogState | null>(null);
  const [symbolTreeDragState, setSymbolTreeDragState] = useState<SymbolTreeDragState | null>(null);
  const [symbolTreeDropTargetId, setSymbolTreeDropTargetId] = useState<string | null>(null);
  const [treeRenameState, setTreeRenameState] = useState<TreeRenameState | null>(null);
  const [newProjectDialog, setNewProjectDialog] = useState<NewProjectDialogState | null>(null);
  const [newFileDialog, setNewFileDialog] = useState<NewFileDialogState | null>(null);
  const [newDiagramDialog, setNewDiagramDialog] = useState<NewDiagramDialogState | null>(null);
  const [pendingProjectFileToOpen, setPendingProjectFileToOpen] = useState<string | null>(null);
  const [tabsOverflow, setTabsOverflow] = useState(false);
  const [tabsOverflowMenuOpen, setTabsOverflowMenuOpen] = useState(false);
  const [dragTabPath, setDragTabPath] = useState<string | null>(null);
  const [dragOverTabPath, setDragOverTabPath] = useState<string | null>(null);
  const [diagramDragHover, setDiagramDragHover] = useState(false);
  const [activeToolTab, setActiveToolTab] = useState<ToolTabId>("logs");
  const [expressionInput, setExpressionInput] = useState("1 + 2 * 3");
  const [expressionResult, setExpressionResult] = useState<ExpressionEvaluationResult | null>(null);
  const [expressionPending, setExpressionPending] = useState(false);
  const [expressionRequestError, setExpressionRequestError] = useState("");
  const [autoBuildActiveFile, setAutoBuildActiveFile] = useState<boolean>(() =>
    window.localStorage?.getItem(AUTO_BUILD_ACTIVE_FILE_KEY) === "1",
  );
  const [rightPaneWidth, setRightPaneWidth] = useState<number>(() => initialRightPaneWidth);
  const [leftPaneWidth, setLeftPaneWidth] = useState<number>(() =>
    parseLeftPaneWidth(
      window.localStorage?.getItem(LEFT_PANE_WIDTH_KEY) || null,
      initialViewportWidth,
      initialRightPaneWidth,
    ),
  );
  const [rightPanelSplitRatio, setRightPanelSplitRatio] = useState<number>(() =>
    parseRightPanelSplitRatio(window.localStorage?.getItem(RIGHT_PANEL_SPLIT_KEY)),
  );
  const [centerHarnessSplitRatio, setCenterHarnessSplitRatio] = useState<number>(() =>
    parseCenterHarnessSplitRatio(window.localStorage?.getItem(CENTER_HARNESS_SPLIT_KEY)),
  );
  const [leftPaneDragging, setLeftPaneDragging] = useState(false);
  const [rightPaneDragging, setRightPaneDragging] = useState(false);
  const [rightPanelSplitDragging, setRightPanelSplitDragging] = useState(false);
  const [centerHarnessSplitDragging, setCenterHarnessSplitDragging] = useState(false);
  const shouldShowTabDropdown = tabsOverflow || openTabs.length > TAB_DROPDOWN_THRESHOLD;

  const {
    rootPath: projectTreeRootPath,
    treeEntries,
    expanded,
    hydrateTree: hydrateProjectTree,
    refreshRoot,
    toggleExpand,
    ensureExpanded,
    expandAll,
    collapseAll,
  } = useProjectTree();
  const {
    rootPath: libraryTreeRootPath,
    treeEntries: libraryTreeEntries,
    expanded: expandedLibraryDirs,
    manifestEntries: libraryTreeManifest,
    hydrateTree: hydrateLibraryTree,
    refreshRoot: refreshLibraryTree,
    toggleExpand: toggleLibraryDir,
    expandAll: expandAllLibraryTree,
    collapseAll: collapseLibraryTree,
  } = useFileTree();

  const {
    sessionToken,
    compileStatus,
    setCompileStatus,
    showErrorNotification,
    compileRunId,
    compileToast,
    runCompile,
    cancelCompile,
    symbols,
    symbolsStatus,
    parsedFiles,
    fileDiagnosticPaths,
    progressUiUpdates,
    droppedCompileRequests,
    buildLogEntries,
    clearBuildLogs,
    buildProgress,
    activeLibraryPath,
    symbolIndexError,
    semanticRefreshVersion,
    applyWorkspaceSnapshot,
    resetWorkspaceSymbols,
  } = useCompileRunner({ rootPath });
  const unresolvedCount = useMemo(
    () => compileToast.fileDiagnostics.reduce(
      (count, bucket) => count + bucket.diagnostics.filter((diagnostic) => diagnostic.source === "semantic").length,
      0,
    ),
    [compileToast.fileDiagnostics],
  );
  const projectSymbols = useMemo(
    () => symbols.filter((symbol) => symbol.source_scope !== "library"),
    [symbols],
  );
  const workspaceSymbolsByQualified = useMemo(
    () => new Map(symbols.map((symbol) => [symbol.qualified_name, symbol] as const)),
    [symbols],
  );
  const projectSymbolsByQualified = useMemo(
    () => new Map(projectSymbols.map((symbol) => [symbol.qualified_name, symbol] as const)),
    [projectSymbols],
  );
  const librarySymbols = useMemo(
    () => symbols.filter((symbol) => symbol.source_scope === "library"),
    [symbols],
  );
  const projectSymbolRoots = useMemo(
    () => buildSymbolOwnershipTree(projectSymbols),
    [projectSymbols],
  );
  const librarySymbolRoots = useMemo(
    () => buildSymbolOwnershipTree(librarySymbols),
    [librarySymbols],
  );
  const [buildClockTick, setBuildClockTick] = useState(0);

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const cursorListenerRef = useRef<{ dispose: () => void } | null>(null);
  const treeRenameInputRef = useRef<HTMLInputElement | null>(null);
  const suppressDirtyRef = useRef(false);
  const dirtyRef = useRef(false);
  const fileOpenReqRef = useRef(0);
  const contentRef = useRef("");
  const harnessRunIdRef = useRef(0);
  const progressUiUpdatesRef = useRef(0);
  const cursorFlushTimerRef = useRef<number | undefined>(undefined);
  const pendingCursorRef = useRef<{ line: number; col: number } | null>(null);
  const leftPaneWidthRef = useRef(leftPaneWidth);
  const rightPaneWidthRef = useRef(rightPaneWidth);
  const tabsStripRef = useRef<HTMLDivElement | null>(null);
  const newProjectNameInputRef = useRef<HTMLInputElement | null>(null);
  const newFileNameInputRef = useRef<HTMLInputElement | null>(null);
  const newDiagramNameInputRef = useRef<HTMLInputElement | null>(null);
  const rightPanelRef = useRef<HTMLElement | null>(null);
const centerPanelRef = useRef<HTMLElement | null>(null);
const leftPaneDragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
const rightPaneDragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
const rightPanelSplitDragRef = useRef<{
  pointerId: number | null;
  startY: number;
  startRatio: number;
  captureTarget: HTMLElement | null;
} | null>(null);
const centerHarnessSplitDragRef = useRef<{ pointerId: number; startY: number; startRatio: number } | null>(null);
  const projectFilesChangedTimerRef = useRef<number | undefined>(undefined);
  const projectWatcherRootRef = useRef("");
  const libraryFilesChangedTimerRef = useRef<number | undefined>(undefined);
  const libraryWatcherRootRef = useRef("");
  const projectFilesSettingsButtonRef = useRef<HTMLDivElement | null>(null);
  const autoBuildTimerRef = useRef<number | undefined>(undefined);
  const autoBuildQueuedRef = useRef(false);
  const lastAutoBuildAtRef = useRef<number>(0);
  const compileRunIdRef = useRef<number | null>(compileRunId ?? null);
  const workspaceStartupRequestRef = useRef(0);

  const syncViewportHeight = useCallback(() => {
    const viewportHeight =
      window.visualViewport?.height
      || window.innerHeight
      || document.documentElement?.clientHeight
      || 0;
    if (viewportHeight > 0) {
      document.documentElement.style.setProperty("--app-vh", `${Math.round(viewportHeight)}px`);
    }
  }, []);

  useLayoutEffect(() => {
    syncViewportHeight();
  }, [syncViewportHeight]);
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
    window.localStorage?.setItem(RIGHT_PANEL_SPLIT_KEY, String(Math.round(rightPanelSplitRatio * 1000) / 1000));
  }, [rightPanelSplitRatio]);

  useEffect(() => {
    window.localStorage?.setItem(CENTER_HARNESS_SPLIT_KEY, String(Math.round(centerHarnessSplitRatio * 1000) / 1000));
  }, [centerHarnessSplitRatio]);

  useEffect(() => {
    window.localStorage?.setItem(PROJECT_FILES_SHOW_BY_FILE_KEY, projectFilesShowByFile ? "1" : "0");
  }, [projectFilesShowByFile]);

  const reportStartupEvent = useCallback((
    level: "info" | "warn" | "error",
    message: string,
  ) => {
    const text = `${message || ""}`.trim();
    if (!text) return;
    void logFrontendEvent({
      level,
      kind: "startup",
      message: text,
    }).catch(() => {});
  }, []);

  const loadLiveWorkspaceTrees = useCallback(async (
    path: string,
  ): Promise<boolean> => {
    const trimmed = (path || "").trim();
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const requestId = workspaceStartupRequestRef.current + 1;
    workspaceStartupRequestRef.current = requestId;
    if (!trimmed) {
      hydrateProjectTree("", []);
      hydrateLibraryTree("", []);
      resetWorkspaceSymbols();
      return true;
    }

    const snapshot = await getWorkspaceTreeSnapshot(trimmed);
    if (workspaceStartupRequestRef.current !== requestId) return false;
    const canonicalProjectRoot = (snapshot.project_root || trimmed).trim();
    const durationMs = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt);

    hydrateProjectTree(
      canonicalProjectRoot,
      (snapshot.project_tree || []).map((entry) => toFileEntry(entry.path, entry.name, !!entry.is_dir)),
    );
    hydrateLibraryTree(
      (snapshot.library_path || "").trim(),
      (snapshot.library_tree || []).map((entry) => toFileEntry(entry.path, entry.name, !!entry.is_dir)),
    );
    setTreeError("");
    reportStartupEvent(
      "info",
      `workspace tree loaded root=${canonicalProjectRoot} duration_ms=${durationMs} project_entries=${snapshot.project_tree?.length || 0} library_entries=${snapshot.library_tree?.length || 0}`,
    );
    return true;
  }, [hydrateLibraryTree, hydrateProjectTree, reportStartupEvent, resetWorkspaceSymbols]);

  const loadCachedWorkspaceSymbols = useCallback(async (
    path: string,
  ): Promise<boolean> => {
    const trimmed = (path || "").trim();
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (!trimmed) {
      resetWorkspaceSymbols();
      return true;
    }
    const snapshot = await getWorkspaceStartupSnapshot(trimmed, false, true);
    const durationMs = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt);
    const diagnostics = snapshot?.diagnostics || [];
    const backendTimings = snapshot?.timings;
    const symbolTimings = snapshot?.symbol_timings;
    for (const diagnostic of diagnostics) {
      if (/(failed|error)/i.test(`${diagnostic || ""}`)) {
        showErrorNotification(diagnostic);
      }
    }
    reportStartupEvent(
      snapshot?.cache_hit ? "info" : "warn",
      `workspace startup snapshot duration_ms=${durationMs} cache_hit=${snapshot?.cache_hit ? "true" : "false"} project_symbols=${snapshot?.project_symbols?.length || 0} library_symbols=${snapshot?.library_symbols?.length || 0} project_semantic_projections=${snapshot?.project_semantic_projection_count || 0} diagnostics=${diagnostics.length}`,
    );
    if (backendTimings) {
      const frontendOverheadMs = Math.max(0, durationMs - (backendTimings.total_duration_ms || 0));
      reportStartupEvent(
        "info",
        `workspace startup backend timings total_ms=${backendTimings.total_duration_ms} frontend_overhead_ms=${frontendOverheadMs} cache_load_ms=${backendTimings.cache_load_ms} cache_seed_symbol_index_ms=${backendTimings.cache_seed_symbol_index_ms} cache_seed_projection_ms=${backendTimings.cache_seed_projection_ms} project_tree_collect_ms=${backendTimings.project_tree_collect_ms} symbol_snapshot_ms=${backendTimings.symbol_snapshot_ms} library_tree_collect_ms=${backendTimings.library_tree_collect_ms}`,
      );
    }
    if (symbolTimings) {
      reportStartupEvent(
        "info",
        `workspace symbol snapshot timings total_ms=${symbolTimings.total_duration_ms} seed_symbol_index_ms=${symbolTimings.seed_symbol_index_ms} project_query_ms=${symbolTimings.project_query_ms} library_query_ms=${symbolTimings.library_query_ms} library_hydration_ms=${symbolTimings.library_hydration_ms} library_requery_ms=${symbolTimings.library_requery_ms} library_metadata_ms=${symbolTimings.library_metadata_ms}`,
      );
    }
    if (snapshot?.cache_hit) {
      applyWorkspaceSnapshot({
        snapshot,
        sessionToken,
        reason: "startup-cache",
      });
      setCompileStatus("Startup: workspace cache loaded");
      return true;
    }
    setCompileStatus("Startup: no workspace cache; compiling project");
    reportStartupEvent("warn", `workspace cache miss root=${trimmed}; compile fallback starting`);
    const ok = await runCompile();
    reportStartupEvent(
      ok ? "info" : "warn",
      `workspace compile fallback completed root=${trimmed} ok=${ok ? "true" : "false"}`,
    );
    return ok;
  }, [
    applyWorkspaceSnapshot,
    reportStartupEvent,
    resetWorkspaceSymbols,
    runCompile,
    sessionToken,
    setCompileStatus,
    showErrorNotification,
  ]);

  useEffect(() => {
    if (!rootPath) {
      setTreeError("");
      setTreeRenameState(null);
      workspaceStartupRequestRef.current += 1;
      hydrateProjectTree("", []);
      hydrateLibraryTree("", []);
      resetWorkspaceSymbols();
      return;
    }
    let active = true;
    setTreeError("");
    void (async () => {
      const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      reportStartupEvent("info", `startup sequence begin root=${rootPath}`);
      try {
        await loadLiveWorkspaceTrees(rootPath);
        if (!active) return;
        const startupOk = await loadCachedWorkspaceSymbols(rootPath);
        if (!active) return;
        const durationMs = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt);
        reportStartupEvent(
          startupOk ? "info" : "warn",
          `startup sequence complete root=${rootPath} duration_ms=${durationMs} ok=${startupOk ? "true" : "false"}`,
        );
      } catch (error) {
        if (!active) return;
        const message = `Startup failed: ${String(error)}`;
        setTreeError(message);
        setCompileStatus(message);
        showErrorNotification(message);
        reportStartupEvent("error", `${message} root=${rootPath}`);
      }
    })();
    return () => {
      active = false;
      workspaceStartupRequestRef.current += 1;
    };
  }, [
    hydrateLibraryTree,
    hydrateProjectTree,
    loadCachedWorkspaceSymbols,
    loadLiveWorkspaceTrees,
    reportStartupEvent,
    resetWorkspaceSymbols,
    rootPath,
    setCompileStatus,
    showErrorNotification,
  ]);

  useEffect(() => {
    if (autoBuildTimerRef.current !== undefined) {
      window.clearTimeout(autoBuildTimerRef.current);
      autoBuildTimerRef.current = undefined;
    }
    setActiveFilePath(null);
    setOpenTabs([]);
    setSelectedSymbol(null);
    setExpandedFileSymbols({});
    setExpandedLibraryFiles({});
    collapseLibraryTree();
    setCollapsedSymbolNodes({});
    setExpandedProjectElementsOverflow(false);
    setExpandedLibraryElementsOverflow(false);
    setExpandedProjectFileSymbolOverflow({});
    setExpandedLibraryFileSymbolOverflow({});
    contentRef.current = "";
    dirtyRef.current = false;
    setDirty(false);
    if (editorRef.current) {
      suppressDirtyRef.current = true;
      editorRef.current.setValue("");
    }
  }, [collapseLibraryTree, rootPath]);

  const effectiveTreeError = treeError || (symbolsStatus === "error" ? symbolIndexError : "");
  const rightPanelWorkspaceErrors = useMemo(() => {
    const seen = new Set<string>();
    const next: string[] = [];
    for (const message of [effectiveTreeError, ...compileToast.workspaceErrors]) {
      const text = `${message || ""}`.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      next.push(text);
    }
    return next;
  }, [compileToast.workspaceErrors, effectiveTreeError]);

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
    window.localStorage?.setItem(AUTO_BUILD_ACTIVE_FILE_KEY, autoBuildActiveFile ? "1" : "0");
  }, [autoBuildActiveFile]);

  useEffect(() => {
    compileRunIdRef.current = compileRunId ?? null;
  }, [compileRunId]);

  useEffect(() => {
    setExpressionResult(null);
    setExpressionRequestError("");
  }, [rootPath]);

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
    if (!rootPath) {
      setProjectModel(null);
      setMetamodelSchemaVersion(null);
      return;
    }
    let active = true;
    void Promise.allSettled([
      getProjectModel(rootPath),
      getDefaultStdlib(),
    ])
      .then((results) => {
        if (!active) return;
        const projectModel = results[0].status === "fulfilled" ? results[0].value : null;
        const defaultStdlib = results[1].status === "fulfilled" ? results[1].value : null;
        setProjectModel(projectModel);
        const resolvedStdlibPath = (projectModel?.stdlib_path || activeLibraryPath || "").trim();
        const version = stdlibVersionFromPath(resolvedStdlibPath) || (defaultStdlib || "").trim();
        setMetamodelSchemaVersion(version || null);
      })
      .catch(() => {
        if (!active) return;
        setProjectModel(null);
        setMetamodelSchemaVersion(null);
      });
    return () => {
      active = false;
    };
  }, [rootPath, activeLibraryPath, semanticRefreshVersion]);

  useEffect(() => {
    const handleResize = () => {
      syncViewportHeight();
      const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
      const nextRight = clampRightPaneWidth(rightPaneWidthRef.current, viewportWidth, leftPaneWidthRef.current);
      const nextLeft = clampLeftPaneWidth(leftPaneWidthRef.current, viewportWidth, nextRight);
      setRightPaneWidth(nextRight);
      setLeftPaneWidth(nextLeft);
      editorRef.current?.layout();
    };
    handleResize();
    const visualViewport = window.visualViewport;
    window.addEventListener("resize", handleResize);
    visualViewport?.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      visualViewport?.removeEventListener("resize", handleResize);
    };
  }, [syncViewportHeight]);

  useEffect(() => {
    document.body.classList.toggle("simple-ui-resizing", leftPaneDragging || rightPaneDragging);
    document.body.classList.toggle(
      "simple-ui-resizing-vertical",
      rightPanelSplitDragging || centerHarnessSplitDragging,
    );
    return () => {
      document.body.classList.remove("simple-ui-resizing");
      document.body.classList.remove("simple-ui-resizing-vertical");
    };
  }, [leftPaneDragging, rightPaneDragging, rightPanelSplitDragging, centerHarnessSplitDragging]);

  const syncMonacoLayout = useCallback(() => {
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
  }, []);

  useEffect(() => {
    const frames: number[] = [];
    const scheduleSync = () => {
      const frame = window.requestAnimationFrame(() => {
        syncViewportHeight();
        syncMonacoLayout();
      });
      frames.push(frame);
    };
    scheduleSync();
    const t1 = window.setTimeout(scheduleSync, 16);
    const t2 = window.setTimeout(scheduleSync, 120);
    const t3 = window.setTimeout(scheduleSync, 260);
    return () => {
      for (const frame of frames) {
        window.cancelAnimationFrame(frame);
      }
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [syncMonacoLayout, syncViewportHeight]);

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
    if (!tabContextMenu && !fileContextMenu && !semanticEditMenu && !tabsOverflowMenuOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (
        target.closest(".simple-tab-context-menu")
        || target.closest(".simple-file-context-menu")
        || target.closest(".simple-semantic-edit-menu")
        || target.closest(".simple-project-files-settings-menu")
        || target.closest(".simple-editor-tabs-overflow")
      ) {
        return;
      }
      setTabContextMenu(null);
      setFileContextMenu(null);
      setSemanticEditMenu(null);
      setTabsOverflowMenuOpen(false);
      setProjectFilesSettingsMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setTabContextMenu(null);
      setFileContextMenu(null);
      setSemanticEditMenu(null);
      setTabsOverflowMenuOpen(false);
      setProjectFilesSettingsMenuOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [tabContextMenu, fileContextMenu, semanticEditMenu, tabsOverflowMenuOpen, projectFilesSettingsMenuOpen]);

  useEffect(() => {
    if (!treeRenameState) return;
    const focusTimer = window.setTimeout(() => {
      treeRenameInputRef.current?.focus();
      treeRenameInputRef.current?.select();
    }, 0);
    return () => {
      window.clearTimeout(focusTimer);
    };
  }, [treeRenameState]);

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
    if (!aboutWindowOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAboutWindowOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [aboutWindowOpen]);

  useEffect(() => {
    if (!newProjectDialog) return;
    const focusTimer = window.setTimeout(() => {
      newProjectNameInputRef.current?.focus();
      newProjectNameInputRef.current?.select();
    }, 0);
    return () => {
      window.clearTimeout(focusTimer);
    };
  }, [!!newProjectDialog]);

  useEffect(() => {
    if (!newProjectDialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !newProjectDialog.submitting) {
        setNewProjectDialog(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [newProjectDialog]);

  useEffect(() => {
    if (!newFileDialog) return;
    const focusTimer = window.setTimeout(() => {
      newFileNameInputRef.current?.focus();
      newFileNameInputRef.current?.select();
    }, 0);
    return () => {
      window.clearTimeout(focusTimer);
    };
  }, [!!newFileDialog]);

  useEffect(() => {
    if (!newFileDialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !newFileDialog.submitting) {
        setNewFileDialog(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [newFileDialog]);

  useEffect(() => {
    if (!newDiagramDialog) return;
    const focusTimer = window.setTimeout(() => {
      newDiagramNameInputRef.current?.focus();
      newDiagramNameInputRef.current?.select();
    }, 0);
    return () => {
      window.clearTimeout(focusTimer);
    };
  }, [!!newDiagramDialog]);

  useEffect(() => {
    if (!newDiagramDialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !newDiagramDialog.submitting) {
        setNewDiagramDialog(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [newDiagramDialog]);

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
      monaco.editor.setModelMarkers(model, FILE_DIAGNOSTIC_MARKER_OWNER, []);
      return;
    }
    const bucket = compileToast.fileDiagnostics.find((entry) => normalizePath(entry.path) === activeKey);
    const markers = (bucket?.diagnostics || []).map((diagnostic) => fileDiagnosticToMarker(monaco, diagnostic));
    monaco.editor.setModelMarkers(model, FILE_DIAGNOSTIC_MARKER_OWNER, markers);
  }, [activeFilePath, compileToast.fileDiagnostics]);

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
    dirtyRef.current = tab.dirty;
    setDirty(tab.dirty);
    if (!isTextEditorTab(tab)) {
      contentRef.current = tab.content;
      setCursorPos(null);
      return;
    }
    contentRef.current = tab.content;
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
        if (!isTextEditorTab(tab)) return tab;
        if (tab.content === nextContent && tab.dirty === nextDirty) return tab;
        changed = true;
        return { ...tab, content: nextContent, dirty: nextDirty };
      });
      return changed ? next : prev;
    });
  }, [activeFilePath]);

  const openEditedFileWithContent = useCallback((
    path: string,
    updatedText: string,
    selection?: TextSelection,
  ) => {
    const pathKey = normalizePath(path);
    const tab: TextEditorTab = {
      path,
      name: displayNameForPath(path),
      kind: "text",
      content: updatedText,
      dirty: false,
    };
    persistActiveEditorBuffer();
    setOpenTabs((prev) => {
      const existingIndex = prev.findIndex((entry) => normalizePath(entry.path) === pathKey);
      if (existingIndex < 0) {
        return [...prev, tab];
      }
      return prev.map((entry, index) => (index === existingIndex ? tab : entry));
    });
    activateEditorTab(tab, selection);
  }, [persistActiveEditorBuffer, activateEditorTab]);

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
      }
      activateEditorTab(existing, selection);
      return;
    }
    const reqId = ++fileOpenReqRef.current;
    try {
      const text = await readFileText(path);
      if (reqId !== fileOpenReqRef.current) return;
      let tab: EditorTab;
      if (isDiagramFilePath(path)) {
        try {
          const document = parseDiagramDocument(text);
          tab = {
            path,
            name: document.name || displayNameForPath(path),
            kind: "diagram",
            content: text,
            document,
            dirty: false,
          };
        } catch (error) {
          setCompileStatus(`Diagram parse failed for ${displayNameForPath(path)}: ${String(error)}. Opened as text.`);
          tab = {
            path,
            name: displayNameForPath(path),
            kind: "text",
            content: text,
            dirty: false,
          };
        }
      } else {
        tab = {
          path,
          name: displayNameForPath(path),
          kind: "text",
          content: text,
          dirty: false,
        };
      }
      setOpenTabs((prev) => {
        if (prev.some((entry) => normalizePath(entry.path) === pathKey)) return prev;
        return [...prev, tab];
      });
      if (!options?.preserveSymbolSelection) {
        setSelectedSymbol(null);
      }
      activateEditorTab(tab, selection);
    } catch (error) {
      setCompileStatus(`Open failed: ${String(error)}`);
    }
  }, [activeFilePath, persistActiveEditorBuffer, openTabs, applySelection, activateEditorTab, setCompileStatus]);

  const updateExplorerTab = useCallback((
    path: string,
    updater: (tab: ExplorerEditorTab) => ExplorerEditorTab,
  ) => {
    const pathKey = normalizePath(path);
    setOpenTabs((prev) => prev.map((tab) => {
      if (normalizePath(tab.path) !== pathKey || !isExplorerEditorTab(tab)) return tab;
      return updater(tab);
    }));
  }, []);

  const openModelExplorerForSymbol = useCallback((symbol: SymbolView | null) => {
    const preferredRoot = resolvePreferredExplorerRoot(symbol, symbols);
    if (!preferredRoot) {
      setCompileStatus("Select an element to open Model Explorer.");
      return;
    }
    const existing = openTabs.find((tab) => normalizePath(tab.path) === normalizePath(MODEL_EXPLORER_TAB_PATH));
    const nextTab: ExplorerEditorTab = isExplorerEditorTab(existing)
      ? {
          ...existing,
          rootQualifiedName: preferredRoot.qualified_name,
          expandedQualifiedNames: [],
          viewport: null,
          nodePositions: {},
          historyBack: existing.rootQualifiedName && existing.rootQualifiedName !== preferredRoot.qualified_name
            ? [...existing.historyBack, existing.rootQualifiedName]
            : existing.historyBack,
          historyForward: [],
          selectedQualifiedName: preferredRoot.qualified_name,
          selectedEdgeId: null,
        }
      : {
          path: MODEL_EXPLORER_TAB_PATH,
          name: "Model Explorer",
          kind: "explorer",
          content: "",
          rootQualifiedName: preferredRoot.qualified_name,
          expandedQualifiedNames: [],
          viewport: null,
          nodePositions: {},
          showDirectedRelationships: false,
          historyBack: [],
          historyForward: [],
          selectedQualifiedName: preferredRoot.qualified_name,
          selectedEdgeId: null,
          dirty: false,
        };
    persistActiveEditorBuffer();
    setOpenTabs((prev) => {
      const next = prev.filter((tab) => normalizePath(tab.path) !== normalizePath(MODEL_EXPLORER_TAB_PATH));
      return [...next, nextTab];
    });
    setSelectedSymbol(preferredRoot);
    activateEditorTab(nextTab);
  }, [activateEditorTab, openTabs, persistActiveEditorBuffer, setCompileStatus, symbols]);

  const createNewProjectFromDialog = useCallback(async () => {
    if (!newProjectDialog || newProjectDialog.submitting) return;
    const parentPath = newProjectDialog.parentPath.trim();
    if (!parentPath) {
      setNewProjectDialog((prev) => (prev ? { ...prev, error: "Parent folder is required." } : prev));
      return;
    }
    const projectName = newProjectDialog.name.trim();
    if (!projectName) {
      setNewProjectDialog((prev) => (prev ? { ...prev, error: "Project name is required." } : prev));
      return;
    }
    if (projectName === "." || projectName === ".." || INVALID_NEW_PROJECT_NAME_CHARS.test(projectName)) {
      setNewProjectDialog((prev) => (
        prev
          ? { ...prev, error: "Project name contains invalid characters: <>:\"/\\|?*" }
          : prev
      ));
      return;
    }
    const createStarterFile = !!newProjectDialog.createStarterFile;
    const starterFileBaseName = createStarterFile
      ? newProjectDialog.starterFileName.trim().replace(/\.(sysml|kerml)$/i, "").trim()
      : "";
    if (createStarterFile && !starterFileBaseName) {
      setNewProjectDialog((prev) => (prev ? { ...prev, error: "Starter file name is required." } : prev));
      return;
    }
    if (createStarterFile && INVALID_NEW_FILE_NAME_CHARS.test(starterFileBaseName)) {
      setNewProjectDialog((prev) => (
        prev
          ? { ...prev, error: "Starter file name contains invalid characters: <>:\"/\\|?*" }
          : prev
      ));
      return;
    }
    setNewProjectDialog((prev) => (prev ? { ...prev, error: "", submitting: true } : prev));
    try {
      const createdRoot = await createProject(
        parentPath,
        projectName,
        newProjectDialog.author.trim(),
        newProjectDialog.description.trim(),
        newProjectDialog.organization.trim(),
        newProjectDialog.useDefaultLibrary,
      );
      let starterPath: string | null = null;
      if (createStarterFile) {
        const starterFileName = buildNewSemanticFileName(
          starterFileBaseName,
          newProjectDialog.starterFileExtension,
        );
        starterPath = await createProjectFile(createdRoot, createdRoot, starterFileName);
        await invoke("write_file", {
          path: starterPath,
          content: buildStarterProjectContent(projectName),
        });
      }
      setNewProjectDialog(null);
      if (starterPath) {
        setPendingProjectFileToOpen(starterPath);
      }
      const nextRoot = createdRoot.trim();
      if (autoBuildTimerRef.current !== undefined) {
        window.clearTimeout(autoBuildTimerRef.current);
        autoBuildTimerRef.current = undefined;
      }
      if (compileRunIdRef.current) {
        void cancelCompile();
      }
      setRootPath(nextRoot);
      if (nextRoot) {
        window.localStorage?.setItem(ROOT_STORAGE_KEY, nextRoot);
        setRecentProjects((prev) => pushRecentProject(nextRoot, prev));
      }
      setCompileStatus(
        starterPath
          ? `Created project: ${createdRoot} (${displayNameForPath(starterPath)})`
          : `Created project: ${createdRoot}`,
      );
    } catch (error) {
      const message = String(error);
      setCompileStatus(`Create project failed: ${message}`);
      setNewProjectDialog((prev) => (
        prev
          ? { ...prev, error: `Create project failed: ${message}`, submitting: false }
          : prev
      ));
    }
  }, [cancelCompile, newProjectDialog, setCompileStatus]);

  useEffect(() => {
    const pendingPath = (pendingProjectFileToOpen || "").trim();
    const activeRoot = (projectTreeRootPath || rootPath).trim();
    if (!pendingPath || !activeRoot || !isPathWithin(activeRoot, pendingPath)) return;
    let active = true;
    void (async () => {
      try {
        await openFilePath(pendingPath);
      } finally {
        if (active) {
          setPendingProjectFileToOpen(null);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [openFilePath, pendingProjectFileToOpen, projectTreeRootPath, rootPath]);

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
    setFileContextMenu(null);
    setTabsOverflowMenuOpen(false);
    if (!wasActive) return;
    const fallback = nextTabs[Math.max(0, index - 1)] || nextTabs[0] || null;
    if (fallback) {
      setSelectedSymbol(null);
      activateEditorTab(fallback);
      return;
    }
    setActiveFilePath(null);
    setSelectedSymbol(null);
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
      activateEditorTab(keepTab);
    }
    setTabContextMenu(null);
    setFileContextMenu(null);
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
    contentRef.current = "";
    dirtyRef.current = false;
    setDirty(false);
    if (editorRef.current) {
      suppressDirtyRef.current = true;
      editorRef.current.setValue("");
    }
    setTabContextMenu(null);
    setFileContextMenu(null);
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
      if (!isTextEditorTab(tab)) continue;
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
    if (autoBuildTimerRef.current !== undefined) {
      window.clearTimeout(autoBuildTimerRef.current);
      autoBuildTimerRef.current = undefined;
    }
    if (compileRunIdRef.current) {
      void cancelCompile();
    }
    setRootPath(next);
    if (next) {
      window.localStorage?.setItem(ROOT_STORAGE_KEY, next);
      setRecentProjects((prev) => pushRecentProject(next, prev));
    }
  }, [cancelCompile]);

  const saveActiveFile = useCallback(async (): Promise<boolean> => {
    if (!activeFilePath) return false;
    const activeKey = normalizePath(activeFilePath);
    const currentTab = openTabs.find((tab) => normalizePath(tab.path) === activeKey) || null;
    if (!currentTab) return false;
    try {
      if (isExplorerEditorTab(currentTab)) {
        setCompileStatus("Model Explorer tabs are live views and do not need saving.");
        return true;
      }
      if (isDiagramEditorTab(currentTab)) {
        const graph = buildDiagramGraph(currentTab.document, projectModel, projectSymbols);
        const prepared = prepareDiagramDocumentForSave(
          currentTab.document,
          graph.nodes.map((node) => node.id),
        );
        const content = serializeDiagramDocument(prepared);
        await writeFileText(activeFilePath, content);
        dirtyRef.current = false;
        setDirty(false);
        setOpenTabs((prev) => prev.map((tab) => (
          normalizePath(tab.path) === activeKey && isDiagramEditorTab(tab)
            ? { ...tab, name: prepared.name, document: prepared, content, dirty: false }
            : tab
        )));
        setCompileStatus(`Saved ${displayNameForPath(activeFilePath)}`);
        return true;
      }
      await writeFileText(activeFilePath, contentRef.current);
      dirtyRef.current = false;
      setDirty(false);
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
  }, [activeFilePath, openTabs, projectModel, projectSymbols, setCompileStatus]);

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

  const getCurrentTextForPath = useCallback(async (path: string): Promise<string> => {
    const pathKey = normalizePath(path);
    if (activeFilePath && normalizePath(activeFilePath) === pathKey) {
      const currentTab = openTabs.find((tab) => normalizePath(tab.path) === pathKey) || null;
      return isTextEditorTab(currentTab) ? contentRef.current : readFileText(path);
    }
    const existing = openTabs.find((tab) => normalizePath(tab.path) === pathKey);
    if (existing) {
      return isTextEditorTab(existing) ? existing.content : readFileText(path);
    }
    return readFileText(path);
  }, [activeFilePath, openTabs]);

  const openSemanticEditMenu = useCallback((symbol: SymbolView, x: number, y: number) => {
    setTreeRenameState(null);
    setTabContextMenu(null);
    setFileContextMenu(null);
    setTabsOverflowMenuOpen(false);
    setSemanticEditMenu({
      symbol,
      x,
      y,
      loading: true,
      actions: [],
      error: "",
    });
    void listSemanticEditActions(semanticEditTarget(symbol))
      .then((actions) => {
        setSemanticEditMenu((prev) => {
          if (!prev || symbolIdentity(prev.symbol) !== symbolIdentity(symbol)) return prev;
          const visibleActions = actions.filter(
            (action) => action.id !== DRAG_MOVE_TO_PACKAGE_ACTION.id && action.id !== TREE_RENAME_ACTION_ID,
          );
          return {
            ...prev,
            loading: false,
            actions: visibleActions,
            error: visibleActions.length || canRenameSymbol(symbol)
              ? ""
              : "No semantic actions available for this element.",
          };
        });
      })
      .catch((error) => {
        setSemanticEditMenu((prev) => {
          if (!prev || symbolIdentity(prev.symbol) !== symbolIdentity(symbol)) return prev;
          return {
            ...prev,
            loading: false,
            error: `Failed to load actions: ${String(error)}`,
          };
        });
      });
  }, []);

  const startSemanticEditAction = useCallback((
    symbol: SymbolView,
    action: SemanticEditAction,
    initialValues?: SemanticEditInputValues,
  ) => {
    setTreeRenameState(null);
    setSemanticEditMenu(null);
    setSemanticEditDialog({
      symbol,
      action,
      values: { ...buildSemanticEditInputValues(action), ...(initialValues || {}) },
      preview: null,
      previewing: false,
      applying: false,
      previewError: "",
      dirtySincePreview: true,
    });
  }, []);

  const startTreeRename = useCallback((symbol: SymbolView) => {
    if (!canRenameSymbol(symbol)) {
      setCompileStatus("Rename is unavailable for the selected symbol.");
      return;
    }
    setSemanticEditMenu(null);
    setSelectedSymbol(symbol);
    setTreeRenameState({
      symbol,
      value: symbol.name || "",
      submitting: false,
      error: "",
    });
  }, [setCompileStatus]);

  const openMoveSymbolToPackageDialog = useCallback((source: SymbolView, targetPackage: SymbolView) => {
    if (!canDropSymbolOnPackage(source, targetPackage)) {
      setCompileStatus("That package drop target is not valid for the selected symbol.");
      return;
    }
    setSymbolTreeDropTargetId(null);
    setSelectedSymbol(targetPackage);
    startSemanticEditAction(targetPackage, DRAG_MOVE_TO_PACKAGE_ACTION, {
      source_symbol_id: source.symbol_id || "",
      source_qualified_name: source.qualified_name || source.name || "",
      source_name: source.name || "",
      source_kind: source.kind || symbolKindLabel(source),
      source_file_path: source.file_path,
      source_parent_qualified_name: source.parent_qualified_name || "",
      source_start_line: `${source.start_line || 0}`,
      source_start_col: `${source.start_col || 0}`,
      source_end_line: `${source.end_line || 0}`,
      source_end_col: `${source.end_col || 0}`,
    });
  }, [setCompileStatus, startSemanticEditAction]);

  const updateSemanticEditValue = useCallback((key: string, value: string | boolean) => {
    setSemanticEditDialog((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        values: { ...prev.values, [key]: value },
        preview: null,
        previewError: "",
        dirtySincePreview: true,
      };
    });
  }, []);

  const requestSemanticEditPreview = useCallback(async () => {
    if (!semanticEditDialog || !rootPath) return;
    const dialog = semanticEditDialog;
    setSemanticEditDialog((prev) => (prev ? { ...prev, previewing: true, previewError: "" } : prev));
    try {
      const currentText = await getCurrentTextForPath(dialog.symbol.file_path);
      const preview = await previewSemanticEdit({
        root: rootPath,
        target: semanticEditTarget(dialog.symbol),
        action_id: dialog.action.id,
        input: dialog.values,
        current_text: currentText,
        conflict_policy: "abort",
      });
      setSemanticEditDialog((prev) => {
        if (!prev || prev.action.id !== dialog.action.id || symbolIdentity(prev.symbol) !== symbolIdentity(dialog.symbol)) {
          return prev;
        }
        return {
          ...prev,
          preview,
          previewing: false,
          previewError: "",
          dirtySincePreview: false,
        };
      });
    } catch (error) {
      setSemanticEditDialog((prev) => (prev ? {
        ...prev,
        previewing: false,
        previewError: String(error),
      } : prev));
    }
  }, [semanticEditDialog, rootPath, getCurrentTextForPath]);

  const requestSemanticEditApply = useCallback(async () => {
    if (!semanticEditDialog || !rootPath || !semanticEditDialog.preview || semanticEditDialog.dirtySincePreview) {
      return;
    }
    const dialog = semanticEditDialog;
    setSemanticEditDialog((prev) => (prev ? { ...prev, applying: true, previewError: "" } : prev));
    try {
      const currentText = await getCurrentTextForPath(dialog.symbol.file_path);
      const result: SemanticEditApplyResult = await applySemanticEdit({
        root: rootPath,
        target: semanticEditTarget(dialog.symbol),
        action_id: dialog.action.id,
        input: dialog.values,
        current_text: currentText,
        conflict_policy: "abort",
      });
      openEditedFileWithContent(dialog.symbol.file_path, result.updated_text, symbolSelection(dialog.symbol));
      setSelectedSymbol(dialog.symbol);
      setSemanticEditDialog(null);
      setCompileStatus(`${dialog.action.label} applied to ${dialog.symbol.name || dialog.symbol.qualified_name}`);
      await compileProject();
    } catch (error) {
      setSemanticEditDialog((prev) => (prev ? {
        ...prev,
        applying: false,
        previewError: String(error),
      } : prev));
    }
  }, [
    semanticEditDialog,
    rootPath,
    getCurrentTextForPath,
    openEditedFileWithContent,
    compileProject,
    setCompileStatus,
  ]);

  const submitTreeRename = useCallback(async () => {
    if (!treeRenameState || !rootPath) return;
    if (compileRunId) {
      setCompileStatus("Wait for the current build to finish before renaming.");
      return;
    }
    const symbol = treeRenameState.symbol;
    const newName = treeRenameState.value.trim();
    if (!newName) {
      setTreeRenameState((prev) => (prev ? { ...prev, error: "A new name is required." } : prev));
      return;
    }
    if (newName === (symbol.name || "").trim()) {
      setTreeRenameState(null);
      return;
    }
    setTreeRenameState((prev) => (prev ? { ...prev, submitting: true, error: "" } : prev));
    try {
      const currentText = await getCurrentTextForPath(symbol.file_path);
      const result = await applySemanticEdit({
        root: rootPath,
        target: semanticEditTarget(symbol),
        action_id: TREE_RENAME_ACTION_ID,
        input: { new_name: newName },
        current_text: currentText,
        conflict_policy: "abort",
      });
      const renamed = renamedSymbolSnapshot(symbol, newName);
      openEditedFileWithContent(symbol.file_path, result.updated_text, symbolSelection(renamed));
      setSelectedSymbol(renamed);
      setTreeRenameState(null);
      setCompileStatus(`Renamed ${symbol.name || symbol.qualified_name} to ${newName}`);
      await compileProject();
    } catch (error) {
      const message = String(error);
      setTreeRenameState((prev) => (prev ? { ...prev, submitting: false, error: message } : prev));
      setCompileStatus(`Rename failed: ${message}`);
    }
  }, [
    treeRenameState,
    rootPath,
    compileRunId,
    getCurrentTextForPath,
    openEditedFileWithContent,
    compileProject,
    setCompileStatus,
  ]);

  const scheduleAutoBuild = useCallback(() => {
    if (!autoBuildActiveFile || !rootPath || !activeFilePath || !isSemanticSource(activeFilePath)) {
      autoBuildQueuedRef.current = false;
      return;
    }
    if (compileRunIdRef.current) {
      autoBuildQueuedRef.current = true;
      return;
    }
    autoBuildQueuedRef.current = false;
    if (autoBuildTimerRef.current !== undefined) {
      window.clearTimeout(autoBuildTimerRef.current);
    }
    autoBuildTimerRef.current = window.setTimeout(() => {
      autoBuildTimerRef.current = undefined;
      if (!autoBuildActiveFile) return;
      if (compileRunIdRef.current) {
        autoBuildQueuedRef.current = true;
        return;
      }
      const now = Date.now();
      if (now - lastAutoBuildAtRef.current < AUTO_BUILD_MIN_INTERVAL_MS) {
        autoBuildTimerRef.current = window.setTimeout(() => {
          autoBuildTimerRef.current = undefined;
          if (!autoBuildActiveFile) return;
          if (compileRunIdRef.current) {
            autoBuildQueuedRef.current = true;
            return;
          }
          lastAutoBuildAtRef.current = Date.now();
          void compileActiveFile();
        }, AUTO_BUILD_MIN_INTERVAL_MS);
        return;
      }
      lastAutoBuildAtRef.current = now;
      void compileActiveFile();
    }, AUTO_BUILD_DEBOUNCE_MS);
  }, [autoBuildActiveFile, rootPath, activeFilePath, compileActiveFile]);

  useEffect(() => {
    if (compileRunId !== null) return;
    if (!autoBuildQueuedRef.current) return;
    autoBuildQueuedRef.current = false;
    scheduleAutoBuild();
  }, [compileRunId, scheduleAutoBuild]);

  const clearAllCaches = useCallback(async () => {
    if (compileRunId) {
      setCompileStatus("Cannot clear caches while compile is running");
      return;
    }
    try {
        const summary = await invoke<CacheClearSummary>("clear_all_caches");
        setCompileStatus(
          `Caches cleared (snapshot ${summary.workspace_snapshot_entries}, semantic ${summary.project_semantic_lookup_entries}, parsed ${summary.parsed_file_entries}, project disk ${summary.workspace_ir_cache_files_deleted}, stdlib disk ${summary.stdlib_index_cache_files_deleted}${summary.symbol_index_cleared ? ", symbol index" : ""})`,
        );
    } catch (error) {
      setCompileStatus(`Clear caches failed: ${String(error)}`);
    }
  }, [compileRunId, setCompileStatus]);

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

  const openNewProjectDialog = useCallback(async () => {
    setMenuOpen(null);
    setTabContextMenu(null);
    setFileContextMenu(null);
    setTabsOverflowMenuOpen(false);
    const activeParent = parentPathForPath(rootPath);
    let suggestedParent = activeParent;
    if (!suggestedParent) {
      try {
        suggestedParent = await getUserProjectsRoot();
      } catch {
        suggestedParent = "";
      }
    }
    setNewProjectDialog({
      parentPath: suggestedParent,
      name: "",
      author: "",
      description: "",
      organization: "",
      createStarterFile: true,
      starterFileName: "model",
      starterFileExtension: ".sysml",
      useDefaultLibrary: true,
      error: "",
      submitting: false,
    });
  }, [rootPath]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const lowered = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && lowered === "n") {
        event.preventDefault();
        void openNewProjectDialog();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && lowered === "s") {
        event.preventDefault();
        void saveActiveFile();
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && lowered === "b") {
        event.preventDefault();
        if (compileRunId) return;
        void compileProject();
        return;
      }
      if (event.key === "F5") {
        event.preventDefault();
        if (compileRunId) return;
        void compileProject();
        return;
      }
      if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === "F2") {
        if (!selectedSymbol || treeRenameState || semanticEditDialog || newProjectDialog || newFileDialog || newDiagramDialog) return;
        event.preventDefault();
        startTreeRename(selectedSymbol);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    openNewProjectDialog,
    saveActiveFile,
    compileProject,
    compileRunId,
    selectedSymbol,
    treeRenameState,
    semanticEditDialog,
    newProjectDialog,
    newFileDialog,
    newDiagramDialog,
    startTreeRename,
  ]);

  const runMenuAction = useCallback(async (action: string) => {
    switch (action) {
      case "new-project":
        await openNewProjectDialog();
        return;
      case "open-explorer":
        openModelExplorerForSymbol(selectedSymbol);
        return;
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
      case "toggle-autobuild-active-file":
        setAutoBuildActiveFile((prev) => !prev);
        return;
      case "clear-caches":
        await clearAllCaches();
        return;
      case "show-tooling":
        setActiveToolTab("tooling");
        return;
      case "show-logs":
        setActiveToolTab("logs");
        return;
      case "show-expressions":
        setActiveToolTab("expressions");
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
        await invoke("app_exit").catch((error) => {
          setCompileStatus(`Exit failed: ${String(error)}`);
        });
        return;
      case "about":
        setAboutWindowOpen(true);
        return;
      default:
        return;
    }
  }, [
    openNewProjectDialog,
    openModelExplorerForSymbol,
    selectedSymbol,
    applyRootPath,
    openFilePath,
    saveActiveFile,
    compileProject,
    compileActiveFile,
    clearAllCaches,
    setActiveToolTab,
    setStdlibManagerOpen,
    setAboutWindowOpen,
    toggleTheme,
    setCompileStatus,
  ]);

  const normalizeWatchedPath = useCallback((path: string) => {
    return normalizePath(path).replace(/[\\\/]+$/, "");
  }, []);

  const scheduleProjectTreeRefresh = useCallback(() => {
    if (projectFilesChangedTimerRef.current !== undefined) {
      window.clearTimeout(projectFilesChangedTimerRef.current);
    }
    const timer = window.setTimeout(() => {
      projectFilesChangedTimerRef.current = undefined;
      const watchRoot = projectWatcherRootRef.current;
      const activeRoot = projectTreeRootPath || rootPath || watchRoot;
      if (!watchRoot || !activeRoot) {
        return;
      }
      if (normalizeWatchedPath(watchRoot) !== normalizeWatchedPath(activeRoot)) {
        return;
      }
      void logFrontendEvent({
        level: "info",
        kind: "watcher",
        message: `project refresh root=${activeRoot}`,
      }).catch(() => {});
      void refreshRoot(activeRoot).catch((error) => {
        if (!activeRoot) return;
        void logFrontendEvent({
          level: "error",
          kind: "watcher",
          message: `project refresh failed root=${activeRoot} error=${String(error)}`,
        }).catch(() => {});
      });
    }, 250);
    projectFilesChangedTimerRef.current = timer;
  }, [projectTreeRootPath, refreshRoot, rootPath, normalizeWatchedPath]);

  const scheduleLibraryTreeRefresh = useCallback(() => {
    if (libraryFilesChangedTimerRef.current !== undefined) {
      window.clearTimeout(libraryFilesChangedTimerRef.current);
    }
    const timer = window.setTimeout(() => {
      libraryFilesChangedTimerRef.current = undefined;
      const watchRoot = libraryWatcherRootRef.current;
      const activeRoot = libraryTreeRootPath;
      if (!watchRoot || !activeRoot) {
        return;
      }
      if (normalizeWatchedPath(watchRoot) !== normalizeWatchedPath(activeRoot)) {
        return;
      }
      void logFrontendEvent({
        level: "info",
        kind: "watcher",
        message: `library refresh root=${activeRoot}`,
      }).catch(() => {});
      void refreshLibraryTree(activeRoot).catch((error) => {
        if (!activeRoot) return;
        void logFrontendEvent({
          level: "error",
          kind: "watcher",
          message: `library refresh failed root=${activeRoot} error=${String(error)}`,
        }).catch(() => {});
      });
    }, 250);
    libraryFilesChangedTimerRef.current = timer;
  }, [libraryTreeRootPath, normalizeWatchedPath, refreshLibraryTree]);

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

  useEffect(() => {
    const projectRoot = projectTreeRootPath || rootPath;
    const libraryRoot = libraryTreeRootPath;
    const projectKey = normalizeWatchedPath(projectRoot);
    const libraryKey = normalizeWatchedPath(libraryRoot);
    const libraryCoveredByProject =
      !!projectKey
      && !!libraryKey
      && (libraryKey === projectKey || libraryKey.startsWith(`${projectKey}/`));

    if (!projectRoot) {
      if (projectWatcherRootRef.current) {
        void stopProjectFileWatcher(projectWatcherRootRef.current);
      }
      if (libraryWatcherRootRef.current) {
        void stopProjectFileWatcher(libraryWatcherRootRef.current);
      }
      projectWatcherRootRef.current = "";
      libraryWatcherRootRef.current = "";
      if (projectFilesChangedTimerRef.current !== undefined) {
        window.clearTimeout(projectFilesChangedTimerRef.current);
        projectFilesChangedTimerRef.current = undefined;
      }
      if (libraryFilesChangedTimerRef.current !== undefined) {
        window.clearTimeout(libraryFilesChangedTimerRef.current);
        libraryFilesChangedTimerRef.current = undefined;
      }
      return;
    }

    if (
      projectWatcherRootRef.current
      && normalizeWatchedPath(projectWatcherRootRef.current) !== projectKey
    ) {
      void stopProjectFileWatcher(projectWatcherRootRef.current);
    }
    projectWatcherRootRef.current = projectRoot;
    void startProjectFileWatcher(projectRoot).catch((error) => {
      const message = `Filesystem watcher failed to start: ${String(error)}`;
      setCompileStatus(message);
      showErrorNotification(message);
    });

    if (libraryCoveredByProject || !libraryRoot) {
      if (libraryWatcherRootRef.current) {
        void stopProjectFileWatcher(libraryWatcherRootRef.current);
      }
      libraryWatcherRootRef.current = "";
    } else {
      if (
        libraryWatcherRootRef.current
        && normalizeWatchedPath(libraryWatcherRootRef.current) !== libraryKey
      ) {
        void stopProjectFileWatcher(libraryWatcherRootRef.current);
      }
      libraryWatcherRootRef.current = libraryRoot;
      void startProjectFileWatcher(libraryRoot).catch((error) => {
        const message = `Library watcher failed to start: ${String(error)}`;
        setCompileStatus(message);
        showErrorNotification(message);
      });
    }

    const unlistenPromise = listen<ProjectFilesChangedEvent>("project-files-changed", (event) => {
      const payload = event.payload;
      const changedRoot = normalizeWatchedPath(payload?.root || "");
      const changedPath = normalizeWatchedPath(payload?.path || "");
      const projectAffected =
        (!!projectKey && changedRoot === projectKey)
        || (!!projectRoot && !!changedPath && isPathWithin(changedPath, projectRoot));
      const libraryAffected =
        (!!libraryKey && changedRoot === libraryKey)
        || (!!libraryRoot && !!changedPath && isPathWithin(changedPath, libraryRoot));

      void logFrontendEvent({
        level: "info",
        kind: "watcher",
        message: `event kind=${payload?.kind || ""} root=${changedRoot} path=${changedPath} projectAffected=${projectAffected} libraryAffected=${libraryAffected}`,
      }).catch(() => {});

      if (projectAffected) {
        scheduleProjectTreeRefresh();
        if (libraryCoveredByProject && libraryKey) {
          scheduleLibraryTreeRefresh();
        }
        return;
      }
      if (!libraryCoveredByProject && libraryAffected) {
        scheduleLibraryTreeRefresh();
      }
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
      if (projectFilesChangedTimerRef.current !== undefined) {
        window.clearTimeout(projectFilesChangedTimerRef.current);
        projectFilesChangedTimerRef.current = undefined;
      }
      if (libraryFilesChangedTimerRef.current !== undefined) {
        window.clearTimeout(libraryFilesChangedTimerRef.current);
        libraryFilesChangedTimerRef.current = undefined;
      }
    };
  }, [
    libraryTreeRootPath,
    normalizeWatchedPath,
    projectTreeRootPath,
    rootPath,
    scheduleLibraryTreeRefresh,
    scheduleProjectTreeRefresh,
    setCompileStatus,
    showErrorNotification,
  ]);

  useEffect(() => {
    return () => {
      if (projectWatcherRootRef.current) {
        void stopProjectFileWatcher(projectWatcherRootRef.current);
        projectWatcherRootRef.current = "";
      }
      if (libraryWatcherRootRef.current) {
        void stopProjectFileWatcher(libraryWatcherRootRef.current);
        libraryWatcherRootRef.current = "";
      }
    };
  }, []);

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
    return libraryTreeManifest
      .filter((entry) => !entry.is_dir)
      .map((entry) => entry.path);
  }, [libraryTreeManifest]);
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
    await openFilePath(symbol.file_path, symbolSelection(symbol), { preserveSymbolSelection: true });
  }, [openFilePath]);

  const selectQualifiedName = useCallback((qualifiedName: string) => {
    const target = projectSymbols.find((symbol) => symbol.qualified_name === qualifiedName)
      || symbols.find((symbol) => symbol.qualified_name === qualifiedName);
    if (!target) return;
    void selectSymbol(target);
  }, [projectSymbols, selectSymbol, symbols]);

  const updateDiagramTab = useCallback((
    path: string,
    updater: (tab: DiagramEditorTab) => DiagramEditorTab,
  ) => {
    const pathKey = normalizePath(path);
    setOpenTabs((prev) => prev.map((tab) => {
      if (normalizePath(tab.path) !== pathKey || !isDiagramEditorTab(tab)) return tab;
      return updater(tab);
    }));
  }, []);

  const activeDiagramTab = useMemo(() => {
    if (!activeFilePath) return null;
    const key = normalizePath(activeFilePath);
    const tab = openTabs.find((entry) => normalizePath(entry.path) === key) || null;
    return isDiagramEditorTab(tab) ? tab : null;
  }, [activeFilePath, openTabs]);
  const activeExplorerTab = useMemo(() => {
    if (!activeFilePath) return null;
    const key = normalizePath(activeFilePath);
    const tab = openTabs.find((entry) => normalizePath(entry.path) === key) || null;
    return isExplorerEditorTab(tab) ? tab : null;
  }, [activeFilePath, openTabs]);
  const activeDiagramDocument = activeDiagramTab?.document || null;
  const activeDiagramGraph = useMemo(
    () => (activeDiagramDocument ? buildDiagramGraph(activeDiagramDocument, projectModel, projectSymbols) : null),
    [
      activeDiagramDocument?.diagram_type,
      activeDiagramDocument?.root_element_qualified_name,
      activeDiagramDocument?.root_file_path,
      projectModel,
      projectSymbols,
    ],
  );
  const activeDiagramPositions = useMemo(
    () => (
      activeDiagramDocument && activeDiagramGraph
        ? mergeDiagramNodePositions(activeDiagramGraph, activeDiagramDocument.node_positions)
        : {}
    ),
    [activeDiagramDocument?.node_positions, activeDiagramGraph],
  );
  const activeDiagramViewport = activeDiagramDocument?.viewport || null;
  const activeExplorerGraph = useMemo(
    () => (
      activeExplorerTab
        ? buildExplorerGraph({
            rootQualifiedName: activeExplorerTab.rootQualifiedName,
            expandedQualifiedNames: activeExplorerTab.expandedQualifiedNames,
            showDirectedRelationships: activeExplorerTab.showDirectedRelationships,
            workspaceSymbols: symbols,
            projectModel,
          })
        : null
    ),
    [
      activeExplorerTab?.rootQualifiedName,
      activeExplorerTab?.expandedQualifiedNames,
      activeExplorerTab?.showDirectedRelationships,
      symbols,
      projectModel,
    ],
  );
  const activeExplorerPositions = useMemo(
    () => (
      activeExplorerTab && activeExplorerGraph
        ? mergeExplorerNodePositions(activeExplorerGraph, activeExplorerTab.nodePositions)
        : {}
    ),
    [activeExplorerGraph, activeExplorerTab?.nodePositions],
  );
  const activeExplorerViewport = activeExplorerTab?.viewport || null;
  const activeExplorerSelectedEdge = useMemo(
    () => activeExplorerGraph?.edges.find((edge) => edge.id === activeExplorerTab?.selectedEdgeId) || null,
    [activeExplorerGraph, activeExplorerTab?.selectedEdgeId],
  );

  const updateActiveDiagramRoot = useCallback((symbol: SymbolView) => {
    if (!activeDiagramTab) return;
    const nextRoot = resolvePreferredDiagramRoot(activeDiagramTab.document.diagram_type, symbol, projectSymbols) || symbol;
    updateDiagramTab(activeDiagramTab.path, (tab) => {
      const document = createDiagramDocument({
        name: tab.document.name,
        diagramType: tab.document.diagram_type,
        rootQualifiedName: nextRoot.qualified_name || symbol.qualified_name || symbol.name,
        rootFilePath: nextRoot.file_path || symbol.file_path,
        viewport: null,
        nodePositions: {},
      });
      return {
        ...tab,
        document,
        dirty: true,
      };
    });
  }, [activeDiagramTab, projectSymbols, updateDiagramTab]);

  const handleDiagramPositionsChange = useCallback((positions: Record<string, DiagramPoint>) => {
    if (!activeDiagramTab) return;
    updateDiagramTab(activeDiagramTab.path, (tab) => {
      if (diagramNodePositionsEqual(tab.document.node_positions, positions)) {
        return tab;
      }
      return {
        ...tab,
        dirty: true,
        document: {
          ...tab.document,
          node_positions: positions,
        },
      };
    });
  }, [activeDiagramTab, updateDiagramTab]);

  const handleDiagramViewportChange = useCallback((viewport: DiagramViewport) => {
    if (!activeDiagramTab) return;
    updateDiagramTab(activeDiagramTab.path, (tab) => {
      if (diagramViewportsEqual(tab.document.viewport, viewport)) {
        return tab;
      }
      return {
        ...tab,
        dirty: true,
        document: {
          ...tab.document,
          viewport,
        },
      };
    });
  }, [activeDiagramTab, updateDiagramTab]);

  const handleDiagramSelectNode = useCallback((qualifiedName: string) => {
    const target = projectSymbolsByQualified.get(qualifiedName);
    if (!target) return;
    setSelectedSymbol(target);
  }, [projectSymbolsByQualified]);

  const handleDiagramOpenNode = useCallback((qualifiedName: string) => {
    const target = projectSymbolsByQualified.get(qualifiedName);
    if (!target) return;
    void selectSymbol(target);
  }, [projectSymbolsByQualified, selectSymbol]);

  const getDraggedSymbolQualifiedName = useCallback((dataTransfer: DataTransfer): string => {
    const typedValue = dataTransfer.getData(SYMBOL_TREE_DRAG_MIME);
    if (typedValue) {
      return typedValue;
    }
    return symbolTreeDragState?.symbol.qualified_name || "";
  }, [symbolTreeDragState]);

  const handleDiagramCanvasDragEnter = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const types = Array.from(event.dataTransfer.types || []);
    if (!types.includes(SYMBOL_TREE_DRAG_MIME) && !symbolTreeDragState) return;
    event.preventDefault();
    setDiagramDragHover(true);
  }, [symbolTreeDragState]);

  const handleDiagramCanvasDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const qualifiedName = getDraggedSymbolQualifiedName(event.dataTransfer);
    if (!qualifiedName) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDiagramDragHover(true);
  }, [getDraggedSymbolQualifiedName]);

  const handleDiagramCanvasDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDiagramDragHover(false);
  }, []);

  const handleDiagramCanvasDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDiagramDragHover(false);
    const qualifiedName = getDraggedSymbolQualifiedName(event.dataTransfer);
    if (!qualifiedName) return;
    const target = projectSymbolsByQualified.get(qualifiedName) || symbolTreeDragState?.symbol || null;
    if (!target) return;
    updateActiveDiagramRoot(target);
    setSelectedSymbol(target);
  }, [getDraggedSymbolQualifiedName, projectSymbolsByQualified, symbolTreeDragState, updateActiveDiagramRoot]);

  const setActiveExplorerRoot = useCallback((qualifiedName: string) => {
    if (!activeExplorerTab) return;
    const target = workspaceSymbolsByQualified.get(qualifiedName) || null;
    const preferredRoot = resolvePreferredExplorerRoot(target, symbols) || target;
    const rootQualifiedName = preferredRoot?.qualified_name || qualifiedName;
    updateExplorerTab(activeExplorerTab.path, (tab) => ({
      ...tab,
      rootQualifiedName,
      expandedQualifiedNames: [],
      viewport: null,
      nodePositions: {},
      historyBack: tab.rootQualifiedName && tab.rootQualifiedName !== rootQualifiedName
        ? [...tab.historyBack, tab.rootQualifiedName]
        : tab.historyBack,
      historyForward: [],
      selectedQualifiedName: rootQualifiedName,
      selectedEdgeId: null,
    }));
    if (preferredRoot) {
      setSelectedSymbol(preferredRoot);
    }
  }, [activeExplorerTab, symbols, updateExplorerTab, workspaceSymbolsByQualified]);

  const handleExplorerPositionsChange = useCallback((positions: Record<string, DiagramPoint>) => {
    if (!activeExplorerTab) return;
    updateExplorerTab(activeExplorerTab.path, (tab) => (
      diagramNodePositionsEqual(tab.nodePositions, positions)
        ? tab
        : { ...tab, nodePositions: positions }
    ));
  }, [activeExplorerTab, updateExplorerTab]);

  const handleExplorerViewportChange = useCallback((viewport: DiagramViewport) => {
    if (!activeExplorerTab) return;
    updateExplorerTab(activeExplorerTab.path, (tab) => (
      diagramViewportsEqual(tab.viewport, viewport)
        ? tab
        : { ...tab, viewport }
    ));
  }, [activeExplorerTab, updateExplorerTab]);

  const handleExplorerSelectNode = useCallback((qualifiedName: string) => {
    if (!activeExplorerTab) return;
    updateExplorerTab(activeExplorerTab.path, (tab) => ({ ...tab, selectedQualifiedName: qualifiedName, selectedEdgeId: null }));
    const target = workspaceSymbolsByQualified.get(qualifiedName);
    if (target) {
      setSelectedSymbol(target);
    }
  }, [activeExplorerTab, updateExplorerTab, workspaceSymbolsByQualified]);

  const handleExplorerOpenNode = useCallback((qualifiedName: string) => {
    const target = workspaceSymbolsByQualified.get(qualifiedName);
    if (!target) return;
    void selectSymbol(target);
  }, [selectSymbol, workspaceSymbolsByQualified]);

  const handleExplorerExpandNode = useCallback((qualifiedName: string) => {
    if (!activeExplorerTab) return;
    updateExplorerTab(activeExplorerTab.path, (tab) => {
      const normalized = normalizeQualifiedName(qualifiedName);
      if (!normalized) return tab;
      if (tab.expandedQualifiedNames.includes(normalized)) return tab;
      return {
        ...tab,
        expandedQualifiedNames: [...tab.expandedQualifiedNames, normalized],
      };
    });
  }, [activeExplorerTab, updateExplorerTab]);

  const handleExplorerSelectEdge = useCallback((edgeId: string | null) => {
    if (!activeExplorerTab) return;
    updateExplorerTab(activeExplorerTab.path, (tab) => ({ ...tab, selectedEdgeId: edgeId }));
  }, [activeExplorerTab, updateExplorerTab]);

  const handleExplorerBack = useCallback(() => {
    if (!activeExplorerTab || !activeExplorerTab.historyBack.length) return;
    updateExplorerTab(activeExplorerTab.path, (tab) => {
      const nextBack = [...tab.historyBack];
      const nextRoot = nextBack.pop() || tab.rootQualifiedName;
      return {
        ...tab,
        rootQualifiedName: nextRoot,
        expandedQualifiedNames: [],
        viewport: null,
        nodePositions: {},
        historyBack: nextBack,
        historyForward: tab.rootQualifiedName ? [tab.rootQualifiedName, ...tab.historyForward] : tab.historyForward,
        selectedQualifiedName: nextRoot,
        selectedEdgeId: null,
      };
    });
  }, [activeExplorerTab, updateExplorerTab]);

  const handleExplorerForward = useCallback(() => {
    if (!activeExplorerTab || !activeExplorerTab.historyForward.length) return;
    updateExplorerTab(activeExplorerTab.path, (tab) => {
      const [nextRoot, ...rest] = tab.historyForward;
      return {
        ...tab,
        rootQualifiedName: nextRoot || tab.rootQualifiedName,
        expandedQualifiedNames: [],
        viewport: null,
        nodePositions: {},
        historyBack: tab.rootQualifiedName ? [...tab.historyBack, tab.rootQualifiedName] : tab.historyBack,
        historyForward: rest,
        selectedQualifiedName: nextRoot || tab.selectedQualifiedName,
        selectedEdgeId: null,
      };
    });
  }, [activeExplorerTab, updateExplorerTab]);

  const handleExplorerToggleDirectedRelationships = useCallback(() => {
    if (!activeExplorerTab) return;
    updateExplorerTab(activeExplorerTab.path, (tab) => ({
      ...tab,
      showDirectedRelationships: !tab.showDirectedRelationships,
      selectedEdgeId: null,
    }));
  }, [activeExplorerTab, updateExplorerTab]);

  const handleExplorerFollowRelationshipTarget = useCallback((nodeId: string) => {
    const targetNode = activeExplorerGraph?.nodes.find((node) => node.id === nodeId || node.qualifiedName === nodeId) || null;
    if (!targetNode) return;
    setActiveExplorerRoot(targetNode.qualifiedName);
  }, [activeExplorerGraph, setActiveExplorerRoot]);

  const handleExplorerCanvasDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDiagramDragHover(false);
    const qualifiedName = getDraggedSymbolQualifiedName(event.dataTransfer);
    if (!qualifiedName) return;
    setActiveExplorerRoot(qualifiedName);
  }, [getDraggedSymbolQualifiedName, setActiveExplorerRoot]);

  const canExpandExplorerSelection = useMemo(
    () => canExpandExplorerNode(activeExplorerTab?.selectedQualifiedName, symbols),
    [activeExplorerTab?.selectedQualifiedName, symbols],
  );
  const canReRootExplorerSelection = useMemo(
    () => !!normalizeQualifiedName(activeExplorerTab?.selectedQualifiedName)
      && normalizeQualifiedName(activeExplorerTab?.selectedQualifiedName) !== normalizeQualifiedName(activeExplorerTab?.rootQualifiedName),
    [activeExplorerTab?.rootQualifiedName, activeExplorerTab?.selectedQualifiedName],
  );

  const openDiagnostic = useCallback((path: string, diagnostic: FileDiagnosticView) => {
    const line = Math.max(1, diagnostic.line || 1);
    const col = Math.max(1, diagnostic.column || 1);
    const selection: TextSelection = {
      startLine: line,
      startCol: col,
      endLine: line,
      endCol: col + 1,
    };
    void openFilePath(path, selection);
  }, [openFilePath]);

  const showPathInExplorer = useCallback(async (path: string) => {
    const trimmed = (path || "").trim();
    if (!trimmed) return;
    setTabContextMenu(null);
    setFileContextMenu(null);
    setTabsOverflowMenuOpen(false);
    try {
      await invoke("show_in_explorer", { path: trimmed });
    } catch (error) {
      setCompileStatus(`Show in Explorer failed: ${String(error)}`);
    }
  }, [setCompileStatus]);

  const openNewFileDialog = useCallback((parentPath: string) => {
    const trimmed = (parentPath || "").trim();
    if (!trimmed) return;
    setTabContextMenu(null);
    setFileContextMenu(null);
    setTabsOverflowMenuOpen(false);
    setNewFileDialog({
      parentPath: trimmed,
      name: "",
      extension: ".sysml",
      error: "",
      submitting: false,
    });
  }, []);

  const createNewFileFromDialog = useCallback(async () => {
    if (!newFileDialog || newFileDialog.submitting) return;
    const activeRoot = rootPath.trim();
    if (!activeRoot) {
      setNewFileDialog((prev) => (prev ? { ...prev, error: "Select a project root first." } : prev));
      return;
    }
    const baseName = newFileDialog.name.trim().replace(/\.(sysml|kerml)$/i, "").trim();
    if (!baseName) {
      setNewFileDialog((prev) => (prev ? { ...prev, error: "File name is required." } : prev));
      return;
    }
    if (INVALID_NEW_FILE_NAME_CHARS.test(baseName)) {
      setNewFileDialog((prev) => (
        prev
          ? { ...prev, error: "File name contains invalid characters: <>:\"/\\|?*" }
          : prev
      ));
      return;
    }
    const fileName = buildNewSemanticFileName(baseName, newFileDialog.extension);
    setNewFileDialog((prev) => (prev ? { ...prev, error: "", submitting: true } : prev));
    try {
      const createdPath = await createProjectFile(activeRoot, newFileDialog.parentPath, fileName);
      await refreshRoot(activeRoot);
      await ensureExpanded(newFileDialog.parentPath);
      setProjectFilesExpanded(true);
      setNewFileDialog(null);
      setCompileStatus(`Created file: ${createdPath}`);
      await openFilePath(createdPath);
    } catch (error) {
      const message = String(error);
      setCompileStatus(`Create file failed: ${message}`);
      setNewFileDialog((prev) => (
        prev
          ? { ...prev, error: `Create file failed: ${message}`, submitting: false }
          : prev
      ));
    }
  }, [newFileDialog, rootPath, refreshRoot, ensureExpanded, openFilePath, setCompileStatus]);

  const createNewDiagramFromDialog = useCallback(async () => {
    if (!newDiagramDialog || newDiagramDialog.submitting) return;
    const activeRoot = rootPath.trim();
    if (!activeRoot) {
      setNewDiagramDialog((prev) => (prev ? { ...prev, error: "Select a project root first." } : prev));
      return;
    }
    const diagramName = newDiagramDialog.name.trim();
    if (!diagramName) {
      setNewDiagramDialog((prev) => (prev ? { ...prev, error: "Diagram name is required." } : prev));
      return;
    }
    const rootQualifiedName = newDiagramDialog.rootQualifiedName.trim();
    if (!rootQualifiedName) {
      setNewDiagramDialog((prev) => (prev ? { ...prev, error: "Root element is required." } : prev));
      return;
    }
    const baseName = newDiagramDialog.fileName.trim().replace(/\.diagram$/i, "").trim();
    if (!baseName) {
      setNewDiagramDialog((prev) => (prev ? { ...prev, error: "File name is required." } : prev));
      return;
    }
    if (INVALID_NEW_FILE_NAME_CHARS.test(baseName)) {
      setNewDiagramDialog((prev) => (
        prev
          ? { ...prev, error: "File name contains invalid characters: <>:\"/\\|?*" }
          : prev
      ));
      return;
    }
    setNewDiagramDialog((prev) => (prev ? { ...prev, error: "", submitting: true } : prev));
    try {
      const fileName = buildDiagramFileName(baseName);
      const createdPath = await createProjectFile(activeRoot, newDiagramDialog.parentPath, fileName);
      const document = createDiagramDocument({
        name: diagramName,
        diagramType: newDiagramDialog.diagramType,
        rootQualifiedName,
        rootFilePath: newDiagramDialog.rootFilePath.trim() || null,
      });
      await writeFileText(createdPath, serializeDiagramDocument(document));
      await refreshRoot(activeRoot);
      await ensureExpanded(newDiagramDialog.parentPath);
      setProjectFilesExpanded(true);
      setNewDiagramDialog(null);
      setCompileStatus(`Created diagram: ${createdPath}`);
      await openFilePath(createdPath);
    } catch (error) {
      const message = String(error);
      setCompileStatus(`Create diagram failed: ${message}`);
      setNewDiagramDialog((prev) => (
        prev
          ? { ...prev, error: `Create diagram failed: ${message}`, submitting: false }
          : prev
      ));
    }
  }, [newDiagramDialog, rootPath, refreshRoot, ensureExpanded, openFilePath, setCompileStatus]);

  const toggleProjectFileSymbols = useCallback((filePath: string) => {
    const key = normalizePath(filePath);
    setExpandedFileSymbols((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const toggleLibraryFileSymbols = useCallback((filePath: string) => {
    const key = normalizePath(filePath);
    setExpandedLibraryFiles((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const toggleSymbolNodeCollapse = useCallback((symbolId: string) => {
    if (!symbolId) return;
    setCollapsedSymbolNodes((prev) => ({ ...prev, [symbolId]: !prev[symbolId] }));
  }, []);

  const toggleParseErrorFile = useCallback((filePath: string) => {
    const key = normalizePath(filePath);
    setCollapsedParseErrorFiles((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const showAllProjectElements = useCallback(() => {
    setExpandedProjectElementsOverflow(true);
  }, []);

  const showAllLibraryElements = useCallback(() => {
    setExpandedLibraryElementsOverflow(true);
  }, []);

  const showAllProjectFileSymbols = useCallback((filePath: string) => {
    const key = normalizePath(filePath);
    setExpandedProjectFileSymbolOverflow((prev) => ({ ...prev, [key]: true }));
  }, []);

  const showAllLibraryFileSymbols = useCallback((filePath: string) => {
    const key = normalizePath(filePath);
    setExpandedLibraryFileSymbolOverflow((prev) => ({ ...prev, [key]: true }));
  }, []);

  const expandAllTreeElements = useCallback(async () => {
    if (!rootPath) return;
    setTreeError("");
    try {
      await expandAll();
      await expandAllLibraryTree();
      setProjectFilesExpanded(true);
      setLibraryFilesExpanded(true);
      setExpandedFileSymbols(() => {
        const next: Record<string, boolean> = {};
        for (const key of symbolsByFile.keys()) {
          next[key] = true;
        }
        return next;
      });
      setExpandedLibraryFiles(() => {
        const next: Record<string, boolean> = {};
        for (const libraryFilePath of libraryFilePaths) {
          next[normalizePath(libraryFilePath)] = true;
        }
        return next;
      });
      setExpandedProjectElementsOverflow(true);
      setExpandedLibraryElementsOverflow(true);
      setExpandedProjectFileSymbolOverflow(() => {
        const next: Record<string, boolean> = {};
        for (const key of symbolsByFile.keys()) {
          next[key] = true;
        }
        return next;
      });
      setExpandedLibraryFileSymbolOverflow(() => {
        const next: Record<string, boolean> = {};
        for (const libraryFilePath of libraryFilePaths) {
          next[normalizePath(libraryFilePath)] = true;
        }
        return next;
      });
      setCollapsedSymbolNodes({});
    } catch (error) {
      setTreeError(`Failed to expand tree: ${String(error)}`);
    }
  }, [rootPath, expandAll, expandAllLibraryTree, symbolsByFile, libraryFilePaths]);

  const collapseAllTreeElements = useCallback(() => {
    collapseAll();
    collapseLibraryTree();
    setExpandedFileSymbols({});
    setExpandedLibraryFiles({});
    setCollapsedSymbolNodes({});
    setExpandedProjectElementsOverflow(false);
    setExpandedLibraryElementsOverflow(false);
    setExpandedProjectFileSymbolOverflow({});
    setExpandedLibraryFileSymbolOverflow({});
  }, [collapseAll, collapseLibraryTree]);

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

  const clampRightPanelSplitRatio = useCallback((value: number): number => {
    if (!Number.isFinite(value)) return DEFAULT_RIGHT_PANEL_SPLIT;
    return Math.max(RIGHT_PANEL_SPLIT_MIN, Math.min(RIGHT_PANEL_SPLIT_MAX, value));
  }, []);

  const updateRightPanelSplit = useCallback(
    (clientY: number) => {
      const drag = rightPanelSplitDragRef.current;
      if (!drag) return;
      const panel = rightPanelRef.current;
      if (!panel) return;
      const panelHeight = panel.clientHeight;
      if (!panelHeight) return;
      const deltaY = clientY - drag.startY;
      const next = drag.startRatio + deltaY / panelHeight;
      const clamped = clampRightPanelSplitRatio(next);
      if (Math.abs(clamped - rightPanelSplitRatio) > 0.0001) {
        setRightPanelSplitRatio(clamped);
      }
    },
    [clampRightPanelSplitRatio, rightPanelSplitRatio],
  );

  const stopRightPanelSplitDragById = useCallback((pointerId: number | null) => {
    const drag = rightPanelSplitDragRef.current;
    if (!drag || (pointerId !== null && drag.pointerId !== null && drag.pointerId !== pointerId)) return;
    rightPanelSplitDragRef.current = null;
    setRightPanelSplitDragging(false);
    if (drag.pointerId !== null && drag.captureTarget && drag.captureTarget.hasPointerCapture(drag.pointerId)) {
      drag.captureTarget.releasePointerCapture(drag.pointerId);
    }
  }, []);

  const handleRightPanelSplitPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const panel = rightPanelRef.current;
    if (!panel) return;
    rightPanelSplitDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startRatio: rightPanelSplitRatio,
      captureTarget: event.currentTarget,
    };
    setRightPanelSplitDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [rightPanelSplitRatio]);

  const handleRightPanelSplitPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = rightPanelSplitDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    updateRightPanelSplit(event.clientY);
  }, [updateRightPanelSplit]);

  const stopRightPanelSplitDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    stopRightPanelSplitDragById(event.pointerId);
  }, [stopRightPanelSplitDragById]);

  const handleRightPanelSplitMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const panel = rightPanelRef.current;
    if (!panel) return;
    rightPanelSplitDragRef.current = {
      pointerId: null,
      startY: event.clientY,
      startRatio: rightPanelSplitRatio,
      captureTarget: event.currentTarget,
    };
    setRightPanelSplitDragging(true);
    event.preventDefault();
  }, [rightPanelSplitRatio]);

  useEffect(() => {
    if (!rightPanelSplitDragging) return;
    const onPointerMove = (event: PointerEvent) => {
      const drag = rightPanelSplitDragRef.current;
      if (!drag || drag.pointerId === null || drag.pointerId !== event.pointerId) return;
      updateRightPanelSplit(event.clientY);
    };
    const onPointerUp = (event: PointerEvent) => {
      stopRightPanelSplitDragById(event.pointerId);
    };
    const onMouseMove = (event: MouseEvent) => {
      const drag = rightPanelSplitDragRef.current;
      if (!drag || drag.pointerId !== null) return;
      updateRightPanelSplit(event.clientY);
    };
    const onMouseUp = () => {
      stopRightPanelSplitDragById(null);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [clampRightPanelSplitRatio, rightPanelSplitDragging, rightPanelSplitRatio, stopRightPanelSplitDragById, updateRightPanelSplit]);

  const handleCenterHarnessResizerPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const panel = centerPanelRef.current;
    if (!panel) return;
    centerHarnessSplitDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startRatio: centerHarnessSplitRatio,
    };
    setCenterHarnessSplitDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [centerHarnessSplitRatio]);

  const handleCenterHarnessResizerPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = centerHarnessSplitDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const panel = centerPanelRef.current;
    const panelHeight = panel?.clientHeight || 0;
    if (!panelHeight) return;
    const delta = event.clientY - drag.startY;
    const next = drag.startRatio - delta / panelHeight;
    const clamped = clampCenterHarnessSplitRatio(next);
    if (Math.abs(clamped - centerHarnessSplitRatio) > 0.0001) {
      setCenterHarnessSplitRatio(clamped);
    }
    editorRef.current?.layout();
  }, [centerHarnessSplitRatio]);

  const stopCenterHarnessResizerDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = centerHarnessSplitDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    centerHarnessSplitDragRef.current = null;
    setCenterHarnessSplitDragging(false);
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
    window.requestAnimationFrame(syncMonacoLayout);
    window.setTimeout(() => syncMonacoLayout(), 120);
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
        const kindLabel = symbolKindLabel(symbol);
        const symbolId = symbolIdentity(symbol);
        const selected = selectedSymbolId === symbolId;
        const hasChildren = node.children.length > 0;
        const isCollapsed = hasChildren ? !!collapsedSymbolNodes[symbolId] : false;
        const dragSource = symbolTreeDragState && symbolIdentity(symbolTreeDragState.symbol) === symbolId;
        const dropTarget = symbolTreeDropTargetId === symbolId;
        const renaming = treeRenameState && symbolIdentity(treeRenameState.symbol) === symbolId;
        rows.push(
          <div
            key={symbolId}
            className={`simple-tree-symbol-row ${dropTarget ? "drop-target" : ""}`}
            style={{ paddingLeft: `${basePaddingLeft + depth * 14}px` }}
            onDragOver={(event) => {
              if (!symbolTreeDragState || !canDropSymbolOnPackage(symbolTreeDragState.symbol, symbol)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (symbolTreeDropTargetId !== symbolId) {
                setSymbolTreeDropTargetId(symbolId);
              }
            }}
            onDragEnter={(event) => {
              if (!symbolTreeDragState || !canDropSymbolOnPackage(symbolTreeDragState.symbol, symbol)) return;
              event.preventDefault();
              if (symbolTreeDropTargetId !== symbolId) {
                setSymbolTreeDropTargetId(symbolId);
              }
            }}
            onDragLeave={(event) => {
              const related = event.relatedTarget as HTMLElement | null;
              if (related?.closest(`[data-symbol-row-id="${symbolId}"]`)) return;
              if (symbolTreeDropTargetId === symbolId) {
                setSymbolTreeDropTargetId(null);
              }
            }}
            onDrop={(event) => {
              if (!symbolTreeDragState || !canDropSymbolOnPackage(symbolTreeDragState.symbol, symbol)) return;
              event.preventDefault();
              event.stopPropagation();
              setSymbolTreeDropTargetId(null);
              setSymbolTreeDragState(null);
              openMoveSymbolToPackageDialog(symbolTreeDragState.symbol, symbol);
            }}
            data-symbol-row-id={symbolId}
          >
            {hasChildren ? (
              <button
                type="button"
                className="ghost simple-tree-symbol-toggle"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleSymbolNodeCollapse(symbolId);
                }}
                title={isCollapsed ? "Expand" : "Collapse"}
                aria-label={isCollapsed ? "Expand symbol node" : "Collapse symbol node"}
              >
                {isCollapsed ? ">" : "v"}
              </button>
            ) : (
              <span className="simple-tree-symbol-toggle-placeholder" />
            )}
            {renaming ? (
              <div
                className={`simple-tree-symbol-entry simple-tree-symbol-entry-renaming ${selected ? "active" : ""}`}
                onClick={(event) => event.stopPropagation()}
                title={`${symbol.qualified_name}\n${symbol.file_path}`}
              >
                <span className="simple-tree-symbol-kind">
                  <span className="simple-tree-symbol-kind-icon">{symbolKindIcon(kindLabel)}</span>
                  <span className="simple-tree-symbol-kind-label">{kindLabel}</span>
                </span>
                <input
                  ref={treeRenameInputRef}
                  className="simple-tree-symbol-rename-input"
                  value={treeRenameState.value}
                  disabled={treeRenameState.submitting}
                  onChange={(event) => {
                    const value = event.target.value;
                    setTreeRenameState((prev) => (prev ? { ...prev, value, error: "" } : prev));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void submitTreeRename();
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setTreeRenameState(null);
                    }
                  }}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                  spellCheck={false}
                />
                <span className="simple-tree-symbol-rename-status muted">
                  {treeRenameState.submitting ? "Renaming..." : "Enter to apply"}
                </span>
              </div>
            ) : (
              <button
                type="button"
                className={`ghost simple-tree-symbol-entry ${selected ? "active" : ""} ${dragSource ? "drag-source" : ""}`}
                draggable={canDragSymbol(symbol)}
                onDragStart={(event) => {
                  if (!canDragSymbol(symbol)) return;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData(SYMBOL_TREE_DRAG_MIME, symbol.qualified_name || symbol.name || symbolId);
                  event.dataTransfer.setData("text/plain", symbol.qualified_name || symbol.name || symbolId);
                  setSymbolTreeDragState({ symbol });
                }}
                onDragEnd={() => {
                  setSymbolTreeDragState(null);
                  setSymbolTreeDropTargetId(null);
                }}
                onClick={() => {
                  void selectSymbol(symbol);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setSelectedSymbol(symbol);
                  openSemanticEditMenu(symbol, event.clientX, event.clientY);
                }}
                title={`${symbol.qualified_name}\n${symbol.file_path}`}
              >
                <span className="simple-tree-symbol-kind">
                  <span className="simple-tree-symbol-kind-icon">{symbolKindIcon(kindLabel)}</span>
                  <span className="simple-tree-symbol-kind-label">{kindLabel}</span>
                </span>
                <span className="simple-tree-symbol-name">{symbol.name || "<anonymous>"}</span>
              </button>
            )}
          </div>,
        );
        if (renaming && treeRenameState.error) {
          rows.push(
            <div
              key={`${symbolId}-rename-error`}
              className="simple-tree-symbol-rename-error error"
              style={{ paddingLeft: `${basePaddingLeft + depth * 14 + 20}px` }}
            >
              {treeRenameState.error}
            </div>,
          );
        }
        if (hasChildren && !isCollapsed && budget.remaining > 0) {
          rows.push(...renderNodes(node.children, depth + 1));
        }
      }
      return rows;
    };
    return renderNodes(symbolRoots, 0);
  }, [
    selectedSymbolId,
    selectSymbol,
    collapsedSymbolNodes,
    toggleSymbolNodeCollapse,
    openSemanticEditMenu,
    symbolTreeDragState,
    symbolTreeDropTargetId,
    openMoveSymbolToPackageDialog,
    treeRenameState,
    submitTreeRename,
  ]);

  const projectElementsTree = useMemo(() => {
    const renderLimit = expandedProjectElementsOverflow
      ? Math.max(FILE_SYMBOL_RENDER_LIMIT, projectSymbols.length + 1)
      : FILE_SYMBOL_RENDER_LIMIT;
    const budget = { remaining: renderLimit };
    return {
      shown: renderContainedSymbols(projectSymbolRoots, 14, budget),
      shownCount: renderLimit - budget.remaining,
    };
  }, [expandedProjectElementsOverflow, projectSymbolRoots, projectSymbols.length, renderContainedSymbols]);

  const libraryElementsTree = useMemo(() => {
    const renderLimit = expandedLibraryElementsOverflow
      ? Math.max(FILE_SYMBOL_RENDER_LIMIT, librarySymbols.length + 1)
      : FILE_SYMBOL_RENDER_LIMIT;
    const budget = { remaining: renderLimit };
    return {
      shown: renderContainedSymbols(librarySymbolRoots, 14, budget),
      shownCount: renderLimit - budget.remaining,
    };
  }, [expandedLibraryElementsOverflow, librarySymbolRoots, librarySymbols.length, renderContainedSymbols]);

  const renderTree = useCallback((entries: FileEntry[], depth = 0): ReactNode => {
    return entries.map((entry) => {
      const key = entry.path;
      const isDir = entry.is_dir;
      const isOpen = !!expanded[entry.path];
      const fileKey = normalizePath(entry.path);
      const iconKind = treeNodeIconKind(entry.path, isDir);
      const active = !isDir && normalizePath(activeFilePath) === fileKey;
      const hasParseError = fileDiagnosticPaths.has(fileKey);
      const fileSymbols = isDir ? [] : (symbolsByFile.get(fileKey) || []);
      const symbolCount = fileSymbols.length;
      const isSymbolOpen = !isDir && !!expandedFileSymbols[fileKey];
      const symbolRoots = isSymbolOpen ? buildSymbolOwnershipTree(fileSymbols) : [];
      const expandedOverflow = !isDir && !!expandedProjectFileSymbolOverflow[fileKey];
      const renderLimit = expandedOverflow
        ? Math.max(FILE_SYMBOL_RENDER_LIMIT, symbolCount + 1)
        : FILE_SYMBOL_RENDER_LIMIT;
      const renderBudget = { remaining: renderLimit };
      const shownSymbols = isSymbolOpen
        ? renderContainedSymbols(symbolRoots, 30 + depth * 14, renderBudget)
        : [];
      const shownSymbolCount = renderLimit - renderBudget.remaining;

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
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setTabContextMenu(null);
                setTabsOverflowMenuOpen(false);
                setFileContextMenu({
                  path: entry.path,
                  x: event.clientX,
                  y: event.clientY,
                  allowNewFile: isDir,
                  allowNewDiagram: false,
                });
              }}
              title={entry.path}
            >
              <span className={`simple-tree-icon ${iconKind}`}>
                {treeNodeIcon(iconKind)}
              </span>
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
                <button
                  type="button"
                  className="ghost simple-tree-symbol-more simple-tree-symbol-more-btn muted"
                  style={{ paddingLeft: `${30 + depth * 14}px` }}
                  onClick={(event) => {
                    event.stopPropagation();
                    showAllProjectFileSymbols(entry.path);
                  }}
                  title={`Show ${symbolCount - shownSymbolCount} more symbols`}
                >
                  +{symbolCount - shownSymbolCount} more symbols
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      );
    });
  }, [
    expanded,
    activeFilePath,
    fileDiagnosticPaths,
    symbolsByFile,
    expandedFileSymbols,
    expandedProjectFileSymbolOverflow,
    toggleExpand,
    openEntry,
    toggleProjectFileSymbols,
    showAllProjectFileSymbols,
    renderContainedSymbols,
  ]);

  const renderLibraryTree = useCallback((entries: FileEntry[], depth = 0): ReactNode => {
    return entries.map((entry) => {
      const key = entry.path;
      const isDir = entry.is_dir;
      const fileKey = normalizePath(entry.path);
      const iconKind = treeNodeIconKind(entry.path, isDir);
      const isOpen = isDir ? !!expandedLibraryDirs[entry.path] : !!expandedLibraryFiles[fileKey];
      const active = !isDir && normalizePath(activeFilePath) === fileKey;
      const fileSymbols = isDir ? [] : (librarySymbolsByFile.get(fileKey) || []);
      const symbolRoots = !isDir && isOpen ? buildSymbolOwnershipTree(fileSymbols) : [];
      const expandedOverflow = !isDir && !!expandedLibraryFileSymbolOverflow[fileKey];
      const renderLimit = expandedOverflow
        ? Math.max(FILE_SYMBOL_RENDER_LIMIT, fileSymbols.length + 1)
        : FILE_SYMBOL_RENDER_LIMIT;
      const renderBudget = { remaining: renderLimit };
      const shownSymbols = !isDir && isOpen
        ? renderContainedSymbols(symbolRoots, 30 + depth * 14, renderBudget)
        : [];
      const shownSymbolCount = renderLimit - renderBudget.remaining;

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
                  void toggleLibraryDir(entry);
                }}
                title={isOpen ? "Collapse" : "Expand"}
              >
                {isOpen ? "v" : ">"}
              </button>
            ) : (
              fileSymbols.length > 0 ? (
                <button
                  type="button"
                  className="ghost simple-tree-toggle"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleLibraryFileSymbols(entry.path);
                  }}
                  title={isOpen ? "Hide symbols" : "Show symbols"}
                >
                  {isOpen ? "v" : ">"}
                </button>
              ) : (
                <span className="simple-tree-toggle-placeholder" />
              )
            )}
            <button
              type="button"
              className="ghost simple-tree-entry"
              onClick={() => {
                if (isDir) {
                  void toggleLibraryDir(entry);
                } else {
                  void openFilePath(entry.path);
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setTabContextMenu(null);
                setTabsOverflowMenuOpen(false);
                setFileContextMenu({
                  path: entry.path,
                  x: event.clientX,
                  y: event.clientY,
                  allowNewFile: false,
                  allowNewDiagram: false,
                });
              }}
              title={entry.path}
            >
              <span className={`simple-tree-icon ${iconKind}`}>
                {treeNodeIcon(iconKind)}
              </span>
              <span className="simple-tree-label">{entry.name}</span>
              {!isDir ? <span className="simple-tree-count">{fileSymbols.length}</span> : null}
            </button>
          </div>
          {isDir && isOpen && expandedLibraryDirs[entry.path]?.length
            ? renderLibraryTree(expandedLibraryDirs[entry.path], depth + 1)
            : null}
          {!isDir && isOpen && shownSymbols.length ? (
            <div className="simple-tree-symbols">
              {shownSymbols}
              {fileSymbols.length > shownSymbolCount ? (
                <button
                  type="button"
                  className="ghost simple-tree-symbol-more simple-tree-symbol-more-btn muted"
                  style={{ paddingLeft: `${30 + depth * 14}px` }}
                  onClick={(event) => {
                    event.stopPropagation();
                    showAllLibraryFileSymbols(entry.path);
                  }}
                  title={`Show ${fileSymbols.length - shownSymbolCount} more symbols`}
                >
                  +{fileSymbols.length - shownSymbolCount} more symbols
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      );
    });
  }, [
    activeFilePath,
    expandedLibraryDirs,
    expandedLibraryFileSymbolOverflow,
    expandedLibraryFiles,
    librarySymbolsByFile,
    openFilePath,
    renderContainedSymbols,
    showAllLibraryFileSymbols,
    toggleLibraryDir,
    toggleLibraryFileSymbols,
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
  useEffect(() => {
    if (!activeTab) return;
    dirtyRef.current = activeTab.dirty;
    setDirty(activeTab.dirty);
    if (isDiagramEditorTab(activeTab)) {
      contentRef.current = activeTab.content;
    }
  }, [activeTab]);
  useEffect(() => {
    if (isTextEditorTab(activeTab)) return;
    if (cursorListenerRef.current) {
      cursorListenerRef.current.dispose();
      cursorListenerRef.current = null;
    }
    editorRef.current = null;
    monacoRef.current = null;
    setCursorPos(null);
  }, [activeTab]);
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
  const fileContextMenuStyle = useMemo((): CSSProperties | null => {
    if (!fileContextMenu) return null;
    const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 1280;
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 800;
    const menuWidth = 172;
    const actionCount = (fileContextMenu.allowNewFile ? 1 : 0) + (fileContextMenu.allowNewDiagram ? 1 : 0) + 1;
    const menuHeight = 8 + actionCount * 28;
    const left = Math.max(8, Math.min(fileContextMenu.x, viewportWidth - menuWidth - 8));
    const top = Math.max(8, Math.min(fileContextMenu.y, viewportHeight - menuHeight - 8));
    return { left, top };
  }, [fileContextMenu]);
  const semanticEditMenuStyle = useMemo((): CSSProperties | null => {
    if (!semanticEditMenu) return null;
    const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 1280;
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 800;
    const menuWidth = 220;
    const menuHeight = Math.max(80, 36 + semanticEditMenu.actions.length * 28);
    const left = Math.max(8, Math.min(semanticEditMenu.x, viewportWidth - menuWidth - 8));
    const top = Math.max(8, Math.min(semanticEditMenu.y, viewportHeight - menuHeight - 8));
    return { left, top };
  }, [semanticEditMenu]);
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
  const rightPanelLayoutStyle = useMemo(
    () =>
      ({
        "--simple-right-top-panel-size": `${Math.max(0, Math.min(1, rightPanelSplitRatio)).toFixed(3)}`,
        "--simple-right-bottom-panel-size": `${Math.max(0, Math.min(1, 1 - rightPanelSplitRatio)).toFixed(3)}`,
      }) as CSSProperties,
    [rightPanelSplitRatio],
  );
  const centerHarnessSizeStyle = useMemo(
    () => `${Math.round(centerHarnessSplitRatio * 100)}%`,
    [centerHarnessSplitRatio],
  );
  const centerLayoutStyle = useMemo(
    () =>
      ({
        "--simple-center-harness-size": centerHarnessSizeStyle,
      }) as CSSProperties,
    [centerHarnessSizeStyle],
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
      const timestamp = entry.timestampUtc || entry.at;
      lines.push(`${timestamp}\t${entry.level.toUpperCase()}\t${entry.kind}\t${entry.message}`);
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
  const openToolTab = useCallback((tab: ToolTabId) => {
    setActiveToolTab(tab);
  }, []);
  const evaluateExpressionInput = useCallback(async () => {
    if (!rootPath) {
      setExpressionResult(null);
      setExpressionRequestError("");
      setCompileStatus("Select a project root first");
      return;
    }
    const source = expressionInput.trim();
    if (!source) {
      setExpressionResult(null);
      setExpressionRequestError("");
      setCompileStatus("Enter an expression");
      return;
    }
    setExpressionPending(true);
    setExpressionRequestError("");
    try {
      const view = await getExpressionsView(rootPath, source);
      setExpressionResult(view.evaluation || null);
      setCompileStatus(`Expression result: ${view.evaluation?.result || "-"}`);
    } catch (error) {
      const message = String(error);
      setExpressionRequestError(message);
      setCompileStatus(`Expression evaluation failed: ${message}`);
    } finally {
      setExpressionPending(false);
    }
  }, [expressionInput, rootPath, setCompileStatus]);
  const clearExpressionTool = useCallback(() => {
    setExpressionInput("");
    setExpressionResult(null);
    setExpressionRequestError("");
  }, []);

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
    void invoke("app_exit").catch((error) => {
      setCompileStatus(`Exit failed: ${String(error)}`);
    });
  }, [setCompileStatus]);

  return (
    <div className="app-shell simple-ui-shell">
      <header
        className="native-titlebar"
        onDoubleClick={(event) => {
          const target = event.target as HTMLElement | null;
          if (!target) return;
          if (target.closest(".native-window-btn") || target.closest(".menu-bar")) {
            return;
          }
          toggleMaximizeWindow();
        }}
      >
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
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); void runMenuAction("new-project"); }}>New Project...</button>
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); void runMenuAction("open-explorer"); }} disabled={!selectedSymbol}>Open Model Explorer</button>
                  <div className="menu-bar-sep" />
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); void runMenuAction("open-folder"); }}>Open Folder...</button>
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); void runMenuAction("open-file"); }}>Open File...</button>
                  <div className="menu-bar-sep" />
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); void runMenuAction("save-active"); }}>Save</button>
                  <div className="menu-bar-sep" />
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); void runMenuAction("close-window"); }}>Exit</button>
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
                  <button
                    type="button"
                    className="ghost menu-bar-entry"
                    onClick={() => { setMenuOpen(null); void runMenuAction("toggle-autobuild-active-file"); }}
                  >
                    {autoBuildActiveFile ? `${UI_ICON.check} ` : ""}Autobuild Active File
                  </button>
                  <div className="menu-bar-sep" />
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); void runMenuAction("clear-caches"); }}>Clear Caches</button>
                </div>
              ) : null}
            </div>
            <div className="menu-bar-item">
              <button
                type="button"
                className={`ghost menu-bar-trigger ${menuOpen === "view" ? "active" : ""}`}
                onClick={() => setMenuOpen((prev) => (prev === "view" ? null : "view"))}
              >
                View
              </button>
              {menuOpen === "view" ? (
                <div className="menu-bar-dropdown">
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); openToolTab("tooling"); }}>
                    {activeToolTab === "tooling" ? `${UI_ICON.check} ` : ""}Show Tooling
                  </button>
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); openToolTab("logs"); }}>
                    {activeToolTab === "logs" ? `${UI_ICON.check} ` : ""}Show Logs
                  </button>
                  <button type="button" className="ghost menu-bar-entry" onClick={() => { setMenuOpen(null); openToolTab("expressions"); }}>
                    {activeToolTab === "expressions" ? `${UI_ICON.check} ` : ""}Show Expressions
                  </button>
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
          <button type="button" className="ghost native-window-btn" onClick={minimizeWindow} title="Minimize" aria-label="Minimize window">{UI_ICON.minimize}</button>
          <button type="button" className="ghost native-window-btn" onClick={toggleMaximizeWindow} title="Maximize" aria-label="Maximize or restore window">{UI_ICON.maximize}</button>
          <button type="button" className="ghost native-window-btn close" onClick={closeWindow} title="Exit" aria-label="Exit">{UI_ICON.close}</button>
        </div>
      </header>
      <header className="titlebar simple-ui-titlebar">
        <div className="simple-ui-root-picker">
          <button type="button" className="ghost" onClick={() => void openNewProjectDialog()}>
            New Project...
          </button>
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
              onContextMenu={(event) => {
                const trimmedRoot = rootPath.trim();
                if (!trimmedRoot) return;
                event.preventDefault();
                event.stopPropagation();
                setTabContextMenu(null);
                setTabsOverflowMenuOpen(false);
                setFileContextMenu({
                  path: trimmedRoot,
                  x: event.clientX,
                  y: event.clientY,
                  allowNewFile: true,
                  allowNewDiagram: false,
                });
              }}
              title={projectFilesExpanded ? "Collapse project files" : "Expand project files"}
              aria-label={projectFilesExpanded ? "Collapse project files" : "Expand project files"}
            >
              <span className="simple-tree-section-caret">{projectFilesExpanded ? "v" : ">"}</span>
              <span className="simple-tree-section-title">Project Files</span>
              <span className="simple-tree-section-meta">{projectFolderLabel}</span>
            </button>
            <div className="simple-tree-toolbar">
              <div className="simple-tree-settings-wrap" ref={projectFilesSettingsButtonRef}>
                <button
                  type="button"
                  className={`ghost simple-tree-toolbar-btn ${projectFilesSettingsMenuOpen ? "active" : ""}`}
                  onClick={() => setProjectFilesSettingsMenuOpen((prev) => !prev)}
                  title="Project files settings"
                  aria-label="Project files settings"
                >
                  {UI_ICON.settings}
                </button>
                {projectFilesSettingsMenuOpen ? (
                  <div className="simple-project-files-settings-menu">
                    <button
                      type="button"
                      className="ghost simple-project-files-settings-menu-item"
                      onClick={() => {
                        setProjectFilesShowByFile(true);
                        setProjectFilesSettingsMenuOpen(false);
                      }}
                    >
                      {projectFilesShowByFile ? `${UI_ICON.check} ` : "   "}Show by file
                    </button>
                    <button
                      type="button"
                      className="ghost simple-project-files-settings-menu-item"
                      onClick={() => {
                        setProjectFilesShowByFile(false);
                        setProjectFilesSettingsMenuOpen(false);
                      }}
                    >
                      {projectFilesShowByFile ? "   " : `${UI_ICON.check} `}Hide files (show elements only)
                    </button>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="ghost simple-tree-toolbar-btn"
                onClick={() => {
                  void expandAllTreeElements();
                }}
                disabled={!rootPath}
                title="Expand all"
                aria-label="Expand all"
              >
                +
              </button>
              <button
                type="button"
                className="ghost simple-tree-toolbar-btn"
                onClick={collapseAllTreeElements}
                disabled={!rootPath}
                title="Collapse all"
                aria-label="Collapse all"
              >
                -
              </button>
            </div>
          </div>
          {effectiveTreeError ? <div className="simple-tree-toolbar-error error">{effectiveTreeError}</div> : null}
          <div className="simple-ui-scroll">
            {rootPath ? (
              <>
                <div className="simple-tree-section">
                  {projectFilesExpanded ? (
                    projectFilesShowByFile ? (
                      treeEntries.length ? renderTree(treeEntries) : <div className="muted">No files in root.</div>
                    ) : (
                      projectSymbolRoots.length ? (
                        <div className="simple-tree-symbols">
                          {projectElementsTree.shown}
                          {projectSymbols.length > projectElementsTree.shownCount ? (
                            <button
                              type="button"
                              className="ghost simple-tree-symbol-more simple-tree-symbol-more-btn muted"
                              style={{ paddingLeft: "14px" }}
                              onClick={(event) => {
                                event.stopPropagation();
                                showAllProjectElements();
                              }}
                              title={`Show ${projectSymbols.length - projectElementsTree.shownCount} more symbols`}
                            >
                              +{projectSymbols.length - projectElementsTree.shownCount} more symbols
                            </button>
                          ) : null}
                        </div>
                      ) : (
                        <div className={effectiveTreeError ? "error" : "muted"}>
                          {symbolsStatus === "loading"
                            ? "Loading project symbols..."
                            : (effectiveTreeError || "No project symbols indexed.")}
                        </div>
                      )
                    )
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
                    <span className="simple-tree-count">
                      {projectFilesShowByFile ? libraryFilePaths.length : librarySymbols.length}
                    </span>
                  </div>
                  {libraryFilesExpanded ? (
                    projectFilesShowByFile ? (
                      libraryFilePaths.length ? (
                        renderLibraryTree(libraryTreeEntries)
                      ) : (
                        <div className="muted">No library files indexed.</div>
                      )
                    ) : (
                      librarySymbolRoots.length ? (
                        <div className="simple-tree-symbols">
                          {libraryElementsTree.shown}
                          {librarySymbols.length > libraryElementsTree.shownCount ? (
                            <button
                              type="button"
                              className="ghost simple-tree-symbol-more simple-tree-symbol-more-btn muted"
                              style={{ paddingLeft: "14px" }}
                              onClick={(event) => {
                                event.stopPropagation();
                                showAllLibraryElements();
                              }}
                              title={`Show ${librarySymbols.length - libraryElementsTree.shownCount} more symbols`}
                            >
                              +{librarySymbols.length - libraryElementsTree.shownCount} more symbols
                            </button>
                          ) : null}
                        </div>
                      ) : (
                        <div className="muted">
                          {symbolsStatus === "loading" ? "Loading library symbols..." : "No library symbols indexed."}
                        </div>
                      )
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

        <section className="panel editor simple-ui-center" ref={centerPanelRef} style={centerLayoutStyle}>
          <div className="simple-center-workspace">
            <div className="simple-center-editor-stack">
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
                            setFileContextMenu(null);
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
                {shouldShowTabDropdown ? (
                  <div className="simple-editor-tabs-overflow">
                    <button
                      type="button"
                      className={`ghost simple-editor-tabs-overflow-btn ${tabsOverflowMenuOpen ? "active" : ""}`}
                      onClick={() => {
                        setTabContextMenu(null);
                        setFileContextMenu(null);
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
              {fileContextMenu && fileContextMenuStyle ? (
                <div className="simple-tab-context-menu simple-file-context-menu" style={fileContextMenuStyle}>
                  {fileContextMenu.allowNewFile ? (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => openNewFileDialog(fileContextMenu.path)}
                    >
                      New File...
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      void showPathInExplorer(fileContextMenu.path);
                    }}
                  >
                    Show in Explorer
                  </button>
                </div>
              ) : null}
              {semanticEditMenu && semanticEditMenuStyle ? (
                <div className="simple-tab-context-menu simple-semantic-edit-menu" style={semanticEditMenuStyle}>
                  <div className="simple-semantic-edit-menu-title">
                    {semanticEditMenu.symbol.name || semanticEditMenu.symbol.qualified_name}
                  </div>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => openModelExplorerForSymbol(semanticEditMenu.symbol)}
                    title="Open the selected element in Model Explorer"
                  >
                    Open Model Explorer
                  </button>
                  {canRenameSymbol(semanticEditMenu.symbol) ? (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => startTreeRename(semanticEditMenu.symbol)}
                      title="Rename this element in the containment tree"
                    >
                      Rename
                    </button>
                  ) : null}
                  {semanticEditMenu.loading ? (
                    <div className="muted simple-semantic-edit-menu-message">Loading actions...</div>
                  ) : null}
                  {!semanticEditMenu.loading && semanticEditMenu.error ? (
                    <div className="error simple-semantic-edit-menu-message">{semanticEditMenu.error}</div>
                  ) : null}
                  {!semanticEditMenu.loading && !semanticEditMenu.error
                    ? semanticEditMenu.actions.map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        className="ghost"
                        onClick={() => startSemanticEditAction(semanticEditMenu.symbol, action)}
                        title={action.description}
                      >
                        {action.label}
                      </button>
                    ))
                    : null}
                </div>
              ) : null}
              {showCenterWelcome ? (
                <div className="simple-editor-welcome">
                  <div className="simple-editor-welcome-card">
                    <div className="simple-editor-welcome-title">Welcome to Mercurio SysML</div>
                    <div className="simple-editor-welcome-text">
                      Create a new project, choose a recent project, or open a root folder, then select a file from the project tree.
                    </div>
                    <div className="simple-editor-welcome-hints muted">
                      <div>Ctrl+N: New Project</div>
                      <div>Ctrl+Shift+O: Open Folder</div>
                      <div>Ctrl+O: Open File</div>
                      <div>Ctrl+S: Save</div>
                      <div>Alt+B: Compile Project</div>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {activeExplorerTab && activeExplorerGraph ? (
                    <ModelExplorerCanvas
                      graph={activeExplorerGraph}
                      positions={activeExplorerPositions}
                      viewport={activeExplorerViewport}
                      dragHover={diagramDragHover}
                      selectedNodeQualifiedName={activeExplorerTab.selectedQualifiedName}
                      selectedEdgeId={activeExplorerTab.selectedEdgeId}
                      selectedEdge={activeExplorerSelectedEdge}
                      canGoBack={activeExplorerTab.historyBack.length > 0}
                      canGoForward={activeExplorerTab.historyForward.length > 0}
                      canExpandSelected={canExpandExplorerSelection}
                      canReRootSelected={canReRootExplorerSelection}
                      onPositionsChange={handleExplorerPositionsChange}
                      onViewportChange={handleExplorerViewportChange}
                      onSelectNode={handleExplorerSelectNode}
                      onOpenNode={handleExplorerOpenNode}
                      onReRootNode={setActiveExplorerRoot}
                      onExpandNode={handleExplorerExpandNode}
                      onSelectEdge={handleExplorerSelectEdge}
                      onFollowRelationshipTarget={handleExplorerFollowRelationshipTarget}
                      onBack={handleExplorerBack}
                      onForward={handleExplorerForward}
                      onToggleDirectedRelationships={handleExplorerToggleDirectedRelationships}
                      onCanvasDragEnter={handleDiagramCanvasDragEnter}
                      onCanvasDragOver={handleDiagramCanvasDragOver}
                      onCanvasDragLeave={handleDiagramCanvasDragLeave}
                      onCanvasDrop={handleExplorerCanvasDrop}
                    />
                  ) : activeDiagramTab && activeDiagramGraph ? (
                    <DiagramCanvas
                      graph={activeDiagramGraph}
                      positions={activeDiagramPositions}
                      viewport={activeDiagramViewport}
                      dirty={dirty}
                      dragHover={diagramDragHover}
                      onPositionsChange={handleDiagramPositionsChange}
                      onViewportChange={handleDiagramViewportChange}
                      onSelectNode={handleDiagramSelectNode}
                      onOpenNode={handleDiagramOpenNode}
                      onSave={() => { void saveActiveFile(); }}
                      onCanvasDragEnter={handleDiagramCanvasDragEnter}
                      onCanvasDragOver={handleDiagramCanvasDragOver}
                      onCanvasDragLeave={handleDiagramCanvasDragLeave}
                      onCanvasDrop={handleDiagramCanvasDrop}
                      onRebind={selectedSymbol ? () => updateActiveDiagramRoot(selectedSymbol) : undefined}
                      canRebind={!!selectedSymbol}
                    />
                  ) : (
                    <>
                      <div className="panel-header simple-editor-header">
                        <div className="simple-editor-title">{activeFileName}{dirty ? " *" : ""}</div>
                        <div className="simple-editor-meta">
                          <span>Symbols in file: {activeFileSymbols.length}</span>
                          <span>Parsed files: {parsedFiles.length}</span>
                          <span>Unresolved: {unresolvedCount}</span>
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
                                setOpenTabs((prev) => prev.map((tab) => {
                                  if (normalizePath(tab.path) !== activeKey) return tab;
                                  if (isExplorerEditorTab(tab) || tab.dirty) return tab;
                                  return { ...tab, dirty: true };
                                }));
                              }
                            }
                            scheduleAutoBuild();
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
                            scrollbar: {
                              vertical: "hidden",
                              horizontal: "hidden",
                              alwaysConsumeMouseWheel: false,
                            },
                          }}
                        />
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
            <div
              className={`simple-harness-resizer ${centerHarnessSplitDragging ? "active" : ""}`}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize tooling area"
              onPointerDown={handleCenterHarnessResizerPointerDown}
              onPointerMove={handleCenterHarnessResizerPointerMove}
              onPointerUp={stopCenterHarnessResizerDrag}
              onPointerCancel={stopCenterHarnessResizerDrag}
            />
            <div className="simple-tooling">
              <div className="panel-header simple-tooling-header">
                <div className="simple-tooling-tabs" role="tablist" aria-label="Tooling tabs">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeToolTab === "tooling"}
                    className={`ghost simple-tool-tab ${activeToolTab === "tooling" ? "active" : ""}`}
                    onClick={() => setActiveToolTab("tooling")}
                  >
                    Tooling
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeToolTab === "logs"}
                    className={`ghost simple-tool-tab ${activeToolTab === "logs" ? "active" : ""}`}
                    onClick={() => openToolTab("logs")}
                  >
                    Logs
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeToolTab === "expressions"}
                    className={`ghost simple-tool-tab ${activeToolTab === "expressions" ? "active" : ""}`}
                    onClick={() => openToolTab("expressions")}
                  >
                    Expressions
                  </button>
                </div>
                <div className="simple-tooling-actions">
                  {activeToolTab === "logs" ? (
                    <>
                      <button type="button" className="ghost" onClick={() => void copyBuildProgress()}>
                        Copy Logs
                      </button>
                      <button type="button" className="ghost" onClick={clearBuildLogs}>
                        Clear
                      </button>
                    </>
                  ) : null}
                  {activeToolTab === "expressions" ? (
                    <>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => void evaluateExpressionInput()}
                        disabled={expressionPending}
                      >
                        {expressionPending ? "Evaluating..." : "Evaluate"}
                      </button>
                      <button type="button" className="ghost" onClick={clearExpressionTool} disabled={expressionPending}>
                        Clear
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="simple-tooling-body">
                {activeToolTab === "logs" ? (
                  <div className="simple-log-tool" role="tabpanel" aria-label="Logs tool">
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
                      <BuildLogList entries={buildLogEntries} />
                    </div>
                    <div className="simple-harness-runs" aria-label="Recent runs">
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
                  </div>
                ) : activeToolTab === "expressions" ? (
                  <div className="simple-expression-tool" role="tabpanel" aria-label="Expressions tool">
                    <label className="simple-expression-editor">
                      <span className="muted">Expression</span>
                      <textarea
                        className="simple-expression-input"
                        value={expressionInput}
                        onChange={(event) => setExpressionInput(event.target.value)}
                        onKeyDown={(event) => {
                          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                            event.preventDefault();
                            void evaluateExpressionInput();
                          }
                        }}
                        spellCheck={false}
                        placeholder="Type an expression like 1 + 2 * 3"
                      />
                    </label>
                    <div className="simple-expression-hint muted">Press Ctrl+Enter to evaluate.</div>
                    <div className="simple-expression-results">
                      {expressionRequestError ? (
                        <div className="error">{expressionRequestError}</div>
                      ) : null}
                      {expressionResult ? (
                        <div className="simple-expression-grid">
                          <span className="muted">Expression</span>
                          <span>{expressionResult.expression}</span>
                          <span className="muted">Result</span>
                          <span>{expressionResult.result}</span>
                        </div>
                      ) : (
                        <div className="muted">Enter an expression and evaluate it against the current project.</div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="simple-harness-runs simple-tooling-panel" role="tabpanel" aria-label="Tooling tab">
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
                )}
              </div>
            </div>
          </div>
        </section>

        <aside className="panel simple-ui-right" ref={rightPanelRef} style={rightPanelLayoutStyle}>
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
          <PropertiesPanel
            rootPath={rootPath}
            selectedSymbol={selectedSymbol}
            semanticRefreshVersion={semanticRefreshVersion}
            onSelectQualifiedName={selectQualifiedName}
            onOpenExplorer={() => openModelExplorerForSymbol(selectedSymbol)}
          />
          <div
            className={`simple-right-splitter ${rightPanelSplitDragging ? "active" : ""}`}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize properties and parse errors"
            onPointerDown={handleRightPanelSplitPointerDown}
            onMouseDown={handleRightPanelSplitMouseDown}
            onPointerMove={handleRightPanelSplitPointerMove}
            onPointerUp={stopRightPanelSplitDrag}
            onPointerCancel={stopRightPanelSplitDrag}
          />
          <ParseErrorsPanel
            compileToast={compileToast}
            workspaceErrors={rightPanelWorkspaceErrors}
            collapsedParseErrorFiles={collapsedParseErrorFiles}
            normalizePath={normalizePath}
            displayNameForPath={displayNameForPath}
            toggleParseErrorFile={toggleParseErrorFile}
            openDiagnostic={openDiagnostic}
          />
        </aside>
      </main>

      {semanticEditDialog ? (
        <div
          className="simple-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !semanticEditDialog.previewing && !semanticEditDialog.applying) {
              setSemanticEditDialog(null);
            }
          }}
        >
          <section
            className="simple-modal simple-semantic-edit-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Semantic edit: ${semanticEditDialog.action.label}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="simple-modal-header">
              <strong>{semanticEditDialog.action.label}</strong>
              <div className="simple-modal-header-actions">
                <button
                  type="button"
                  className="ghost"
                  disabled={semanticEditDialog.previewing || semanticEditDialog.applying}
                  onClick={() => setSemanticEditDialog(null)}
                >
                  Close
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={semanticEditDialog.previewing || semanticEditDialog.applying}
                  onClick={() => void requestSemanticEditPreview()}
                >
                  {semanticEditDialog.previewing ? "Previewing..." : "Preview"}
                </button>
                <button
                  type="button"
                  disabled={
                    semanticEditDialog.previewing
                    || semanticEditDialog.applying
                    || !semanticEditDialog.preview
                    || semanticEditDialog.dirtySincePreview
                  }
                  onClick={() => void requestSemanticEditApply()}
                >
                  {semanticEditDialog.applying ? "Applying..." : "Apply"}
                </button>
              </div>
            </div>
            <div className="simple-modal-body simple-semantic-edit-body">
              <div className="simple-semantic-edit-meta">
                <div><strong>Target:</strong> {semanticEditDialog.symbol.qualified_name}</div>
                <div><strong>Kind:</strong> {semanticEditDialog.symbol.kind}</div>
                <div><strong>File:</strong> {displayNameForPath(semanticEditDialog.symbol.file_path)}</div>
              </div>
              <div className="simple-semantic-edit-fields">
                {semanticEditDialog.action.fields.map((field) => {
                  const value = semanticEditDialog.values[field.key];
                  if (field.field_type === "checkbox") {
                    return (
                      <label key={field.key} className="simple-semantic-edit-checkbox">
                        <input
                          type="checkbox"
                          checked={!!value}
                          disabled={semanticEditDialog.previewing || semanticEditDialog.applying}
                          onChange={(event) => updateSemanticEditValue(field.key, event.target.checked)}
                        />
                        <span>{field.label}</span>
                      </label>
                    );
                  }
                  return (
                    <label key={field.key} className="simple-semantic-edit-field">
                      <span className="muted">
                        {field.label}
                        {field.required ? " *" : ""}
                      </span>
                      {field.field_type === "readonly" ? (
                        <input
                          value={semanticEditFieldValue(field, value)}
                          readOnly
                          disabled
                        />
                      ) : field.field_type === "textarea" ? (
                        <textarea
                          value={semanticEditFieldValue(field, value)}
                          placeholder={field.placeholder || ""}
                          disabled={semanticEditDialog.previewing || semanticEditDialog.applying}
                          onChange={(event) => updateSemanticEditValue(field.key, event.target.value)}
                        />
                      ) : field.field_type === "select" ? (
                        <select
                          value={semanticEditFieldValue(field, value)}
                          disabled={semanticEditDialog.previewing || semanticEditDialog.applying}
                          onChange={(event) => updateSemanticEditValue(field.key, event.target.value)}
                        >
                          {field.options.map((option) => (
                            <option key={`${field.key}-${option.value}`} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={semanticEditFieldValue(field, value)}
                          placeholder={field.placeholder || ""}
                          disabled={semanticEditDialog.previewing || semanticEditDialog.applying}
                          onChange={(event) => updateSemanticEditValue(field.key, event.target.value)}
                        />
                      )}
                      {field.description ? <div className="muted">{field.description}</div> : null}
                    </label>
                  );
                })}
              </div>
              {semanticEditDialog.previewError ? (
                <div className="error">{semanticEditDialog.previewError}</div>
              ) : null}
              {semanticEditDialog.preview ? (
                <div className="simple-semantic-edit-preview">
                  <div className="simple-semantic-edit-preview-header">
                    <strong>Preview Diff</strong>
                    <span className="muted">
                      {semanticEditDialog.preview.changed ? "Changes detected" : "No textual changes"}
                    </span>
                  </div>
                  {semanticEditDialog.preview.diagnostics.length ? (
                    <div className="simple-semantic-edit-diagnostics">
                      {semanticEditDialog.preview.diagnostics.map((diagnostic, index) => (
                        <div key={`${diagnostic}-${index}`} className="muted">{diagnostic}</div>
                      ))}
                    </div>
                  ) : null}
                  <pre className="simple-semantic-edit-diff">
                    {semanticEditDialog.preview.diff || "No changes."}
                  </pre>
                </div>
              ) : (
                <div className="muted">Fill in the fields, then preview the generated text diff before applying.</div>
              )}
            </div>
            <div className="simple-modal-footer muted">
              {semanticEditDialog.dirtySincePreview
                ? "Preview is stale. Run Preview again before Apply."
                : "Apply writes the updated text to disk and refreshes the model."}
            </div>
          </section>
        </div>
      ) : null}

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

      {newProjectDialog ? (
        <div
          className="simple-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !newProjectDialog.submitting) {
              setNewProjectDialog(null);
            }
          }}
        >
          <section
            className="simple-modal simple-new-project-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Create new project"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void createNewProjectFromDialog();
              }}
            >
              <div className="simple-modal-header">
                <strong>New Project</strong>
                <div className="simple-modal-header-actions">
                  <button
                    type="button"
                    className="ghost"
                    disabled={newProjectDialog.submitting}
                    onClick={() => setNewProjectDialog(null)}
                  >
                    Cancel
                  </button>
                  <button type="submit" disabled={newProjectDialog.submitting}>
                    {newProjectDialog.submitting ? "Creating..." : "Create"}
                  </button>
                </div>
              </div>
              <div className="simple-modal-body simple-new-project-body">
                <label className="simple-new-file-field">
                  <span className="muted">Parent Folder</span>
                  <div className="simple-new-project-path-row">
                    <input
                      value={newProjectDialog.parentPath}
                      onChange={(event) => setNewProjectDialog((prev) => (
                        prev ? { ...prev, parentPath: event.target.value, error: "" } : prev
                      ))}
                      placeholder="C:\\Users\\...\\Documents"
                      aria-label="Project parent folder"
                      disabled={newProjectDialog.submitting}
                    />
                    <button
                      type="button"
                      className="ghost"
                      disabled={newProjectDialog.submitting}
                      onClick={() => {
                        void (async () => {
                          const selected = await open({ directory: true, multiple: false });
                          if (typeof selected !== "string") return;
                          setNewProjectDialog((prev) => (
                            prev ? { ...prev, parentPath: selected, error: "" } : prev
                          ));
                        })();
                      }}
                    >
                      Browse...
                    </button>
                  </div>
                </label>
                <div className="simple-new-project-grid">
                  <label className="simple-new-file-field">
                    <span className="muted">Project Name</span>
                    <input
                      ref={newProjectNameInputRef}
                      value={newProjectDialog.name}
                      onChange={(event) => setNewProjectDialog((prev) => (
                        prev ? { ...prev, name: event.target.value, error: "" } : prev
                      ))}
                      placeholder="vehicle-architecture"
                      aria-label="Project name"
                      disabled={newProjectDialog.submitting}
                    />
                  </label>
                  <label className="simple-new-file-field">
                    <span className="muted">Author</span>
                    <input
                      value={newProjectDialog.author}
                      onChange={(event) => setNewProjectDialog((prev) => (
                        prev ? { ...prev, author: event.target.value, error: "" } : prev
                      ))}
                      placeholder="Optional"
                      aria-label="Project author"
                      disabled={newProjectDialog.submitting}
                    />
                  </label>
                  <label className="simple-new-file-field">
                    <span className="muted">Organization</span>
                    <input
                      value={newProjectDialog.organization}
                      onChange={(event) => setNewProjectDialog((prev) => (
                        prev ? { ...prev, organization: event.target.value, error: "" } : prev
                      ))}
                      placeholder="Optional"
                      aria-label="Project organization"
                      disabled={newProjectDialog.submitting}
                    />
                  </label>
                </div>
                <label className="simple-new-file-field">
                  <span className="muted">Description</span>
                  <textarea
                    value={newProjectDialog.description}
                    onChange={(event) => setNewProjectDialog((prev) => (
                      prev ? { ...prev, description: event.target.value, error: "" } : prev
                    ))}
                    placeholder="Optional"
                    aria-label="Project description"
                    disabled={newProjectDialog.submitting}
                  />
                </label>
                <div className="simple-new-project-options">
                  <label className="simple-new-project-check">
                    <input
                      type="checkbox"
                      checked={newProjectDialog.useDefaultLibrary}
                      onChange={(event) => setNewProjectDialog((prev) => (
                        prev ? { ...prev, useDefaultLibrary: event.target.checked, error: "" } : prev
                      ))}
                      disabled={newProjectDialog.submitting}
                    />
                    <span>Use default stdlib</span>
                  </label>
                  <label className="simple-new-project-check">
                    <input
                      type="checkbox"
                      checked={newProjectDialog.createStarterFile}
                      onChange={(event) => setNewProjectDialog((prev) => (
                        prev ? { ...prev, createStarterFile: event.target.checked, error: "" } : prev
                      ))}
                      disabled={newProjectDialog.submitting}
                    />
                    <span>Create starter model file</span>
                  </label>
                </div>
                {newProjectDialog.createStarterFile ? (
                  <label className="simple-new-file-field">
                    <span className="muted">Starter File</span>
                    <div className="simple-new-file-input-row">
                      <input
                        value={newProjectDialog.starterFileName}
                        onChange={(event) => setNewProjectDialog((prev) => (
                          prev ? { ...prev, starterFileName: event.target.value, error: "" } : prev
                        ))}
                        placeholder="model"
                        aria-label="Starter file name"
                        disabled={newProjectDialog.submitting}
                      />
                      <div className="simple-new-file-type-group" role="radiogroup" aria-label="Starter file type">
                        {([".sysml", ".kerml"] as const).map((extension) => (
                          <button
                            key={extension}
                            type="button"
                            className={`simple-new-file-type-btn ${newProjectDialog.starterFileExtension === extension ? "active" : ""}`}
                            onClick={() => setNewProjectDialog((prev) => (
                              prev ? { ...prev, starterFileExtension: extension, error: "" } : prev
                            ))}
                            disabled={newProjectDialog.submitting}
                            aria-pressed={newProjectDialog.starterFileExtension === extension}
                          >
                            {extension}
                          </button>
                        ))}
                      </div>
                    </div>
                  </label>
                ) : null}
                {newProjectDialog.error ? (
                  <div className="error">{newProjectDialog.error}</div>
                ) : (
                  <div className="muted">
                    Creates a project folder with a `.project` descriptor
                    {newProjectDialog.createStarterFile ? " and a starter source file." : "."}
                  </div>
                )}
              </div>
              <div className="simple-modal-footer muted">
                Root: {newProjectDialog.parentPath.trim() && newProjectDialog.name.trim()
                  ? `${newProjectDialog.parentPath.replace(/[\\/]+$/, "")}\\${newProjectDialog.name.trim()}`
                  : "<choose parent and name>"}
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {newDiagramDialog ? (
        <div
          className="simple-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !newDiagramDialog.submitting) {
              setNewDiagramDialog(null);
            }
          }}
        >
          <section
            className="simple-modal simple-new-file-modal simple-new-diagram-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Create new diagram"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void createNewDiagramFromDialog();
              }}
            >
              <div className="simple-modal-header">
                <strong>New Diagram</strong>
                <div className="simple-modal-header-actions">
                  <button
                    type="button"
                    className="ghost"
                    disabled={newDiagramDialog.submitting}
                    onClick={() => setNewDiagramDialog(null)}
                  >
                    Cancel
                  </button>
                  <button type="submit" disabled={newDiagramDialog.submitting}>
                    {newDiagramDialog.submitting ? "Creating..." : "Create"}
                  </button>
                </div>
              </div>
              <div className="simple-modal-body simple-new-file-body">
                <div className="simple-new-file-meta muted">
                  <span>Folder: {displayNameForPath(newDiagramDialog.parentPath)}</span>
                  <span title={newDiagramDialog.parentPath}>{newDiagramDialog.parentPath}</span>
                </div>
                <label className="simple-new-file-field">
                  <span className="muted">Diagram Name</span>
                  <input
                    ref={newDiagramNameInputRef}
                    value={newDiagramDialog.name}
                    onChange={(event) => setNewDiagramDialog((prev) => (
                      prev ? { ...prev, name: event.target.value, error: "" } : prev
                    ))}
                    placeholder="Vehicle Diagram"
                    aria-label="Diagram name"
                    disabled={newDiagramDialog.submitting}
                  />
                </label>
                <label className="simple-new-file-field">
                  <span className="muted">File Name</span>
                  <input
                    value={newDiagramDialog.fileName}
                    onChange={(event) => setNewDiagramDialog((prev) => (
                      prev ? { ...prev, fileName: event.target.value, error: "" } : prev
                    ))}
                    placeholder="vehicle-diagram.diagram"
                    aria-label="Diagram file name"
                    disabled={newDiagramDialog.submitting}
                  />
                </label>
                <label className="simple-new-file-field">
                  <span className="muted">Diagram Type</span>
                  <div className="simple-new-file-type-group" role="radiogroup" aria-label="Diagram type">
                    {DIAGRAM_TYPE_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`simple-new-file-type-btn ${newDiagramDialog.diagramType === option.value ? "active" : ""}`}
                        onClick={() => setNewDiagramDialog((prev) => {
                          if (!prev) return prev;
                          const preferredRoot = resolvePreferredDiagramRoot(option.value, selectedSymbol, projectSymbols);
                          return {
                            ...prev,
                            diagramType: option.value,
                            rootQualifiedName: preferredRoot?.qualified_name || prev.rootQualifiedName,
                            rootFilePath: preferredRoot?.file_path || prev.rootFilePath,
                            error: "",
                          };
                        })}
                        disabled={newDiagramDialog.submitting}
                        aria-pressed={newDiagramDialog.diagramType === option.value}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </label>
                <label className="simple-new-file-field">
                  <span className="muted">Root Element</span>
                  <div className="simple-new-diagram-root-row">
                    <input
                      value={newDiagramDialog.rootQualifiedName}
                      onChange={(event) => setNewDiagramDialog((prev) => (
                        prev ? { ...prev, rootQualifiedName: event.target.value, error: "" } : prev
                      ))}
                      placeholder="Qualified name"
                      aria-label="Root element qualified name"
                      disabled={newDiagramDialog.submitting}
                    />
                    <button
                      type="button"
                      className="ghost"
                      disabled={newDiagramDialog.submitting || !selectedSymbol}
                      onClick={() => {
                        const preferredRoot = resolvePreferredDiagramRoot(newDiagramDialog.diagramType, selectedSymbol, projectSymbols);
                        if (!preferredRoot) return;
                        setNewDiagramDialog((prev) => (
                          prev ? {
                            ...prev,
                            rootQualifiedName: preferredRoot.qualified_name,
                            rootFilePath: preferredRoot.file_path || "",
                            error: "",
                          } : prev
                        ));
                      }}
                    >
                      Use Selected
                    </button>
                  </div>
                </label>
                <div className="muted simple-new-file-meta">
                  <span>Root file</span>
                  <span title={newDiagramDialog.rootFilePath || "-"}>{newDiagramDialog.rootFilePath || "-"}</span>
                </div>
                {newDiagramDialog.error ? (
                  <div className="error">{newDiagramDialog.error}</div>
                ) : (
                  <div className="muted">
                    Creates a `.diagram` document that stores the diagram root, viewport, and saved node positions.
                  </div>
                )}
              </div>
              <div className="simple-modal-footer muted">
                File path: {`${newDiagramDialog.parentPath.replace(/[\\/]+$/, "")}\\${buildDiagramFileName(newDiagramDialog.fileName)}`}
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {newFileDialog ? (
        <div
          className="simple-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !newFileDialog.submitting) {
              setNewFileDialog(null);
            }
          }}
        >
          <section
            className="simple-modal simple-new-file-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Create new semantic file"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void createNewFileFromDialog();
              }}
            >
              <div className="simple-modal-header">
                <strong>New File</strong>
                <div className="simple-modal-header-actions">
                  <button
                    type="button"
                    className="ghost"
                    disabled={newFileDialog.submitting}
                    onClick={() => setNewFileDialog(null)}
                  >
                    Cancel
                  </button>
                  <button type="submit" disabled={newFileDialog.submitting}>
                    {newFileDialog.submitting ? "Creating..." : "Create"}
                  </button>
                </div>
              </div>
              <div className="simple-modal-body simple-new-file-body">
                <div className="simple-new-file-meta muted">
                  <span>Folder: {displayNameForPath(newFileDialog.parentPath)}</span>
                  <span title={newFileDialog.parentPath}>{newFileDialog.parentPath}</span>
                </div>
                <label className="simple-new-file-field">
                  <span className="muted">Name</span>
                  <div className="simple-new-file-input-row">
                    <input
                      ref={newFileNameInputRef}
                      value={newFileDialog.name}
                      onChange={(event) => setNewFileDialog((prev) => (
                        prev
                          ? { ...prev, name: event.target.value, error: "" }
                          : prev
                      ))}
                      placeholder="new-model"
                      aria-label="New file name"
                      disabled={newFileDialog.submitting}
                    />
                    <div className="simple-new-file-type-group" role="radiogroup" aria-label="New file type">
                      {([".sysml", ".kerml"] as const).map((extension) => (
                        <button
                          key={extension}
                          type="button"
                          className={`simple-new-file-type-btn ${newFileDialog.extension === extension ? "active" : ""}`}
                          onClick={() => setNewFileDialog((prev) => (
                            prev
                              ? { ...prev, extension, error: "" }
                              : prev
                          ))}
                          disabled={newFileDialog.submitting}
                          aria-pressed={newFileDialog.extension === extension}
                        >
                          {extension}
                        </button>
                      ))}
                    </div>
                  </div>
                </label>
                {newFileDialog.error ? (
                  <div className="error">{newFileDialog.error}</div>
                ) : (
                  <div className="muted">Creates an empty SysML or KerML source file and opens it in the editor.</div>
                )}
              </div>
              <div className="simple-modal-footer muted">
                File name: {newFileDialog.name.trim()
                  ? buildNewSemanticFileName(newFileDialog.name, newFileDialog.extension)
                  : `new-model${newFileDialog.extension}`}
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {aboutWindowOpen ? (
        <div
          className="simple-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setAboutWindowOpen(false);
            }
          }}
        >
          <section
            className="simple-modal simple-about-window"
            role="dialog"
            aria-modal="true"
            aria-label="About Mercurio SysML"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="simple-modal-header">
              <strong>About Mercurio SysML</strong>
              <div className="simple-modal-header-actions">
                <button type="button" className="ghost" onClick={() => setAboutWindowOpen(false)}>
                  Close
                </button>
              </div>
            </div>
            <div className="simple-modal-body simple-about-body">
              <div className="simple-about-title">Mercurio SysML</div>
              <div className="muted">Desktop UI for SysML/KerML authoring and semantic exploration.</div>
              <div className="simple-about-grid">
                <span className="muted">Project Root</span>
                <span title={rootPath || "No root selected"}>{rootPath || "-"}</span>
                <span className="muted">Metamodel Schema</span>
                <span>{metamodelSchemaVersion ?? "-"}</span>
                <span className="muted">Theme</span>
                <span>{appTheme}</span>
                <span className="muted">Build</span>
                <span>{compileStatus}</span>
              </div>
            </div>
            <div className="simple-modal-footer muted">
              Copyright (c) Mercurio
            </div>
          </section>
        </div>
      ) : null}

      <footer className="statusbar">
        <div className="status-left">
          <span>Root: {rootPath || "<none>"}</span>
        </div>
        <div className="status-right">
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
          <span>Unresolved: {unresolvedCount}</span>
          <span>UI updates: {progressUiUpdates}</span>
          <span>Dropped compiles: {droppedCompileRequests}</span>
        </div>
      </footer>
    </div>
  );
}



