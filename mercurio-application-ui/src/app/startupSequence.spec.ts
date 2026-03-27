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

async function testStartupSequenceDoesNotBlockSymbolsOnTrees(): Promise<void> {
  const result = await runWorkspaceStartupSequence({
    loadLiveWorkspaceTrees: async () => {
      await delay(80);
      return true;
    },
    loadCachedWorkspaceSymbols: async () => {
      await delay(15);
      return true;
    },
  });

  assert(result.startupOk, "startup sequence should report cached symbol success");
  assert(result.symbolsReadyMs > 0, "symbols should report a ready time");
  assert(result.treesReadyMs > 0, "trees should report a ready time");
  assert(
    result.symbolsReadyMs < result.treesReadyMs,
    `symbols should become ready before trees; symbols=${result.symbolsReadyMs} trees=${result.treesReadyMs}`,
  );
  assert(
    result.symbolsReadyMs < 50,
    `symbols should not be serialized behind tree load; symbols_ready_ms=${result.symbolsReadyMs}`,
  );
}

async function testStartupSequenceReturnsSymbolTimingOnCacheMiss(): Promise<void> {
  const result = await runWorkspaceStartupSequence({
    loadLiveWorkspaceTrees: async () => {
      await delay(10);
      return true;
    },
    loadCachedWorkspaceSymbols: async () => {
      await delay(20);
      return false;
    },
  });

  assert(!result.startupOk, "startup sequence should report cached symbol failure on miss");
  assert(
    result.symbolsReadyMs >= 15 && result.symbolsReadyMs < 80,
    `symbol timing should still be recorded on miss; symbols_ready_ms=${result.symbolsReadyMs}`,
  );
}

async function run(): Promise<void> {
  await testStartupSequenceDoesNotBlockSymbolsOnTrees();
  await testStartupSequenceReturnsSymbolTimingOnCacheMiss();
}

void run();
