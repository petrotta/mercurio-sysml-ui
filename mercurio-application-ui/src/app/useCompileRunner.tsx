import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { IndexedSymbolView, SymbolView, UnresolvedIssue } from "./types";
import {
  loadLibrarySymbols,
  queryLibrarySymbols,
  queryProjectSymbols,
  queryProjectSymbolsForFiles,
} from "./services/semanticApi";

export type CompileToast = {
  open: boolean;
  ok: boolean | null;
  lines: string[];
  parseErrors: Array<{ path: string; errors: string[] }>;
  details: string[];
  parsedFiles: string[];
};

export type BuildLogEntry = {
  id: number;
  at: string;
  level: "info" | "warn" | "error";
  message: string;
};

export type BuildProgressView = {
  runId: number | null;
  stage: string;
  file: string | null;
  startedAtMs: number | null;
  lastEventAtMs: number | null;
  eventCount: number;
  running: boolean;
};

type CompileResponse = {
  ok: boolean;
  files?: Array<{ path: string; ok: boolean; errors: string[]; symbol_count: number }>;
  parse_error_categories?: Array<{ category: string; count: number }>;
  performance_warnings?: string[];
  project_symbol_count?: number;
  library_path?: string | null;
  parsed_files?: string[];
  parse_duration_ms?: number;
  analysis_duration_ms?: number;
  total_duration_ms?: number;
  symbols: SymbolView[];
  unresolved: UnresolvedIssue[];
};

type CompileProgressPayload = {
  run_id: number;
  stage: string;
  file?: string;
  index?: number;
  total?: number;
};

type UseCompileRunnerOptions = {
  rootPath: string;
};

type UnsavedCompileInput = {
  path: string;
  content: string;
};

const INDEX_QUERY_PAGE_SIZE = 5_000;
const INDEX_QUERY_MAX_PAGES = 80;
const BUILD_LOG_MAX = 240;
const COMPILE_REQUEST_DEBOUNCE_MS = 250;

