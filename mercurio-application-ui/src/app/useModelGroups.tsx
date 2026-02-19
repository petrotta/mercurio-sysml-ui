import { useMemo } from "react";
import type { SymbolView, UnresolvedIssue } from "./types";
import { isPathWithin, normalizeFsPath } from "./pathUtils";

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
    const groups = new Map<string, { path: string; list: SymbolView[] }>();
    deferredSymbols.forEach((symbol) => {
      const rawPath = symbol.file_path || "unknown";
      const key = normalizeFsPath(rawPath) || rawPath;
      if (!groups.has(key)) groups.set(key, { path: rawPath, list: [] });
      groups.get(key)?.list.push(symbol);
    });
    return Array.from(groups.values()).map((group) => ({
      path: group.path,
      list: group.list.sort(compareByParseOrder),
    }));
  }, [deferredSymbols]);

  const libraryFilePathSet = useMemo(() => {
    const set = new Set<string>();
    (libraryFilePaths || []).forEach((path) => {
      const normalized = normalizeFsPath(path);
      if (normalized) set.add(normalized);
    });
    return set;
  }, [libraryFilePaths]);

  const shouldTreatAsLibrary = (path: string) => {
    const normalized = normalizeFsPath(path);
    if (!normalized) return false;
    if (libraryFilePathSet.size > 0) {
      return libraryFilePathSet.has(normalized);
    }
    return !!libraryPath && isPathWithin(path, libraryPath);
  };

  const groupScope = (group: { path: string; list: SymbolView[] }): "project" | "library" | null => {
    if (!group.list.length) return null;
    let projectCount = 0;
    let libraryCount = 0;
    for (const symbol of group.list) {
      if (symbol.source_scope === "project") projectCount += 1;
      if (symbol.source_scope === "library") libraryCount += 1;
    }
    if (projectCount > 0 || libraryCount > 0) {
      return projectCount >= libraryCount ? "project" : "library";
    }
    return null;
  };

  const projectGroups = useMemo(() => {
    return groupedSymbols.filter((group) => {
      const scope = groupScope(group);
      if (scope === "project") return true;
      if (scope === "library") return false;
      if (shouldTreatAsLibrary(group.path)) return false;
      return rootPath ? isPathWithin(group.path, rootPath) : true;
    }).sort((a, b) => a.path.localeCompare(b.path));
  }, [groupedSymbols, rootPath, libraryPath, libraryFilePathSet]);

  const libraryGroups = useMemo(() => {
    const grouped = groupedSymbols.filter((group) => {
      const scope = groupScope(group);
      if (scope === "library") return true;
      if (scope === "project") return false;
      return shouldTreatAsLibrary(group.path);
    });
    const groupedMap = new Map(grouped.map((group) => [normalizeFsPath(group.path), group]));
    const mergedKeys = new Set<string>();
    const merged = (libraryFilePaths || []).map((path) => ({
      path,
      list: (() => {
        const norm = normalizeFsPath(path);
        mergedKeys.add(norm);
        return groupedMap.get(norm)?.list || [];
      })(),
    }));
    grouped.forEach((group) => {
      const norm = normalizeFsPath(group.path);
      if (!mergedKeys.has(norm)) {
        merged.push(group);
      }
    });
    return merged.sort((a, b) => a.path.localeCompare(b.path));
  }, [groupedSymbols, libraryPath, libraryFilePaths, libraryFilePathSet]);

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
