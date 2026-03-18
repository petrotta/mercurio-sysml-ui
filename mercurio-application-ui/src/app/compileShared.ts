import type { IndexedSymbolView, SymbolView, UnresolvedIssue } from "./types";

export type CompileFileResultView = {
  path: string;
  ok: boolean;
  errors: string[];
  symbol_count: number;
};

export type CompileResponse = {
  ok: boolean;
  files?: CompileFileResultView[];
  parse_error_categories?: Array<{ category: string; count: number }>;
  performance_warnings?: string[];
  project_symbol_count?: number;
  library_path?: string | null;
  parsed_files?: string[];
  parse_duration_ms?: number;
  analysis_duration_ms?: number;
  total_duration_ms?: number;
  symbols: SymbolView[];
  unresolved: UnresolvedIssue[];
};

export type CompileProgressPayload = {
  run_id: number;
  stage: string;
  file?: string;
  index?: number;
  total?: number;
};

export type UnsavedCompileInput = {
  path: string;
  content: string;
};

export type SymbolsStatus = "idle" | "loading" | "ready" | "error";

export const INDEX_QUERY_LIMIT = 400_000;
export const COMPILE_REQUEST_DEBOUNCE_MS = 250;
export const POST_COMPILE_SYMBOL_REFRESH_RETRIES = 6;
export const POST_COMPILE_SYMBOL_REFRESH_DELAY_MS = 40;

export function normalizePathKey(path: string): string {
  return (path || "").replace(/\//g, "\\").toLowerCase();
}

export function indexedToSymbol(
  symbol: IndexedSymbolView,
  sourceScope: "project" | "library",
): SymbolView {
  return {
    name: symbol.name,
    kind: symbol.kind,
    metatype_qname: symbol.metatype_qname || null,
    file_path: symbol.file_path,
    source_scope: sourceScope,
    qualified_name: symbol.qualified_name,
    parent_qualified_name: symbol.parent_qualified_name || null,
    file: 0,
    start_line: symbol.start_line,
    start_col: symbol.start_col,
    end_line: symbol.end_line,
    end_col: symbol.end_col,
    doc: symbol.doc_text || null,
    properties: [],
    relationships: [],
  };
}

export function mergeSymbols(symbols: SymbolView[]): SymbolView[] {
  const out: SymbolView[] = [];
  const seen = new Set<string>();
  for (const symbol of symbols) {
    const key = `${normalizePathKey(symbol.file_path)}|${symbol.qualified_name}|${symbol.name}|${symbol.start_line}|${symbol.start_col}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(symbol);
  }
  return out;
}

export function mergeProjectSymbolsByFile(
  previous: SymbolView[],
  incoming: SymbolView[],
  scopedFilePath?: string,
): SymbolView[] {
  if (!scopedFilePath) {
    return incoming.length ? incoming : previous;
  }
  const scopedKey = normalizePathKey(scopedFilePath);
  const kept = previous.filter((symbol) => normalizePathKey(symbol.file_path) !== scopedKey);
  return mergeSymbols([...kept, ...incoming]);
}

export function mergeProjectSymbolsByParsedFiles(
  previous: SymbolView[],
  incoming: SymbolView[],
  parsedFiles: string[] | undefined,
): SymbolView[] {
  const parsed = new Set((parsedFiles || []).map((path) => normalizePathKey(path)));
  if (!parsed.size) {
    return incoming.length ? incoming : previous;
  }
  const kept = previous.filter((symbol) => !parsed.has(normalizePathKey(symbol.file_path)));
  return mergeSymbols([...kept, ...incoming]);
}

export function formatSemanticIssue(issue: UnresolvedIssue): string {
  const line = Number.isFinite(issue.line) && issue.line > 0 ? issue.line : 1;
  const col = Number.isFinite(issue.column) && issue.column > 0 ? issue.column : 1;
  return `[semantic ${line}:${col}] ${issue.message}`;
}

export function compileRequestKey(filePath?: string, unsavedInputs: UnsavedCompileInput[] = []): string {
  const normalizedFile = (filePath || "").trim().toLowerCase();
  const normalizedUnsaved = (unsavedInputs || [])
    .map((entry) => ({
      path: (entry?.path || "").trim().toLowerCase(),
      contentLength: (entry?.content || "").length,
    }))
    .filter((entry) => !!entry.path)
    .sort((left, right) => left.path.localeCompare(right.path));
  return JSON.stringify({
    file: normalizedFile,
    unsaved: normalizedUnsaved,
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function buildCompileErrorBuckets(
  files: CompileFileResultView[],
  unresolved: UnresolvedIssue[],
): Array<{ path: string; errors: string[] }> {
  const byPath = new Map<string, { path: string; errors: string[] }>();
  for (const file of files || []) {
    if (!file?.path) continue;
    const errs = Array.isArray(file.errors) ? file.errors.filter(Boolean) : [];
    if (!errs.length) continue;
    byPath.set(file.path, { path: file.path, errors: [...errs] });
  }
  for (const issue of unresolved || []) {
    if (!issue?.file_path) continue;
    const message = formatSemanticIssue(issue);
    const existing = byPath.get(issue.file_path);
    if (existing) {
      existing.errors.push(message);
    } else {
      byPath.set(issue.file_path, { path: issue.file_path, errors: [message] });
    }
  }
  return Array.from(byPath.values());
}
