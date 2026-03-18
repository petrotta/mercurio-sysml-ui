import { useRef } from "react";
import { clearSemanticElementCache } from "./services/semanticApi";
import type { UnsavedCompileInput } from "./compileShared";
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
  const compileJobs = useCompileJobController({
    rootPath,
    sessionTokenRef,
    currentRunIdRef,
    notifications,
    onCompileSuccess: ({ compileRoot, filePath, response, sessionToken }) => {
      clearSemanticElementCache(compileRoot || undefined);
      symbolRefresh.bumpSemanticRefreshVersion();
      symbolRefresh.applyCompileResponseSymbols({ filePath, response });
      void symbolRefresh.refreshAfterCompile({
        compileRoot,
        filePath,
        response,
        sessionToken,
      });
    },
  });

  return {
    compileStatus: notifications.compileStatus,
    setCompileStatus: notifications.setCompileStatus,
    compileRunId: compileJobs.compileRunId,
    compileToast: notifications.compileToast,
    runCompile: (filePath?: string, unsavedInputs?: UnsavedCompileInput[]) =>
      compileJobs.runCompile(filePath, unsavedInputs),
    cancelCompile: compileJobs.cancelCompile,
    symbols: symbolRefresh.symbols,
    symbolsStatus: symbolRefresh.symbolsStatus,
    unresolved: compileJobs.unresolved,
    parsedFiles: compileJobs.parsedFiles,
    parseErrorPaths: compileJobs.parseErrorPaths,
    progressUiUpdates: notifications.progressUiUpdates,
    droppedCompileRequests: compileJobs.droppedCompileRequests,
    buildLogEntries: notifications.buildLogEntries,
    clearBuildLogs: notifications.clearBuildLogs,
    buildProgress: notifications.buildProgress,
    activeLibraryPath: symbolRefresh.activeLibraryPath,
    symbolIndexError: symbolRefresh.symbolIndexError,
    semanticRefreshVersion: symbolRefresh.semanticRefreshVersion,
  };
}
