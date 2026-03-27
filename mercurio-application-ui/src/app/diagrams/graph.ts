import type {
  ProjectModelAttributeView,
  ProjectModelElementView,
  ProjectModelView,
  SymbolRelationship,
  SymbolView,
} from "../contracts.js";
import type { DiagramDocument, DiagramPoint } from "./file.js";
import { DIAGRAM_TYPES, type DiagramType } from "./model.js";
import { isPackageLikeMetadata, primaryKindLabel } from "../symbolMetadata.js";

export type DiagramGraphNode = {
  id: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  startCol: number;
  name: string;
  kind: string;
  isRoot: boolean;
  attributes: string[];
  documentation: string | null;
};

export type DiagramGraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: "containment" | "generalization" | "relationship";
  label?: string;
};

export type DiagramGraph = {
  diagramType: DiagramType;
  nodes: DiagramGraphNode[];
  edges: DiagramGraphEdge[];
  diagnostics: string[];
  unresolvedRoot: boolean;
  rootNodeId: string | null;
  rootQualifiedName: string | null;
};

function normalizeKey(value: string | null | undefined): string {
  return `${value || ""}`.trim();
}

function stableElementIdentity(element: {
  qualified_name?: string | null;
  file_path?: string;
  name?: string;
  start_line?: number;
  start_col?: number;
}): string {
  const qualified = normalizeKey(element.qualified_name);
  if (qualified) return qualified;
  return `${normalizeKey(element.file_path)}|${normalizeKey(element.name)}|${element.start_line || 0}|${element.start_col || 0}`;
}

function isPackageKind(symbol: SymbolView | null | undefined): boolean {
  return !!symbol && isPackageLikeMetadata(symbol);
}

function formatAttribute(attribute: ProjectModelAttributeView): string {
  const parts = [attribute.name || "<anonymous>"];
  if (attribute.declared_type) {
    parts.push(`: ${attribute.declared_type}`);
  }
  if (attribute.multiplicity) {
    parts.push(` [${attribute.multiplicity}]`);
  }
  return parts.join("");
}

function buildRelationshipEdgeId(source: string, target: string, kind: string): string {
  return `${source}->${target}:${kind}`;
}

function nearestPackageAncestor(
  symbol: SymbolView | null,
  symbolsByQualified: Map<string, SymbolView>,
): SymbolView | null {
  let current = symbol;
  while (current) {
    if (isPackageKind(current)) {
      return current;
    }
    const parentQualified = normalizeKey(current.parent_qualified_name);
    current = parentQualified ? (symbolsByQualified.get(parentQualified) || null) : null;
  }
  return null;
}

export function resolvePreferredDiagramRoot(
  diagramType: DiagramType,
  selectedSymbol: SymbolView | null,
  projectSymbols: SymbolView[],
): SymbolView | null {
  if (!selectedSymbol) return null;
  if (diagramType === DIAGRAM_TYPES.Package) {
    const map = new Map(projectSymbols.map((symbol) => [normalizeKey(symbol.qualified_name), symbol] as const));
    return nearestPackageAncestor(selectedSymbol, map) || selectedSymbol;
  }
  return selectedSymbol;
}

function rootForDocument(
  document: DiagramDocument,
  projectSymbols: SymbolView[],
): SymbolView | null {
  const symbolsByQualified = new Map(projectSymbols.map((symbol) => [normalizeKey(symbol.qualified_name), symbol] as const));
  const direct = symbolsByQualified.get(normalizeKey(document.root_element_qualified_name)) || null;
  if (!direct) return null;
  if (document.diagram_type === DIAGRAM_TYPES.Package) {
    return nearestPackageAncestor(direct, symbolsByQualified);
  }
  return direct;
}

function elementMap(projectModel: ProjectModelView | null): Map<string, ProjectModelElementView> {
  const out = new Map<string, ProjectModelElementView>();
  for (const element of projectModel?.elements || []) {
    out.set(normalizeKey(element.qualified_name), element);
  }
  return out;
}

