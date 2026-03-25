import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..", "..");
const projectRoot = resolve(import.meta.dirname, "..");
const siblingSysmlRoot = resolve(workspaceRoot, "..", "mercurio-sysml");
const outputPath = resolve(projectRoot, "src", "app", "generated", "core-contracts.ts");

const STRUCT_SPECS = [
  {
    rustPath: resolve(workspaceRoot, "mercurio-core", "src", "state.rs"),
    rustName: "CacheClearSummary",
    tsName: "CacheClearSummary",
  },
  {
    rustPath: resolve(workspaceRoot, "mercurio-core", "src", "state.rs"),
    rustName: "CompileDiagnosticView",
    tsName: "ParseDiagnosticView",
    fieldOverrides: {
      source: '"parse" | "semantic"',
    },
  },
  {
    rustPath: resolve(workspaceRoot, "mercurio-core", "src", "workspace_tree.rs"),
    rustName: "WorkspaceTreeEntryView",
    tsName: "WorkspaceTreeEntryView",
  },
  {
    rustPath: resolve(workspaceRoot, "mercurio-core", "src", "workspace_tree.rs"),
    rustName: "WorkspaceTreeSnapshotView",
    tsName: "WorkspaceTreeSnapshotResult",
  },
  {
    rustPath: resolve(workspaceRoot, "mercurio-core", "src", "compile.rs"),
    rustName: "CompileFileDiagnosticsView",
    tsName: "FileDiagnosticsBucket",
  },
  {
    rustPath: resolve(workspaceRoot, "mercurio-core", "src", "compile.rs"),
    rustName: "ParseErrorCategoryView",
    tsName: "ParseErrorCategoryView",
  },
  {
    rustPath: resolve(workspaceRoot, "mercurio-core", "src", "compile.rs"),
    rustName: "CompileResponse",
    tsName: "CompileResponse",
    skipFields: new Set(["files", "symbols", "unresolved", "project_symbol_count", "library_symbol_count", "library_path", "parse_failed", "workspace_snapshot_hit", "stdlib_duration_ms", "stdlib_file_count"]),
    fieldOverrides: {
      file_diagnostics: "FileDiagnosticsBucket[]",
      parse_error_categories: "ParseErrorCategoryView[]",
      performance_warnings: "string[]",
      parsed_files: "string[]",
      parse_duration_ms: "number",
      analysis_duration_ms: "number",
      total_duration_ms: "number",
      ok: "boolean",
    },
    optionalFields: new Set(["file_diagnostics", "parse_error_categories", "performance_warnings", "parsed_files", "parse_duration_ms", "analysis_duration_ms", "total_duration_ms"]),
  },
  {
    rustPath: resolve(workspaceRoot, "mercurio-core", "src", "symbol_index.rs"),
    rustName: "IndexedStructuralTypeView",
    tsName: "IndexedStructuralTypeView",
  },
  {
    rustPath: resolve(workspaceRoot, "mercurio-core", "src", "symbol_index.rs"),
    rustName: "IndexedDirectedRelationshipView",
    tsName: "IndexedDirectedRelationshipView",
  },
  {
    rustPath: resolve(workspaceRoot, "mercurio-core", "src", "symbol_index.rs"),
    rustName: "IndexedSymbolView",
    tsName: "IndexedSymbolView",
  },
  {
    rustPath: resolve(workspaceRoot, "mercurio-core", "src", "workspace_symbols.rs"),
    rustName: "WorkspaceSymbolSnapshotTimingsView",
    tsName: "WorkspaceSymbolSnapshotTimingsView",
  },
  {
    rustPath: resolve(workspaceRoot, "mercurio-core", "src", "workspace_symbols.rs"),
    rustName: "WorkspaceSymbolSnapshotView",
    tsName: "WorkspaceSymbolSnapshotResult",
  },
  {
    rustPath: resolve(workspaceRoot, "mercurio-core", "src", "workspace_symbols.rs"),
    rustName: "WorkspaceStartupSnapshotTimingsView",
    tsName: "WorkspaceStartupSnapshotTimingsView",
  },
  {
    rustPath: resolve(workspaceRoot, "mercurio-core", "src", "workspace_symbols.rs"),
    rustName: "WorkspaceStartupSnapshotView",
    tsName: "WorkspaceStartupSnapshotResult",
  },
  {
    rustPath: resolve(
      siblingSysmlRoot,
      "crates",
      "mercurio-sysml-semantics",
      "src",
      "semantic_project_model_contract.rs",
    ),
    rustName: "ProjectExpressionRecordView",
    tsName: "ProjectExpressionRecordView",
  },
  {
    rustPath: resolve(workspaceRoot, "mercurio-application", "src", "commands", "tools.rs"),
    rustName: "ExpressionEvaluationResult",
    tsName: "ExpressionEvaluationResult",
  },
  {
    rustPath: resolve(workspaceRoot, "mercurio-application", "src", "commands", "tools.rs"),
    rustName: "ExpressionsToolView",
    tsName: "ExpressionsToolView",
    fieldOverrides: {
      records: "ProjectExpressionRecordView[]",
    },
  },
  {
    rustPath: resolve(
      siblingSysmlRoot,
      "crates",
      "mercurio-sysml-semantics",
      "src",
      "semantic_project_model_contract.rs",
    ),
    rustName: "ProjectModelAttributeView",
    tsName: "ProjectModelAttributeView",
  },
  {
    rustPath: resolve(
      siblingSysmlRoot,
      "crates",
      "mercurio-sysml-semantics",
      "src",
      "semantic_project_model_contract.rs",
    ),
    rustName: "ProjectModelElementView",
    tsName: "ProjectModelElementView",
  },
  {
    rustPath: resolve(
      siblingSysmlRoot,
      "crates",
      "mercurio-sysml-semantics",
      "src",
      "semantic_project_model_contract.rs",
    ),
    rustName: "ProjectModelView",
    tsName: "ProjectModelView",
  },
  {
    rustPath: resolve(
      siblingSysmlRoot,
      "crates",
      "mercurio-sysml-semantics",
      "src",
      "semantic_project_model_contract.rs",
    ),
    rustName: "ProjectElementInheritedAttributeView",
    tsName: "ProjectElementInheritedAttributeView",
  },
  {
    rustPath: resolve(workspaceRoot, "mercurio-core", "src", "project_model.rs"),
    rustName: "ProjectElementPropertyRowView",
    tsName: "ProjectElementPropertyRowView",
  },
  {
    rustPath: resolve(workspaceRoot, "mercurio-core", "src", "project_model.rs"),
    rustName: "ProjectElementPropertySectionView",
    tsName: "ProjectElementPropertySectionView",
  },
  {
    rustPath: resolve(workspaceRoot, "mercurio-core", "src", "project_model.rs"),
    rustName: "ProjectElementPropertySectionsView",
    tsName: "ProjectElementPropertySectionsView",
  },
];

