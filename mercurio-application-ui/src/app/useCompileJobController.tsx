import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  COMPILE_REQUEST_DEBOUNCE_MS,
  compileRequestKey,
  normalizePathKey,
  type UnsavedCompileInput,
} from "./compileShared";
import type { CompileResponse, FileDiagnosticsBucket } from "./contracts";

function countSemanticDiagnostics(fileDiagnostics: FileDiagnosticsBucket[]): number {
  return fileDiagnostics.reduce(
    (count, bucket) => count + bucket.diagnostics.filter((diagnostic) => diagnostic.source === "semantic").length,
    0,
  );
}

type UseCompileJobControllerOptions = {
  rootPath: string;
  sessionTokenRef: MutableRefObject<number>;
  currentRunIdRef: MutableRefObject<number | null>;
  notifications: {
    setCompileStatus: (status: string) => void;
    appendBuildLogEntries: (
      entries: Array<{ level: "info" | "warn" | "error"; message: string }>,
    ) => void;
    resetForRoot: (rootPath: string) => void;
    updateRunState: (runId: number | null) => void;
    startCompile: (runId: number, filePath?: string) => void;
    finishCompile: (args: {
      ok: boolean;
      filePath?: string;
      fileDiagnostics: FileDiagnosticsBucket[];
      details: string[];
      parsedFiles: string[];
    }) => void;
    failCompile: (error: unknown) => void;
    requestCancel: (runId: number) => void;
  };
  onCompileSuccess: (args: {
    compileRoot: string;
    runId: number;
    sessionToken: number;
  }) => void;
};

export function useCompileJobController({
  rootPath,
  sessionTokenRef,
  currentRunIdRef,
  notifications,
  onCompileSuccess,
}: UseCompileJobControllerOptions) {
  const {
    setCompileStatus,
    appendBuildLogEntries,
    resetForRoot,
    updateRunState,
    startCompile,
    finishCompile,
    failCompile,
    requestCancel,
  } = notifications;
  const [compileRunId, setCompileRunId] = useState<number | null>(null);
  const [droppedCompileRequests, setDroppedCompileRequests] = useState(0);
  const [parsedFiles, setParsedFiles] = useState<string[]>([]);
  const [fileDiagnosticPaths, setFileDiagnosticPaths] = useState<Set<string>>(new Set());

  const runCompileRef = useRef<(filePath?: string, unsavedInputs?: UnsavedCompileInput[]) => Promise<boolean>>(async () => false);
  const pendingCompileRequestRef = useRef<{ filePath?: string; unsavedInputs: UnsavedCompileInput[] } | null>(null);
  const lastCompileRequestKeyRef = useRef("");
  const lastCompileRequestAtRef = useRef(0);

  useEffect(() => {
    const activeRunId = currentRunIdRef.current;
    if (activeRunId) {
      void invoke("cancel_compile", { run_id: activeRunId }).catch(() => {});
    }
    pendingCompileRequestRef.current = null;
    lastCompileRequestKeyRef.current = "";
    lastCompileRequestAtRef.current = 0;
    currentRunIdRef.current = null;
    setCompileRunId(null);
    setDroppedCompileRequests(0);
    setParsedFiles([]);
    setFileDiagnosticPaths(new Set());
    resetForRoot(rootPath);
  }, [currentRunIdRef, resetForRoot, rootPath]);

  useEffect(() => {
    currentRunIdRef.current = compileRunId;
    updateRunState(compileRunId);
  }, [compileRunId, currentRunIdRef, updateRunState]);

  const runCompile = useCallback(async (
    filePath?: string,
    unsavedInputs: UnsavedCompileInput[] = [],
  ): Promise<boolean> => {
    if (!rootPath) return false;
    const sessionToken = sessionTokenRef.current;
    const compileRoot = rootPath;
    const isCurrentSession = () => sessionTokenRef.current === sessionToken;
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
    if (currentRunIdRef.current) {
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

    const runId = Date.now();
    const isCurrentRun = () => isCurrentSession() && currentRunIdRef.current === runId;
    currentRunIdRef.current = runId;
    setCompileRunId(runId);
    startCompile(runId, filePath);
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
          root: compileRoot,
          run_id: runId,
          allow_parse_errors: true,
          file: filePath,
          include_symbols: false,
          unsaved,
        },
      });
      if (!isCurrentRun()) {
        return false;
      }

      const nextParsedFiles = response?.parsed_files || [];
      setParsedFiles(nextParsedFiles);

      const fileDiagnostics = response?.file_diagnostics || [];
      setFileDiagnosticPaths(new Set(fileDiagnostics.map((file) => normalizePathKey(file.path))));
      const unresolvedCount = countSemanticDiagnostics(fileDiagnostics);

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
      details.push(`Unresolved: ${unresolvedCount}`);

      const ok = !!response?.ok;
      finishCompile({
        ok,
        filePath,
        fileDiagnostics,
        details,
        parsedFiles: nextParsedFiles,
      });
      appendBuildLogEntries([{
        level: ok ? "info" : "warn",
        message: `Compile finished (run=${runId}, ok=${ok}, parsed=${nextParsedFiles.length}, unresolved=${unresolvedCount}, total=${response?.total_duration_ms ?? 0}ms)`,
      }]);
      onCompileSuccess({
        compileRoot,
        runId,
        sessionToken,
      });
      return ok;
    } catch (error) {
      failCompile(error);
      appendBuildLogEntries([{ level: "error", message: `Compile failed (run=${runId}): ${String(error)}` }]);
      return false;
    } finally {
      if (isCurrentSession()) {
        currentRunIdRef.current = null;
        setCompileRunId(null);
        const pending = pendingCompileRequestRef.current;
        pendingCompileRequestRef.current = null;
        if (pending) {
          window.setTimeout(() => {
            void runCompileRef.current(pending.filePath, pending.unsavedInputs);
          }, 0);
        }
      }
    }
  }, [
    appendBuildLogEntries,
    currentRunIdRef,
    failCompile,
    finishCompile,
    onCompileSuccess,
    rootPath,
    sessionTokenRef,
    setCompileStatus,
    startCompile,
  ]);

  useEffect(() => {
    runCompileRef.current = runCompile;
  }, [runCompile]);

  const cancelCompile = useCallback(async () => {
    if (!compileRunId) return;
    requestCancel(compileRunId);
    await invoke("cancel_compile", { run_id: compileRunId }).catch(() => {});
  }, [compileRunId, requestCancel]);

  return {
    compileRunId,
    runCompile,
    cancelCompile,
    parsedFiles,
    fileDiagnosticPaths,
    droppedCompileRequests,
  };
}
