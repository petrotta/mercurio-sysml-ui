import type {
  ProjectModelElementView,
  ProjectModelView,
  SymbolView,
} from "../contracts.js";
import type { DiagramPoint } from "../diagrams/file.js";

export type ExplorerEdgeKind = "ownsDefinition" | "specializes" | "directedRelationship";

export type ExplorerGraphNode = {
  id: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  startCol: number;
  name: string;
  kind: string;
  isRoot: boolean;
  relationOnly: boolean;
  attributes: string[];
  documentation: string | null;
};

export type ExplorerGraphEdge = {
  id: string;
  source: string;
  target: string;
  sourceQualifiedName: string;
  targetQualifiedName: string;
  kind: ExplorerEdgeKind;
  label?: string;
  canonicalKind?: string | null;
  viaQualifiedName?: string | null;
};

export type ExplorerGraph = {
  nodes: ExplorerGraphNode[];
  edges: ExplorerGraphEdge[];
  diagnostics: string[];
  unresolvedRoot: boolean;
  rootNodeId: string | null;
  rootQualifiedName: string | null;
  showDirectedRelationships: boolean;
};

type BuildExplorerGraphInput = {
  rootQualifiedName: string;
  expandedQualifiedNames?: Iterable<string>;
  showDirectedRelationships: boolean;
  workspaceSymbols: SymbolView[];
  projectModel: ProjectModelView | null;
};

type ExplorerNodeInclusion = "structural" | "relation";

function normalizeKey(value: string | null | undefined): string {
  return `${value || ""}`.trim();
}

function normalizeLower(value: string | null | undefined): string {
  return normalizeKey(value).toLowerCase();
}

function stableIdentity(element: {
  qualified_name?: string | null;
  file_path?: string | null;
  name?: string | null;
  start_line?: number;
  start_col?: number;
}): string {
  const qualified = normalizeKey(element.qualified_name);
  if (qualified) return qualified;
  return `${normalizeKey(element.file_path)}|${normalizeKey(element.name)}|${element.start_line || 0}|${element.start_col || 0}`;
}

function isDefinitionKind(kind: string | null | undefined, metatype: string | null | undefined): boolean {
  const kindValue = normalizeLower(kind);
  const metatypeValue = normalizeLower(metatype);
  return kindValue.includes("definition")
    || metatypeValue.includes("definition")
    || kindValue === "package"
    || metatypeValue.endsWith("::package");
}

function formatAttribute(attribute: { name: string; declared_type: string | null; multiplicity: string | null }): string {
  const parts = [attribute.name || "<anonymous>"];
  if (attribute.declared_type) {
    parts.push(`: ${attribute.declared_type}`);
  }
  if (attribute.multiplicity) {
    parts.push(`[${attribute.multiplicity}]`);
  }
  return parts.join(" ");
}

function buildNode(
  symbol: SymbolView | null,
  element: ProjectModelElementView | null,
  relationOnly: boolean,
  rootQualifiedName: string,
): ExplorerGraphNode {
  const identity = stableIdentity(element || symbol || {});
  const qualifiedName = normalizeKey(symbol?.qualified_name || element?.qualified_name);
  return {
    id: identity,
    qualifiedName,
    filePath: element?.file_path || symbol?.file_path || "",
    startLine: element?.start_line || symbol?.start_line || 1,
    startCol: element?.start_col || symbol?.start_col || 1,
    name: element?.name || symbol?.name || qualifiedName || "<anonymous>",
    kind: element?.kind || symbol?.kind || "?",
    isRoot: qualifiedName === rootQualifiedName,
    relationOnly,
    attributes: (element?.attributes || []).slice(0, 6).map(formatAttribute),
    documentation: element?.documentation || symbol?.doc || null,
  };
}

function endpointToDefinitionQname(
  qualifiedName: string,
  symbolsByQualified: Map<string, SymbolView>,
  seen = new Set<string>(),
): string {
  const key = normalizeKey(qualifiedName);
  if (!key || seen.has(key)) return key;
  seen.add(key);
  const symbol = symbolsByQualified.get(key);
  if (!symbol) return key;
  if (isDefinitionKind(symbol.kind, symbol.metatype_qname)) {
    return key;
  }
  const structuralTarget = normalizeKey(symbol.structural_type?.target);
  if (!structuralTarget || structuralTarget === key) {
    return key;
  }
  return endpointToDefinitionQname(structuralTarget, symbolsByQualified, seen);
}

function preferredRootFromSymbol(
  symbol: SymbolView | null,
  symbolsByQualified: Map<string, SymbolView>,
): SymbolView | null {
  if (!symbol) return null;
  if (isDefinitionKind(symbol.kind, symbol.metatype_qname)) {
    return symbol;
  }
  const structuralTarget = normalizeKey(symbol.structural_type?.target);
  if (!structuralTarget) return symbol;
  return symbolsByQualified.get(structuralTarget) || symbol;
}

