import { callTool } from "../agentClient";
import type {
  IndexedSymbolView,
  ProjectElementAttributesView,
  SemanticElementResult,
} from "../types";

const SEMANTIC_ELEMENT_CACHE_LIMIT = 256;
const semanticElementCache = new Map<string, SemanticElementResult | null>();
const semanticElementInFlight = new Map<string, Promise<SemanticElementResult | null>>();

function semanticElementCacheKey(root: string, qualifiedName: string, filePath?: string | null): string {
  return `${root.toLowerCase()}\u0000${(filePath || "").toLowerCase()}\u0000${qualifiedName.toLowerCase()}`;
}

function rememberSemanticElement(
  key: string,
  value: SemanticElementResult | null,
): SemanticElementResult | null {
  semanticElementCache.delete(key);
  semanticElementCache.set(key, value);
  if (semanticElementCache.size > SEMANTIC_ELEMENT_CACHE_LIMIT) {
    const oldest = semanticElementCache.keys().next().value;
    if (oldest) {
      semanticElementCache.delete(oldest);
    }
  }
  return value;
}

export function clearSemanticElementCache(root?: string): void {
  if (!root) {
    semanticElementCache.clear();
    semanticElementInFlight.clear();
    return;
  }
  const prefix = `${root.toLowerCase()}\u0000`;
  for (const key of Array.from(semanticElementCache.keys())) {
    if (key.startsWith(prefix)) {
      semanticElementCache.delete(key);
    }
  }
  for (const key of Array.from(semanticElementInFlight.keys())) {
    if (key.startsWith(prefix)) {
      semanticElementInFlight.delete(key);
    }
  }
}

export async function querySemanticElementByQualifiedName(
  root: string,
  qualifiedName: string,
  filePath?: string | null,
): Promise<SemanticElementResult | null> {
  const target = (qualifiedName || "").trim();
  if (!target) return null;
  const key = semanticElementCacheKey(root, target, filePath);
  if (semanticElementCache.has(key)) {
    return semanticElementCache.get(key) || null;
  }
  const existing = semanticElementInFlight.get(key);
  if (existing) {
    return existing;
  }
  const request = callTool<SemanticElementResult | null>("core.query_semantic_element@v1", {
    root,
    qualified_name: target,
    file_path: filePath || null,
  })
    .then((row) => rememberSemanticElement(key, row || null))
    .finally(() => {
      semanticElementInFlight.delete(key);
    });
  semanticElementInFlight.set(key, request);
  return request;
}

export async function queryProjectSymbols(
  root: string,
  filePath?: string | null,
  offset = 0,
  limit = 200_000,
): Promise<IndexedSymbolView[]> {
  return callTool<IndexedSymbolView[]>("core.query_project_symbols@v1", {
    root,
    file_path: filePath || null,
    offset,
    limit,
  });
}

export async function queryLibrarySymbols(
  root: string,
  filePath?: string | null,
  offset = 0,
  limit = 200_000,
): Promise<IndexedSymbolView[]> {
  return callTool<IndexedSymbolView[]>("core.query_library_symbols@v1", {
    root,
    file_path: filePath || null,
    offset,
    limit,
  });
}

export async function getProjectElementAttributes(
  root: string,
  elementQualifiedName: string,
  symbolKind?: string | null,
): Promise<ProjectElementAttributesView> {
  return callTool<ProjectElementAttributesView>("core.get_project_element_attributes@v1", {
    root,
    element_qualified_name: elementQualifiedName,
    symbol_kind: symbolKind || null,
  });
}
