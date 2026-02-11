import type { FileEntry } from "../types";
import type { MouseEvent } from "react";

type ProjectTreeProps = {
  treeEntries: FileEntry[];
  expanded: Record<string, FileEntry[]>;
  onOpenFile: (entry: FileEntry) => void | Promise<void>;
  onContextMenu: (event: MouseEvent, entry: FileEntry) => void;
  onRootContextMenu: (event: MouseEvent) => void;
  showOnlyModelFiles: boolean;
  parseErrorPaths: Set<string>;
};

export function ProjectTree({
  treeEntries,
  expanded,
  onOpenFile,
  onContextMenu,
  onRootContextMenu,
  showOnlyModelFiles,
  parseErrorPaths,
}: ProjectTreeProps) {
  const isModelFile = (entry: FileEntry) => {
    const ext = entry.name.toLowerCase().split(".").pop() || "";
    return ext === "sysml" || ext === "kerml";
  };

  const renderEntries = (entries: FileEntry[], depth = 0) => {
    return entries.map((entry) => {
      if (!entry.is_dir && showOnlyModelFiles && !isModelFile(entry)) {
        return null;
      }
      const isExpanded = Boolean(expanded[entry.path]);
      const ext = entry.name.toLowerCase().split(".").pop() || "";
      const isDiagram = !entry.is_dir && ext === "diagram";
      const iconLabel =
        entry.is_dir
          ? ""
          : ext === "sysml"
            ? "s"
            : ext === "kerml"
              ? "k"
              : ext === "diagram"
                ? "d"
              : ext === "json" || ext === "jsonld"
                ? "{}"
                : "";
      const iconClass = entry.is_dir ? "folder" : isDiagram ? "file diagram" : "file";
      const hasParseError = !entry.is_dir && parseErrorPaths.has(entry.path);
      return (
        <div key={`${entry.path}-${depth}`} className="tree-node">
          <div
            className={`tree-row ${entry.is_dir ? "dir" : "file"} ${hasParseError ? "tree-row-error" : ""}`}
            onClick={() => onOpenFile(entry)}
            onContextMenu={(event) => onContextMenu(event, entry)}
          >
            <span className="tree-caret">{entry.is_dir ? (isExpanded ? "v" : ">") : ""}</span>
            <span className={`tree-icon ${iconClass}`}>
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
