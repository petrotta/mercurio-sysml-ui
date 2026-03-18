import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import {
  INDEX_QUERY_MAX_PAGES,
  INDEX_QUERY_PAGE_SIZE,
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
      if (scopedFilePath) {
        const indexed = await queryProjectSymbols(path, scopedFilePath, 0, INDEX_QUERY_PAGE_SIZE);
        return (indexed || []).map((symbol) => indexedToSymbol(symbol, "project"));
      }
      const out: SymbolView[] = [];
      let offset = 0;
      for (let page = 0; page < INDEX_QUERY_MAX_PAGES; page += 1) {
        const indexed = await queryProjectSymbols(path, null, offset, INDEX_QUERY_PAGE_SIZE);
        if (!indexed?.length) break;
        out.push(...indexed.map((symbol) => indexedToSymbol(symbol, "project")));
        if (indexed.length < INDEX_QUERY_PAGE_SIZE) break;
        offset += indexed.length;
      }
      return out;
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
      const indexed = await queryProjectSymbolsForFiles(path, unique, 0, INDEX_QUERY_PAGE_SIZE * INDEX_QUERY_MAX_PAGES);
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
      if (scopedFilePath) {
        const indexed = await queryLibrarySymbols(path, scopedFilePath, 0, INDEX_QUERY_PAGE_SIZE);
        return (indexed || []).map((symbol) => indexedToSymbol(symbol, "library"));
      }
      const out: SymbolView[] = [];
      let offset = 0;
      for (let page = 0; page < INDEX_QUERY_MAX_PAGES; page += 1) {
        const indexed = await queryLibrarySymbols(path, null, offset, INDEX_QUERY_PAGE_SIZE);
        if (!indexed?.length) break;
        out.push(...indexed.map((symbol) => indexedToSymbol(symbol, "library")));
        if (indexed.length < INDEX_QUERY_PAGE_SIZE) break;
        offset += indexed.length;
      }
      return out;
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
      const indexed = await queryIndexedLibrarySymbols(path);
      if (indexed) {
        appendBuildLogEntries([{
          level: "info",
          message: `Library load complete (${indexed.length} symbols, files=${loaded?.stdlib_file_count ?? 0}, snapshot_hit=${loaded?.workspace_snapshot_hit ? "yes" : "no"})`,
        }]);
      } else {
        appendBuildLogEntries([{
          level: "warn",
          message: "Library load completed, but indexed library query failed.",
        }]);
      }
      return indexed;
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

    const incoming = indexedIncoming || [];
    if (incoming.length > 0 || !response?.project_symbol_count) {
      setProjectSemanticSymbols((prev) =>
        filePath
          ? mergeProjectSymbolsByFile(prev, incoming, filePath)
          : mergeProjectSymbolsByParsedFiles(prev, incoming, response?.parsed_files),
      );
    }

    if (response?.project_symbol_count && incoming.length === 0) {
      const message = `Project symbol refresh returned no results after compile (${response.project_symbol_count} expected).`;
      setSymbolIndexError(message);
      setSymbolsStatus("error");
      showErrorNotification(message);
    } else {
      setSymbolIndexError("");
      setSymbolsStatus("ready");
      appendBuildLogEntries([{
        level: "info",
        message: `Project symbols refreshed (${incoming.length} symbols)`,
      }]);
    }

    if (!filePath) {
      const previousLibraryPath = libraryPathRef.current;
      const responseLibraryPath = (response?.library_path || "").trim();
      const libraryPathChanged = responseLibraryPath !== previousLibraryPath;
      if (libraryPathChanged) {
        libraryBootstrapAttemptedRef.current = false;
      }
      const shouldRefreshLibrary =
        !librarySemanticSymbols.length
        || libraryPathChanged;
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
