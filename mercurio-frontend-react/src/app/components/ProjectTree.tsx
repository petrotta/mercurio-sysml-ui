import type { FileEntry } from "../types";
import type { MouseEvent } from "react";

type ProjectTreeProps = {
  treeEntries: FileEntry[];
  expanded: Record<string, FileEntry[]>;
  onOpenFile: (entry: FileEntry) => void | Promise<void>;
  onContextMenu: (event: MouseEvent, entry: FileEntry) => void;
  onRootContextMenu: (event: MouseEvent) => void;
};

export function ProjectTree({
  treeEntries,
  expanded,
  onOpenFile,
  onContextMenu,
  onRootContextMenu,
}: ProjectTreeProps) {
  const renderEntries = (entries: FileEntry[], depth = 0) => {
    return entries.map((entry) => {
      const isExpanded = Boolean(expanded[entry.path]);
      const ext = entry.name.toLowerCase().split(".").pop() || "";
      const iconLabel =
        entry.is_dir
          ? ""
          : ext === "sysml"
            ? "s"
            : ext === "kerml"
              ? "k"
              : ext === "json" || ext === "jsonld"
                ? "{}"
                : "";
      return (
        <div key={`${entry.path}-${depth}`} className="tree-node">
          <div
            className={`tree-row ${entry.is_dir ? "dir" : "file"}`}
            style={{ paddingLeft: `${10 + depth * 14}px` }}
            onClick={() => onOpenFile(entry)}
            onContextMenu={(event) => onContextMenu(event, entry)}
          >
            <span className="tree-caret">{entry.is_dir ? (isExpanded ? "v" : ">") : ""}</span>
            <span className={`tree-icon ${entry.is_dir ? "folder" : "file"}`}>
              {iconLabel ? <span className="tree-icon-label">{iconLabel}</span> : null}
            </span>
            <span className="tree-label">{entry.name}</span>
          </div>
          {entry.is_dir && isExpanded ? (
            <div className="tree-children">
              {renderEntries(expanded[entry.path] || [], depth + 1)}
            </div>
          ) : null}
        </div>
      );
    });
  };

  return (
    <div className="file-tree" onContextMenu={onRootContextMenu}>
      {renderEntries(treeEntries, 0)}
    </div>
  );
}
