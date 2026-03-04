type PerfEntry = {
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  lastAt: number;
};

const PERF_STORAGE_KEY = "mercurio.perf.enabled";
const perfEntries = new Map<string, PerfEntry>();
let longTaskObserverInstalled = false;

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function isEnabled(): boolean {
  try {
    return window.localStorage?.getItem(PERF_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function setEnabled(enabled: boolean): void {
  try {
    if (enabled) {
      window.localStorage?.setItem(PERF_STORAGE_KEY, "1");
    } else {
      window.localStorage?.removeItem(PERF_STORAGE_KEY);
    }
  } catch {
    // no-op
  }
}

function record(name: string, elapsedMs: number): void {
  if (!isEnabled()) return;
  const existing = perfEntries.get(name) || {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    lastMs: 0,
    lastAt: 0,
  };
  existing.count += 1;
  existing.totalMs += elapsedMs;
  existing.maxMs = Math.max(existing.maxMs, elapsedMs);
  existing.lastMs = elapsedMs;
  existing.lastAt = Date.now();
  perfEntries.set(name, existing);
}

export function perfCount(name: string): void {
  record(name, 0);
}

export function perfStart(name: string): () => void {
  if (!isEnabled()) return () => {};
  const start = nowMs();
  return () => {
    record(name, Math.max(0, nowMs() - start));
  };
}

export function perfObserveDuration(name: string, durationMs: number): void {
  record(name, Math.max(0, durationMs || 0));
}

export function perfSnapshot(): Record<string, PerfEntry & { avgMs: number }> {
  const out: Record<string, PerfEntry & { avgMs: number }> = {};
  for (const [name, value] of perfEntries.entries()) {
    out[name] = {
      ...value,
      avgMs: value.count > 0 ? value.totalMs / value.count : 0,
    };
  }
  return out;
}

export function perfReset(): void {
  perfEntries.clear();
}

declare global {
  interface Window {
    __mercurioPerf?: {
      enable: () => void;
      disable: () => void;
      reset: () => void;
      snapshot: () => Record<string, PerfEntry & { avgMs: number }>;
      snapshotJson: () => string;
      copySnapshot: () => Promise<boolean>;
    };
  }
}

export function installPerfDebugApi(): void {
  if (typeof window === "undefined") return;
  if (window.__mercurioPerf) return;
  if (!longTaskObserverInstalled && typeof PerformanceObserver !== "undefined") {
    try {
      const obs = new PerformanceObserver((list) => {
        if (!isEnabled()) return;
        const entries = list.getEntries();
        for (const entry of entries) {
          record("browser.longtask.duration", entry.duration || 0);
        }
      });
      obs.observe({ entryTypes: ["longtask"] });
      longTaskObserverInstalled = true;
    } catch {
      // unsupported in this runtime
    }
  }
  window.__mercurioPerf = {
    enable: () => setEnabled(true),
    disable: () => setEnabled(false),
    reset: () => perfReset(),
    snapshot: () => perfSnapshot(),
    snapshotJson: () => JSON.stringify(perfSnapshot(), null, 2),
    copySnapshot: async () => {
      try {
        if (!navigator?.clipboard?.writeText) return false;
        await navigator.clipboard.writeText(JSON.stringify(perfSnapshot(), null, 2));
        return true;
      } catch {
        return false;
      }
    },
  };
}
