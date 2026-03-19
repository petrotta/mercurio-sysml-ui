import { callTool } from "../agentClient";
import type {
  IndexedSymbolView,
  ProjectModelView,
  ProjectElementAttributesView,
  ProjectExpressionRecordView,
  SemanticElementProjectionResult,
  SymbolView,
} from "../types";

const SEMANTIC_ELEMENT_CACHE_LIMIT = 256;
const PROJECT_ELEMENT_ATTRIBUTES_TIMEOUT_MS = 20000;
const semanticProjectionCache = new Map<string, SemanticElementProjectionResult | null>();
const semanticProjectionInFlight = new Map<
  string,
  Promise<SemanticElementProjectionResult | null>
>();

export type LibrarySymbolsLoadResult = {
  ok: boolean;
  symbols: SymbolView[];
  library_files: string[];
  library_path?: string | null;
  workspace_snapshot_hit: boolean;
  stdlib_duration_ms: number;
  stdlib_file_count: number;
  total_duration_ms: number;
};

export type ExpressionEvaluationResult = {
  expression: string;
  result: string;
};

export type ExpressionsToolView = {
  records: ProjectExpressionRecordView[];
  diagnostics: string[];
  evaluation?: ExpressionEvaluationResult | null;
};

function semanticElementCacheKey(root: string, qualifiedName: string, filePath?: string | null): string {
  return `${root.toLowerCase()}\u0000${(filePath || "").toLowerCase()}\u0000${qualifiedName.toLowerCase()}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function clearSemanticProjectionCache(root?: string): void {
  if (!root) {
    semanticProjectionCache.clear();
    semanticProjectionInFlight.clear();
    return;
  }
  const prefix = `${root.toLowerCase()}\u0000`;
  for (const key of Array.from(semanticProjectionCache.keys())) {
    if (key.startsWith(prefix)) {
      semanticProjectionCache.delete(key);
    }
  }
  for (const key of Array.from(semanticProjectionInFlight.keys())) {
    if (key.startsWith(prefix)) {
      semanticProjectionInFlight.delete(key);
    }
  }
}

export async function querySemanticElementProjectionByQualifiedName(
  root: string,
  qualifiedName: string,
  filePath?: string | null,
): Promise<SemanticElementProjectionResult | null> {
  const target = (qualifiedName || "").trim();
  if (!target) return null;
  const key = semanticElementCacheKey(root, target, filePath);
  if (semanticProjectionCache.has(key)) {
    return semanticProjectionCache.get(key) || null;
  }
  const existing = semanticProjectionInFlight.get(key);
  if (existing) {
    return existing;
  }
  const request = callTool<SemanticElementProjectionResult | null>("core.query_semantic_element@v2", {
    root,
    qualified_name: target,
    file_path: filePath || null,
  })
    .then((row) => {
      semanticProjectionCache.delete(key);
      semanticProjectionCache.set(key, row || null);
      if (semanticProjectionCache.size > SEMANTIC_ELEMENT_CACHE_LIMIT) {
        const oldest = semanticProjectionCache.keys().next().value;
        if (oldest) {
          semanticProjectionCache.delete(oldest);
        }
      }
      return row || null;
    })
    .finally(() => {
      semanticProjectionInFlight.delete(key);
    });
  semanticProjectionInFlight.set(key, request);
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

export async function queryProjectSymbolsForFiles(
  root: string,
  filePaths: string[],
  offset = 0,
  limit = 200_000,
): Promise<IndexedSymbolView[]> {
  return callTool<IndexedSymbolView[]>("core.query_project_symbols_for_files@v1", {
    root,
    file_paths: filePaths,
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

export async function loadLibrarySymbols(
  root: string,
  filePath?: string | null,
  includeSymbols = true,
): Promise<LibrarySymbolsLoadResult> {
  return callTool<LibrarySymbolsLoadResult>("core.load_library_symbols@v1", {
    root,
    file_path: filePath || null,
    include_symbols: includeSymbols,
  });
}

export async function getProjectElementAttributes(
  root: string,
  elementQualifiedName: string,
  symbolKind?: string | null,
): Promise<ProjectElementAttributesView> {
  return withTimeout(
    callTool<ProjectElementAttributesView>("core.get_project_element_attributes@v1", {
      root,
      element_qualified_name: elementQualifiedName,
      symbol_kind: symbolKind || null,
    }),
    PROJECT_ELEMENT_ATTRIBUTES_TIMEOUT_MS,
    "Loading semantic attributes",
  );
}

export async function getProjectModel(root: string): Promise<ProjectModelView> {
  return callTool<ProjectModelView>("core.get_project_model@v1", { root });
}

export async function getDefaultStdlib(): Promise<string | null> {
  return callTool<string | null>("stdlib.get_default@v1", {});
}

export async function getExpressionsView(root: string, expression?: string | null): Promise<ExpressionsToolView> {
  return callTool<ExpressionsToolView>("core.get_expressions_view@v1", {
    root,
    expression: expression || null,
  });
}