const TYPE_NAME_MAP = new Map(STRUCT_SPECS.map((spec) => [spec.rustName, spec.tsName]));

function extractStructBody(source, rustName) {
  const markers = [`pub struct ${rustName}`, `struct ${rustName}`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? -1;
  if (start < 0) {
    throw new Error(`Could not find struct ${rustName}`);
  }
  const braceStart = source.indexOf("{", start);
  if (braceStart < 0) {
    throw new Error(`Could not find opening brace for ${rustName}`);
  }
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(braceStart + 1, index);
      }
    }
  }
  throw new Error(`Could not find closing brace for ${rustName}`);
}

function splitGenericArgs(raw) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw[index];
    if (ch === "<") depth += 1;
    if (ch === ">") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(raw.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = raw.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function mapRustTypeToTs(rustType) {
  const trimmed = rustType.trim();
  if (trimmed.startsWith("Option<") && trimmed.endsWith(">")) {
    const inner = trimmed.slice(7, -1);
    return `${mapRustTypeToTs(inner)} | null`;
  }
  if (trimmed.startsWith("Vec<") && trimmed.endsWith(">")) {
    const inner = trimmed.slice(4, -1);
    return `${mapRustTypeToTs(inner)}[]`;
  }
  if (trimmed.startsWith("HashMap<") && trimmed.endsWith(">")) {
    const inner = trimmed.slice(8, -1);
    const [keyType, valueType] = splitGenericArgs(inner);
    if (keyType === "String") {
      return `Record<string, ${mapRustTypeToTs(valueType)}>`;
    }
  }
  if (trimmed === "String" || trimmed === "&str") return "string";
  if (trimmed === "bool") return "boolean";
  if (/^(u|i)\d+$/.test(trimmed) || trimmed === "usize" || trimmed === "isize" || /^f\d+$/.test(trimmed)) {
    return "number";
  }
  return TYPE_NAME_MAP.get(trimmed) ?? trimmed;
}

function parseFields(body) {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#["))
    .map((line) => {
      const match = line.match(/^(?:pub\s+)?([a-zA-Z0-9_]+):\s*(.+),$/);
      if (!match) {
        throw new Error(`Unsupported field line: ${line}`);
      }
      return {
        name: match[1],
        rustType: match[2],
      };
    });
}

function buildTypeBlock(spec) {
  const source = readFileSync(spec.rustPath, "utf8");
  const body = extractStructBody(source, spec.rustName);
  const fields = parseFields(body)
    .filter((field) => !(spec.skipFields && spec.skipFields.has(field.name)))
    .map((field) => {
      const optional = spec.optionalFields?.has(field.name) ?? false;
      const tsType = spec.fieldOverrides?.[field.name] ?? mapRustTypeToTs(field.rustType);
      return `  ${field.name}${optional ? "?" : ""}: ${tsType};`;
    });
  return `export type ${spec.tsName} = {\n${fields.join("\n")}\n};`;
}

const lines = [
  "// GENERATED FILE. DO NOT EDIT.",
  `// Generated by ${"scripts/generate-core-contracts.mjs"}.`,
  "",
  ...STRUCT_SPECS.map(buildTypeBlock).flatMap((block) => [block, ""]),
];

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${lines.join("\n").trimEnd()}\n`);
console.log(`Wrote ${outputPath}`);
