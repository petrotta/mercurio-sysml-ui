import { useCallback, useRef } from "react";
import { useBuildNotifications } from "./useBuildNotifications";
import { useCompileJobController } from "./useCompileJobController";
import { useSymbolRefreshController } from "./useSymbolRefreshController";

export type {
  CompileToast,
  BuildLogEntry,
  BuildProgressView,
} from "./useBuildNotifications";

type UseCompileRunnerOptions = {
  rootPath: string;
};

export function useCompileRunner({ rootPath }: UseCompileRunnerOptions) {
  const sessionTokenRef = useRef(0);
  const lastRootPathRef = useRef<string | null>(null);
  const currentRunIdRef = useRef<number | null>(null);

  if (lastRootPathRef.current !== rootPath) {
    lastRootPathRef.current = rootPath;
    sessionTokenRef.current += 1;
  }

  const notifications = useBuildNotifications({ currentRunIdRef });
  const symbolRefresh = useSymbolRefreshController({
    rootPath,
    sessionTokenRef,
    appendBuildLogEntries: notifications.appendBuildLogEntries,
    showErrorNotification: notifications.showErrorNotification,
  });
  const handleCompileSuccess = useCallback(({
    compileRoot,
    sessionToken,
  }: {
    compileRoot: string;
    runId: number;
    sessionToken: number;
  }) => {
    void symbolRefresh.refreshAfterCompile({
      compileRoot,
      sessionToken,
    });
  }, [symbolRefresh.refreshAfterCompile]);
  const compileJobs = useCompileJobController({
    rootPath,
    sessionTokenRef,
    currentRunIdRef,
    notifications,
    onCompileSuccess: handleCompileSuccess,
  });

  return {
    sessionToken: sessionTokenRef.current,
    compileStatus: notifications.compileStatus,
    setCompileStatus: notifications.setCompileStatus,
    showErrorNotification: notifications.showErrorNotification,
    compileRunId: compileJobs.compileRunId,
    compileToast: notifications.compileToast,
    runCompile: compileJobs.runCompile,
    cancelCompile: compileJobs.cancelCompile,
    symbols: symbolRefresh.symbols,
    symbolsStatus: symbolRefresh.symbolsStatus,
    parsedFiles: compileJobs.parsedFiles,
    fileDiagnosticPaths: compileJobs.fileDiagnosticPaths,
    progressUiUpdates: notifications.progressUiUpdates,
    droppedCompileRequests: compileJobs.droppedCompileRequests,
    buildLogEntries: notifications.buildLogEntries,
    clearBuildLogs: notifications.clearBuildLogs,
    buildProgress: notifications.buildProgress,
    activeLibraryPath: symbolRefresh.activeLibraryPath,
    symbolIndexError: symbolRefresh.symbolIndexError,
    semanticRefreshVersion: symbolRefresh.semanticRefreshVersion,
    applyWorkspaceSnapshot: symbolRefresh.applyWorkspaceSnapshot,
    resetWorkspaceSymbols: symbolRefresh.resetWorkspaceSymbols,
    loadStartupSymbols: symbolRefresh.loadStartupSymbols,
    refreshWorkspaceSymbols: symbolRefresh.refreshWorkspaceSymbols,
  };
}
