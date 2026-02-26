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
  modelShowFiles: boolean;
  defaultExpanded?: boolean;
  libraryLoadingFilePaths: string[];
  libraryLoadErrors: Record<string, string>;
  libraryKindFilter: string | null;
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
  modelShowFiles,
  defaultExpanded = false,
  libraryLoadingFilePaths,
  libraryLoadErrors,
  libraryKindFilter,
}: UseModelTreeOptions) {
  const propertyText = (value: SymbolView["properties"][number]["value"]): string | null => {
    if ("type" in value && value.type === "text") return value.value ?? null;
    return null;
  };

  const simplifyMetatypeLabel = (raw: string): string => {
    let label = (raw || "").trim();
    if (!label) return "";
    if (label.includes("::")) {
      const parts = label.split("::").filter(Boolean);
      label = parts[parts.length - 1] || label;
    }
    if (label.endsWith("Definition")) {
      return label.slice(0, -"Definition".length) || label;
    }
    if (label.endsWith("Usage")) {
      return label.slice(0, -"Usage".length) || label;
    }
    return label;
  };

  const symbolMetatypeLabel = (symbol: SymbolView): string | null => {
    const direct = (symbol as SymbolView & { metatype_qname?: string | null }).metatype_qname || "";
    const directLabel = simplifyMetatypeLabel(direct);
    if (directLabel) return directLabel;
    for (const prop of symbol.properties || []) {
      const name = (prop.name || "").toLowerCase();
      if (name !== "metatype_qname" && name !== "emf::metatype" && name !== "element::metatype") {
        continue;
      }
      const text = propertyText(prop.value) || "";
      const label = simplifyMetatypeLabel(text);
      if (label) return label;
    }
    return null;
  };

  const buildSymbolTree = (list: SymbolView[]) => {
    const symbolQname = (symbol: SymbolView) => {
      const qualified = (symbol.qualified_name || "").trim();
      if (qualified) return qualified;
      const name = (symbol.name || "").trim();
      if (name) return name;
      const line = Math.max(0, symbol.start_line || 0);
      const col = Math.max(0, symbol.start_col || 0);
      return `@${symbol.kind || "Node"}:${line}:${col}`;
    };
    const lastSegment = (qualified: string) => {
      const parts = qualified.split("::").filter(Boolean);
      return parts.length ? parts[parts.length - 1] : qualified;
    };
    const findNearestParent = (qualified: string, known: Set<string>) => {
      let probe = qualified;
      while (probe.includes("::")) {
        probe = probe.substring(0, probe.lastIndexOf("::"));
        if (known.has(probe)) return probe;
      }
      return null;
    };
    const root: SymbolNode = {
      name: "root",
      fullName: "",
      symbols: [],
      children: new Map(),
    };
    const symbolsByQname = new Map<string, SymbolView[]>();
    list.forEach((symbol) => {
      const qualified = symbolQname(symbol);
      if (!qualified) return;
      if (!symbolsByQname.has(qualified)) symbolsByQname.set(qualified, []);
      symbolsByQname.get(qualified)?.push(symbol);
    });
    const knownQnames = new Set(Array.from(symbolsByQname.keys()));
    const ensureQnameNode = (qualified: string) => {
      if (!qualified) return;
      if (!symbolsByQname.has(qualified)) {
        symbolsByQname.set(qualified, []);
      }
      knownQnames.add(qualified);
    };
    // Fill implicit parent containers from qualified names so hierarchy remains visible
    // even when the parser only emits leaf nodes.
    Array.from(knownQnames).forEach((qualified) => {
      const parts = qualified.split("::").filter(Boolean);
      if (parts.length <= 1) return;
      let prefix = "";
      for (let i = 0; i < parts.length - 1; i += 1) {
        prefix = prefix ? `${prefix}::${parts[i]}` : parts[i];
        ensureQnameNode(prefix);
      }
    });
    const parentByQname = new Map<string, string>();
    list.forEach((symbol) => {
      const owner = symbolQname(symbol);
      if (!owner) return;
      (symbol.relationships || []).forEach((rel) => {
        const relKind = (rel.kind || "").toLowerCase();
        const target = (rel.resolved_target || rel.target || "").trim();
        if (!target) return;
        if (target === owner) return;
        ensureQnameNode(target);
        if (relKind.startsWith("owning") || relKind.includes("owning")) {
          // owning* relationships directly encode parent of current symbol.
          if (!parentByQname.has(owner)) {
            parentByQname.set(owner, target);
          }
          return;
        }
        if (!relKind.startsWith("owned")) return;
        const ownerIsNestedUnderTarget = owner.startsWith(`${target}::`);
        const targetIsNestedUnderOwner = target.startsWith(`${owner}::`);
        if (ownerIsNestedUnderTarget) {
          // Relationship points to a containing owner (common in fast symbols).
          if (!parentByQname.has(owner)) {
            parentByQname.set(owner, target);
          }
          return;
        }
        if (targetIsNestedUnderOwner) {
          // Relationship points to an owned element.
          if (!parentByQname.has(target)) {
            parentByQname.set(target, owner);
          }
          return;
        }
        // Fallback: preserve previous behavior when direction is unclear.
        if (!parentByQname.has(target)) {
          parentByQname.set(target, owner);
        }
      });
    });
    Array.from(knownQnames).forEach((qualified) => {
      if (parentByQname.has(qualified)) return;
      const fallback = findNearestParent(qualified, knownQnames);
      if (fallback) parentByQname.set(qualified, fallback);
    });
    const childrenByParent = new Map<string, string[]>();
    parentByQname.forEach((parent, child) => {
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
      childrenByParent.get(parent)?.push(child);
    });
    const parseOrderFor = (qname: string) => {
      const sym = symbolsByQname.get(qname)?.[0];
      return {
        line: sym?.start_line ?? Number.MAX_SAFE_INTEGER,
        col: sym?.start_col ?? Number.MAX_SAFE_INTEGER,
      };
    };
    const sortQnamesByParseOrder = (qnames: string[]) =>
      [...qnames].sort((a, b) => {
        const ao = parseOrderFor(a);
        const bo = parseOrderFor(b);
        if (ao.line !== bo.line) return ao.line - bo.line;
        if (ao.col !== bo.col) return ao.col - bo.col;
        return a.localeCompare(b);
      });
    const buildNode = (qualified: string, stack: Set<string>): SymbolNode => {
      const node: SymbolNode = {
        name: lastSegment(qualified),
        fullName: qualified,
        symbols: symbolsByQname.get(qualified) || [],
        children: new Map(),
      };
      if (stack.has(qualified)) return node;
      stack.add(qualified);
      const children = sortQnamesByParseOrder(childrenByParent.get(qualified) || []);
      children.forEach((childQname) => {
        node.children.set(childQname, buildNode(childQname, stack));
      });
      stack.delete(qualified);
      return node;
    };
    sortQnamesByParseOrder(Array.from(knownQnames)).forEach((qualified) => {
      const parent = parentByQname.get(qualified);
      if (parent && parent !== qualified && knownQnames.has(parent)) return;
      root.children.set(qualified, buildNode(qualified, new Set<string>()));
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
      const isFileContainerRow = depth === 0 && !!rootLabel && node.symbols.length === 0;
      const metatypeLabels = Array.from(
        new Set(node.symbols.map((symbol) => symbolMetatypeLabel(symbol)).filter(Boolean) as string[]),
      );
      const fallbackKinds = Array.from(new Set(node.symbols.map((symbol) => symbol.kind).filter(Boolean)));
      const kindLabel =
        metatypeLabels.join(" ") ||
        fallbackKinds.join(" ") ||
        (isFileContainerRow ? "File" : node.children.size ? "Package" : "");
      const kindKey = isFileContainerRow ? "file" : getKindKey(node.symbols[0]?.kind || "");
      const hasChildren = node.children.size > 0;
      const expandedState = collapseAll ? false : expanded[nodeId] ?? defaultExpanded;
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
        Array.from(node.children.values()).forEach((child) => {
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
        const merged = groups.flatMap((group) => {
          const usageFiltered = showUsages ? group.list : group.list.filter((symbol) => !isUsageSymbol(symbol));
          if (sectionKey === "library" && libraryKindFilter) {
            return usageFiltered.filter((symbol) => symbol.kind === libraryKindFilter);
          }
          return usageFiltered;
        });
        const tree = buildSymbolTree(merged);
        const builtRows = buildRowsForTree(tree, undefined, `${sectionKey}::all`, modelExpanded, collapseAllModel);
        builtRows.forEach((row) => {
          rows.push({
            type: "symbol",
            key: row.id,
            section: sectionKey as "project" | "library",
            filePath: null,
            isFileRoot: false,
            isLoading: false,
            loadError: undefined,
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
        const usageFiltered = showUsages ? group.list : group.list.filter((symbol) => !isUsageSymbol(symbol));
        const filtered =
          sectionKey === "library" && libraryKindFilter
            ? usageFiltered.filter((symbol) => symbol.kind === libraryKindFilter)
            : usageFiltered;
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
            section: sectionKey as "project" | "library",
            filePath: group.path,
            isFileRoot: row.depth === 0,
            isLoading:
              (sectionKey as "project" | "library") === "library" &&
              row.depth === 0 &&
              libraryLoadingFilePaths.includes(group.path),
            loadError:
              (sectionKey as "project" | "library") === "library" && row.depth === 0
                ? libraryLoadErrors[group.path]
                : undefined,
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
      libraryCounts.fileCount > 0 ? "Expand a library file to load symbols." : "No library symbols loaded.",
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
    modelShowFiles,
    libraryLoadingFilePaths,
    libraryLoadErrors,
    libraryKindFilter,
    defaultExpanded,
  ]);

  return { modelRows };
}
