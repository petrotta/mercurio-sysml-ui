import { useCallback, useEffect, useMemo, useState } from "react";
import type { MutableRefObject } from "react";
import {
  indexedToSymbol,
  type SymbolsStatus,
} from "./compileShared";
import type { SymbolView } from "./contracts";
import { getWorkspaceSymbolSnapshot } from "./services/semanticApi";

type UseSymbolRefreshControllerOptions = {
  rootPath: string;
  sessionTokenRef: MutableRefObject<number>;
  appendBuildLogEntries: (
    entries: Array<{ level: "info" | "warn" | "error"; message: string }>,
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

  const loadWorkspaceSymbols = useCallback(async ({
    path,
    sessionToken,
    reason,
  }: {
    path: string;
    sessionToken: number;
    reason: "startup" | "post-compile";
  }): Promise<boolean> => {
    if (!path) {
      setProjectSemanticSymbols([]);
      setLibrarySemanticSymbols([]);
      setActiveLibraryPath("");
      setSymbolsStatus("idle");
      setSymbolIndexError("");
      return true;
    }

    const isCurrentSession = () => sessionTokenRef.current === sessionToken;
    setSymbolsStatus("loading");
    appendBuildLogEntries([{
      level: "info",
      message: `Workspace symbol snapshot started (${reason})`,
    }]);

    try {
      const snapshot = await getWorkspaceSymbolSnapshot(path, true);
      if (!isCurrentSession()) return false;

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
        message: `Workspace symbol snapshot complete (project=${nextProjectSymbols.length}, library=${nextLibrarySymbols.length}, hydrated=${snapshot?.library_hydrated ? "yes" : "no"})`,
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
  }, [appendBuildLogEntries, sessionTokenRef, showErrorNotification]);

  const bumpSemanticRefreshVersion = useCallback(() => {
    setSemanticRefreshVersion((prev) => prev + 1);
  }, []);

  const refreshAfterCompile = useCallback(async ({
    compileRoot,
    sessionToken,
  }: {
    compileRoot: string;
    sessionToken: number;
  }) => {
    await loadWorkspaceSymbols({
      path: compileRoot,
      sessionToken,
      reason: "post-compile",
    });
  }, [loadWorkspaceSymbols]);

  useEffect(() => {
    const sessionToken = sessionTokenRef.current;
    let active = true;
    setProjectSemanticSymbols([]);
    setLibrarySemanticSymbols([]);
    setSymbolIndexError("");
    setActiveLibraryPath("");
    if (!rootPath) {
      setSymbolsStatus("idle");
      return () => {
        active = false;
      };
    }

    void (async () => {
      const loaded = await loadWorkspaceSymbols({
        path: rootPath,
        sessionToken,
        reason: "startup",
      });
      if (!active || sessionTokenRef.current !== sessionToken) return;
      if (!loaded && symbolsStatus !== "error") {
        setSymbolsStatus("error");
      }
    })();

    return () => {
      active = false;
    };
  }, [loadWorkspaceSymbols, rootPath, sessionTokenRef]);

  return {
    symbols,
    symbolsStatus,
    symbolIndexError,
    activeLibraryPath,
    semanticRefreshVersion,
    bumpSemanticRefreshVersion,
    refreshAfterCompile,
  };
}
