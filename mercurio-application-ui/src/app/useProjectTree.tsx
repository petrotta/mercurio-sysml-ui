import { useCallback, useEffect, useRef, useState } from "react";
import { listDirEntries } from "./fileOps";
import type { FileEntry } from "./types";

function normalizeTreePath(path: string): string {
  return path.replace(/[\\/]+$/, "").toLowerCase();
}

function isSameOrChildPath(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeTreePath(root);
  const normalizedCandidate = normalizeTreePath(candidate);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}\\`)
    || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

export function useProjectTree() {
  const [treeEntries, setTreeEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, FileEntry[]>>({});
  const expandedRef = useRef<Record<string, FileEntry[]>>({});
  const treeEntriesRef = useRef<FileEntry[]>([]);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    treeEntriesRef.current = treeEntries;
  }, [treeEntries]);

  const refreshRoot = useCallback(async (path: string) => {
    const entries = await listDirEntries(path);
    const previouslyExpanded = Object.keys(expandedRef.current)
      .filter((entryPath) => isSameOrChildPath(path, entryPath))
      .sort((left, right) => left.length - right.length);

    const nextExpanded: Record<string, FileEntry[]> = {};
    for (const entryPath of previouslyExpanded) {
      try {
        nextExpanded[entryPath] = await listDirEntries(entryPath);
      } catch {
        // Ignore folders that no longer exist or are temporarily unavailable.
      }
    }

    setTreeEntries(entries);
    setExpanded(nextExpanded);
  }, []);

  const toggleExpand = useCallback(async (entry: FileEntry) => {
    if (!entry.is_dir) return;
    if (expandedRef.current[entry.path]) {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[entry.path];
        return next;
      });
      return;
    }
    const children = await listDirEntries(entry.path);
    setExpanded((prev) => ({ ...prev, [entry.path]: children }));
  }, []);

  const ensureExpanded = useCallback(async (path: string) => {
    if (!path || expandedRef.current[path]) return;
    const children = await listDirEntries(path);
    setExpanded((prev) => {
      if (prev[path]) return prev;
      return { ...prev, [path]: children };
    });
  }, []);

  const expandAll = useCallback(async () => {
    const rootEntries = treeEntriesRef.current;
    if (!rootEntries.length) {
      setExpanded({});
      return;
    }
    const nextExpanded: Record<string, FileEntry[]> = {};
    const queue: FileEntry[] = [...rootEntries];
    while (queue.length) {
      const current = queue.shift();
      if (!current || !current.is_dir) continue;
      const children = await listDirEntries(current.path);
      nextExpanded[current.path] = children;
      for (const child of children) {
        if (child.is_dir) {
          queue.push(child);
        }
      }
    }
    setExpanded(nextExpanded);
  }, []);

  const collapseAll = useCallback(() => {
    setExpanded({});
  }, []);

  return { treeEntries, expanded, refreshRoot, toggleExpand, ensureExpanded, expandAll, collapseAll };
}