import type {
  FileDiagnosticView,
  IndexedSymbolView,
  SymbolView,
} from "./contracts";
import { normalizePathKey } from "./pathUtils";

export { normalizePathKey } from "./pathUtils";

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

export const COMPILE_REQUEST_DEBOUNCE_MS = 250;

export function indexedToSymbol(
  symbol: IndexedSymbolView,
): SymbolView {
  const sourceScope = symbol.scope === "library" || symbol.scope === "stdlib"
    ? "library"
    : symbol.scope === "project"
      ? "project"
      : undefined;
  return {
    symbol_id: symbol.id,
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
    structural_type: symbol.structural_type
      ? {
          feature_name: symbol.structural_type.feature_name,
          label: symbol.structural_type.label,
          target: symbol.structural_type.target,
          target_metatype_qname: symbol.structural_type.target_metatype_qname || null,
          declared_type_qname: symbol.structural_type.declared_type_qname || null,
          metamodel_feature_qname: symbol.structural_type.metamodel_feature_qname || null,
        }
      : null,
    directed_relationships: (symbol.directed_relationships || []).map((relationship) => ({
      canonical_kind: relationship.canonical_kind,
      display_label: relationship.display_label,
      source: relationship.source,
      target: relationship.target,
      target_metatype_qname: relationship.target_metatype_qname || null,
      source_feature: relationship.source_feature || null,
      target_feature: relationship.target_feature || null,
      resolved: !!relationship.resolved,
    })),
    explorer_diagnostics: symbol.explorer_diagnostics || [],
  };
}

function normalizeDiagnosticPosition(line?: number, column?: number): { line: number; column: number } {
  return {
    line: Number.isFinite(line) && (line || 0) > 0 ? Number(line) : 1,
    column: Number.isFinite(column) && (column || 0) > 0 ? Number(column) : 1,
  };
}

export function compileRequestKey(filePath?: string, unsavedInputs: UnsavedCompileInput[] = []): string {
  const normalizedFile = normalizePathKey((filePath || "").trim());
  const normalizedUnsaved = (unsavedInputs || [])
    .map((entry) => ({
      path: normalizePathKey((entry?.path || "").trim()),
      contentLength: (entry?.content || "").length,
    }))
    .filter((entry) => !!entry.path)
    .sort((left, right) => left.path.localeCompare(right.path));
  return JSON.stringify({
    file: normalizedFile,
    unsaved: normalizedUnsaved,
  });
}

export function formatFileDiagnostic(diagnostic: FileDiagnosticView): string {
  const { line, column } = normalizeDiagnosticPosition(diagnostic.line, diagnostic.column);
  const source = diagnostic.source === "semantic" ? "semantic" : "parse";
  const kind = `${diagnostic.kind || ""}`.trim();
  const label = kind && kind !== source ? `${source}/${kind}` : source;
  return `[${label} ${line}:${column}] ${diagnostic.message}`;
}