function buildGraphNode(
  symbol: SymbolView,
  element: ProjectModelElementView | null,
  isRoot: boolean,
): DiagramGraphNode {
  const id = stableElementIdentity(element || symbol);
  const attributes = element?.attributes?.slice(0, 6).map(formatAttribute) || [];
  return {
    id,
    qualifiedName: normalizeKey(symbol.qualified_name),
    filePath: element?.file_path || symbol.file_path,
    startLine: element?.start_line || symbol.start_line || 1,
    startCol: element?.start_col || symbol.start_col || 1,
    name: element?.name || symbol.name || symbol.qualified_name || "<anonymous>",
    kind: primaryKindLabel({
      kind: element?.kind || symbol.kind || "?",
      semantic_kind: symbol.semantic_kind || symbol.kind || null,
      structural_metatype_qname: symbol.structural_metatype_qname || null,
      classification_qname: symbol.classification_qname || null,
      metatype_qname: symbol.metatype_qname || element?.metatype_qname || null,
    }),
    isRoot,
    attributes,
    documentation: element?.documentation || symbol.doc || null,
  };
}

function addContainedEdge(edges: Map<string, DiagramGraphEdge>, source: string, target: string) {
  const id = buildRelationshipEdgeId(source, target, "containment");
  if (edges.has(id) || source === target) return;
  edges.set(id, { id, source, target, kind: "containment", label: "contains" });
}

function addGeneralizationEdges(
  edges: Map<string, DiagramGraphEdge>,
  node: DiagramGraphNode,
  element: ProjectModelElementView | null,
  includedIdsByQualified: Map<string, string>,
) {
  for (const supertype of element?.declared_supertypes || element?.supertypes || []) {
    const target = includedIdsByQualified.get(normalizeKey(supertype));
    if (!target || target === node.id) continue;
    const id = buildRelationshipEdgeId(node.id, target, "generalization");
    if (edges.has(id)) continue;
    edges.set(id, {
      id,
      source: node.id,
      target,
      kind: "generalization",
      label: "specializes",
    });
  }
}

function addResolvedRelationshipEdges(
  edges: Map<string, DiagramGraphEdge>,
  sourceSymbol: SymbolView,
  sourceId: string,
  relationships: SymbolRelationship[] | undefined,
  includedIdsByQualified: Map<string, string>,
  filter: (relationship: SymbolRelationship) => boolean,
) {
  for (const relationship of relationships || []) {
    if (!filter(relationship)) continue;
    const targetId = includedIdsByQualified.get(normalizeKey(relationship.resolved_target || relationship.target));
    if (!targetId || targetId === sourceId) continue;
    const kind = normalizeKey(relationship.kind).toLowerCase() || "relationship";
    const id = buildRelationshipEdgeId(sourceId, targetId, kind);
    if (edges.has(id)) continue;
    edges.set(id, {
      id,
      source: sourceId,
      target: targetId,
      kind: "relationship",
      label: relationship.kind || sourceSymbol.kind || "related",
    });
  }
}

