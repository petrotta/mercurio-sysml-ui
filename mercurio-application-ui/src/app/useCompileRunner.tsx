import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { IndexedSymbolView, SymbolView, UnresolvedIssue } from "./types";
import { queryLibrarySymbols, queryProjectSymbols } from "./services/semanticApi";

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
  parse_error_categories?: Array<{ category: string; count: number }>;
  performance_warnings?: string[];
  project_symbol_count?: number;
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

const INDEX_QUERY_LIMIT = 200_000;

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
    file_path: symbol.file_path,
    source_scope: sourceScope,
    qualified_name: symbol.qualified_name,
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

function withProjectScope(symbols: SymbolView[] | undefined): SymbolView[] {
  return (symbols || []).map((symbol) => ({ ...symbol, source_scope: "project" as const }));
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

  const [projectSemanticSymbols, setProjectSemanticSymbols] = useState<SymbolView[]>([]);
  const [librarySemanticSymbols, setLibrarySemanticSymbols] = useState<SymbolView[]>([]);
  const symbols = useMemo(
    () => mergeSymbols([...projectSemanticSymbols, ...librarySemanticSymbols]),
    [projectSemanticSymbols, librarySemanticSymbols],
  );
  const [unresolved, setUnresolved] = useState<UnresolvedIssue[]>([]);
  const [parsedFiles, setParsedFiles] = useState<string[]>([]);
  const [parseErrorPaths, setParseErrorPaths] = useState<Set<string>>(new Set());

  const queryIndexedProjectSymbols = useCallback(async (
    path: string,
    scopedFilePath?: string,
  ): Promise<SymbolView[] | null> => {
    if (!path) return [];
    try {
      const indexed = await queryProjectSymbols(path, scopedFilePath || null, 0, INDEX_QUERY_LIMIT);
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
      const indexed = await queryLibrarySymbols(path, scopedFilePath || null, 0, INDEX_QUERY_LIMIT);
      return (indexed || []).map((symbol) => indexedToSymbol(symbol, "library"));
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (compileToastTimerRef.current !== undefined) {
      window.clearTimeout(compileToastTimerRef.current);
      compileToastTimerRef.current = undefined;
    }
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
    setUnresolved([]);
    setParsedFiles([]);
    setParseErrorPaths(new Set());
    if (!rootPath) {
      setCompileStatus("Compile: idle");
      return;
    }
    setCompileStatus("Compile: ready");
    let active = true;
    void Promise.all([
      queryIndexedProjectSymbols(rootPath),
      queryIndexedLibrarySymbols(rootPath),
    ]).then(([projectSymbolsFromIndex, librarySymbolsFromIndex]) => {
      if (!active) return;
      if (projectSymbolsFromIndex) {
        setProjectSemanticSymbols(mergeSymbols(projectSymbolsFromIndex));
      }
      if (librarySymbolsFromIndex) {
        setLibrarySemanticSymbols(mergeSymbols(librarySymbolsFromIndex));
      }
    });
    return () => {
      active = false;
    };
  }, [rootPath, queryIndexedProjectSymbols, queryIndexedLibrarySymbols]);

  useEffect(() => {
    compileRunIdRef.current = compileRunId;
  }, [compileRunId]);

  useEffect(() => {
    return () => {
      if (compileToastTimerRef.current !== undefined) {
        window.clearTimeout(compileToastTimerRef.current);
        compileToastTimerRef.current = undefined;
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
      setCompileStatus(`Compile: ${detail}`);
      if (activeRunId && payload.run_id === activeRunId) {
        setCompileToast((prev) => ({
          ...prev,
          open: true,
          lines: [...prev.lines, detail].slice(-8),
        }));
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  const runCompile = useCallback(async (filePath?: string): Promise<boolean> => {
    if (!rootPath) return false;
    if (compileToastTimerRef.current !== undefined) {
      window.clearTimeout(compileToastTimerRef.current);
      compileToastTimerRef.current = undefined;
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

      const indexedIncoming = await queryIndexedProjectSymbols(rootPath, filePath);
      const incoming = indexedIncoming ?? withProjectScope(response?.symbols || []);
      setProjectSemanticSymbols((prev) =>
        filePath
          ? mergeProjectSymbolsByFile(prev, incoming, filePath)
          : mergeProjectSymbolsByParsedFiles(prev, incoming, response?.parsed_files),
      );
      if (!filePath) {
        const libraryIncoming = await queryIndexedLibrarySymbols(rootPath);
        if (libraryIncoming) {
          setLibrarySemanticSymbols(mergeSymbols(libraryIncoming));
        }
      }

      const nextUnresolved = response?.unresolved || [];
      setUnresolved(nextUnresolved);
      const nextParsedFiles = response?.parsed_files || [];
      setParsedFiles(nextParsedFiles);

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
      if (indexedIncoming) {
        details.push("Symbols source: index");
      }
      details.push(`Symbols: ${incoming.length}`);
      details.push(`Unresolved: ${nextUnresolved.length}`);

      const ok = !!response?.ok;
      setCompileStatus(ok ? "Compile: complete" : "Compile: finished with errors");
      setCompileToast((prev) => ({ ...prev, ok, open: true, parseErrors, details, parsedFiles: nextParsedFiles }));

      if (ok) {
        compileToastTimerRef.current = window.setTimeout(() => {
          setCompileToast((prev) => ({ ...prev, open: false }));
          compileToastTimerRef.current = undefined;
        }, 2000);
      }

      return ok;
    } catch (error) {
      setCompileStatus(`Compile: failed: ${String(error)}`);
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
  }, [rootPath, queryIndexedProjectSymbols, queryIndexedLibrarySymbols]);

  const cancelCompile = useCallback(async () => {
    if (!compileRunId) return;
    await invoke("cancel_compile", { run_id: compileRunId }).catch(() => {});
    setCompileStatus("Compile: canceling...");
  }, [compileRunId]);

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
  };
}
