import { useCallback, useEffect, useRef, useState } from "react";
import { listDirEntries } from "./fileOps";
import type { FileEntry } from "./types";

export function useProjectTree() {
  const [treeEntries, setTreeEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, FileEntry[]>>({});
  const expandedRef = useRef<Record<string, FileEntry[]>>({});

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

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

  return { treeEntries, expanded, refreshRoot, toggleExpand };
}
