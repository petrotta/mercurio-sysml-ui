import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SymbolView, UnresolvedIssue } from "./types";

const LIBRARY_BULK_CONCURRENCY = 4;
const LIBRARY_INDEX_PAGE_SIZE = 2000;
const BACKGROUND_COMPILE_TIMEOUT_MS = 30000;

export type CompileToast = {
  open: boolean;
  ok: boolean | null;
  lines: string[];
  parseErrors: Array<{ path: string; errors: string[] }>;
  details: string[];
  parsedFiles: string[];
};

type CompileResponse = {
  ok: boolean;
  files?: Array<{ path: string; ok: boolean; errors: string[]; symbol_count: number }>;
  project_symbol_count?: number;
  library_symbol_count?: number;
  parsed_files?: string[];
  parse_duration_ms?: number;
  analysis_duration_ms?: number;
  stdlib_duration_ms?: number;
  stdlib_file_count?: number;
  total_duration_ms?: number;
  stdlib_cache_hit?: boolean;
  symbols: SymbolView[];
  unresolved: UnresolvedIssue[];
  library_path?: string | null;
};

type LibrarySymbolsResponse = {
  ok: boolean;
  symbols: SymbolView[];
  library_files?: string[];
  library_path?: string | null;
  stdlib_cache_hit?: boolean;
  stdlib_duration_ms?: number;
  stdlib_file_count?: number;
  total_duration_ms?: number;
};

type IndexedSymbolView = {
  file_path: string;
  name: string;
  qualified_name: string;
  kind: string;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
  doc_text?: string | null;
};

type LibraryIndexSummary = {
  file_count: number;
  symbol_count: number;
  kind_counts: Array<[string, number]>;
};

type UseCompileRunnerOptions = {
  rootPath: string;
};

type ActiveFileSymbolMode = "fast" | "semantic";

type SemanticElementView = {
  name: string;
  qualified_name: string;
  metatype_qname?: string | null;
  file_path: string;
  attributes?: Record<string, string>;
};

