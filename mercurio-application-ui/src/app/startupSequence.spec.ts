import { runWorkspaceStartupSequence } from "./startupSequence.js";

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    fail(message);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function testStartupSequenceLoadsTreesBeforeCacheOverlays(): Promise<void> {
  const result = await runWorkspaceStartupSequence({
    loadLiveWorkspaceTrees: async () => {
      await delay(25);
      return true;
    },
    loadCachedProjectSymbols: async () => {
      await delay(40);
      return true;
    },
    loadCachedLibrarySymbols: async () => {
      await delay(15);
      return true;
    },
  });

  assert(result.startupOk, "startup sequence should report cache success");
  assert(result.treesReadyMs > 0, "trees should report a ready time");
  assert(result.projectSymbolsReadyMs >= result.treesReadyMs, "project overlay should start after trees");
  assert(result.librarySymbolsReadyMs >= result.treesReadyMs, "library overlay should start after trees");
}

async function testStartupSequenceTracksIndependentProjectAndLibraryResults(): Promise<void> {
  const result = await runWorkspaceStartupSequence({
    loadLiveWorkspaceTrees: async () => {
      await delay(10);
      return true;
    },
    loadCachedProjectSymbols: async () => {
      await delay(20);
      return false;
    },
    loadCachedLibrarySymbols: async () => {
      await delay(30);
      return true;
    },
  });

  assert(!result.startupOk, "startup should be false when either overlay fails");
  assert(!result.projectStartupOk, "project startup status should reflect the miss");
  assert(result.libraryStartupOk, "library startup status should reflect the hit");
  assert(
    result.projectSymbolsReadyMs >= 10 && result.projectSymbolsReadyMs < 80,
    `project timing should be recorded; project_ready_ms=${result.projectSymbolsReadyMs}`,
  );
  assert(
    result.librarySymbolsReadyMs >= 10 && result.librarySymbolsReadyMs < 90,
    `library timing should be recorded; library_ready_ms=${result.librarySymbolsReadyMs}`,
  );
}

async function run(): Promise<void> {
  await testStartupSequenceLoadsTreesBeforeCacheOverlays();
  await testStartupSequenceTracksIndependentProjectAndLibraryResults();
}

void run();