function nodePosition(index: number, relationOnly: boolean): DiagramPoint {
  const columns = relationOnly ? 4 : 3;
  const horizontalGap = relationOnly ? 240 : 280;
  const verticalGap = relationOnly ? 180 : 220;
  const column = index % columns;
  const row = Math.floor(index / columns);
  const width = (columns - 1) * horizontalGap;
  return {
    x: column * horizontalGap - width / 2,
    y: 180 + row * verticalGap,
  };
}

function addEdge(
  edges: Map<string, ExplorerGraphEdge>,
  edge: ExplorerGraphEdge,
) {
  if (!edge.source || !edge.target || edge.source === edge.target) return;
  if (edges.has(edge.id)) return;
  edges.set(edge.id, edge);
}

export function resolvePreferredExplorerRoot(
  selectedSymbol: SymbolView | null,
  workspaceSymbols: SymbolView[],
): SymbolView | null {
  const symbolsByQualified = new Map(
    workspaceSymbols.map((symbol) => [normalizeKey(symbol.qualified_name), symbol] as const),
  );
  return preferredRootFromSymbol(selectedSymbol, symbolsByQualified);
}

export function buildExplorerGraph({
  rootQualifiedName,
  expandedQualifiedNames,
  showDirectedRelationships,
  workspaceSymbols,
  projectModel,
}: BuildExplorerGraphInput): ExplorerGraph {
  const diagnostics: string[] = [];
  const symbolsByQualified = new Map(
    workspaceSymbols.map((symbol) => [normalizeKey(symbol.qualified_name), symbol] as const),
  );
  const elementsByQualified = new Map(
    (projectModel?.elements || []).map((element) => [normalizeKey(element.qualified_name), element] as const),
  );
  const rootResolvedQname = endpointToDefinitionQname(rootQualifiedName, symbolsByQualified);
  const rootSymbol = symbolsByQualified.get(rootResolvedQname) || symbolsByQualified.get(normalizeKey(rootQualifiedName)) || null;
  const rootElement = elementsByQualified.get(rootResolvedQname) || null;
  if (!rootSymbol && !rootElement) {
    return {
      nodes: [],
      edges: [],
      diagnostics: [`Root element not found: ${rootQualifiedName}`],
      unresolvedRoot: true,
      rootNodeId: null,
      rootQualifiedName: null,
      showDirectedRelationships,
    };
  }

  const expanded = new Set(
    Array.from(expandedQualifiedNames || [], (value) => endpointToDefinitionQname(value, symbolsByQualified))
      .filter(Boolean),
  );
  expanded.add(rootResolvedQname);

  const includedNodes = new Map<string, ExplorerGraphNode>();
  const includedKinds = new Map<string, ExplorerNodeInclusion>();
  const carrierQualifiedNames = new Set<string>();
  const edges = new Map<string, ExplorerGraphEdge>();

  const ensureNode = (qualifiedName: string, inclusion: ExplorerNodeInclusion): ExplorerGraphNode | null => {
    const normalized = endpointToDefinitionQname(qualifiedName, symbolsByQualified);
    if (!normalized) return null;
    const current = includedNodes.get(normalized);
    if (current) {
      if (includedKinds.get(normalized) !== "structural" && inclusion === "structural") {
        const next = { ...current, relationOnly: false };
        includedKinds.set(normalized, inclusion);
        includedNodes.set(normalized, next);
        return next;
      }
      return current;
    }
    const symbol = symbolsByQualified.get(normalized) || null;
    const element = elementsByQualified.get(normalized) || null;
    if (!symbol && !element) return null;
    const node = buildNode(symbol, element, inclusion === "relation", rootResolvedQname);
    includedKinds.set(normalized, inclusion);
    includedNodes.set(normalized, node);
    return node;
  };

  const structuralOwners = Array.from(expanded.values());
  for (const ownerQname of structuralOwners) {
    const ownerNode = ensureNode(ownerQname, "structural");
    if (!ownerNode) continue;
    carrierQualifiedNames.add(ownerQname);
    const directChildren = workspaceSymbols.filter(
      (symbol) => normalizeKey(symbol.parent_qualified_name) === ownerQname && symbol.source_scope !== "library",
    );
    for (const child of directChildren) {
      const childQname = normalizeKey(child.qualified_name);
      if (!childQname) continue;
      carrierQualifiedNames.add(childQname);
      if (isDefinitionKind(child.kind, child.metatype_qname)) {
        const childNode = ensureNode(childQname, "structural");
        if (!childNode) continue;
        addEdge(edges, {
          id: `${ownerNode.id}->${childNode.id}:owns:${childQname}`,
          source: ownerNode.id,
          target: childNode.id,
          sourceQualifiedName: ownerNode.qualifiedName,
          targetQualifiedName: childNode.qualifiedName,
          kind: "ownsDefinition",
          viaQualifiedName: childQname,
        });
        continue;
      }
      const structuralType = child.structural_type;
      const targetQname = normalizeKey(structuralType?.target);
      if (!targetQname) {
        continue;
      }
      const targetNode = ensureNode(targetQname, "structural");
      if (!targetNode) {
        diagnostics.push(`Structural target not found for ${childQname}: ${targetQname}`);
        continue;
      }
      addEdge(edges, {
        id: `${ownerNode.id}->${targetNode.id}:owns:${childQname}`,
        source: ownerNode.id,
        target: targetNode.id,
        sourceQualifiedName: ownerNode.qualifiedName,
        targetQualifiedName: targetNode.qualifiedName,
        kind: "ownsDefinition",
        label: child.name || structuralType?.label || undefined,
        viaQualifiedName: childQname,
      });
    }
  }

  const specializationSeed = Array.from(includedNodes.values()).map((node) => node.qualifiedName);
  for (const nodeQname of specializationSeed) {
    const sourceNode = ensureNode(nodeQname, includedKinds.get(nodeQname) || "structural");
    const element = elementsByQualified.get(nodeQname);
    if (!sourceNode || !element) continue;
    for (const supertype of element.declared_supertypes || element.supertypes || []) {
      const targetNode = ensureNode(supertype, "relation");
      if (!targetNode) continue;
      addEdge(edges, {
        id: `${sourceNode.id}->${targetNode.id}:specializes`,
        source: sourceNode.id,
        target: targetNode.id,
        sourceQualifiedName: sourceNode.qualifiedName,
        targetQualifiedName: targetNode.qualifiedName,
        kind: "specializes",
        label: "specializes",
      });
    }
    for (const subtype of element.direct_specializations || []) {
      const subtypeNode = ensureNode(subtype, "relation");
      if (!subtypeNode) continue;
      addEdge(edges, {
        id: `${subtypeNode.id}->${sourceNode.id}:specializes`,
        source: subtypeNode.id,
        target: sourceNode.id,
        sourceQualifiedName: subtypeNode.qualifiedName,
        targetQualifiedName: sourceNode.qualifiedName,
        kind: "specializes",
        label: "specializes",
      });
    }
  }

  if (showDirectedRelationships) {
    for (const carrierQname of carrierQualifiedNames) {
      const carrier = symbolsByQualified.get(carrierQname);
      if (!carrier) continue;
      for (const relationship of carrier.directed_relationships || []) {
        if (!relationship.resolved) {
          diagnostics.push(`Unresolved ${relationship.display_label} relationship on ${carrierQname}`);
          continue;
        }
        const sourceQname = endpointToDefinitionQname(relationship.source, symbolsByQualified);
        const targetQname = endpointToDefinitionQname(relationship.target, symbolsByQualified);
        const sourceNode = ensureNode(sourceQname, "relation");
        const targetNode = ensureNode(targetQname, "relation");
        if (!sourceNode || !targetNode) {
          diagnostics.push(
            `Directed relationship target not found for ${carrierQname}: ${relationship.source} -> ${relationship.target}`,
          );
          continue;
        }
        addEdge(edges, {
          id: `${carrierQname}:${relationship.canonical_kind}:${sourceNode.id}->${targetNode.id}`,
          source: sourceNode.id,
          target: targetNode.id,
          sourceQualifiedName: sourceNode.qualifiedName,
          targetQualifiedName: targetNode.qualifiedName,
          kind: "directedRelationship",
          label: relationship.display_label,
          canonicalKind: relationship.canonical_kind,
          viaQualifiedName: carrierQname,
        });
      }
      for (const diagnostic of carrier.explorer_diagnostics || []) {
        diagnostics.push(`${carrierQname}: ${diagnostic}`);
      }
    }
  }

  const nodes = Array.from(includedNodes.values()).sort((left, right) => {
    if (left.isRoot && !right.isRoot) return -1;
    if (!left.isRoot && right.isRoot) return 1;
    if (left.relationOnly !== right.relationOnly) {
      return left.relationOnly ? 1 : -1;
    }
    return left.name.localeCompare(right.name);
  });

  return {
    nodes,
    edges: Array.from(edges.values()),
    diagnostics,
    unresolvedRoot: false,
    rootNodeId: ensureNode(rootResolvedQname, "structural")?.id || null,
    rootQualifiedName: rootResolvedQname,
    showDirectedRelationships,
  };
}

export function mergeExplorerNodePositions(
  graph: ExplorerGraph,
  savedPositions: Record<string, DiagramPoint> | null | undefined,
): Record<string, DiagramPoint> {
  const next: Record<string, DiagramPoint> = {};
  const saved = savedPositions || {};
  let index = 0;
  for (const node of graph.nodes) {
    if (saved[node.id]) {
      next[node.id] = saved[node.id]!;
      continue;
    }
    if (node.isRoot) {
      next[node.id] = { x: 0, y: 0 };
      continue;
    }
    next[node.id] = nodePosition(index, node.relationOnly);
    index += 1;
  }
  return next;
}

export function canExpandExplorerNode(
  qualifiedName: string | null | undefined,
  workspaceSymbols: SymbolView[],
): boolean {
  const target = workspaceSymbols.find((symbol) => normalizeKey(symbol.qualified_name) === normalizeKey(qualifiedName));
  return !!target && isDefinitionKind(target.kind, target.metatype_qname);
}