export function buildDiagramGraph(
  document: DiagramDocument,
  projectModel: ProjectModelView | null,
  projectSymbols: SymbolView[],
): DiagramGraph {
  const diagnostics: string[] = [];
  const rootSymbol = rootForDocument(document, projectSymbols);
  if (!rootSymbol) {
    return {
      diagramType: document.diagram_type,
      nodes: [],
      edges: [],
      diagnostics: [`Root element not found: ${document.root_element_qualified_name}`],
      unresolvedRoot: true,
      rootNodeId: null,
      rootQualifiedName: null,
    };
  }

  const elementsByQualified = elementMap(projectModel);
  const children = projectSymbols.filter((symbol) => normalizeKey(symbol.parent_qualified_name) === normalizeKey(rootSymbol.qualified_name));
  const includedSymbols = [rootSymbol];
  if (document.diagram_type === DIAGRAM_TYPES.Package) {
    includedSymbols.push(...children.filter((symbol) => isPackageKind(symbol)));
  } else {
    includedSymbols.push(...children);
  }

  const uniqueSymbols = new Map<string, SymbolView>();
  for (const symbol of includedSymbols) {
    const key = normalizeKey(symbol.qualified_name);
    if (!key || uniqueSymbols.has(key)) continue;
    uniqueSymbols.set(key, symbol);
  }

  const nodes = Array.from(uniqueSymbols.values())
    .map((symbol) => buildGraphNode(
      symbol,
      elementsByQualified.get(normalizeKey(symbol.qualified_name)) || null,
      normalizeKey(symbol.qualified_name) === normalizeKey(rootSymbol.qualified_name),
    ))
    .sort((a, b) => {
      if (a.isRoot && !b.isRoot) return -1;
      if (!a.isRoot && b.isRoot) return 1;
      return a.name.localeCompare(b.name);
    });

  const includedIdsByQualified = new Map(nodes.map((node) => [normalizeKey(node.qualifiedName), node.id] as const));
  const edges = new Map<string, DiagramGraphEdge>();

  for (const node of nodes) {
    if (node.qualifiedName === normalizeKey(rootSymbol.qualified_name)) continue;
    addContainedEdge(edges, stableElementIdentity(rootSymbol), node.id);
  }

  for (const symbol of uniqueSymbols.values()) {
    const sourceId = includedIdsByQualified.get(normalizeKey(symbol.qualified_name));
    if (!sourceId) continue;
    const element = elementsByQualified.get(normalizeKey(symbol.qualified_name)) || null;
    if (document.diagram_type === DIAGRAM_TYPES.Bdd) {
      const sourceNode = nodes.find((node) => node.id === sourceId);
      if (sourceNode) {
        addGeneralizationEdges(edges, sourceNode, element, includedIdsByQualified);
      }
      addResolvedRelationshipEdges(
        edges,
        symbol,
        sourceId,
        symbol.relationships,
        includedIdsByQualified,
        (relationship) => {
          const kind = normalizeKey(relationship.kind).toLowerCase();
          return !kind.includes("import");
        },
      );
      continue;
    }
    addResolvedRelationshipEdges(
      edges,
      symbol,
      sourceId,
      symbol.relationships,
      includedIdsByQualified,
      (relationship) => {
        const kind = normalizeKey(relationship.kind).toLowerCase();
        return kind.includes("import") || kind.includes("reference") || kind.includes("use");
      },
    );
  }

  if (document.diagram_type === DIAGRAM_TYPES.Package && nodes.length <= 1) {
    diagnostics.push("No child packages found for the selected root.");
  }

  return {
    diagramType: document.diagram_type,
    nodes,
    edges: Array.from(edges.values()),
    diagnostics,
    unresolvedRoot: false,
    rootNodeId: stableElementIdentity(rootSymbol),
    rootQualifiedName: normalizeKey(rootSymbol.qualified_name),
  };
}

function defaultNodePosition(
  index: number,
  diagramType: DiagramType,
): DiagramPoint {
  const columns = diagramType === DIAGRAM_TYPES.Package ? 3 : 2;
  const horizontalGap = diagramType === DIAGRAM_TYPES.Package ? 260 : 280;
  const verticalGap = diagramType === DIAGRAM_TYPES.Package ? 180 : 220;
  const column = index % columns;
  const row = Math.floor(index / columns);
  const width = (columns - 1) * horizontalGap;
  return {
    x: column * horizontalGap - width / 2,
    y: 180 + row * verticalGap,
  };
}

export function mergeDiagramNodePositions(
  graph: DiagramGraph,
  savedPositions: Record<string, DiagramPoint> | null | undefined,
): Record<string, DiagramPoint> {
  const saved = savedPositions || {};
  const next: Record<string, DiagramPoint> = {};
  const rootId = graph.rootNodeId;
  const rootSaved = rootId ? saved[rootId] : null;
  const delta = rootSaved
    ? { x: rootSaved.x, y: rootSaved.y }
    : { x: 0, y: 0 };
  let childIndex = 0;
  for (const node of graph.nodes) {
    if (saved[node.id]) {
      next[node.id] = saved[node.id]!;
      continue;
    }
    if (node.id === rootId) {
      next[node.id] = rootSaved || { x: 0, y: 0 };
      continue;
    }
    const position = defaultNodePosition(childIndex, graph.diagramType);
    next[node.id] = {
      x: position.x + delta.x,
      y: position.y + delta.y,
    };
    childIndex += 1;
  }
  return next;
}