function semanticAttr(
  attributes: Record<string, string> | undefined,
  ...keys: string[]
): string | undefined {
  if (!attributes) return undefined;
  const normalize = (value: string) => value.replace(/:+/g, "::").toLowerCase();
  const wanted = new Set(keys.map((key) => normalize(key)));
  for (const [rawKey, rawValue] of Object.entries(attributes)) {
    if (!wanted.has(normalize(rawKey))) continue;
    const text = String(rawValue ?? "").trim();
    if (text.length) return text;
  }
  for (const key of keys) {
    const value = attributes[key];
    if (value != null && String(value).trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function semanticAttrBySuffix(
  attributes: Record<string, string> | undefined,
  ...suffixes: string[]
): string | undefined {
  if (!attributes) return undefined;
  for (const [key, value] of Object.entries(attributes)) {
    for (const suffix of suffixes) {
      if (key === suffix || key.endsWith(`::${suffix}`)) {
        const text = String(value || "").trim();
        if (text.length) return text;
      }
    }
  }
  return undefined;
}

function mergeSymbols(project: SymbolView[], library: SymbolView[]): SymbolView[] {
  const out: SymbolView[] = [];
  const seen = new Set<string>();
  for (const symbol of [...project, ...library]) {
    const key = `${symbol.file_path}|${symbol.qualified_name}|${symbol.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(symbol);
  }
  return out;
}

function mergeProjectSymbolsByFile(
  previous: SymbolView[],
  incoming: SymbolView[],
  scopedFilePath?: string,
): SymbolView[] {
  if (!incoming.length) {
    return previous;
  }
  if (!scopedFilePath) return incoming;
  const kept = previous.filter((symbol) => symbol.file_path !== scopedFilePath);
  return mergeSymbols(kept, incoming);
}

function mapIndexedToSymbolView(
  input: IndexedSymbolView,
  sourceScope: "project" | "library",
): SymbolView {
  return {
    file_path: input.file_path,
    name: input.name,
    kind: input.kind,
    source_scope: sourceScope,
    qualified_name: input.qualified_name,
    file: 0,
    start_line: input.start_line || 0,
    start_col: input.start_col || 0,
    end_line: input.end_line || 0,
    end_col: input.end_col || 0,
    doc: input.doc_text ?? null,
    properties: [],
  };
}

function semanticSymbolKey(symbol: Pick<SymbolView, "file_path" | "qualified_name" | "name" | "kind">): string {
  return `${normalizePathKey(symbol.file_path)}|${symbol.qualified_name}|${symbol.name}|${symbol.kind}`;
}

function mapSemanticToSymbolView(
  input: SemanticElementView,
  sourceScope: "project" | "library",
  spanSeed?: Map<string, SymbolView>,
): SymbolView {
  const attributes = input.attributes || {};
  const qualifiedName =
    semanticAttr(attributes, "emf::qualifiedName", "Element::qualifiedName") || input.qualified_name;
  const name =
    semanticAttr(attributes, "emf::name", "NamedElement::name") ||
    input.name ||
    qualifiedName.split("::").pop() ||
    "Unnamed";
  const metatypeQname = semanticAttr(attributes, "emf::metatype", "Element::metatype") || input.metatype_qname || null;
  const multiplicityText =
    semanticAttr(attributes, "emf::multiplicityText", "multiplicityText", "multiplicity") ||
    semanticAttrBySuffix(attributes, "multiplicityText", "multiplicity");
  const kind =
    semanticAttr(attributes, "emf::kind", "Element::kind", "kind") ||
    metatypeQname?.split("::").pop() ||
    "Unknown";
  const seedKey = semanticSymbolKey({
    file_path: input.file_path,
    qualified_name: qualifiedName,
    name,
    kind,
  });
  const seed = spanSeed?.get(seedKey);
  const ownerQname = semanticAttr(attributes, "emf::owner", "Element::owner");
  return {
    file_path: input.file_path,
    name,
    kind,
    source_scope: sourceScope,
    qualified_name: qualifiedName,
    file: seed?.file ?? 0,
    start_line: seed?.start_line ?? 0,
    start_col: seed?.start_col ?? 0,
    end_line: seed?.end_line ?? 0,
    end_col: seed?.end_col ?? 0,
    doc: seed?.doc ?? null,
    properties: [
      ...Object.entries(attributes).map(([key, value]) => ({
        name: key,
        label: key,
        value: { type: "text" as const, value: String(value) },
      })),
      ...(metatypeQname
        ? [
            {
              name: "metatype_qname",
              label: "metatype_qname",
              value: { type: "text" as const, value: metatypeQname },
            },
          ]
        : []),
      ...(multiplicityText
        ? [
            {
              name: "multiplicity",
              label: "multiplicity",
              value: { type: "text" as const, value: multiplicityText },
            },
          ]
        : []),
    ],
    relationships: ownerQname
      ? [
          {
            kind: "owningNamespace",
            target: ownerQname,
            resolved_target: ownerQname,
            start_line: seed?.start_line ?? 0,
            start_col: seed?.start_col ?? 0,
            end_line: seed?.end_line ?? 0,
            end_col: seed?.end_col ?? 0,
          },
        ]
      : seed?.relationships || [],
  };
}

function withScope(
  symbols: SymbolView[] | undefined,
  sourceScope: "project" | "library",
): SymbolView[] {
  return (symbols || []).map((symbol) => ({ ...symbol, source_scope: sourceScope }));
}

function categorizeParseError(message: string): string {
  const text = (message || "").toLowerCase();
  if (text.includes("expected")) return "expected-token";
  if (text.includes("unexpected")) return "unexpected-token";
  if (text.includes("unterminated")) return "unterminated";
  if (text.includes("invalid")) return "invalid-syntax";
  return "other";
}

function normalizePathKey(path: string): string {
  return (path || "").replace(/\//g, "\\").toLowerCase();
}

export function useCompileRunner({ rootPath }: UseCompileRunnerOptions) {
  const [compileStatus, setCompileStatus] = useState("Background compile: idle");
  const [compileRunId, setCompileRunId] = useState<number | null>(null);
  const [compileToast, setCompileToast] = useState<CompileToast>({
    open: false,
    ok: null,
    lines: [],
    parseErrors: [],
    details: [],
    parsedFiles: [],
  });
  const compileToastTimerRef = useRef<number | undefined>(undefined);
  const libraryLoadTokenRef = useRef(0);
  const backgroundCompileRef = useRef<number | null>(null);
  const backgroundCompileTokenRef = useRef(0);
  const [backgroundCompileActive, setBackgroundCompileActive] = useState(false);
  const loadedLibraryFilesRef = useRef<Set<string>>(new Set());
  const [backgroundCompileEnabled, setBackgroundCompileEnabled] = useState(true);
  const [projectFastSymbols, setProjectFastSymbols] = useState<SymbolView[]>([]);
  const [projectSemanticSymbols, setProjectSemanticSymbols] = useState<SymbolView[]>([]);
  const [activeFileSymbolMode, setActiveFileSymbolMode] = useState<ActiveFileSymbolMode>("semantic");
  const projectFastSymbolsRef = useRef<SymbolView[]>([]);
  const [librarySymbols, setLibrarySymbols] = useState<SymbolView[]>([]);
  const [libraryFiles, setLibraryFiles] = useState<string[]>([]);
  const [libraryLoadingFiles, setLibraryLoadingFiles] = useState<string[]>([]);
  const [libraryLoadErrors, setLibraryLoadErrors] = useState<Record<string, string>>({});
  const [libraryBulkLoading, setLibraryBulkLoading] = useState(false);
  const [loadedLibraryFileCount, setLoadedLibraryFileCount] = useState(0);
  const [libraryBulkTotal, setLibraryBulkTotal] = useState(0);
  const [libraryBulkCompleted, setLibraryBulkCompleted] = useState(0);
  const [libraryBulkFailed, setLibraryBulkFailed] = useState(0);
  const [libraryImportCount, setLibraryImportCount] = useState(0);
  const [libraryKindCounts, setLibraryKindCounts] = useState<Array<[string, number]>>([]);
  const [libraryIndexedSymbolCount, setLibraryIndexedSymbolCount] = useState(0);
  const [symbols, setSymbols] = useState<SymbolView[]>([]);
  const [unresolved, setUnresolved] = useState<UnresolvedIssue[]>([]);
  const [libraryPath, setLibraryPath] = useState<string | null>(null);
  const [projectSymbolsLoaded, setProjectSymbolsLoaded] = useState(false);
  const [stdlibFileCount, setStdlibFileCount] = useState(0);
  const [parsedFiles, setParsedFiles] = useState<string[]>([]);
  const [parseErrorPaths, setParseErrorPaths] = useState<Set<string>>(new Set());
  const backgroundCompileTimeoutRef = useRef<number | null>(null);
  const libraryBootstrapRef = useRef<string | null>(null);

  const clearBackgroundCompileTimeout = useCallback(() => {
    if (backgroundCompileTimeoutRef.current != null) {
      window.clearTimeout(backgroundCompileTimeoutRef.current);
      backgroundCompileTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
      projectFastSymbolsRef.current = [];
      setProjectSymbolsLoaded(false);
      setStdlibFileCount(0);
      setProjectFastSymbols([]);
      setProjectSemanticSymbols([]);
      setLibrarySymbols([]);
      setLibraryFiles([]);
      setLibraryLoadingFiles([]);
      setLibraryLoadErrors({});
      setLibraryBulkLoading(false);
      setLoadedLibraryFileCount(0);
      setLibraryBulkTotal(0);
      setLibraryBulkCompleted(0);
      setLibraryBulkFailed(0);
      setLibraryImportCount(0);
      setLibraryKindCounts([]);
      setLibraryIndexedSymbolCount(0);
      setSymbols([]);
      loadedLibraryFilesRef.current = new Set();
      libraryLoadTokenRef.current += 1;
      backgroundCompileRef.current = null;
      clearBackgroundCompileTimeout();
      setBackgroundCompileActive(false);
      setActiveFileSymbolMode("semantic");
      libraryBootstrapRef.current = null;
  }, [rootPath, clearBackgroundCompileTimeout]);

  useEffect(() => {
    projectFastSymbolsRef.current = projectFastSymbols;
  }, [projectFastSymbols]);

  const composeProjectSymbols = useCallback((semantic: SymbolView[]) => semantic, []);

  useEffect(() => {
    const visibleProject = composeProjectSymbols(projectSemanticSymbols);
    setSymbols(mergeSymbols(visibleProject, librarySymbols));
  }, [
    projectSemanticSymbols,
    librarySymbols,
    composeProjectSymbols,
  ]);

  useEffect(() => {
    setLibraryImportCount(librarySymbols.filter((symbol) => symbol.kind === "Import").length);
  }, [librarySymbols]);

  useEffect(() => {
    const unlistenPromise = listen<{
      run_id: number;
      stage: string;
      file?: string;
      index?: number;
      total?: number;
    }>("compile-progress", (event) => {
      const payload = event.payload;
      if (!payload) return;
      const stage = payload.stage || "running";
      if (payload.run_id && compileRunId && payload.run_id !== compileRunId) {
        return;
      }
      const detail = payload.file ? `${stage}: ${payload.file}` : stage;
      const prefix = compileRunId ? "Compile" : "Background compile";
      setCompileStatus(`${prefix}: ${detail}`);
      if (compileRunId && payload.run_id === compileRunId) {
        setCompileToast((prev) => ({ ...prev, open: true, lines: [...prev.lines, detail].slice(-8) }));
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [compileRunId]);

  const refreshLibrarySummary = useCallback(async (path: string) => {
    if (!path) return;
    try {
      const summary = await invoke<LibraryIndexSummary>("query_index_library_summary", {
        payload: { root: path },
      });
      setLibraryIndexedSymbolCount(summary?.symbol_count || 0);
      setLibraryKindCounts(summary?.kind_counts || []);
    } catch {
    }
  }, []);

  const loadProjectSymbolsFromIndex = useCallback(async (path: string) => {
    if (!path) return;
    try {
      const indexed = await invoke<IndexedSymbolView[]>("query_index_project_symbols", {
        payload: { root: path },
      });
      const mapped = (indexed || []).map((symbol) => mapIndexedToSymbolView(symbol, "project"));
      setProjectFastSymbols(mapped);
      setProjectSymbolsLoaded(true);
    } catch {
    }
  }, []);

  const refreshSemanticProjectSymbols = useCallback(async (path: string) => {
    if (!path) return;
    try {
      const semantic = await invoke<SemanticElementView[]>("query_semantic", {
        root: path,
        query: {
          metatype: null,
          metatype_is_a: null,
          predicates: [],
        },
      });
      const spanSeed = new Map<string, SymbolView>();
      for (const symbol of projectFastSymbolsRef.current) {
        spanSeed.set(semanticSymbolKey(symbol), symbol);
      }
      const mapped = (semantic || []).map((item) => mapSemanticToSymbolView(item, "project", spanSeed));
      setProjectSemanticSymbols(mapped);
      setProjectSymbolsLoaded(true);
    } catch {
    }
  }, []);

  const loadLibrarySymbols = useCallback(async (path: string, filePath?: string, includeSymbols: boolean = true): Promise<boolean> => {
    if (!path) return false;
    try {
      const response = await invoke<LibrarySymbolsResponse>("load_library_symbols", {
        payload: {
          root: path,
          file: filePath,
          include_symbols: includeSymbols,
        },
      });
      if (Array.isArray(response?.library_files)) {
        setLibraryFiles(response.library_files);
      }
      if (includeSymbols) {
        const incoming = withScope(response?.symbols, "library");
        if (filePath) {
          setLibrarySymbols((prev) => mergeSymbols(prev, incoming));
          loadedLibraryFilesRef.current.add(filePath);
          setLoadedLibraryFileCount(loadedLibraryFilesRef.current.size);
          setLibraryLoadErrors((prev) => {
            if (!(filePath in prev)) return prev;
            const next = { ...prev };
            delete next[filePath];
            return next;
          });
        } else {
          setLibrarySymbols(incoming);
          if (Array.isArray(response?.library_files)) {
            loadedLibraryFilesRef.current = new Set(response.library_files);
            setLoadedLibraryFileCount(loadedLibraryFilesRef.current.size);
          }
          setLibraryLoadErrors({});
        }
      }
      setLibraryPath(response?.library_path ?? null);
      setStdlibFileCount(response?.stdlib_file_count || 0);
      await refreshLibrarySummary(path);
      return true;
    } catch (error) {
      if (filePath) {
        setLibraryLoadErrors((prev) => ({ ...prev, [filePath]: String(error) }));
      }
      setCompileStatus(`Library symbols load failed: ${String(error)}`);
      return false;
    }
  }, [refreshLibrarySummary]);

  const loadLibrarySymbolsForFile = useCallback(async (filePath: string): Promise<boolean> => {
    if (!rootPath || !filePath) return false;
    if (loadedLibraryFilesRef.current.has(filePath)) return true;
    setLibraryLoadingFiles((prev) => (prev.includes(filePath) ? prev : [...prev, filePath]));
    try {
      try {
        const indexed = await invoke<IndexedSymbolView[]>("query_index_library_symbols", {
          payload: { root: rootPath, file: filePath },
        });
        const mapped = (indexed || []).map((symbol) => mapIndexedToSymbolView(symbol, "library"));
        setLibrarySymbols((prev) => mergeSymbols(prev, mapped));
        loadedLibraryFilesRef.current.add(filePath);
        setLoadedLibraryFileCount(loadedLibraryFilesRef.current.size);
        setLibraryLoadErrors((prev) => {
          if (!(filePath in prev)) return prev;
          const next = { ...prev };
          delete next[filePath];
          return next;
        });
        await refreshLibrarySummary(rootPath);
        return true;
      } catch {
        const ok = await loadLibrarySymbols(rootPath, filePath, true);
        return ok && loadedLibraryFilesRef.current.has(filePath);
      }
    } finally {
      setLibraryLoadingFiles((prev) => prev.filter((item) => item !== filePath));
    }
  }, [rootPath, loadLibrarySymbols, refreshLibrarySummary]);

  const loadAllLibrarySymbols = useCallback(async () => {
    if (!rootPath || !libraryFiles.length) return;
    libraryLoadTokenRef.current += 1;
    const token = libraryLoadTokenRef.current;
    setLibraryBulkLoading(true);
    setLibraryBulkFailed(0);
    setCompileStatus("Library symbols: loading all files...");
    try {
      const pending = libraryFiles.filter((path) => !loadedLibraryFilesRef.current.has(path));
      setLibraryBulkTotal(pending.length);
      setLibraryBulkCompleted(0);
      if (!pending.length) {
        setCompileStatus("Library symbols: all files already loaded");
        return;
      }
      // Fast path: query all stdlib symbols from persistent index.
      try {
        const mapped: SymbolView[] = [];
        let offset = 0;
        while (token === libraryLoadTokenRef.current) {
          const indexed = await invoke<IndexedSymbolView[]>("query_index_library_symbols", {
            payload: {
              root: rootPath,
              offset,
              limit: LIBRARY_INDEX_PAGE_SIZE,
            },
          });
          const page = (indexed || []).map((symbol) => mapIndexedToSymbolView(symbol, "library"));
          if (!page.length) break;
          mapped.push(...page);
          if (page.length < LIBRARY_INDEX_PAGE_SIZE) break;
          offset += page.length;
        }
        if (token === libraryLoadTokenRef.current) {
          setLibrarySymbols(mapped);
          loadedLibraryFilesRef.current = new Set(libraryFiles);
          setLoadedLibraryFileCount(libraryFiles.length);
          setLibraryLoadErrors({});
          setLibraryBulkCompleted(pending.length);
          setLibraryBulkFailed(0);
          setCompileStatus("Library symbols: all files loaded");
          return;
        }
      } catch {
      }
      // Fallback: one round-trip for entire stdlib symbol set.
      const fullLoadOk = await loadLibrarySymbols(rootPath, undefined, true);
      if (fullLoadOk && token === libraryLoadTokenRef.current) {
        setLibraryBulkCompleted(pending.length);
        setLibraryBulkFailed(0);
        setCompileStatus("Library symbols: all files loaded");
        return;
      }
      let cursor = 0;
      const worker = async () => {
        while (token === libraryLoadTokenRef.current) {
          if (cursor >= pending.length) return;
          const filePath = pending[cursor];
          cursor += 1;
          const ok = await loadLibrarySymbolsForFile(filePath);
          if (token !== libraryLoadTokenRef.current) return;
          setLibraryBulkCompleted((prev) => prev + 1);
          if (!ok) {
            setLibraryBulkFailed((prev) => prev + 1);
          }
        }
      };
      const workers = Array.from(
        { length: Math.min(LIBRARY_BULK_CONCURRENCY, pending.length) },
        () => worker(),
      );
      await Promise.all(workers);
      if (token === libraryLoadTokenRef.current) {
        const failed = pending.filter((path) => !loadedLibraryFilesRef.current.has(path)).length;
        setCompileStatus(
          failed
            ? `Library symbols: completed with ${failed} file load failures`
            : "Library symbols: all files loaded",
        );
      }
      await refreshLibrarySummary(rootPath);
    } finally {
      if (token === libraryLoadTokenRef.current) {
        setLibraryBulkLoading(false);
      }
    }
  }, [rootPath, libraryFiles, loadLibrarySymbolsForFile, loadLibrarySymbols, refreshLibrarySummary]);

  const retryFailedLibraryLoads = useCallback(async () => {
    if (!rootPath) return;
    const failed = Object.keys(libraryLoadErrors);
    if (!failed.length) return;
    libraryLoadTokenRef.current += 1;
    const token = libraryLoadTokenRef.current;
    setLibraryBulkLoading(true);
    setLibraryBulkFailed(0);
    setLibraryBulkTotal(failed.length);
    setLibraryBulkCompleted(0);
    setCompileStatus(`Library symbols: retrying ${failed.length} failed file loads...`);
    try {
      let cursor = 0;
      const worker = async () => {
        while (token === libraryLoadTokenRef.current) {
          if (cursor >= failed.length) return;
          const filePath = failed[cursor];
          cursor += 1;
          const ok = await loadLibrarySymbolsForFile(filePath);
          if (token !== libraryLoadTokenRef.current) return;
          setLibraryBulkCompleted((prev) => prev + 1);
          if (!ok) {
            setLibraryBulkFailed((prev) => prev + 1);
          }
        }
      };
      const workers = Array.from(
        { length: Math.min(LIBRARY_BULK_CONCURRENCY, failed.length) },
        () => worker(),
      );
      await Promise.all(workers);
      if (token === libraryLoadTokenRef.current) {
        const remaining = failed.filter((path) => !loadedLibraryFilesRef.current.has(path)).length;
        setCompileStatus(
          remaining
            ? `Library symbols: retry completed with ${remaining} remaining failures`
            : "Library symbols: retry completed successfully",
        );
      }
      await refreshLibrarySummary(rootPath);
    } finally {
      if (token === libraryLoadTokenRef.current) {
        setLibraryBulkLoading(false);
      }
    }
  }, [rootPath, libraryLoadErrors, loadLibrarySymbolsForFile, refreshLibrarySummary]);

  const cancelLibrarySymbolLoading = useCallback(() => {
    libraryLoadTokenRef.current += 1;
    setLibraryBulkLoading(false);
    setLibraryLoadingFiles([]);
    setCompileStatus("Library symbols: loading canceled");
  }, []);

  useEffect(() => {
    if (!rootPath) return;
    void loadProjectSymbolsFromIndex(rootPath);
    void refreshSemanticProjectSymbols(rootPath);
    void loadLibrarySymbols(rootPath, undefined, false);
  }, [rootPath, loadLibrarySymbols, loadProjectSymbolsFromIndex, refreshSemanticProjectSymbols]);

  useEffect(() => {
    if (!rootPath) return;
    if (!libraryFiles.length) return;
    if (libraryIndexedSymbolCount > 0) return;
    if (libraryBulkLoading) return;
    if (libraryBootstrapRef.current === rootPath) return;
    libraryBootstrapRef.current = rootPath;
    void loadLibrarySymbols(rootPath, undefined, true);
  }, [
    rootPath,
    libraryFiles.length,
    libraryIndexedSymbolCount,
    libraryBulkLoading,
    loadLibrarySymbols,
  ]);

  const runCompile = useCallback(async (filePath?: string): Promise<boolean> => {
    if (!rootPath) return false;
    if (backgroundCompileRef.current) {
      void invoke("cancel_compile", { run_id: backgroundCompileRef.current }).catch(() => {});
      backgroundCompileRef.current = null;
      clearBackgroundCompileTimeout();
      setBackgroundCompileActive(false);
    }
    const runId = Date.now();
    setCompileRunId(runId);
    setCompileToast({ open: true, ok: null, lines: ["starting..."], parseErrors: [], details: [], parsedFiles: [] });
    setCompileStatus("Compile: starting...");
    try {
      const response = await invoke<CompileResponse>("compile_project_delta", {
        payload: {
          root: rootPath,
          run_id: runId,
          allow_parse_errors: true,
          file: filePath,
          unsaved: [],
        },
      });
      const incomingProject = withScope(response?.symbols, "project");
      setProjectFastSymbols((prev) => (incomingProject.length ? incomingProject : prev));
      setUnresolved(response?.unresolved || []);
      setProjectSymbolsLoaded(true);
      setParsedFiles(response?.parsed_files || []);
      const ok = !!response?.ok;
      const parseErrors = (response?.files || [])
        .filter((file) => !file.ok && file.errors && file.errors.length)
        .map((file) => ({ path: file.path, errors: file.errors }));
      setParseErrorPaths(new Set(parseErrors.map((file) => normalizePathKey(file.path))));
      const details: string[] = [];
      if (typeof response?.stdlib_cache_hit === "boolean") {
        details.push(`Stdlib: ${response.stdlib_cache_hit ? "cache hit" : "reloaded"}`);
      }
      if (typeof response?.stdlib_duration_ms === "number") {
        details.push(`Stdlib load: ${response.stdlib_duration_ms} ms`);
      }
      if (typeof response?.parse_duration_ms === "number") {
        details.push(`Parse: ${response.parse_duration_ms} ms`);
      }
      if (typeof response?.analysis_duration_ms === "number") {
        details.push(`Analysis: ${response.analysis_duration_ms} ms`);
      }
      if (typeof response?.total_duration_ms === "number") {
        details.push(`Total: ${response.total_duration_ms} ms`);
        if (response.total_duration_ms > 2000) {
          details.push("Warning: compile exceeded 2000 ms performance budget");
        }
      }
      if (typeof response?.parse_duration_ms === "number" && response.parse_duration_ms > 750) {
        details.push("Warning: parse stage exceeded 750 ms");
      }
      if (typeof response?.analysis_duration_ms === "number" && response.analysis_duration_ms > 750) {
        details.push("Warning: analysis stage exceeded 750 ms");
      }
      if (typeof response?.stdlib_duration_ms === "number" && response.stdlib_duration_ms > 500) {
        details.push("Warning: stdlib load exceeded 500 ms");
      }
      const parsedFiles = response?.parsed_files || [];
      if (parsedFiles.length) {
        details.push(`Files parsed: ${parsedFiles.length}`);
      }
      if (parseErrors.length) {
        const categories = new Map<string, number>();
        parseErrors.forEach((entry) => {
          entry.errors.forEach((message) => {
            const category = categorizeParseError(message);
            categories.set(category, (categories.get(category) || 0) + 1);
          });
        });
        const summary = Array.from(categories.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([name, count]) => `${name}:${count}`)
          .join(", ");
        details.push(`Parse error categories: ${summary}`);
      }
      if (response?.symbols?.length != null) {
        details.push(`Symbols: ${response.symbols.length}`);
      }
      if (response?.project_symbol_count != null || response?.library_symbol_count != null) {
        details.push(
          `Project symbols: ${response?.project_symbol_count || 0} | Library symbols: ${response?.library_symbol_count || 0}`,
        );
      }
      if (response?.unresolved?.length != null) {
        details.push(`Unresolved: ${response.unresolved.length}`);
      }
      setCompileStatus(ok ? "Compile: complete" : "Compile: finished with errors");
      setCompileToast((prev) => ({ ...prev, ok, open: true, parseErrors, details, parsedFiles }));
      void refreshSemanticProjectSymbols(rootPath);
      await loadLibrarySymbols(rootPath, undefined, false);
      if (ok) {
        if (compileToastTimerRef.current !== undefined) {
          window.clearTimeout(compileToastTimerRef.current);
        }
        compileToastTimerRef.current = window.setTimeout(() => {
          setCompileToast((prev) => ({ ...prev, open: false }));
          compileToastTimerRef.current = undefined;
        }, 2000);
      }
      return ok;
    } catch (error) {
      setCompileStatus(`Compile: failed: ${error}`);
      setCompileToast((prev) => ({
        ...prev,
        ok: false,
        open: true,
        lines: [...prev.lines, `failed: ${String(error)}`].slice(-8),
      }));
      return false;
    } finally {
      setCompileRunId(null);
    }
  }, [rootPath, loadLibrarySymbols, refreshSemanticProjectSymbols]);

  const cancelCompile = useCallback(async () => {
    if (!compileRunId) return;
    await invoke("cancel_compile", { run_id: compileRunId });
    setCompileStatus("Compile: canceling...");
  }, [compileRunId]);

  const runBackgroundCompile = useCallback(async (path: string, filePath?: string) => {
    if (!backgroundCompileEnabled || !path || compileRunId || backgroundCompileRef.current) return;
    const runId = Date.now();
    const token = backgroundCompileTokenRef.current;
    backgroundCompileRef.current = runId;
    setBackgroundCompileActive(true);
    clearBackgroundCompileTimeout();
    backgroundCompileTimeoutRef.current = window.setTimeout(() => {
      if (backgroundCompileRef.current !== runId) return;
      backgroundCompileRef.current = null;
      setBackgroundCompileActive(false);
      setCompileStatus(`Background compile: timed out after ${Math.round(BACKGROUND_COMPILE_TIMEOUT_MS / 1000)}s`);
      void invoke("cancel_compile", { run_id: runId }).catch(() => {});
    }, BACKGROUND_COMPILE_TIMEOUT_MS);
    setCompileStatus("Background compile: starting...");
    try {
      const response = await invoke<CompileResponse>("compile_project_delta", {
        payload: {
          root: path,
          run_id: runId,
          allow_parse_errors: true,
          file: filePath,
          unsaved: [],
        },
      });
      if (token !== backgroundCompileTokenRef.current || path !== rootPath) {
        return;
      }
      setProjectFastSymbols((prev) => {
        const incomingProject = withScope(response?.symbols, "project");
        return mergeProjectSymbolsByFile(prev, incomingProject, filePath);
      });
      if (!filePath && (!response?.symbols || response.symbols.length === 0)) {
        await loadProjectSymbolsFromIndex(path);
      }
      setUnresolved(response?.unresolved || []);
      setProjectSymbolsLoaded(true);
      setParsedFiles(response?.parsed_files || []);
      const parseErrors = (response?.files || [])
        .filter((file) => !file.ok && file.errors && file.errors.length)
        .map((file) => file.path);
      setParseErrorPaths(new Set(parseErrors.map((path) => normalizePathKey(path))));
      const symbolCount = response?.symbols?.length || 0;
      setCompileStatus(
        response?.ok
          ? `Background compile: complete (${symbolCount} symbols)`
          : `Background compile: finished with errors (${symbolCount} symbols)`,
      );
      void refreshSemanticProjectSymbols(path);
    } catch (error) {
      if (token === backgroundCompileTokenRef.current) {
        setCompileStatus(`Background compile: failed: ${error}`);
      }
    } finally {
      clearBackgroundCompileTimeout();
      if (token === backgroundCompileTokenRef.current) {
        backgroundCompileRef.current = null;
        setBackgroundCompileActive(false);
      } else if (backgroundCompileRef.current === runId) {
        backgroundCompileRef.current = null;
        setBackgroundCompileActive(false);
      }
    }
  }, [
    backgroundCompileEnabled,
    compileRunId,
    rootPath,
    clearBackgroundCompileTimeout,
    loadProjectSymbolsFromIndex,
    refreshSemanticProjectSymbols,
  ]);

  const runBackgroundCompileWithUnsaved = useCallback(async (path: string, filePath: string, content: string) => {
    if (!backgroundCompileEnabled || !path || compileRunId || backgroundCompileRef.current) return;
    const runId = Date.now();
    const token = backgroundCompileTokenRef.current;
    backgroundCompileRef.current = runId;
    setBackgroundCompileActive(true);
    clearBackgroundCompileTimeout();
    backgroundCompileTimeoutRef.current = window.setTimeout(() => {
      if (backgroundCompileRef.current !== runId) return;
      backgroundCompileRef.current = null;
      setBackgroundCompileActive(false);
      setCompileStatus(`Background compile: timed out after ${Math.round(BACKGROUND_COMPILE_TIMEOUT_MS / 1000)}s`);
      void invoke("cancel_compile", { run_id: runId }).catch(() => {});
    }, BACKGROUND_COMPILE_TIMEOUT_MS);
    setCompileStatus("Background compile: starting...");
    try {
      const response = await invoke<CompileResponse>("compile_project_delta", {
        payload: {
          root: path,
          run_id: runId,
          allow_parse_errors: true,
          file: filePath,
          unsaved: [{ path: filePath, content }],
        },
      });
      if (token !== backgroundCompileTokenRef.current || path !== rootPath) {
        return;
      }
      setProjectFastSymbols((prev) => {
        const incomingProject = withScope(response?.symbols, "project");
        return mergeProjectSymbolsByFile(prev, incomingProject, filePath);
      });
      if (!response?.symbols || response.symbols.length === 0) {
        await loadProjectSymbolsFromIndex(path);
      }
      setUnresolved(response?.unresolved || []);
      setProjectSymbolsLoaded(true);
      setParsedFiles(response?.parsed_files || []);
      const parseErrors = (response?.files || [])
        .filter((file) => !file.ok && file.errors && file.errors.length)
        .map((file) => file.path);
      setParseErrorPaths(new Set(parseErrors.map((path) => normalizePathKey(path))));
      const symbolCount = response?.symbols?.length || 0;
      setCompileStatus(
        response?.ok
          ? `Background compile: complete (${symbolCount} symbols)`
          : `Background compile: finished with errors (${symbolCount} symbols)`,
      );
      void refreshSemanticProjectSymbols(path);
    } catch (error) {
      if (token === backgroundCompileTokenRef.current) {
        setCompileStatus(`Background compile: failed: ${error}`);
      }
    } finally {
      clearBackgroundCompileTimeout();
      if (token === backgroundCompileTokenRef.current) {
        backgroundCompileRef.current = null;
        setBackgroundCompileActive(false);
      } else if (backgroundCompileRef.current === runId) {
        backgroundCompileRef.current = null;
        setBackgroundCompileActive(false);
      }
    }
  }, [
    backgroundCompileEnabled,
    compileRunId,
    rootPath,
    clearBackgroundCompileTimeout,
    loadProjectSymbolsFromIndex,
    refreshSemanticProjectSymbols,
  ]);

  const cancelBackgroundCompile = useCallback(async () => {
    if (!backgroundCompileRef.current) return;
    const runId = backgroundCompileRef.current;
    backgroundCompileRef.current = null;
    setBackgroundCompileActive(false);
    clearBackgroundCompileTimeout();
    backgroundCompileTokenRef.current += 1;
    await invoke("cancel_compile", { run_id: runId }).catch(() => {});
  }, [clearBackgroundCompileTimeout]);

  const setEditorParseError = useCallback((path: string, hasError: boolean) => {
    const key = normalizePathKey(path);
    if (!key) return;
    setParseErrorPaths((prev) => {
      const next = new Set(prev);
      if (hasError) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }, []);

  return {
    compileStatus,
    setCompileStatus,
    compileRunId,
    compileToast,
    setCompileToast,
    runCompile,
    cancelCompile,
    runBackgroundCompile,
    runBackgroundCompileWithUnsaved,
    cancelBackgroundCompile,
    backgroundCompileEnabled,
    setBackgroundCompileEnabled,
    backgroundCompileActive,
    activeFileSymbolMode,
    setActiveFileSymbolMode,
    projectFastSymbols,
    projectSemanticSymbols,
    symbols,
    unresolved,
    libraryPath,
    libraryFiles,
    libraryLoadingFiles,
    libraryLoadErrors,
    libraryBulkLoading,
    loadedLibraryFileCount,
    libraryBulkTotal,
    libraryBulkCompleted,
    libraryBulkFailed,
    libraryImportCount,
    libraryKindCounts,
    libraryIndexedSymbolCount,
    loadLibrarySymbolsForFile,
    loadAllLibrarySymbols,
    retryFailedLibraryLoads,
    cancelLibrarySymbolLoading,
    stdlibFileCount,
    projectSymbolsLoaded,
    parsedFiles,
    parseErrorPaths,
    setEditorParseError,
  };
}
