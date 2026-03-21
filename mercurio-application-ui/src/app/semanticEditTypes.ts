import type { SymbolView } from "./contracts";

export type SemanticEditTarget = Pick<
  SymbolView,
  | "symbol_id"
  | "qualified_name"
  | "name"
  | "kind"
  | "metatype_qname"
  | "file_path"
  | "source_scope"
  | "parent_qualified_name"
  | "start_line"
  | "start_col"
  | "end_line"
  | "end_col"
  | "short_name_start_line"
  | "short_name_start_col"
  | "short_name_end_line"
  | "short_name_end_col"
>;

export type SemanticEditFieldType = "text" | "textarea" | "checkbox" | "select" | "readonly";

export type SemanticEditFieldOption = {
  value: string;
  label: string;
};

export type SemanticEditField = {
  key: string;
  label: string;
  field_type: SemanticEditFieldType;
  required: boolean;
  placeholder?: string | null;
  description?: string | null;
  default_text?: string | null;
  default_bool?: boolean | null;
  options: SemanticEditFieldOption[];
};

export type SemanticEditAppliesTo = {
  type_name: string;
  include_subtypes: boolean;
};

export type SemanticEditAction = {
  id: string;
  label: string;
  description: string;
  applies_to: SemanticEditAppliesTo[];
  fields: SemanticEditField[];
};

export type SemanticEditPreviewResult = {
  action_id: string;
  action_label: string;
  changed: boolean;
  diff: string;
  updated_text: string;
  diagnostics: string[];
  skipped_ops: number;
};

export type SemanticEditApplyResult = {
  action_id: string;
  action_label: string;
  changed: boolean;
  updated_text: string;
  diagnostics: string[];
  skipped_ops: number;
  file_path: string;
};

export type SemanticEditInputValue = string | boolean;

export type SemanticEditInputValues = Record<string, SemanticEditInputValue>;

export type SemanticEditTargetWithLineage = SemanticEditTarget & {
  metatype_lineage?: string[] | null;
  metatype_supertypes?: string[] | null;
};
