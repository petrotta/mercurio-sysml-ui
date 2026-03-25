import { DEFAULT_DIAGRAM_TYPE, normalizeDiagramType, type DiagramType } from "./model.js";

export const DIAGRAM_DOCUMENT_VERSION = 1;
export const DIAGRAM_FILE_EXTENSION = ".diagram";

export type DiagramPoint = {
  x: number;
  y: number;
};

export type DiagramViewport = {
  x: number;
  y: number;
  zoom: number;
};

export type DiagramDocument = {
  version: number;
  name: string;
  diagram_type: DiagramType;
  root_element_qualified_name: string;
  root_file_path: string | null;
  viewport?: DiagramViewport | null;
  node_positions?: Record<string, DiagramPoint>;
};

type DiagramDocumentInput = {
  name: string;
  diagramType?: DiagramType | null;
  rootQualifiedName: string;
  rootFilePath?: string | null;
  viewport?: DiagramViewport | null;
  nodePositions?: Record<string, DiagramPoint> | null;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseViewport(value: unknown): DiagramViewport | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (!isFiniteNumber(candidate.x) || !isFiniteNumber(candidate.y) || !isFiniteNumber(candidate.zoom)) {
    return null;
  }
  return {
    x: candidate.x,
    y: candidate.y,
    zoom: candidate.zoom,
  };
}

function parseNodePositions(value: unknown): Record<string, DiagramPoint> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, DiagramPoint> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim() || !entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    if (!isFiniteNumber(candidate.x) || !isFiniteNumber(candidate.y)) continue;
    out[key] = { x: candidate.x, y: candidate.y };
  }
  return out;
}

export function isDiagramFilePath(path: string | null | undefined): boolean {
  return `${path || ""}`.toLowerCase().endsWith(DIAGRAM_FILE_EXTENSION);
}

export function buildDiagramFileName(name: string): string {
  const trimmed = `${name || ""}`.trim();
  if (!trimmed) return `new-diagram${DIAGRAM_FILE_EXTENSION}`;
  if (trimmed.toLowerCase().endsWith(DIAGRAM_FILE_EXTENSION)) return trimmed;
  return `${trimmed}${DIAGRAM_FILE_EXTENSION}`;
}

export function createDiagramDocument(input: DiagramDocumentInput): DiagramDocument {
  const name = `${input.name || ""}`.trim();
  const rootQualifiedName = `${input.rootQualifiedName || ""}`.trim();
  if (!name) {
    throw new Error("Diagram name is required.");
  }
  if (!rootQualifiedName) {
    throw new Error("Diagram root element is required.");
  }
  const rootFilePath = `${input.rootFilePath || ""}`.trim();
  const viewport = input.viewport || null;
  const nodePositions = input.nodePositions || {};
  return {
    version: DIAGRAM_DOCUMENT_VERSION,
    name,
    diagram_type: normalizeDiagramType(input.diagramType || DEFAULT_DIAGRAM_TYPE),
    root_element_qualified_name: rootQualifiedName,
    root_file_path: rootFilePath || null,
    viewport: viewport
      ? {
          x: viewport.x,
          y: viewport.y,
          zoom: viewport.zoom,
        }
      : null,
    node_positions: Object.keys(nodePositions).length ? { ...nodePositions } : {},
  };
}

export function parseDiagramDocument(text: string): DiagramDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid diagram JSON: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Diagram document must be a JSON object.");
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== DIAGRAM_DOCUMENT_VERSION) {
    throw new Error(`Unsupported diagram document version: ${String(candidate.version)}`);
  }
  if (typeof candidate.name !== "string" || !candidate.name.trim()) {
    throw new Error("Diagram name is required.");
  }
  if (
    typeof candidate.root_element_qualified_name !== "string"
    || !candidate.root_element_qualified_name.trim()
  ) {
    throw new Error("Diagram root element is required.");
  }
  const diagramType = normalizeDiagramType(
    typeof candidate.diagram_type === "string" ? candidate.diagram_type : undefined,
  );
  if (typeof candidate.diagram_type !== "string" || diagramType !== candidate.diagram_type.toLowerCase()) {
    throw new Error(`Unsupported diagram type: ${String(candidate.diagram_type)}`);
  }
  const rootFilePath = typeof candidate.root_file_path === "string"
    ? candidate.root_file_path.trim()
    : "";
  return createDiagramDocument({
    name: candidate.name,
    diagramType,
    rootQualifiedName: candidate.root_element_qualified_name,
    rootFilePath: rootFilePath || null,
    viewport: parseViewport(candidate.viewport),
    nodePositions: parseNodePositions(candidate.node_positions),
  });
}

export function prepareDiagramDocumentForSave(
  document: DiagramDocument,
  allowedNodeIds?: Iterable<string>,
): DiagramDocument {
  const allowed = allowedNodeIds
    ? new Set(Array.from(allowedNodeIds, (value) => `${value || ""}`.trim()).filter(Boolean))
    : null;
  const nextPositions = parseNodePositions(document.node_positions || {});
  const filteredPositions: Record<string, DiagramPoint> = {};
  for (const key of Object.keys(nextPositions).sort()) {
    if (allowed && !allowed.has(key)) continue;
    filteredPositions[key] = nextPositions[key]!;
  }
  return createDiagramDocument({
    name: document.name,
    diagramType: document.diagram_type,
    rootQualifiedName: document.root_element_qualified_name,
    rootFilePath: document.root_file_path,
    viewport: parseViewport(document.viewport),
    nodePositions: filteredPositions,
  });
}

export function serializeDiagramDocument(
  document: DiagramDocument,
  allowedNodeIds?: Iterable<string>,
): string {
  const prepared = prepareDiagramDocumentForSave(document, allowedNodeIds);
  const payload: Record<string, unknown> = {
    version: prepared.version,
    name: prepared.name,
    diagram_type: prepared.diagram_type,
    root_element_qualified_name: prepared.root_element_qualified_name,
    root_file_path: prepared.root_file_path,
  };
  if (prepared.viewport) {
    payload.viewport = prepared.viewport;
  }
  if (prepared.node_positions && Object.keys(prepared.node_positions).length) {
    payload.node_positions = prepared.node_positions;
  }
  return `${JSON.stringify(payload, null, 2)}\n`;
}
