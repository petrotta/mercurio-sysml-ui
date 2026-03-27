export type StartupSequenceResult = {
  startupOk: boolean;
  symbolsReadyMs: number;
  treesReadyMs: number;
  totalMs: number;
};

type RunWorkspaceStartupSequenceOptions = {
  loadLiveWorkspaceTrees: () => Promise<boolean>;
  loadCachedWorkspaceSymbols: () => Promise<boolean>;
  now?: () => number;
  onSymbolsReady?: (elapsedMs: number) => void;
  onTreesReady?: (elapsedMs: number) => void;
};

function defaultNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export async function runWorkspaceStartupSequence({
  loadLiveWorkspaceTrees,
  loadCachedWorkspaceSymbols,
  now = defaultNow,
  onSymbolsReady,
  onTreesReady,
}: RunWorkspaceStartupSequenceOptions): Promise<StartupSequenceResult> {
  const startedAt = now();

  let symbolsReadyMs = 0;
  let treesReadyMs = 0;

  const liveTreesPromise = loadLiveWorkspaceTrees().then((value) => {
    treesReadyMs = Math.round(now() - startedAt);
    onTreesReady?.(treesReadyMs);
    return value;
  });

  const cachedSymbolsPromise = loadCachedWorkspaceSymbols().then((value) => {
    symbolsReadyMs = Math.round(now() - startedAt);
    onSymbolsReady?.(symbolsReadyMs);
    return value;
  });

  const [_, startupOk] = await Promise.all([liveTreesPromise, cachedSymbolsPromise]);
  return {
    startupOk,
    symbolsReadyMs,
    treesReadyMs,
    totalMs: Math.round(now() - startedAt),
  };
}
