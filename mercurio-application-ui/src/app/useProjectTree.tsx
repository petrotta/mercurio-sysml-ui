import { useCallback, useMemo, useState } from "react";
import { listDirEntries } from "./fileOps";
import { normalizePathKey } from "./pathUtils";
import type { FileEntry } from "./types";

type ExpandedTree = Record<string, FileEntry[]>;

type TreeIndex = {
  rootEntries: FileEntry[];
  childrenByParent: Map<string, FileEntry[]>;
  directoryPaths: Set<string>;
};

function parentPath(path: string): string {
  const trimmed = `${path || ""}`.replace(/[\\/]+$/, "");
  const slashIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slashIndex >= 0 ? trimmed.slice(0, slashIndex) : "";
}

function buildTreeIndex(rootPath: string, manifestEntries: FileEntry[]): TreeIndex {
  const childrenByParent = new Map<string, FileEntry[]>();
  const directoryPaths = new Set<string>();
  for (const entry of manifestEntries) {
    const parentKey = normalizePathKey(parentPath(entry.path));
    const existing = childrenByParent.get(parentKey);
    if (existing) {
      existing.push(entry);
    } else {
      childrenByParent.set(parentKey, [entry]);
    }
    if (entry.is_dir) {
      directoryPaths.add(normalizePathKey(entry.path));
    }
  }
  return {
    rootEntries: childrenByParent.get(normalizePathKey(rootPath)) || [],
    childrenByParent,
    directoryPaths,
  };
}

function pruneExpandedPaths(
  expandedPaths: Record<string, boolean>,
  directoryPaths: Set<string>,
  nextRootPath: string,
): Record<string, boolean> {
  if (!nextRootPath) return {};
  const next: Record<string, boolean> = {};
  for (const path of Object.keys(expandedPaths)) {
    const normalized = normalizePathKey(path);
    if (directoryPaths.has(normalized)) {
      next[path] = true;
    }
  }
  return next;
}

async function loadTreeManifest(path: string): Promise<FileEntry[]> {
  const entries = await listDirEntries(path);
  const manifest = [...entries];
  for (const entry of entries) {
    if (!entry.is_dir) continue;
    manifest.push(...(await loadTreeManifest(entry.path)));
  }
  return manifest;
}

export function useFileTree() {
  const [rootPath, setRootPath] = useState("");
  const [manifestEntries, setManifestEntries] = useState<FileEntry[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});

  const treeIndex = useMemo(
    () => buildTreeIndex(rootPath, manifestEntries),
    [rootPath, manifestEntries],
  );

  const expanded = useMemo<ExpandedTree>(() => {
    const next: ExpandedTree = {};
    for (const path of Object.keys(expandedPaths)) {
      if (!expandedPaths[path]) continue;
      next[path] = treeIndex.childrenByParent.get(normalizePathKey(path)) || [];
    }
    return next;
  }, [expandedPaths, treeIndex]);

  const hydrateTree = useCallback((nextRootPath: string, entries: FileEntry[]) => {
    const nextIndex = buildTreeIndex(nextRootPath, entries);
    setRootPath(nextRootPath);
    setManifestEntries(entries);
    setExpandedPaths((prev) => pruneExpandedPaths(prev, nextIndex.directoryPaths, nextRootPath));
  }, []);

  const refreshRoot = useCallback(async (path: string) => {
    if (!path) {
      hydrateTree("", []);
      return;
    }
    const entries = await loadTreeManifest(path);
    hydrateTree(path, entries);
  }, [hydrateTree]);

  const toggleExpand = useCallback(async (entry: FileEntry) => {
    if (!entry.is_dir) return;
    setExpandedPaths((prev) => {
      if (prev[entry.path]) {
        const next = { ...prev };
        delete next[entry.path];
        return next;
      }
      return { ...prev, [entry.path]: true };
    });
  }, []);

  const ensureExpanded = useCallback(async (path: string) => {
    if (!path) return;
    setExpandedPaths((prev) => (prev[path] ? prev : { ...prev, [path]: true }));
  }, []);

  const expandAll = useCallback(async () => {
    const next: Record<string, boolean> = {};
    for (const entry of manifestEntries) {
      if (entry.is_dir) {
        next[entry.path] = true;
      }
    }
    setExpandedPaths(next);
  }, [manifestEntries]);

  const collapseAll = useCallback(() => {
    setExpandedPaths({});
  }, []);

  return {
    rootPath,
    treeEntries: treeIndex.rootEntries,
    expanded,
    manifestEntries,
    hydrateTree,
    refreshRoot,
    toggleExpand,
    ensureExpanded,
    expandAll,
    collapseAll,
  };
}

export function useProjectTree() {
  return useFileTree();
}
