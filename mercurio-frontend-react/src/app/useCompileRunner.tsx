import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SymbolView, UnresolvedIssue } from "./types";

type CompileToast = {
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
  parsed_files?: string[];
  parse_duration_ms?: number;
  analysis_duration_ms?: number;
  stdlib_duration_ms?: number;
  total_duration_ms?: number;
  stdlib_cache_hit?: boolean;
  symbols: SymbolView[];
  unresolved: UnresolvedIssue[];
  library_path?: string | null;
};

type UseCompileRunnerOptions = {
  rootPath: string;
};

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
  const compileToastTimerRef = useRef<number | null>(null);
  const backgroundCompileRef = useRef<number | null>(null);
  const backgroundCompileTokenRef = useRef(0);
  const [backgroundCompileEnabled, setBackgroundCompileEnabled] = useState(true);
  const [symbols, setSymbols] = useState<SymbolView[]>([]);
  const [unresolved, setUnresolved] = useState<UnresolvedIssue[]>([]);
  const [libraryPath, setLibraryPath] = useState<string | null>(null);
  const [projectSymbolsLoaded, setProjectSymbolsLoaded] = useState(false);
  const [parsedFiles, setParsedFiles] = useState<string[]>([]);

  useEffect(() => {
    setProjectSymbolsLoaded(false);
  }, [rootPath]);

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

  const runCompile = useCallback(async () => {
    if (!rootPath) return;
    if (backgroundCompileRef.current) {
      void invoke("cancel_compile", { run_id: backgroundCompileRef.current }).catch(() => {});
      backgroundCompileRef.current = null;
    }
    const runId = Date.now();
    setCompileRunId(runId);
    setCompileToast({ open: true, ok: null, lines: ["starting..."], parseErrors: [], details: [], parsedFiles: [] });
    setCompileStatus("Compile: starting...");
    try {
      const response = await invoke<CompileResponse>("compile_workspace", {
        payload: {
          root: rootPath,
          run_id: runId,
          allow_parse_errors: true,
          unsaved: [],
        },
      });
      setSymbols(response?.symbols || []);
      setUnresolved(response?.unresolved || []);
      setLibraryPath(response?.library_path ?? null);
      setProjectSymbolsLoaded(true);
      setParsedFiles(response?.parsed_files || []);
      const ok = !!response?.ok;
      const parseErrors = (response?.files || [])
        .filter((file) => !file.ok && file.errors && file.errors.length)
        .map((file) => ({ path: file.path, errors: file.errors }));
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
      }
      const parsedFiles = response?.parsed_files || [];
      if (parsedFiles.length) {
        details.push(`Files parsed: ${parsedFiles.length}`);
      }
      if (response?.symbols?.length != null) {
        details.push(`Symbols: ${response.symbols.length}`);
      }
      if (response?.unresolved?.length != null) {
        details.push(`Unresolved: ${response.unresolved.length}`);
      }
      setCompileStatus(ok ? "Compile: complete" : "Compile: finished with errors");
      setCompileToast((prev) => ({ ...prev, ok, open: true, parseErrors, details, parsedFiles }));
      if (ok) {
        if (compileToastTimerRef.current) {
          window.clearTimeout(compileToastTimerRef.current);
        }
        compileToastTimerRef.current = window.setTimeout(() => {
          setCompileToast((prev) => ({ ...prev, open: false }));
          compileToastTimerRef.current = null;
        }, 2000);
      }
    } catch (error) {
      setCompileStatus(`Compile: failed: ${error}`);
      setCompileToast((prev) => ({
        ...prev,
        ok: false,
        open: true,
        lines: [...prev.lines, `failed: ${String(error)}`].slice(-8),
      }));
    } finally {
      setCompileRunId(null);
    }
  }, [rootPath]);

  const cancelCompile = useCallback(async () => {
    if (!compileRunId) return;
    await invoke("cancel_compile", { run_id: compileRunId });
    setCompileStatus("Compile: canceling...");
  }, [compileRunId]);

  const runBackgroundCompile = useCallback(async (path: string) => {
    if (!backgroundCompileEnabled || !path || compileRunId || backgroundCompileRef.current) return;
    const runId = Date.now();
    const token = backgroundCompileTokenRef.current;
    backgroundCompileRef.current = runId;
    setCompileStatus("Background compile: starting...");
    try {
      const response = await invoke<CompileResponse>("compile_workspace", {
        payload: {
          root: path,
          run_id: runId,
          allow_parse_errors: true,
          unsaved: [],
        },
      });
      if (token !== backgroundCompileTokenRef.current || path !== rootPath) {
        return;
      }
      setSymbols(response?.symbols || []);
      setUnresolved(response?.unresolved || []);
      setLibraryPath(response?.library_path ?? null);
      setProjectSymbolsLoaded(true);
      setParsedFiles(response?.parsed_files || []);
      setCompileStatus(response?.ok ? "Background compile: complete" : "Background compile: finished with errors");
    } catch (error) {
      if (token === backgroundCompileTokenRef.current) {
        setCompileStatus(`Background compile: failed: ${error}`);
      }
    } finally {
      if (token === backgroundCompileTokenRef.current) {
        backgroundCompileRef.current = null;
      }
    }
  }, [backgroundCompileEnabled, compileRunId, rootPath]);

  const runBackgroundCompileWithUnsaved = useCallback(async (path: string, filePath: string, content: string) => {
    if (!backgroundCompileEnabled || !path || compileRunId || backgroundCompileRef.current) return;
    const runId = Date.now();
    const token = backgroundCompileTokenRef.current;
    backgroundCompileRef.current = runId;
    setCompileStatus("Background compile: starting...");
    try {
      const response = await invoke<CompileResponse>("compile_workspace", {
        payload: {
          root: path,
          run_id: runId,
          allow_parse_errors: true,
          unsaved: [{ path: filePath, content }],
        },
      });
      if (token !== backgroundCompileTokenRef.current || path !== rootPath) {
        return;
      }
      setSymbols(response?.symbols || []);
      setUnresolved(response?.unresolved || []);
      setLibraryPath(response?.library_path ?? null);
      setProjectSymbolsLoaded(true);
      setParsedFiles(response?.parsed_files || []);
      setCompileStatus(response?.ok ? "Background compile: complete" : "Background compile: finished with errors");
    } catch (error) {
      if (token === backgroundCompileTokenRef.current) {
        setCompileStatus(`Background compile: failed: ${error}`);
      }
    } finally {
      if (token === backgroundCompileTokenRef.current) {
        backgroundCompileRef.current = null;
      }
    }
  }, [backgroundCompileEnabled, compileRunId, rootPath]);

  const cancelBackgroundCompile = useCallback(async () => {
    if (!backgroundCompileRef.current) return;
    const runId = backgroundCompileRef.current;
    backgroundCompileRef.current = null;
    backgroundCompileTokenRef.current += 1;
    await invoke("cancel_compile", { run_id: runId }).catch(() => {});
  }, []);

  const backgroundCompileActive = backgroundCompileRef.current != null;

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
    symbols,
    unresolved,
    libraryPath,
    projectSymbolsLoaded,
    parsedFiles,
  };
}
