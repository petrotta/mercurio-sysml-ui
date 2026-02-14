import { useMemo } from "react";
import type { ModelRow, SymbolNode, SymbolView, UnresolvedIssue } from "./types";

type SymbolGroup = {
  path: string;
  list: SymbolView[];
};

type CountSummary = {
  fileCount: number;
  symbolCount: number;
};

type ModelSectionOpen = { project: boolean; library: boolean; errors: boolean };

type UseModelTreeOptions = {
  projectGroups: SymbolGroup[];
  libraryGroups: SymbolGroup[];
  deferredUnresolved: UnresolvedIssue[];
  modelExpanded: Record<string, boolean>;
  collapseAllModel: boolean;
  modelSectionOpen: ModelSectionOpen;
  projectCounts: CountSummary;
  libraryCounts: CountSummary;
  errorCounts: CountSummary;
  projectSymbolsLoaded: boolean;
  getKindKey: (kind: string) => string;
  showUsages: boolean;
  modelSortBy: "name" | "qualified_name";
  modelShowFiles: boolean;
};

export function useModelTree({
  projectGroups,
  libraryGroups,
  deferredUnresolved,
  modelExpanded,
  collapseAllModel,
  modelSectionOpen,
  projectCounts,
  libraryCounts,
  errorCounts,
  projectSymbolsLoaded,
  getKindKey,
  showUsages,
  modelSortBy,
  modelShowFiles,
}: UseModelTreeOptions) {
  const buildSymbolTree = (list: SymbolView[]) => {
    const root: SymbolNode = {
      name: "root",
      fullName: "",
      symbols: [],
      children: new Map(),
    };
    list.forEach((symbol) => {
      const qualified = symbol.qualified_name || symbol.name;
      const segments = qualified.split("::").filter(Boolean);
      let cursor = root;
      segments.forEach((segment, index) => {
        if (!cursor.children.has(segment)) {
          cursor.children.set(segment, {
            name: segment,
            fullName: cursor.fullName ? `${cursor.fullName}::${segment}` : segment,
            symbols: [],
            children: new Map(),
          });
        }
        cursor = cursor.children.get(segment)!;
        if (index === segments.length - 1) {
          cursor.symbols.push(symbol);
        }
      });
    });
    return root;
  };

  const isUsageSymbol = (symbol: SymbolView) => {
    return (symbol.properties || []).some((prop) => prop.name.startsWith("usage_"));
  };

  const buildRowsForTree = (
    root: SymbolNode,
    rootLabel: string | undefined,
    rootKey: string,
    expanded: Record<string, boolean>,
    collapseAll: boolean,
  ) => {
    const rows: Array<{
      id: string;
      name: string;
      kindLabel: string;
      kindKey: string;
      depth: number;
      node: SymbolNode;
      hasChildren: boolean;
      expanded: boolean;
    }> = [];
    const walk = (node: SymbolNode, depth: number, isTop: boolean, pathKey: string) => {
      const displayName = isTop && node.name === "root" && rootLabel ? rootLabel : node.name;
      const nodeId = `${rootKey}::${node.fullName || pathKey}`;
      const kindLabel = Array.from(new Set(node.symbols.map((symbol) => symbol.kind).filter(Boolean))).join(" ");
      const kindKey = getKindKey(node.symbols[0]?.kind || "");
      const hasChildren = node.children.size > 0;
      const expandedState = collapseAll ? false : expanded[nodeId] ?? false;
      const isVirtualRoot = node.name === "root" && node.symbols.length === 0;
      if (!isVirtualRoot) {
        rows.push({
          id: nodeId,
          name: displayName,
          kindLabel,
          kindKey,
          depth,
          node,
          hasChildren,
          expanded: expandedState,
        });
      }
      if (hasChildren && (expandedState || isVirtualRoot)) {
        const byNameCount = new Map<string, number>();
        Array.from(node.children.values())
          .sort((a, b) => {
            if (modelSortBy === "qualified_name") {
              return a.fullName.localeCompare(b.fullName);
            }
            return a.name.localeCompare(b.name);
          })
          .forEach((child) => {
            const keyBase = child.name || "node";
            const count = (byNameCount.get(keyBase) || 0) + 1;
            byNameCount.set(keyBase, count);
            const childKey = `${pathKey}::${keyBase}#${count}`;
            walk(child, isVirtualRoot ? depth : depth + 1, false, childKey);
          });
      }
    };
    walk(root, 0, true, rootKey || "root");
    return rows;
  };

  const modelRows = useMemo<ModelRow[]>(() => {
    const rows: ModelRow[] = [];
    const pushSymbolGroups = (groups: SymbolGroup[], sectionKey: string) => {
      if (!modelShowFiles) {
        const merged = groups.flatMap((group) =>
          showUsages ? group.list : group.list.filter((symbol) => !isUsageSymbol(symbol)),
        );
        const tree = buildSymbolTree(merged);
        const builtRows = buildRowsForTree(tree, undefined, `${sectionKey}::all`, modelExpanded, collapseAllModel);
        builtRows.forEach((row) => {
          rows.push({
            type: "symbol",
            key: row.id,
            name: row.name,
            kindLabel: row.kindLabel,
            kindKey: row.kindKey,
            depth: row.depth,
            node: row.node,
            hasChildren: row.hasChildren,
            expanded: row.expanded,
          });
        });
        return;
      }
      groups.forEach((group) => {
        const rootLabel = group.path.split(/[\\/]/).pop() || group.path;
        const filtered = showUsages ? group.list : group.list.filter((symbol) => !isUsageSymbol(symbol));
        const fileRow: SymbolNode = {
          name: rootLabel,
          fullName: `${sectionKey}::${group.path}`,
          symbols: [],
          children: new Map([[rootLabel, buildSymbolTree(filtered)]]),
        };
        const builtRows = buildRowsForTree(fileRow, rootLabel, `${sectionKey}::${group.path}`, modelExpanded, collapseAllModel);
        builtRows.forEach((row) => {
          rows.push({
            type: "symbol",
            key: row.id,
            name: row.name,
            kindLabel: row.kindLabel,
            kindKey: row.kindKey,
            depth: row.depth,
            node: row.node,
            hasChildren: row.hasChildren,
            expanded: row.expanded,
          });
        });
      });
    };
    const addSection = (
      section: "project" | "library" | "errors",
      label: string,
      countLabel: string,
      addBody: () => void,
      emptyLabel: string,
    ) => {
      rows.push({ type: "section", key: `section-${section}`, section, label, countLabel });
      if (!modelSectionOpen[section]) return;
      const beforeCount = rows.length;
      addBody();
      if (rows.length === beforeCount) {
        rows.push({ type: "empty", key: `empty-${section}`, text: emptyLabel });
      }
    };
    addSection(
      "project",
      "Project",
      `${projectCounts.fileCount} files • ${projectCounts.symbolCount} symbols`,
      () => {
        if (projectGroups.length) {
          pushSymbolGroups(projectGroups, "project");
        }
      },
      projectSymbolsLoaded ? "No project symbols." : "Loading project symbols...",
    );
    addSection(
      "library",
      "Library",
      `${libraryCounts.fileCount} files • ${libraryCounts.symbolCount} symbols`,
      () => {
        if (libraryGroups.length) {
          pushSymbolGroups(libraryGroups, "library");
        }
      },
      "No library symbols loaded.",
    );
    addSection(
      "errors",
      "Errors",
      `${errorCounts.fileCount} files • ${errorCounts.symbolCount} issues`,
      () => {
        deferredUnresolved.forEach((issue, index) => {
          rows.push({
            type: "error",
            key: `error-${issue.file_path}-${issue.line}-${issue.column}-${index}`,
            issue,
          });
        });
      },
      "No semantic errors.",
    );
    return rows;
  }, [
    projectGroups,
    libraryGroups,
    deferredUnresolved,
    modelExpanded,
    collapseAllModel,
    modelSectionOpen,
    projectCounts.fileCount,
    projectCounts.symbolCount,
    libraryCounts.fileCount,
    libraryCounts.symbolCount,
    errorCounts.fileCount,
    errorCounts.symbolCount,
    projectSymbolsLoaded,
    getKindKey,
    showUsages,
    modelSortBy,
    modelShowFiles,
  ]);

  return { modelRows };
}
