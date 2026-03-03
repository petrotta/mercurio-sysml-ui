import "./style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import MonacoEditor, { loader, type OnMount } from "@monaco-editor/react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ROOT_STORAGE_KEY, THEME_KEY } from "./app/constants";
import { useProjectTree } from "./app/useProjectTree";
import { readFileText } from "./app/fileOps";
import { useCompileRunner } from "./app/useCompileRunner";
import { useSemanticSelection } from "./app/useSemanticSelection";
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
  durationMs: number;
  at: string;
};

const MAX_SYMBOL_ROWS = 1200;
const FILE_SYMBOL_RENDER_LIMIT = 300;
const SYSML_LANGUAGE_ID = "mercurio-sysml";
let sysmlLanguageRegistered = false;

function normalizePath(path: string | null | undefined): string {
  return (path || "").replace(/\//g, "\\").toLowerCase();
}

function symbolIdentity(symbol: SymbolView): string {
  return `${normalizePath(symbol.file_path)}|${symbol.qualified_name || symbol.name}|${symbol.start_line}|${symbol.start_col}`;
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

function fileExtension(path: string | null | undefined): string {
  const value = path || "";
  const idx = value.lastIndexOf(".");
  return idx >= 0 ? value.slice(idx).toLowerCase() : "";
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
  const [rootPath, setRootPath] = useState<string>(() => window.localStorage?.getItem(ROOT_STORAGE_KEY) || "");
  const [rootInput, setRootInput] = useState<string>(() => window.localStorage?.getItem(ROOT_STORAGE_KEY) || "");
  const [treeError, setTreeError] = useState("");
  const [appTheme, setAppTheme] = useState<"dark" | "light">(
    (window.localStorage?.getItem(THEME_KEY) as "dark" | "light") || "dark",
  );
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [cursorPos, setCursorPos] = useState<{ line: number; col: number } | null>(null);
  const [symbolQuery, setSymbolQuery] = useState("");
  const [showCurrentFileOnly, setShowCurrentFileOnly] = useState(true);
  const [selectedSymbol, setSelectedSymbol] = useState<SymbolView | null>(null);
  const [semanticSelectedQname, setSemanticSelectedQname] = useState("");
  const [harnessRuns, setHarnessRuns] = useState<HarnessRun[]>([]);
  const [harnessRunning, setHarnessRunning] = useState(false);
  const [expandedFileSymbols, setExpandedFileSymbols] = useState<Record<string, boolean>>({});
  const [expandedLibraryFiles, setExpandedLibraryFiles] = useState<Record<string, boolean>>({});

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
    cancelCompile,
    symbols,
    unresolved,
    parsedFiles,
    parseErrorPaths,
  } = useCompileRunner({ rootPath });

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
  const cursorFlushTimerRef = useRef<number | undefined>(undefined);
  const pendingCursorRef = useRef<{ line: number; col: number } | null>(null);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    window.localStorage?.setItem(THEME_KEY, appTheme);
    document.body.classList.toggle("theme-light", appTheme === "light");
    const monaco = monacoRef.current;
    if (monaco) {
      monaco.editor.setTheme(appTheme === "light" ? "vs" : "vs-dark");
    }
  }, [appTheme]);

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

  const openFilePath = useCallback(async (
    path: string,
    selection?: TextSelection,
    options?: { preserveSymbolSelection?: boolean },
  ) => {
    if (!path) return;
    if (dirtyRef.current && activeFilePath && normalizePath(activeFilePath) !== normalizePath(path)) {
      const proceed = window.confirm("Discard unsaved changes in the current file?");
      if (!proceed) return;
    }
    const reqId = ++fileOpenReqRef.current;
    try {
      const text = await readFileText(path);
      if (reqId !== fileOpenReqRef.current) return;
      setActiveFilePath(path);
      if (!options?.preserveSymbolSelection) {
        setSelectedSymbol(null);
        setSemanticSelectedQname("");
      }
      contentRef.current = text;
      dirtyRef.current = false;
      setDirty(false);
      if (editorRef.current) {
        suppressDirtyRef.current = true;
        editorRef.current.setValue(text);
        if (selection) {
          applySelection(selection);
        } else {
          editorRef.current.setPosition({ lineNumber: 1, column: 1 });
          editorRef.current.revealLine(1);
        }
      }
    } catch (error) {
      setCompileStatus(`Open failed: ${String(error)}`);
    }
  }, [activeFilePath, applySelection, setCompileStatus]);

  const openEntry = useCallback(async (entry: FileEntry) => {
    if (entry.is_dir) {
      await toggleExpand(entry);
      return;
    }
    await openFilePath(entry.path);
  }, [toggleExpand, openFilePath]);

  const saveActiveFile = useCallback(async (): Promise<boolean> => {
    if (!activeFilePath) return false;
    try {
      await invoke("write_file", { path: activeFilePath, content: contentRef.current });
      dirtyRef.current = false;
      setDirty(false);
      setCompileStatus(`Saved ${activeFilePath.split(/[\\/]/).pop() || activeFilePath}`);
      return true;
    } catch (error) {
      setCompileStatus(`Save failed: ${String(error)}`);
      return false;
    }
  }, [activeFilePath, setCompileStatus]);

  const addHarnessRun = useCallback((kind: "project" | "file", ok: boolean, durationMs: number) => {
    harnessRunIdRef.current += 1;
    const run: HarnessRun = {
      id: harnessRunIdRef.current,
      kind,
      ok,
      durationMs,
      at: new Date().toLocaleTimeString(),
    };
    setHarnessRuns((prev) => [run, ...prev].slice(0, 16));
  }, []);

  const compileProject = useCallback(async (): Promise<boolean> => {
    if (!rootPath) {
      setCompileStatus("Compile requires a project root");
      return false;
    }
    const start = typeof performance !== "undefined" ? performance.now() : Date.now();
    const ok = await runCompile();
    const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - start;
    addHarnessRun("project", ok, elapsed);
    return ok;
  }, [rootPath, runCompile, setCompileStatus, addHarnessRun]);

  const compileActiveFile = useCallback(async (): Promise<boolean> => {
    if (!rootPath) {
      setCompileStatus("Compile requires a project root");
      return false;
    }
    if (!activeFilePath || !isSemanticSource(activeFilePath)) {
      return compileProject();
    }
    const start = typeof performance !== "undefined" ? performance.now() : Date.now();
    const ok = await runCompile(activeFilePath);
    const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - start;
    addHarnessRun("file", ok, elapsed);
    return ok;
  }, [rootPath, activeFilePath, runCompile, compileProject, setCompileStatus, addHarnessRun]);

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
        void compileProject();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveActiveFile, compileProject]);

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

  const selectedSymbolId = useMemo(
    () => (selectedSymbol ? symbolIdentity(selectedSymbol) : ""),
    [selectedSymbol],
  );

  const activeFileSymbols = useMemo(() => {
    if (!activeFilePath) return [] as SymbolView[];
    return symbolsByFile.get(normalizePath(activeFilePath)) || [];
  }, [activeFilePath, symbolsByFile]);

  const filteredSymbols = useMemo(() => {
    const query = symbolQuery.trim().toLowerCase();
    const activeKey = normalizePath(activeFilePath);
    let source = projectSymbols;
    if (showCurrentFileOnly && activeKey) {
      source = source.filter((symbol) => normalizePath(symbol.file_path) === activeKey);
    }
    if (!query) return source.slice(0, MAX_SYMBOL_ROWS);
    return source
      .filter((symbol) => {
        return (
          symbol.name.toLowerCase().includes(query) ||
          symbol.kind.toLowerCase().includes(query) ||
          symbol.qualified_name.toLowerCase().includes(query) ||
          symbol.file_path.toLowerCase().includes(query)
        );
      })
      .slice(0, MAX_SYMBOL_ROWS);
  }, [projectSymbols, showCurrentFileOnly, activeFilePath, symbolQuery]);

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
      const shownSymbols = isSymbolOpen ? fileSymbols.slice(0, FILE_SYMBOL_RENDER_LIMIT) : [];

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
              {shownSymbols.map((symbol) => {
                const symbolId = symbolIdentity(symbol);
                const selected = selectedSymbolId === symbolId;
                return (
                  <button
                    key={symbolId}
                    type="button"
                    className={`ghost simple-tree-symbol-row ${selected ? "active" : ""}`}
                    style={{ paddingLeft: `${30 + depth * 14}px` }}
                    onClick={() => {
                      void selectSymbol(symbol);
                    }}
                    title={`${symbol.qualified_name}\n${symbol.file_path}`}
                  >
                    <span className="simple-tree-symbol-kind">{symbol.kind || "?"}</span>
                    <span className="simple-tree-symbol-name">{symbol.name || "<anonymous>"}</span>
                    <span className="simple-tree-symbol-line">L{symbol.start_line || 1}</span>
                  </button>
                );
              })}
              {fileSymbols.length > FILE_SYMBOL_RENDER_LIMIT ? (
                <div
                  className="simple-tree-symbol-more muted"
                  style={{ paddingLeft: `${30 + depth * 14}px` }}
                >
                  +{fileSymbols.length - FILE_SYMBOL_RENDER_LIMIT} more symbols
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
    selectedSymbolId,
    selectSymbol,
  ]);

  const renderLibraryTree = useCallback((): ReactNode => {
    return libraryFilePaths.map((libraryFilePath) => {
      const fileKey = normalizePath(libraryFilePath);
      const fileSymbols = librarySymbolsByFile.get(fileKey) || [];
      const isOpen = !!expandedLibraryFiles[fileKey];
      const shownSymbols = isOpen ? fileSymbols.slice(0, FILE_SYMBOL_RENDER_LIMIT) : [];
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
              {shownSymbols.map((symbol) => {
                const symbolId = symbolIdentity(symbol);
                const selected = selectedSymbolId === symbolId;
                return (
                  <button
                    key={symbolId}
                    type="button"
                    className={`ghost simple-tree-symbol-row ${selected ? "active" : ""}`}
                    style={{ paddingLeft: "30px" }}
                    onClick={() => {
                      void selectSymbol(symbol);
                    }}
                    title={`${symbol.qualified_name}\n${symbol.file_path}`}
                  >
                    <span className="simple-tree-symbol-kind">{symbol.kind || "?"}</span>
                    <span className="simple-tree-symbol-name">{symbol.name || "<anonymous>"}</span>
                    <span className="simple-tree-symbol-line">L{symbol.start_line || 1}</span>
                  </button>
                );
              })}
              {fileSymbols.length > FILE_SYMBOL_RENDER_LIMIT ? (
                <div className="simple-tree-symbol-more muted" style={{ paddingLeft: "30px" }}>
                  +{fileSymbols.length - FILE_SYMBOL_RENDER_LIMIT} more symbols
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
    selectedSymbolId,
    selectSymbol,
  ]);

  const harnessMaxDuration = useMemo(
    () => Math.max(1, ...harnessRuns.map((run) => run.durationMs)),
    [harnessRuns],
  );

  const activeFileName = activeFilePath?.split(/[\\/]/).pop() || "No file selected";
  const rootDisplayName = rootPath ? (rootPath.split(/[\\/]/).pop() || rootPath) : "No project";

  const minimizeWindow = useCallback(() => {
    void getCurrentWindow().minimize().catch(() => {});
  }, []);

  const toggleMaximizeWindow = useCallback(() => {
    void getCurrentWindow().toggleMaximize().catch(() => {});
  }, []);

  const closeWindow = useCallback(() => {
    void getCurrentWindow().close().catch(() => {});
  }, []);

  return (
    <div className="app-shell simple-ui-shell">
      <header className="native-titlebar">
        <div className="native-titlebar-left" data-tauri-drag-region>
          <span className="app-mark">
            <img src="/app-icon.png" alt="Mercurio" className="app-mark-image" />
          </span>
          <span className="native-titlebar-name">Mercurio SysML</span>
          <span className="native-titlebar-root muted">{rootDisplayName}</span>
        </div>
        <div className="native-titlebar-center" data-tauri-drag-region>{activeFileName}</div>
        <div className="native-titlebar-right">
          <button type="button" className="ghost native-window-btn" onClick={minimizeWindow} title="Minimize" aria-label="Minimize window">-</button>
          <button type="button" className="ghost native-window-btn" onClick={toggleMaximizeWindow} title="Maximize" aria-label="Maximize or restore window">[]</button>
          <button type="button" className="ghost native-window-btn close" onClick={closeWindow} title="Close" aria-label="Close window">X</button>
        </div>
      </header>
      <header className="titlebar simple-ui-titlebar">
        <div className="simple-ui-root-picker">
          <button type="button" className="ghost" onClick={() => void (async () => {
            const selected = await open({ directory: true, multiple: false });
            if (typeof selected !== "string") return;
            setRootInput(selected);
            setRootPath(selected);
            window.localStorage?.setItem(ROOT_STORAGE_KEY, selected);
          })()}>
            Open Root
          </button>
          <input
            value={rootInput}
            onChange={(event) => setRootInput(event.target.value)}
            placeholder="Project root path"
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              const next = rootInput.trim();
              setRootPath(next);
              if (next) {
                window.localStorage?.setItem(ROOT_STORAGE_KEY, next);
              }
            }}
          />
          <button
            type="button"
            className="ghost"
            onClick={() => {
              const next = rootInput.trim();
              setRootPath(next);
              if (next) {
                window.localStorage?.setItem(ROOT_STORAGE_KEY, next);
              }
            }}
          >
            Apply
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!rootPath}
            onClick={() => {
              if (!rootPath) return;
              void refreshRoot(rootPath).catch((error) => {
                setTreeError(`Failed to refresh project tree: ${String(error)}`);
              });
            }}
          >
            Refresh Tree
          </button>
        </div>
        <div className="simple-ui-status">{compileStatus}</div>
        <div className="simple-ui-actions">
          <button
            type="button"
            className={`ghost ${appTheme === "light" ? "active" : ""}`}
            onClick={() => setAppTheme((prev) => (prev === "light" ? "dark" : "light"))}
          >
            Theme: {appTheme}
          </button>
          <button type="button" className="ghost" onClick={() => void saveActiveFile()} disabled={!activeFilePath || !dirty}>
            Save
          </button>
          <button type="button" className="ghost" onClick={() => void compileActiveFile()} disabled={!rootPath || !!compileRunId}>
            Compile File
          </button>
          <button type="button" onClick={() => void compileProject()} disabled={!rootPath || !!compileRunId}>
            Compile Project
          </button>
          {compileRunId ? (
            <button type="button" className="ghost" onClick={() => void cancelCompile()}>
              Cancel
            </button>
          ) : null}
        </div>
      </header>

      <main className="simple-ui-main">
        <aside className="panel simple-ui-left">
          <div className="panel-header">
            <strong>Project Files</strong>
            {treeError ? <span className="error">{treeError}</span> : null}
          </div>
          <div className="simple-ui-scroll">
            {rootPath ? (
              <>
                <div className="simple-tree-section">
                  {treeEntries.length ? renderTree(treeEntries) : <div className="muted">No files in root.</div>}
                </div>
                <div className="simple-tree-section">
                  <div className="simple-tree-subheader">
                    <strong>Library Files</strong>
                    <span className="simple-tree-count">{libraryFilePaths.length}</span>
                  </div>
                  {libraryFilePaths.length ? (
                    renderLibraryTree()
                  ) : (
                    <div className="muted">No library files indexed.</div>
                  )}
                </div>
              </>
            ) : (
              <div className="muted">Select a project root to begin.</div>
            )}
          </div>
        </aside>

        <section className="panel editor simple-ui-center">
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
            <div className="panel-header">
              <strong>Graphical Test Harness</strong>
              <div className="simple-harness-actions">
                <button type="button" className="ghost" disabled={!rootPath || harnessRunning} onClick={() => void runHarness(1)}>
                  Run 1x
                </button>
                <button type="button" className="ghost" disabled={!rootPath || harnessRunning} onClick={() => void runHarness(5)}>
                  Run 5x
                </button>
                {harnessRunning ? <span className="muted">running...</span> : null}
              </div>
            </div>
            <div className="simple-harness-runs">
              {harnessRuns.length ? (
                harnessRuns.map((run) => {
                  const width = `${Math.max(6, Math.round((run.durationMs / harnessMaxDuration) * 100))}%`;
                  return (
                    <div key={run.id} className="simple-harness-row">
                      <span>{run.at}</span>
                      <span>{run.kind}</span>
                      <span className={run.ok ? "ok" : "error"}>{run.ok ? "ok" : "fail"}</span>
                      <span>{Math.round(run.durationMs)} ms</span>
                      <div className="simple-harness-bar">
                        <div className={`simple-harness-bar-fill ${run.ok ? "ok" : "error"}`} style={{ width }} />
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="muted">No runs yet.</div>
              )}
            </div>
          </div>
        </section>

        <aside className="panel simple-ui-right">
          <div className="panel-header simple-symbols-header">
            <strong>Semantic Symbols</strong>
            <label className="inline-checkbox">
              <input
                type="checkbox"
                checked={showCurrentFileOnly}
                onChange={(event) => setShowCurrentFileOnly(event.target.checked)}
              />
              <span>current file</span>
            </label>
          </div>
          <div className="simple-symbols-controls">
            <input
              value={symbolQuery}
              onChange={(event) => setSymbolQuery(event.target.value)}
              placeholder="Filter name, kind, qname"
            />
            <div className="muted">{filteredSymbols.length} shown of {projectSymbols.length} project symbols</div>
          </div>
          <div className="simple-ui-scroll simple-symbol-list">
            {filteredSymbols.map((symbol) => {
              const selected =
                !!selectedSymbol
                && normalizePath(selectedSymbol.file_path) === normalizePath(symbol.file_path)
                && (selectedSymbol.qualified_name || selectedSymbol.name) === (symbol.qualified_name || symbol.name);
              return (
                <button
                  key={`${symbol.file_path}|${symbol.qualified_name}|${symbol.start_line}|${symbol.start_col}`}
                  type="button"
                  className={`simple-symbol-row ${selected ? "active" : ""}`}
                  onClick={() => {
                    void selectSymbol(symbol);
                  }}
                  title={`${symbol.qualified_name}\n${symbol.file_path}`}
                >
                  <span className="simple-symbol-kind">{symbol.kind || "?"}</span>
                  <span className="simple-symbol-name">{symbol.name || "<anonymous>"}</span>
                  <span className="simple-symbol-qname">{symbol.qualified_name || "-"}</span>
                </button>
              );
            })}
            {!filteredSymbols.length ? <div className="muted">No symbols match the current filter.</div> : null}
          </div>

          <div className="panel-header"><strong>Properties</strong></div>
          <div className="simple-ui-scroll simple-properties-host">
            <CombinedPropertiesPane
              selectedSymbols={selectedSymbol ? [selectedSymbol] : null}
              selectedSemanticRow={selectedSemanticRow}
              selectedSemanticLoading={selectedSemanticLoading}
              selectedSemanticError={selectedSemanticError}
              onSelectQualifiedName={selectQualifiedName}
              expressionRecords={[]}
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

      <footer className="statusbar">
        <div className="status-left">
          <span>Root: {rootPath || "<none>"}</span>
        </div>
        <div className="status-right">
          {cursorPos && activeFilePath ? <span>Ln {cursorPos.line}, Col {cursorPos.col}</span> : null}
          <span>Project symbols: {projectSymbols.length}</span>
          <span>Unresolved: {unresolved.length}</span>
        </div>
      </footer>
    </div>
  );
}
