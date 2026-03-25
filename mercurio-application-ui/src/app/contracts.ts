import type { ParseDiagnosticView } from "./generated/core-contracts";

export * from "./generated/core-contracts";

export type FileDiagnosticView = ParseDiagnosticView;

export type SymbolPropertyValue =
  | { type: "text"; value: string }
  | { type: "list"; items: string[] }
  | { type: "bool"; value: boolean }
  | { type: "number"; value: number };

export type SymbolProperty = {
  name: string;
  label: string;
  value: SymbolPropertyValue;
  hint?: string | null;
  group?: string | null;
};

export type SymbolRelationship = {
  kind: string;
  target: string;
  resolved_target?: string | null;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
};

export type SymbolStructuralType = {
  feature_name: string;
  label: string;
  target: string;
  target_metatype_qname?: string | null;
  declared_type_qname?: string | null;
  metamodel_feature_qname?: string | null;
};

export type DirectedRelationshipView = {
  canonical_kind: string;
  display_label: string;
  source: string;
  target: string;
  target_metatype_qname?: string | null;
  source_feature?: string | null;
  target_feature?: string | null;
  resolved: boolean;
};

export type SymbolView = {
  symbol_id?: string | null;
  name: string;
  kind: string;
  metatype_qname?: string | null;
  file_path: string;
  source_scope?: "project" | "library";
  qualified_name: string;
  parent_qualified_name?: string | null;
  file: number;
  short_name?: string | null;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
  expr_start_line?: number;
  expr_start_col?: number;
  expr_end_line?: number;
  expr_end_col?: number;
  short_name_start_line?: number;
  short_name_start_col?: number;
  short_name_end_line?: number;
  short_name_end_col?: number;
  doc?: string | null;
  properties: SymbolProperty[];
  relationships?: SymbolRelationship[];
  structural_type?: SymbolStructuralType | null;
  directed_relationships?: DirectedRelationshipView[];
  explorer_diagnostics?: string[];
};

export type ParseTreeNodeView = {
  id: string;
  parent_id?: string | null;
  kind: string;
  label: string;
  start_offset: number;
  end_offset: number;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
  depth: number;
};
