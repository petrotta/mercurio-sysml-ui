export type StartupSequenceResult = {
  startupOk: boolean;
  projectStartupOk: boolean;
  libraryStartupOk: boolean;
  projectSymbolsReadyMs: number;
  librarySymbolsReadyMs: number;
  treesReadyMs: number;
  totalMs: number;
};

type RunWorkspaceStartupSequenceOptions = {
  loadLiveWorkspaceTrees: () => Promise<boolean>;
  loadCachedProjectSymbols: () => Promise<boolean>;
  loadCachedLibrarySymbols: () => Promise<boolean>;
  now?: () => number;
  onProjectSymbolsReady?: (elapsedMs: number) => void;
  onLibrarySymbolsReady?: (elapsedMs: number) => void;
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
  loadCachedProjectSymbols,
  loadCachedLibrarySymbols,
  now = defaultNow,
  onProjectSymbolsReady,
  onLibrarySymbolsReady,
  onTreesReady,
}: RunWorkspaceStartupSequenceOptions): Promise<StartupSequenceResult> {
  const startedAt = now();

  let projectSymbolsReadyMs = 0;
  let librarySymbolsReadyMs = 0;
  let treesReadyMs = 0;

  await loadLiveWorkspaceTrees().then((value) => {
    treesReadyMs = Math.round(now() - startedAt);
    onTreesReady?.(treesReadyMs);
    return value;
  });

  const projectSymbolsPromise = loadCachedProjectSymbols().then((value) => {
    projectSymbolsReadyMs = Math.round(now() - startedAt);
    onProjectSymbolsReady?.(projectSymbolsReadyMs);
    return value;
  });

  const librarySymbolsPromise = loadCachedLibrarySymbols().then((value) => {
    librarySymbolsReadyMs = Math.round(now() - startedAt);
    onLibrarySymbolsReady?.(librarySymbolsReadyMs);
    return value;
  });

  const [projectStartupOk, libraryStartupOk] = await Promise.all([
    projectSymbolsPromise,
    librarySymbolsPromise,
  ]);
  return {
    startupOk: projectStartupOk && libraryStartupOk,
    projectStartupOk,
    libraryStartupOk,
    projectSymbolsReadyMs,
    librarySymbolsReadyMs,
    treesReadyMs,
    totalMs: Math.round(now() - startedAt),
  };
}
