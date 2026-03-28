import { useCallback, useEffect, useMemo, useState } from "react";
import type { MutableRefObject } from "react";
import {
  indexedToSymbol,
  type SymbolsStatus,
} from "./compileShared";
import type { SymbolView, WorkspaceSymbolSnapshotResult } from "./contracts";
import { getWorkspaceSymbolSnapshot } from "./services/semanticApi";
import type { AppLogLevel } from "./services/logger";

type UseSymbolRefreshControllerOptions = {
  rootPath: string;
  sessionTokenRef: MutableRefObject<number>;
  appendBuildLogEntries: (
    entries: Array<{ level: AppLogLevel; message: string }>,
  ) => void;
  showErrorNotification: (message: string) => void;
};

export function useSymbolRefreshController({
  rootPath,
  sessionTokenRef,
  appendBuildLogEntries,
  showErrorNotification,
}: UseSymbolRefreshControllerOptions) {
  const [projectSemanticSymbols, setProjectSemanticSymbols] = useState<SymbolView[]>([]);
  const [librarySemanticSymbols, setLibrarySemanticSymbols] = useState<SymbolView[]>([]);
  const [symbolsStatus, setSymbolsStatus] = useState<SymbolsStatus>("idle");
  const [symbolIndexError, setSymbolIndexError] = useState("");
  const [activeLibraryPath, setActiveLibraryPath] = useState("");
  const [semanticRefreshVersion, setSemanticRefreshVersion] = useState(0);

  const symbols = useMemo(
    () => [...projectSemanticSymbols, ...librarySemanticSymbols],
    [projectSemanticSymbols, librarySemanticSymbols],
  );

  const resetWorkspaceSymbols = useCallback(() => {
    setProjectSemanticSymbols([]);
    setLibrarySemanticSymbols([]);
    setActiveLibraryPath("");
    setSymbolIndexError("");
    setSymbolsStatus("idle");
  }, []);

  const applyWorkspaceSnapshot = useCallback(({
    snapshot,
    sessionToken,
    reason,
  }: {
    snapshot: Pick<WorkspaceSymbolSnapshotResult, "project_symbols" | "library_symbols" | "library_path" | "diagnostics">;
    sessionToken: number;
    reason: "startup-cache" | "startup-reconcile" | "post-compile";
  }): boolean => {
    if (sessionTokenRef.current !== sessionToken) return false;
    const nextProjectSymbols = (snapshot?.project_symbols || []).map((symbol) => indexedToSymbol(symbol));
    const nextLibrarySymbols = (snapshot?.library_symbols || []).map((symbol) => indexedToSymbol(symbol));
    setProjectSemanticSymbols(nextProjectSymbols);
    setLibrarySemanticSymbols(nextLibrarySymbols);
    setActiveLibraryPath((snapshot?.library_path || "").trim());
    setSymbolIndexError("");
    setSymbolsStatus("ready");
    const diagnostics = snapshot?.diagnostics || [];
    if (diagnostics.length) {
      appendBuildLogEntries(diagnostics.map((message) => ({
        level: "warn" as const,
        message,
      })));
    }
    appendBuildLogEntries([{
      level: "info",
      message: `Workspace symbol snapshot complete (${reason}, project=${nextProjectSymbols.length}, library=${nextLibrarySymbols.length})`,
    }]);
    setSemanticRefreshVersion((prev) => prev + 1);
    return true;
  }, [appendBuildLogEntries, sessionTokenRef]);

  const loadWorkspaceSymbols = useCallback(async ({
    path,
    sessionToken,
    reason,
    hydrateLibrary,
  }: {
    path: string;
    sessionToken: number;
    reason: "startup-cache" | "startup-reconcile" | "post-compile";
    hydrateLibrary: boolean;
  }): Promise<boolean> => {
    if (!path) {
      resetWorkspaceSymbols();
      return true;
    }

    const isCurrentSession = () => sessionTokenRef.current === sessionToken;
    setSymbolsStatus("loading");
    appendBuildLogEntries([{
      level: "info",
      message: `Workspace symbol snapshot started (${reason})`,
    }]);

    try {
      const snapshot = await getWorkspaceSymbolSnapshot(path, hydrateLibrary);
      if (!isCurrentSession()) return false;
      const applied = applyWorkspaceSnapshot({
        snapshot,
        sessionToken,
        reason,
      });
      if (!applied) return false;
      appendBuildLogEntries([{
        level: "info",
        message: `Workspace symbol hydration source=${snapshot?.library_hydrated ? "live" : "cached-or-indexed"}`,
      }]);
      return true;
    } catch (error) {
      if (!isCurrentSession()) return false;
      const message = `Workspace symbol snapshot failed: ${String(error)}`;
      setSymbolIndexError(message);
      setSymbolsStatus("error");
      showErrorNotification(message);
      appendBuildLogEntries([{ level: "error", message }]);
      return false;
    }
  }, [appendBuildLogEntries, applyWorkspaceSnapshot, resetWorkspaceSymbols, sessionTokenRef, showErrorNotification]);

  const bumpSemanticRefreshVersion = useCallback(() => {
    setSemanticRefreshVersion((prev) => prev + 1);
  }, []);

  const loadStartupSymbols = useCallback(async ({
    path,
    sessionToken,
  }: {
    path: string;
    sessionToken: number;
  }) => {
    await loadWorkspaceSymbols({
      path,
      sessionToken,
      reason: "startup-cache",
      hydrateLibrary: false,
    });
  }, [loadWorkspaceSymbols]);

  const refreshWorkspaceSymbols = useCallback(async ({
    compileRoot,
    sessionToken,
    reason,
    hydrateLibrary,
  }: {
    compileRoot: string;
    sessionToken: number;
    reason: "startup-reconcile" | "post-compile";
    hydrateLibrary?: boolean;
  }) => {
    await loadWorkspaceSymbols({
      path: compileRoot,
      sessionToken,
      reason,
      hydrateLibrary: hydrateLibrary ?? true,
    });
  }, [loadWorkspaceSymbols]);

  const refreshAfterCompile = useCallback(async ({
    compileRoot,
    sessionToken,
  }: {
    compileRoot: string;
    sessionToken: number;
  }) => {
    await refreshWorkspaceSymbols({
      compileRoot,
      sessionToken,
      reason: "post-compile",
      hydrateLibrary: false,
    });
  }, [refreshWorkspaceSymbols]);

  useEffect(() => {
    if (rootPath) return;
    resetWorkspaceSymbols();
  }, [resetWorkspaceSymbols, rootPath]);

  return {
    symbols,
    symbolsStatus,
    symbolIndexError,
    activeLibraryPath,
    semanticRefreshVersion,
    applyWorkspaceSnapshot,
    resetWorkspaceSymbols,
    loadStartupSymbols,
    bumpSemanticRefreshVersion,
    refreshWorkspaceSymbols,
    refreshAfterCompile,
  };
}
