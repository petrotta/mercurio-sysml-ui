import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { MutableRefObject } from "react";
import type { CompileProgressPayload } from "./compileShared";

const BUILD_LOG_MAX = 240;

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

type UseBuildNotificationsOptions = {
  currentRunIdRef: MutableRefObject<number | null>;
};

export function useBuildNotifications({ currentRunIdRef }: UseBuildNotificationsOptions) {
  const [compileStatus, setCompileStatus] = useState("Compile: idle");
  const [compileToast, setCompileToast] = useState<CompileToast>({
    open: false,
    ok: null,
    lines: [],
    parseErrors: [],
    details: [],
    parsedFiles: [],
  });
  const [buildLogEntries, setBuildLogEntries] = useState<BuildLogEntry[]>([]);
  const [progressUiUpdates, setProgressUiUpdates] = useState(0);
  const [buildProgress, setBuildProgress] = useState<BuildProgressView>({
    runId: null,
    stage: "idle",
    file: null,
    startedAtMs: null,
    lastEventAtMs: null,
    eventCount: 0,
    running: false,
  });

  const compileToastTimerRef = useRef<number | undefined>(undefined);
  const progressFlushTimerRef = useRef<number | undefined>(undefined);
  const progressLatestDetailRef = useRef("");
  const progressLineBufferRef = useRef<string[]>([]);
  const buildLogIdRef = useRef(0);
  const buildStartedAtRef = useRef<number | null>(null);
  const progressStageRef = useRef("idle");
  const progressFileRef = useRef<string | null>(null);
  const progressLastEventAtRef = useRef<number | null>(null);
  const progressEventCountRef = useRef(0);

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
      runId: currentRunIdRef.current,
      stage: progressStageRef.current,
      file: progressFileRef.current,
      startedAtMs: buildStartedAtRef.current,
      lastEventAtMs: progressLastEventAtRef.current,
      eventCount: progressEventCountRef.current,
      running: !!currentRunIdRef.current,
    });
    if (currentRunIdRef.current && lines.length) {
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
  }, [appendBuildLogEntries, currentRunIdRef]);

  const scheduleProgressUiFlush = useCallback(() => {
    if (progressFlushTimerRef.current !== undefined) return;
    progressFlushTimerRef.current = window.setTimeout(flushProgressUi, 100);
  }, [flushProgressUi]);

  const resetForRoot = useCallback((rootPath: string) => {
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
    setCompileToast({
      open: false,
      ok: null,
      lines: [],
      parseErrors: [],
      details: [],
      parsedFiles: [],
    });
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
    if (!rootPath) {
      setCompileStatus("Compile: idle");
      return;
    }
    setCompileStatus("Compile: ready");
    appendBuildLogEntries([{ level: "info", message: `Project root set: ${rootPath}` }]);
  }, [appendBuildLogEntries]);

  const updateRunState = useCallback((runId: number | null) => {
    setBuildProgress((prev) => ({
      ...prev,
      runId,
      running: !!runId,
    }));
  }, []);

  const startCompile = useCallback((runId: number, filePath?: string) => {
    if (compileToastTimerRef.current !== undefined) {
      window.clearTimeout(compileToastTimerRef.current);
      compileToastTimerRef.current = undefined;
    }
    const startedAt = Date.now();
    buildStartedAtRef.current = startedAt;
    progressStageRef.current = "starting";
    progressFileRef.current = filePath || null;
    progressLastEventAtRef.current = startedAt;
    progressEventCountRef.current = 0;
    updateRunState(runId);
    setCompileToast({
      open: true,
      ok: null,
      lines: ["starting..."],
      parseErrors: [],
      details: [],
      parsedFiles: [],
    });
    setCompileStatus("Compile: starting...");
  }, [updateRunState]);

  const finishCompile = useCallback(({
    ok,
    filePath,
    parseErrors,
    details,
    parsedFiles,
  }: {
    ok: boolean;
    filePath?: string;
    parseErrors: Array<{ path: string; errors: string[] }>;
    details: string[];
    parsedFiles: string[];
  }) => {
    flushProgressUi();
    progressStageRef.current = ok ? "complete" : "finished_with_errors";
    progressFileRef.current = filePath || null;
    progressLastEventAtRef.current = Date.now();
    setCompileStatus(ok ? "Compile: complete" : "Compile: finished with errors");
    setCompileToast((prev) => ({
      ...prev,
      ok,
      open: true,
      parseErrors,
      details,
      parsedFiles,
    }));
    if (ok) {
      compileToastTimerRef.current = window.setTimeout(() => {
        setCompileToast((prev) => ({ ...prev, open: false }));
        compileToastTimerRef.current = undefined;
      }, 2000);
    }
  }, [flushProgressUi]);

  const failCompile = useCallback((error: unknown) => {
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
  }, [flushProgressUi]);

  const requestCancel = useCallback((runId: number) => {
    progressStageRef.current = "canceling";
    progressLastEventAtRef.current = Date.now();
    setCompileStatus("Compile: canceling...");
    appendBuildLogEntries([{ level: "warn", message: `Compile cancel requested (run=${runId})` }]);
  }, [appendBuildLogEntries]);

  const showErrorNotification = useCallback((message: string) => {
    const text = `${message}`.trim();
    if (!text) return;
    setCompileToast((prev) => ({
      ...prev,
      open: true,
      ok: false,
      lines: [...prev.lines, text].slice(-8),
      details: prev.details.includes(text) ? prev.details : [...prev.details, text].slice(-12),
    }));
    appendBuildLogEntries([{ level: "error", message: text }]);
  }, [appendBuildLogEntries]);

  useEffect(() => {
    const unlistenPromise = listen<CompileProgressPayload>("compile-progress", (event) => {
      const payload = event.payload;
      if (!payload) return;
      const activeRunId = currentRunIdRef.current;
      if (!activeRunId || !payload.run_id || payload.run_id !== activeRunId) {
        return;
      }
      const stage = payload.stage || "running";
      const detail = payload.file ? `${stage}: ${payload.file}` : stage;
      progressLatestDetailRef.current = detail;
      progressStageRef.current = stage;
      progressFileRef.current = payload.file || null;
      progressLastEventAtRef.current = Date.now();
      progressEventCountRef.current += 1;
      progressLineBufferRef.current.push(detail);
      scheduleProgressUiFlush();
    });
    return () => {
      flushProgressUi();
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
      if (compileToastTimerRef.current !== undefined) {
        window.clearTimeout(compileToastTimerRef.current);
        compileToastTimerRef.current = undefined;
      }
      if (progressFlushTimerRef.current !== undefined) {
        window.clearTimeout(progressFlushTimerRef.current);
        progressFlushTimerRef.current = undefined;
      }
    };
  }, [currentRunIdRef, flushProgressUi, scheduleProgressUiFlush]);

  return {
    compileStatus,
    setCompileStatus,
    compileToast,
    buildLogEntries,
    clearBuildLogs,
    buildProgress,
    progressUiUpdates,
    appendBuildLogEntries,
    resetForRoot,
    updateRunState,
    startCompile,
    finishCompile,
    failCompile,
    requestCancel,
    showErrorNotification,
    flushProgressUi,
  };
}