function normalizePathKey(path: string): string {
  return (path || "").replace(/\//g, "\\").toLowerCase();
}

function indexedToSymbol(
  symbol: IndexedSymbolView,
  sourceScope: "project" | "library",
): SymbolView {
  return {
    name: symbol.name,
    kind: symbol.kind,
    metatype_qname: symbol.metatype_qname || null,
    file_path: symbol.file_path,
    source_scope: sourceScope,
    qualified_name: symbol.qualified_name,
    parent_qualified_name: symbol.parent_qualified_name || null,
    file: 0,
    start_line: symbol.start_line,
    start_col: symbol.start_col,
    end_line: symbol.end_line,
    end_col: symbol.end_col,
    doc: symbol.doc_text || null,
    properties: [],
    relationships: [],
  };
}

function mergeSymbols(symbols: SymbolView[]): SymbolView[] {
  const out: SymbolView[] = [];
  const seen = new Set<string>();
  for (const symbol of symbols) {
    const key = `${normalizePathKey(symbol.file_path)}|${symbol.qualified_name}|${symbol.name}|${symbol.start_line}|${symbol.start_col}`;
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
  if (!scopedFilePath) {
    return incoming.length ? incoming : previous;
  }
  const scopedKey = normalizePathKey(scopedFilePath);
  const kept = previous.filter((symbol) => normalizePathKey(symbol.file_path) !== scopedKey);
  return mergeSymbols([...kept, ...incoming]);
}

function mergeProjectSymbolsByParsedFiles(
  previous: SymbolView[],
  incoming: SymbolView[],
  parsedFiles: string[] | undefined,
): SymbolView[] {
  const parsed = new Set((parsedFiles || []).map((path) => normalizePathKey(path)));
  if (!parsed.size) {
    return incoming.length ? incoming : previous;
  }
  const kept = previous.filter((symbol) => !parsed.has(normalizePathKey(symbol.file_path)));
  return mergeSymbols([...kept, ...incoming]);
}

function formatSemanticIssue(issue: UnresolvedIssue): string {
  const line = Number.isFinite(issue.line) && issue.line > 0 ? issue.line : 1;
  const col = Number.isFinite(issue.column) && issue.column > 0 ? issue.column : 1;
  return `[semantic ${line}:${col}] ${issue.message}`;
}

function compileRequestKey(filePath?: string, unsavedInputs: UnsavedCompileInput[] = []): string {
  const normalizedFile = (filePath || "").trim().toLowerCase();
  const normalizedUnsaved = (unsavedInputs || [])
    .map((entry) => ({
      path: (entry?.path || "").trim().toLowerCase(),
      contentLength: (entry?.content || "").length,
    }))
    .filter((entry) => !!entry.path)
    .sort((left, right) => left.path.localeCompare(right.path));
  return JSON.stringify({
    file: normalizedFile,
    unsaved: normalizedUnsaved,
  });
}

function buildCompileErrorBuckets(
  files: Array<{ path: string; ok: boolean; errors: string[]; symbol_count: number }>,
  unresolved: UnresolvedIssue[],
): Array<{ path: string; errors: string[] }> {
  const byPath = new Map<string, { path: string; errors: string[] }>();
  for (const file of files || []) {
    if (!file?.path) continue;
    const errs = Array.isArray(file.errors) ? file.errors.filter(Boolean) : [];
    if (!errs.length) continue;
    byPath.set(file.path, { path: file.path, errors: [...errs] });
  }
  for (const issue of unresolved || []) {
    if (!issue?.file_path) continue;
    const message = formatSemanticIssue(issue);
    const existing = byPath.get(issue.file_path);
    if (existing) {
      existing.errors.push(message);
    } else {
      byPath.set(issue.file_path, { path: issue.file_path, errors: [message] });
    }
  }
  return Array.from(byPath.values());
}

export function useCompileRunner({ rootPath }: UseCompileRunnerOptions) {
  const [compileStatus, setCompileStatus] = useState("Compile: idle");
  const [compileRunId, setCompileRunId] = useState<number | null>(null);
  const [progressUiUpdates, setProgressUiUpdates] = useState(0);
  const [droppedCompileRequests, setDroppedCompileRequests] = useState(0);
  const [compileToast, setCompileToast] = useState<CompileToast>({
    open: false,
    ok: null,
    lines: [],
    parseErrors: [],
    details: [],
    parsedFiles: [],
  });
  const compileToastTimerRef = useRef<number | undefined>(undefined);
  const compileRunIdRef = useRef<number | null>(null);
  const runCompileRef = useRef<(filePath?: string, unsavedInputs?: UnsavedCompileInput[]) => Promise<boolean>>(async () => false);
  const pendingCompileRequestRef = useRef<{ filePath?: string; unsavedInputs: UnsavedCompileInput[] } | null>(null);
  const lastCompileRequestKeyRef = useRef("");
  const lastCompileRequestAtRef = useRef(0);
  const progressFlushTimerRef = useRef<number | undefined>(undefined);
  const progressLatestDetailRef = useRef("");
  const progressLineBufferRef = useRef<string[]>([]);
  const libraryPathRef = useRef("");
  const libraryBootstrapAttemptedRef = useRef(false);

  const [projectSemanticSymbols, setProjectSemanticSymbols] = useState<SymbolView[]>([]);
  const [librarySemanticSymbols, setLibrarySemanticSymbols] = useState<SymbolView[]>([]);
  const [activeLibraryPath, setActiveLibraryPath] = useState("");
  const symbols = useMemo(
    () => mergeSymbols([...projectSemanticSymbols, ...librarySemanticSymbols]),
    [projectSemanticSymbols, librarySemanticSymbols],
  );
  const [unresolved, setUnresolved] = useState<UnresolvedIssue[]>([]);
  const [parsedFiles, setParsedFiles] = useState<string[]>([]);
  const [parseErrorPaths, setParseErrorPaths] = useState<Set<string>>(new Set());
  const [buildLogEntries, setBuildLogEntries] = useState<BuildLogEntry[]>([]);
  const buildLogIdRef = useRef(0);
  const buildStartedAtRef = useRef<number | null>(null);
  const progressStageRef = useRef("idle");
  const progressFileRef = useRef<string | null>(null);
  const progressLastEventAtRef = useRef<number | null>(null);
  const progressEventCountRef = useRef(0);
  const [buildProgress, setBuildProgress] = useState<BuildProgressView>({
    runId: null,
    stage: "idle",
    file: null,
    startedAtMs: null,
    lastEventAtMs: null,
    eventCount: 0,
    running: false,
  });

  const appendBuildLogEntries = useCallback((
    entries: Array<{ level: "info" | "warn" | "error"; message: string }>,
  ) => {
    if (!entries.length) return;
    const stamped = entries.map((entry) => ({
      id: ++buildLogIdRef.current,
      at: new Date().toLocaleTimeString(),
      level: entry.level,
      message: entry.message,
    }));
    setBuildLogEntries((prev) => [...prev, ...stamped].slice(-BUILD_LOG_MAX));
    for (const entry of stamped) {
      if (entry.level === "error") {
        console.error(`[build][${entry.at}] ${entry.message}`);
      } else if (entry.level === "warn") {
        console.warn(`[build][${entry.at}] ${entry.message}`);
      } else {
        console.info(`[build][${entry.at}] ${entry.message}`);
      }
    }
  }, []);

  const clearBuildLogs = useCallback(() => {
    setBuildLogEntries([]);
  }, []);

  const flushProgressUi = useCallback(() => {
    if (progressFlushTimerRef.current !== undefined) {
      window.clearTimeout(progressFlushTimerRef.current);
      progressFlushTimerRef.current = undefined;
    }
    const detail = progressLatestDetailRef.current;
    const lines = progressLineBufferRef.current.splice(0);
    if (!detail && !lines.length) return;
    if (detail) {
      setCompileStatus(`Compile: ${detail}`);
    }
    setBuildProgress({
      runId: compileRunIdRef.current,
      stage: progressStageRef.current,
      file: progressFileRef.current,
      startedAtMs: buildStartedAtRef.current,
      lastEventAtMs: progressLastEventAtRef.current,
      eventCount: progressEventCountRef.current,
      running: !!compileRunIdRef.current,
    });
    if (compileRunIdRef.current && lines.length) {
      setCompileToast((prev) => ({
        ...prev,
        open: true,
        lines: [...prev.lines, ...lines].slice(-8),
      }));
      appendBuildLogEntries(
        lines.map((line) => ({ level: "info" as const, message: line })),
      );
    }
    setProgressUiUpdates((prev) => prev + 1);
  }, [appendBuildLogEntries]);

  const scheduleProgressUiFlush = useCallback(() => {
    if (progressFlushTimerRef.current !== undefined) return;
    progressFlushTimerRef.current = window.setTimeout(flushProgressUi, 100);
  }, [flushProgressUi]);

  const queryIndexedProjectSymbols = useCallback(async (
    path: string,
    scopedFilePath?: string,
  ): Promise<SymbolView[] | null> => {
    if (!path) return [];
    try {
      if (scopedFilePath) {
        const indexed = await queryProjectSymbols(path, scopedFilePath, 0, INDEX_QUERY_PAGE_SIZE);
        return (indexed || []).map((symbol) => indexedToSymbol(symbol, "project"));
      }
      const out: SymbolView[] = [];
      let offset = 0;
      for (let page = 0; page < INDEX_QUERY_MAX_PAGES; page += 1) {
        const indexed = await queryProjectSymbols(path, null, offset, INDEX_QUERY_PAGE_SIZE);
        if (!indexed?.length) break;
        out.push(...indexed.map((symbol) => indexedToSymbol(symbol, "project")));
        if (indexed.length < INDEX_QUERY_PAGE_SIZE) break;
        offset += indexed.length;
      }
      return out;
    } catch {
      return null;
    }
  }, []);

  const queryIndexedProjectSymbolsForFiles = useCallback(async (
    path: string,
    filePaths: string[],
  ): Promise<SymbolView[] | null> => {
    const unique = Array.from(
      new Set((filePaths || []).map((filePath) => filePath?.trim()).filter((filePath): filePath is string => !!filePath)),
    );
    if (!unique.length) return [];
    try {
      const indexed = await queryProjectSymbolsForFiles(path, unique, 0, INDEX_QUERY_PAGE_SIZE * INDEX_QUERY_MAX_PAGES);
      return (indexed || []).map((symbol) => indexedToSymbol(symbol, "project"));
    } catch {
      return null;
    }
  }, []);

  const queryIndexedLibrarySymbols = useCallback(async (
    path: string,
    scopedFilePath?: string,
  ): Promise<SymbolView[] | null> => {
    if (!path) return [];
    try {
      if (scopedFilePath) {
        const indexed = await queryLibrarySymbols(path, scopedFilePath, 0, INDEX_QUERY_PAGE_SIZE);
        return (indexed || []).map((symbol) => indexedToSymbol(symbol, "library"));
      }
      const out: SymbolView[] = [];
      let offset = 0;
      for (let page = 0; page < INDEX_QUERY_MAX_PAGES; page += 1) {
        const indexed = await queryLibrarySymbols(path, null, offset, INDEX_QUERY_PAGE_SIZE);
        if (!indexed?.length) break;
        out.push(...indexed.map((symbol) => indexedToSymbol(symbol, "library")));
        if (indexed.length < INDEX_QUERY_PAGE_SIZE) break;
        offset += indexed.length;
      }
      return out;
    } catch {
      return null;
    }
  }, []);

  const hydrateLibraryIndexIfNeeded = useCallback(async (
    path: string,
    reason: "startup" | "post-compile",
  ): Promise<SymbolView[] | null> => {
    if (!path || libraryBootstrapAttemptedRef.current) return null;
    libraryBootstrapAttemptedRef.current = true;
    appendBuildLogEntries([{
      level: "info",
      message: `Library index empty; loading stdlib symbols (${reason})`,
    }]);
    try {
      const loaded = await loadLibrarySymbols(path, null, true);
      const resolvedLibraryPath = (loaded?.library_path || "").trim();
      if (resolvedLibraryPath) {
        setActiveLibraryPath(resolvedLibraryPath);
        libraryPathRef.current = resolvedLibraryPath;
      }
      const indexed = await queryIndexedLibrarySymbols(path);
      if (indexed) {
        appendBuildLogEntries([{
          level: "info",
          message: `Library load complete (${indexed.length} symbols, files=${loaded?.stdlib_file_count ?? 0}, snapshot_hit=${loaded?.workspace_snapshot_hit ? "yes" : "no"})`,
        }]);
      } else {
        appendBuildLogEntries([{
          level: "warn",
          message: "Library load completed, but indexed library query failed.",
        }]);
      }
      return indexed;
    } catch (error) {
      appendBuildLogEntries([{
        level: "warn",
        message: `Library load failed: ${String(error)}`,
      }]);
      return null;
    }
  }, [appendBuildLogEntries, queryIndexedLibrarySymbols]);

  useEffect(() => {
    if (compileToastTimerRef.current !== undefined) {
      window.clearTimeout(compileToastTimerRef.current);
      compileToastTimerRef.current = undefined;
    }
    if (progressFlushTimerRef.current !== undefined) {
      window.clearTimeout(progressFlushTimerRef.current);
      progressFlushTimerRef.current = undefined;
    }
    progressLatestDetailRef.current = "";
    progressLineBufferRef.current = [];
    buildStartedAtRef.current = null;
    progressStageRef.current = "idle";
    progressFileRef.current = null;
    progressLastEventAtRef.current = null;
    progressEventCountRef.current = 0;
    setCompileRunId(null);
    setCompileToast({
      open: false,
      ok: null,
      lines: [],
      parseErrors: [],
      details: [],
      parsedFiles: [],
    });
    setProjectSemanticSymbols([]);
    setLibrarySemanticSymbols([]);
    libraryBootstrapAttemptedRef.current = false;
    libraryPathRef.current = "";
    setActiveLibraryPath("");
    setUnresolved([]);
    setParsedFiles([]);
    setParseErrorPaths(new Set());
    setBuildLogEntries([]);
    buildLogIdRef.current = 0;
    setBuildProgress({
      runId: null,
      stage: "idle",
      file: null,
      startedAtMs: null,
      lastEventAtMs: null,
      eventCount: 0,
      running: false,
    });
    setProgressUiUpdates(0);
    setDroppedCompileRequests(0);
    if (!rootPath) {
      setCompileStatus("Compile: idle");
      return;
    }
    setCompileStatus("Compile: ready");
    appendBuildLogEntries([{ level: "info", message: `Project root set: ${rootPath}` }]);
    let active = true;
    void (async () => {
      const [projectSymbolsFromIndex, librarySymbolsFromIndex] = await Promise.all([
        queryIndexedProjectSymbols(rootPath),
        queryIndexedLibrarySymbols(rootPath),
      ]);
      if (!active) return;
      if (projectSymbolsFromIndex) {
        setProjectSemanticSymbols(mergeSymbols(projectSymbolsFromIndex));
      }
      let resolvedLibrarySymbols = librarySymbolsFromIndex;
      if (!resolvedLibrarySymbols || resolvedLibrarySymbols.length === 0) {
        const hydrated = await hydrateLibraryIndexIfNeeded(rootPath, "startup");
        if (!active) return;
        if (hydrated) {
          resolvedLibrarySymbols = hydrated;
        }
      }
      if (resolvedLibrarySymbols) {
        setLibrarySemanticSymbols(mergeSymbols(resolvedLibrarySymbols));
      }
    })();
    return () => {
      active = false;
    };
  }, [
    rootPath,
    queryIndexedProjectSymbols,
    queryIndexedLibrarySymbols,
    hydrateLibraryIndexIfNeeded,
    appendBuildLogEntries,
  ]);

  useEffect(() => {
    compileRunIdRef.current = compileRunId;
    setBuildProgress((prev) => ({
      ...prev,
      runId: compileRunId,
      running: !!compileRunId,
    }));
  }, [compileRunId]);

  useEffect(() => {
    return () => {
      if (compileToastTimerRef.current !== undefined) {
        window.clearTimeout(compileToastTimerRef.current);
        compileToastTimerRef.current = undefined;
      }
      if (progressFlushTimerRef.current !== undefined) {
        window.clearTimeout(progressFlushTimerRef.current);
        progressFlushTimerRef.current = undefined;
      }
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<CompileProgressPayload>("compile-progress", (event) => {
      const payload = event.payload;
      if (!payload) return;
      const activeRunId = compileRunIdRef.current;
      if (payload.run_id && activeRunId && payload.run_id !== activeRunId) {
        return;
      }
      const stage = payload.stage || "running";
      const detail = payload.file ? `${stage}: ${payload.file}` : stage;
      progressLatestDetailRef.current = detail;
      progressStageRef.current = stage;
      progressFileRef.current = payload.file || null;
      progressLastEventAtRef.current = Date.now();
      progressEventCountRef.current += 1;
      if (activeRunId && payload.run_id === activeRunId) {
        progressLineBufferRef.current.push(detail);
      }
      scheduleProgressUiFlush();
    });
    return () => {
      flushProgressUi();
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [flushProgressUi, scheduleProgressUiFlush]);

  const runCompile = useCallback(async (
    filePath?: string,
    unsavedInputs: UnsavedCompileInput[] = [],
  ): Promise<boolean> => {
    if (!rootPath) return false;
    const now = Date.now();
    const requestKey = compileRequestKey(filePath, unsavedInputs);
    if (
      requestKey === lastCompileRequestKeyRef.current
      && now - lastCompileRequestAtRef.current < COMPILE_REQUEST_DEBOUNCE_MS
    ) {
      appendBuildLogEntries([{ level: "info", message: "Compile request skipped: duplicate request window." }]);
      return false;
    }
    lastCompileRequestKeyRef.current = requestKey;
    lastCompileRequestAtRef.current = now;
    if (compileRunIdRef.current) {
      setDroppedCompileRequests((prev) => prev + 1);
      pendingCompileRequestRef.current = {
        filePath,
        unsavedInputs: (unsavedInputs || []).map((entry) => ({
          path: entry.path,
          content: entry.content,
        })),
      };
      setCompileStatus("Compile: running (latest request queued)");
      appendBuildLogEntries([{ level: "warn", message: "Compile request queued: compile already running." }]);
      return false;
    }
    if (compileToastTimerRef.current !== undefined) {
      window.clearTimeout(compileToastTimerRef.current);
      compileToastTimerRef.current = undefined;
    }
    const runId = Date.now();
    const startedAt = Date.now();
    buildStartedAtRef.current = startedAt;
    progressStageRef.current = "starting";
    progressFileRef.current = filePath || null;
    progressLastEventAtRef.current = startedAt;
    progressEventCountRef.current = 0;
    compileRunIdRef.current = runId;
    setCompileRunId(runId);
    setCompileToast({ open: true, ok: null, lines: ["starting..."], parseErrors: [], details: [], parsedFiles: [] });
    setCompileStatus("Compile: starting...");
    try {
      const unsavedByPath = new Map<string, { path: string; content: string }>();
      for (const entry of unsavedInputs || []) {
        const path = (entry?.path || "").trim();
        if (!path) continue;
        unsavedByPath.set(normalizePathKey(path), { path, content: entry.content ?? "" });
      }
      const unsaved = Array.from(unsavedByPath.values());
      appendBuildLogEntries([{
        level: "info",
        message: `Compile start (run=${runId}, mode=${filePath ? "file" : "project"}, unsaved=${unsaved.length})`,
      }]);
      const response = await invoke<CompileResponse>("compile_project_delta", {
        payload: {
          root: rootPath,
          run_id: runId,
          allow_parse_errors: true,
          file: filePath,
          include_symbols: false,
          unsaved,
        },
      });

      const nextUnresolved = response?.unresolved || [];
      setUnresolved(nextUnresolved);
      const nextParsedFiles = response?.parsed_files || [];
      setParsedFiles(nextParsedFiles);
      const previousLibraryPath = libraryPathRef.current;
      const responseLibraryPath = (response?.library_path || "").trim();
      if (responseLibraryPath) {
        setActiveLibraryPath(responseLibraryPath);
      } else if (!filePath) {
        setActiveLibraryPath("");
      }

      const parseErrors = buildCompileErrorBuckets(response?.files || [], nextUnresolved);
      setParseErrorPaths(new Set(parseErrors.map((file) => normalizePathKey(file.path))));

      const details: string[] = [];
      if (typeof response?.parse_duration_ms === "number") {
        details.push(`Parse: ${response.parse_duration_ms} ms`);
      }
      if (typeof response?.analysis_duration_ms === "number") {
        details.push(`Analysis: ${response.analysis_duration_ms} ms`);
      }
      if (typeof response?.total_duration_ms === "number") {
        details.push(`Total: ${response.total_duration_ms} ms`);
      }
      if (nextParsedFiles.length) {
        details.push(`Files parsed: ${nextParsedFiles.length}`);
      }
      if (response?.parse_error_categories?.length) {
        const summary = response.parse_error_categories
          .map((entry) => `${entry.category}:${entry.count}`)
          .join(", ");
        details.push(`Parse error categories: ${summary}`);
      }
      for (const warning of response?.performance_warnings || []) {
        details.push(`Warning: ${warning}`);
      }
      details.push(`Unsaved overlays: ${unsaved.length}`);
      details.push("Symbols refresh: deferred");
      details.push(`Unresolved: ${nextUnresolved.length}`);

      flushProgressUi();
      const ok = !!response?.ok;
      progressStageRef.current = ok ? "complete" : "finished_with_errors";
      progressFileRef.current = filePath || null;
      progressLastEventAtRef.current = Date.now();
      setCompileStatus(ok ? "Compile: complete" : "Compile: finished with errors");
      setCompileToast((prev) => ({ ...prev, ok, open: true, parseErrors, details, parsedFiles: nextParsedFiles }));
      appendBuildLogEntries([{
        level: ok ? "info" : "warn",
        message: `Compile finished (run=${runId}, ok=${ok}, parsed=${nextParsedFiles.length}, unresolved=${nextUnresolved.length}, total=${response?.total_duration_ms ?? 0}ms)`,
      }]);

      void (async () => {
        appendBuildLogEntries([{
          level: "info",
          message: `Symbol refresh started (run=${runId}, mode=${filePath ? "file" : "delta"})`,
        }]);
        let indexedIncoming: SymbolView[] | null = null;
        if (filePath) {
          indexedIncoming = await queryIndexedProjectSymbols(rootPath, filePath);
        } else if (response?.parsed_files?.length) {
          indexedIncoming = await queryIndexedProjectSymbolsForFiles(rootPath, response.parsed_files);
        } else {
          indexedIncoming = [];
        }
        if (indexedIncoming !== null) {
          const incoming = indexedIncoming || [];
          setProjectSemanticSymbols((prev) =>
            filePath
              ? mergeProjectSymbolsByFile(prev, incoming, filePath)
              : mergeProjectSymbolsByParsedFiles(prev, incoming, response?.parsed_files),
          );
          appendBuildLogEntries([{
            level: "info",
            message: `Project symbols refreshed (${incoming.length} symbols)`,
          }]);
        } else {
          appendBuildLogEntries([{
            level: "warn",
            message: "Project symbol refresh skipped due to query error.",
          }]);
        }
        if (!filePath) {
          const libraryPathChanged = responseLibraryPath !== previousLibraryPath;
          if (libraryPathChanged) {
            libraryBootstrapAttemptedRef.current = false;
          }
          const shouldRefreshLibrary =
            !librarySemanticSymbols.length
            || libraryPathChanged;
          if (shouldRefreshLibrary) {
            let libraryIncoming = await queryIndexedLibrarySymbols(rootPath);
            if (!libraryIncoming || !libraryIncoming.length) {
              const hydrated = await hydrateLibraryIndexIfNeeded(rootPath, "post-compile");
              if (hydrated) {
                libraryIncoming = hydrated;
              }
            }
            if (libraryIncoming) {
              setLibrarySemanticSymbols(mergeSymbols(libraryIncoming));
              appendBuildLogEntries([{
                level: "info",
                message: `Library symbols refreshed (${libraryIncoming.length} symbols)`,
              }]);
            } else {
              appendBuildLogEntries([{
                level: "warn",
                message: "Library symbol refresh skipped due to query error.",
              }]);
            }
          }
          libraryPathRef.current = responseLibraryPath;
        }
        appendBuildLogEntries([{ level: "info", message: `Symbol refresh completed (run=${runId})` }]);
      })();

      if (ok) {
        compileToastTimerRef.current = window.setTimeout(() => {
          setCompileToast((prev) => ({ ...prev, open: false }));
          compileToastTimerRef.current = undefined;
        }, 2000);
      }

      return ok;
    } catch (error) {
      progressStageRef.current = "failed";
      progressLastEventAtRef.current = Date.now();
      flushProgressUi();
      setCompileStatus(`Compile: failed: ${String(error)}`);
      setCompileToast((prev) => ({
        ...prev,
        ok: false,
        open: true,
        lines: [...prev.lines, `failed: ${String(error)}`].slice(-8),
      }));
      appendBuildLogEntries([{ level: "error", message: `Compile failed (run=${runId}): ${String(error)}` }]);
      return false;
    } finally {
      progressLastEventAtRef.current = Date.now();
      compileRunIdRef.current = null;
      setCompileRunId(null);
      const pending = pendingCompileRequestRef.current;
      pendingCompileRequestRef.current = null;
      if (pending) {
        window.setTimeout(() => {
          void runCompileRef.current(pending.filePath, pending.unsavedInputs);
        }, 0);
      }
    }
  }, [
    rootPath,
    queryIndexedProjectSymbols,
    queryIndexedProjectSymbolsForFiles,
    queryIndexedLibrarySymbols,
    hydrateLibraryIndexIfNeeded,
    librarySemanticSymbols.length,
    flushProgressUi,
    appendBuildLogEntries,
  ]);

  useEffect(() => {
    runCompileRef.current = runCompile;
  }, [runCompile]);

  const cancelCompile = useCallback(async () => {
    if (!compileRunId) return;
    progressStageRef.current = "canceling";
    progressLastEventAtRef.current = Date.now();
    await invoke("cancel_compile", { run_id: compileRunId }).catch(() => {});
    setCompileStatus("Compile: canceling...");
    appendBuildLogEntries([{ level: "warn", message: `Compile cancel requested (run=${compileRunId})` }]);
  }, [compileRunId, appendBuildLogEntries]);

  return {
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
    progressUiUpdates,
    droppedCompileRequests,
    buildLogEntries,
    clearBuildLogs,
    buildProgress,
    activeLibraryPath,
  };
}
