import { useMemo } from "react";
import type { SymbolView, UnresolvedIssue } from "./types";
import { isPathWithin } from "./pathUtils";

type CountSummary = {
  fileCount: number;
  symbolCount: number;
};

type UseModelGroupsOptions = {
  deferredSymbols: SymbolView[];
  deferredUnresolved: UnresolvedIssue[];
  rootPath: string;
  libraryPath: string | null;
  libraryFilePaths: string[];
  stdlibFileCount: number;
  librarySymbolCount: number;
  dataExcludeStdlib: boolean;
};

export function useModelGroups({
  deferredSymbols,
  deferredUnresolved,
  rootPath,
  libraryPath,
  libraryFilePaths,
  stdlibFileCount,
  librarySymbolCount,
  dataExcludeStdlib,
}: UseModelGroupsOptions) {
  const compareByParseOrder = (a: SymbolView, b: SymbolView) => {
    const aLine = a.start_line || 0;
    const bLine = b.start_line || 0;
    if (aLine !== bLine) return aLine - bLine;
    const aCol = a.start_col || 0;
    const bCol = b.start_col || 0;
    if (aCol !== bCol) return aCol - bCol;
    return (a.qualified_name || a.name || "").localeCompare(b.qualified_name || b.name || "");
  };

  const groupedSymbols = useMemo(() => {
    const groups = new Map<string, SymbolView[]>();
    deferredSymbols.forEach((symbol) => {
      const key = symbol.file_path || "unknown";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)?.push(symbol);
    });
    return Array.from(groups.entries()).map(([path, list]) => ({
      path,
      list: list.sort(compareByParseOrder),
    }));
  }, [deferredSymbols]);

  const projectGroups = useMemo(() => {
    return groupedSymbols.filter((group) => {
      if (isPathWithin(group.path, libraryPath)) return false;
      return rootPath ? isPathWithin(group.path, rootPath) : true;
    }).sort((a, b) => a.path.localeCompare(b.path));
  }, [groupedSymbols, rootPath, libraryPath]);

  const libraryGroups = useMemo(() => {
    const grouped = libraryPath ? groupedSymbols.filter((group) => isPathWithin(group.path, libraryPath)) : [];
    const groupedMap = new Map(grouped.map((group) => [group.path, group.list]));
    const merged = (libraryFilePaths || []).map((path) => ({
      path,
      list: groupedMap.get(path) || [],
    }));
    grouped.forEach((group) => {
      if (!merged.some((entry) => entry.path === group.path)) {
        merged.push(group);
      }
    });
    return merged.sort((a, b) => a.path.localeCompare(b.path));
  }, [groupedSymbols, libraryPath, libraryFilePaths]);

  const projectCounts = useMemo<CountSummary>(() => {
    const fileCount = projectGroups.length;
    const symbolCount = projectGroups.reduce((sum, group) => sum + group.list.length, 0);
    return { fileCount, symbolCount };
  }, [projectGroups]);

  const libraryCounts = useMemo<CountSummary>(() => {
    const fileCount = Math.max(libraryGroups.length, stdlibFileCount || 0);
    const loadedSymbolCount = libraryGroups.reduce((sum, group) => sum + group.list.length, 0);
    const symbolCount = Math.max(loadedSymbolCount, librarySymbolCount || 0);
    return { fileCount, symbolCount };
  }, [libraryGroups, stdlibFileCount, librarySymbolCount]);

  const errorCounts = useMemo<CountSummary>(() => {
    const fileCount = new Set(deferredUnresolved.map((entry) => entry.file_path)).size;
    const symbolCount = deferredUnresolved.length;
    return { fileCount, symbolCount };
  }, [deferredUnresolved]);

  const dataViewSymbols = useMemo(() => {
    if (!dataExcludeStdlib || !libraryPath) return deferredSymbols;
    return deferredSymbols.filter((symbol) => !isPathWithin(symbol.file_path, libraryPath));
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
