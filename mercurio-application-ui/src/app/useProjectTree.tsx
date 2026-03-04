import { useCallback, useEffect, useRef, useState } from "react";
import { listDirEntries } from "./fileOps";
import type { FileEntry } from "./types";

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
    setTreeEntries(entries);
    setExpanded({});
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

  return { treeEntries, expanded, refreshRoot, toggleExpand, expandAll, collapseAll };
}
