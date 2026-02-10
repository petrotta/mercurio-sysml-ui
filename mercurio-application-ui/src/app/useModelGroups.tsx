import { useMemo } from "react";
import type { SymbolView, UnresolvedIssue } from "./types";

type CountSummary = {
  fileCount: number;
  symbolCount: number;
};

type UseModelGroupsOptions = {
  deferredSymbols: SymbolView[];
  deferredUnresolved: UnresolvedIssue[];
  rootPath: string;
  libraryPath: string | null;
  dataExcludeStdlib: boolean;
};

export function useModelGroups({
  deferredSymbols,
  deferredUnresolved,
  rootPath,
  libraryPath,
  dataExcludeStdlib,
}: UseModelGroupsOptions) {
  const groupedSymbols = useMemo(() => {
    const groups = new Map<string, SymbolView[]>();
    deferredSymbols.forEach((symbol) => {
      const key = symbol.file_path || "unknown";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)?.push(symbol);
    });
    return Array.from(groups.entries()).map(([path, list]) => ({
      path,
      list: list.sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }, [deferredSymbols]);

  const projectGroups = useMemo(() => {
    const prefix = rootPath ? rootPath.toLowerCase() : "";
    const libPrefix = libraryPath ? libraryPath.toLowerCase() : "";
    return groupedSymbols.filter((group) => {
      const path = group.path.toLowerCase();
      if (libPrefix && path.startsWith(libPrefix)) return false;
      return prefix ? path.startsWith(prefix) : true;
    });
  }, [groupedSymbols, rootPath, libraryPath]);

  const libraryGroups = useMemo(() => {
    const libPrefix = libraryPath ? libraryPath.toLowerCase() : "";
    if (!libPrefix) return [];
    return groupedSymbols.filter((group) => group.path.toLowerCase().startsWith(libPrefix));
  }, [groupedSymbols, libraryPath]);

  const projectCounts = useMemo<CountSummary>(() => {
    const fileCount = projectGroups.length;
    const symbolCount = projectGroups.reduce((sum, group) => sum + group.list.length, 0);
    return { fileCount, symbolCount };
  }, [projectGroups]);

  const libraryCounts = useMemo<CountSummary>(() => {
    const fileCount = libraryGroups.length;
    const symbolCount = libraryGroups.reduce((sum, group) => sum + group.list.length, 0);
    return { fileCount, symbolCount };
  }, [libraryGroups]);

  const errorCounts = useMemo<CountSummary>(() => {
    const fileCount = new Set(deferredUnresolved.map((entry) => entry.file_path)).size;
    const symbolCount = deferredUnresolved.length;
    return { fileCount, symbolCount };
  }, [deferredUnresolved]);

  const dataViewSymbols = useMemo(() => {
    if (!dataExcludeStdlib || !libraryPath) return deferredSymbols;
    const libPrefix = libraryPath.toLowerCase();
    return deferredSymbols.filter((symbol) => !(symbol.file_path || "").toLowerCase().startsWith(libPrefix));
  }, [deferredSymbols, dataExcludeStdlib, libraryPath]);

  const dataViewSymbolKindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    dataViewSymbols.forEach((symbol) => {
      const key = symbol.kind || "Unknown";
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [dataViewSymbols]);

  return {
    groupedSymbols,
    projectGroups,
    libraryGroups,
    projectCounts,
    libraryCounts,
    errorCounts,
    dataViewSymbols,
    dataViewSymbolKindCounts,
  };
}
