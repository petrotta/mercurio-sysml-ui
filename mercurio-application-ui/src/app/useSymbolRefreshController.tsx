import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import {
  INDEX_QUERY_LIMIT,
  POST_COMPILE_SYMBOL_REFRESH_DELAY_MS,
  POST_COMPILE_SYMBOL_REFRESH_RETRIES,
  delay,
  indexedToSymbol,
  mergeProjectSymbolsByFile,
  mergeProjectSymbolsByParsedFiles,
  mergeSymbols,
  type CompileResponse,
  type SymbolsStatus,
} from "./compileShared";
import type { SymbolView } from "./types";
import {
  loadLibrarySymbols,
  queryLibrarySymbols,
  queryProjectSymbols,
  queryProjectSymbolsForFiles,
} from "./services/semanticApi";

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

  const libraryPathRef = useRef("");
  const libraryBootstrapAttemptedRef = useRef(false);

  const symbols = useMemo(
    () => mergeSymbols([...projectSemanticSymbols, ...librarySemanticSymbols]),
    [projectSemanticSymbols, librarySemanticSymbols],
  );

  const queryIndexedProjectSymbols = useCallback(async (
    path: string,
    scopedFilePath?: string,
  ): Promise<SymbolView[] | null> => {
    if (!path) return [];
    try {
      const indexed = await queryProjectSymbols(path, scopedFilePath ?? null, 0, INDEX_QUERY_LIMIT);
      return (indexed || []).map((symbol) => indexedToSymbol(symbol, "project"));
    } catch {
      return null;
    }
  }, []);

  const queryIndexedProjectSymbolsForFiles = useCallback(async (
    path: string,
    filePaths: string[],
  ): Promise<SymbolView[] | null> => {
    const unique = Array.from(
      new Set((filePaths || []).map((filePath) => filePath?.trim()).filter((filePath): filePath is string => !!filePath)),
    );
    if (!unique.length) return [];
    try {
      const indexed = await queryProjectSymbolsForFiles(path, unique, 0, INDEX_QUERY_LIMIT);
      return (indexed || []).map((symbol) => indexedToSymbol(symbol, "project"));
    } catch {
      return null;
    }
  }, []);

  const queryIndexedLibrarySymbols = useCallback(async (
    path: string,
    scopedFilePath?: string,
  ): Promise<SymbolView[] | null> => {
    if (!path) return [];
    try {
      const indexed = await queryLibrarySymbols(path, scopedFilePath ?? null, 0, INDEX_QUERY_LIMIT);
      return (indexed || []).map((symbol) => indexedToSymbol(symbol, "library"));
    } catch {
      return null;
    }
  }, []);

  const loadProjectSymbolsWithRetry = useCallback(async ({
    path,
    scopedFilePath,
    parsedFiles,
    expectedSymbols = 0,
  }: {
    path: string;
    scopedFilePath?: string;
    parsedFiles?: string[];
    expectedSymbols?: number;
  }): Promise<SymbolView[] | null> => {
    let indexedIncoming: SymbolView[] | null = null;
    for (let attempt = 0; attempt < POST_COMPILE_SYMBOL_REFRESH_RETRIES; attempt += 1) {
      if (scopedFilePath) {
        indexedIncoming = await queryIndexedProjectSymbols(path, scopedFilePath);
      } else if (parsedFiles?.length) {
        indexedIncoming = await queryIndexedProjectSymbolsForFiles(path, parsedFiles);
      } else {
        indexedIncoming = await queryIndexedProjectSymbols(path);
      }
      const shouldRetry =
        (!indexedIncoming || indexedIncoming.length === 0)
        && expectedSymbols > 0;
      if (!shouldRetry || attempt === POST_COMPILE_SYMBOL_REFRESH_RETRIES - 1) {
        break;
      }
      await delay(POST_COMPILE_SYMBOL_REFRESH_DELAY_MS);
    }
    if ((!indexedIncoming || indexedIncoming.length === 0) && !scopedFilePath && expectedSymbols > 0) {
      indexedIncoming = await queryIndexedProjectSymbols(path);
    }
    return indexedIncoming;
  }, [queryIndexedProjectSymbols, queryIndexedProjectSymbolsForFiles]);

  const hydrateLibraryIndexIfNeeded = useCallback(async (
    path: string,
    reason: "startup" | "post-compile",
  ): Promise<SymbolView[] | null> => {
    if (!path || libraryBootstrapAttemptedRef.current) return null;
    libraryBootstrapAttemptedRef.current = true;
    appendBuildLogEntries([{
      level: "info",
      message: `Library index empty; loading stdlib symbols (${reason})`,
    }]);
    try {
      const loaded = await loadLibrarySymbols(path, null, true);
      const resolvedLibraryPath = (loaded?.library_path || "").trim();
      if (resolvedLibraryPath) {
        setActiveLibraryPath(resolvedLibraryPath);
        libraryPathRef.current = resolvedLibraryPath;
      }
      const loadedSymbols = mergeSymbols(
        (loaded?.symbols || []).map((symbol) => ({ ...symbol, source_scope: "library" as const })),
      );
      if (loadedSymbols.length) {
        appendBuildLogEntries([{
          level: "info",
          message: `Library load complete (${loadedSymbols.length} symbols, files=${loaded?.stdlib_file_count ?? 0}, snapshot_hit=${loaded?.workspace_snapshot_hit ? "yes" : "no"})`,
        }]);
      } else {
        appendBuildLogEntries([{
          level: "warn",
          message: "Library load completed, but returned no symbols.",
        }]);
      }
      return loadedSymbols;
    } catch (error) {
      appendBuildLogEntries([{
        level: "warn",
        message: `Library load failed: ${String(error)}`,
      }]);
      return null;
    }
  }, [appendBuildLogEntries, queryIndexedLibrarySymbols]);

  const bumpSemanticRefreshVersion = useCallback(() => {
    setSemanticRefreshVersion((prev) => prev + 1);
  }, []);

  const applyCompileResponseSymbols = useCallback(({
    filePath,
    response,
  }: {
    filePath?: string;
    response: CompileResponse;
  }) => {
    const responseSymbols = Array.isArray(response?.symbols)
      ? response.symbols.filter((symbol) => symbol?.source_scope !== "library")
      : [];
    if (!responseSymbols.length) return;
    setProjectSemanticSymbols((prev) =>
      filePath
        ? mergeProjectSymbolsByFile(prev, responseSymbols, filePath)
        : mergeProjectSymbolsByParsedFiles(prev, responseSymbols, response?.parsed_files),
    );
  }, []);

  const refreshAfterCompile = useCallback(async ({
    compileRoot,
    filePath,
    response,
    sessionToken,
  }: {
    compileRoot: string;
    filePath?: string;
    response: CompileResponse;
    sessionToken: number;
  }) => {
    const isCurrentSession = () => sessionTokenRef.current === sessionToken;
    setSymbolsStatus("loading");
    appendBuildLogEntries([{
      level: "info",
      message: `Symbol refresh started (run=post-compile, mode=${filePath ? "file" : "delta"})`,
    }]);
    const responseSymbols = Array.isArray(response?.symbols) ? response.symbols : [];
    let projectRefreshCount = responseSymbols.length;
    if (!responseSymbols.length && response?.project_symbol_count) {
      const indexedIncoming = await loadProjectSymbolsWithRetry({
        path: compileRoot,
        scopedFilePath: filePath,
        parsedFiles: response?.parsed_files,
        expectedSymbols: response?.project_symbol_count || 0,
      });
      if (!isCurrentSession()) return;
      if (indexedIncoming === null) {
        const message = "Project symbol refresh failed.";
        setSymbolIndexError(message);
        setSymbolsStatus("error");
        showErrorNotification(message);
        return;
      }

      projectRefreshCount = indexedIncoming.length;
      if (indexedIncoming.length > 0 || !response?.project_symbol_count) {
        setProjectSemanticSymbols((prev) =>
          filePath
            ? mergeProjectSymbolsByFile(prev, indexedIncoming, filePath)
            : mergeProjectSymbolsByParsedFiles(prev, indexedIncoming, response?.parsed_files),
        );
      }
      if (response?.project_symbol_count && indexedIncoming.length === 0) {
        const message = `Project symbol refresh returned no results after compile (${response.project_symbol_count} expected).`;
        setSymbolIndexError(message);
        setSymbolsStatus("error");
        showErrorNotification(message);
        return;
      }
    }

    if (!isCurrentSession()) return;
    setSymbolIndexError("");
    setSymbolsStatus("ready");
    appendBuildLogEntries([{
      level: "info",
      message: `Project symbols refreshed (${projectRefreshCount} symbols)`,
    }]);

    if (!filePath) {
      const previousLibraryPath = libraryPathRef.current;
      const responseLibraryPath = (response?.library_path || "").trim();
      const libraryPathChanged = responseLibraryPath !== previousLibraryPath;
      if (libraryPathChanged) {
        libraryBootstrapAttemptedRef.current = false;
      }
      const shouldRefreshLibrary = !librarySemanticSymbols.length || libraryPathChanged;
      if (shouldRefreshLibrary) {
        let libraryIncoming = await queryIndexedLibrarySymbols(compileRoot);
        if (!isCurrentSession()) return;
        if (!libraryIncoming || !libraryIncoming.length) {
          const hydrated = await hydrateLibraryIndexIfNeeded(compileRoot, "post-compile");
          if (!isCurrentSession()) return;
          if (hydrated) {
            libraryIncoming = hydrated;
          }
        }
        if (libraryIncoming) {
          setLibrarySemanticSymbols(mergeSymbols(libraryIncoming));
          appendBuildLogEntries([{
            level: "info",
            message: `Library symbols refreshed (${libraryIncoming.length} symbols)`,
          }]);
        } else {
          showErrorNotification("Library symbol refresh failed.");
        }
      }
      libraryPathRef.current = responseLibraryPath;
    }
  }, [
    appendBuildLogEntries,
    hydrateLibraryIndexIfNeeded,
    librarySemanticSymbols.length,
    loadProjectSymbolsWithRetry,
    queryIndexedLibrarySymbols,
    sessionTokenRef,
    showErrorNotification,
  ]);

  useEffect(() => {
    const sessionToken = sessionTokenRef.current;
    let active = true;
    setProjectSemanticSymbols([]);
    setLibrarySemanticSymbols([]);
    setSymbolIndexError("");
    libraryBootstrapAttemptedRef.current = false;
    libraryPathRef.current = "";
    setActiveLibraryPath("");
    if (!rootPath) {
      setSymbolsStatus("idle");
      return () => {
        active = false;
      };
    }
    setSymbolsStatus("loading");
    void (async () => {
      const [projectSymbolsFromIndex, librarySymbolsFromIndex] = await Promise.all([
        loadProjectSymbolsWithRetry({ path: rootPath, expectedSymbols: 1 }),
        queryIndexedLibrarySymbols(rootPath),
      ]);
      if (!active || sessionTokenRef.current !== sessionToken) return;
      if (projectSymbolsFromIndex === null) {
        const message = "Project symbols could not be loaded.";
        setSymbolIndexError(message);
        setSymbolsStatus("error");
        showErrorNotification(message);
        return;
      }
      setProjectSemanticSymbols(mergeSymbols(projectSymbolsFromIndex));
      let resolvedLibrarySymbols = librarySymbolsFromIndex;
      if (!resolvedLibrarySymbols || resolvedLibrarySymbols.length === 0) {
        const hydrated = await hydrateLibraryIndexIfNeeded(rootPath, "startup");
        if (!active || sessionTokenRef.current !== sessionToken) return;
        if (hydrated) {
          resolvedLibrarySymbols = hydrated;
        }
      }
      if (resolvedLibrarySymbols) {
        setLibrarySemanticSymbols(mergeSymbols(resolvedLibrarySymbols));
      }
      setSymbolsStatus("ready");
    })();
    return () => {
      active = false;
    };
  }, [
    rootPath,
    hydrateLibraryIndexIfNeeded,
    loadProjectSymbolsWithRetry,
    queryIndexedLibrarySymbols,
    sessionTokenRef,
    showErrorNotification,
  ]);

  return {
    symbols,
    symbolsStatus,
    symbolIndexError,
    activeLibraryPath,
    semanticRefreshVersion,
    bumpSemanticRefreshVersion,
    applyCompileResponseSymbols,
    refreshAfterCompile,
  };
}
