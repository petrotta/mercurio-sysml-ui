import { invoke } from "@tauri-apps/api/core";

export type AppLogLevel = "debug" | "info" | "warn" | "error";

export type BackendLogRecord = {
  seq: number;
  timestamp_utc: string;
  level: string;
  kind: string;
  message: string;
};

export const APP_LOG_EVENT = "app-log";

export async function getBackendLogs(): Promise<BackendLogRecord[]> {
  return invoke<BackendLogRecord[]>("get_logs");
}

export async function logFrontendEvent({
  level,
  kind = "frontend",
  message,
}: {
  level: AppLogLevel;
  kind?: string;
  message: string;
}): Promise<void> {
  const trimmed = `${message || ""}`.trim();
  if (!trimmed) return;
  await invoke("log_frontend", {
    payload: {
      level,
      kind,
      message: trimmed,
    },
  });
}

export function formatBackendLogTimestamp(timestampUtc: string): string {
  const parsed = new Date(timestampUtc);
  if (Number.isNaN(parsed.getTime())) {
    return timestampUtc;
  }
  return parsed.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  });
}

export function normalizeBackendLogLevel(level: string): AppLogLevel {
  const normalized = `${level || ""}`.trim().toLowerCase();
  if (normalized === "debug" || normalized === "trace") return "debug";
  if (normalized === "error") return "error";
  if (normalized === "warn" || normalized === "warning") return "warn";
  return "info";
}
