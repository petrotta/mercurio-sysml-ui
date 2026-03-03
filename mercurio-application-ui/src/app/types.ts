import type { DiagramType } from "./diagrams/model";

export type FileEntry = {
  path: string;
  name: string;
  is_dir: boolean;
  is_parent?: boolean;
  is_action?: boolean;
};

export type AiEndpoint = {
  id: string;
  name: string;
  url: string;
  type: "chat" | "embeddings";
  provider: "openai" | "anthropic";
  model: string;
  token: string;
};

export type TabKind = "file" | "descriptor" | "diagram" | "explore-diagram" | "ai" | "data" | "project-model" | "stdlib-graph";

export type OpenTab = {
  path: string;
  name: string;
  dirty: boolean;
  kind?: TabKind;
  sourcePath?: string;
};

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

export type SymbolView = {
  name: string;
  kind: string;
  file_path: string;
  source_scope?: "project" | "library";
  qualified_name: string;
  file: number;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
  expr_start_line?: number;
  expr_start_col?: number;
  expr_end_line?: number;
  expr_end_col?: number;
  doc?: string | null;
  properties: SymbolProperty[];
  relationships?: SymbolRelationship[];
};

export type IndexedSymbolView = {
  id: string;
  project_root: string;
  library_key?: string | null;
  scope: string;
  name: string;
  qualified_name: string;
  kind: string;
  metatype_qname?: string | null;
  file_path: string;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
  doc_text?: string | null;
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

export type UnresolvedIssue = {
  file_path: string;
  message: string;
  line: number;
  column: number;
};

export type SymbolNode = {
  name: string;
  fullName: string;
  symbols: SymbolView[];
  children: Map<string, SymbolNode>;
};

export type ModelRow =
  | { type: "section"; key: string; section: "project" | "library" | "imports" | "errors"; label: string; countLabel: string }
  | {
      type: "symbol";
      key: string;
      section: "project" | "library";
      filePath: string | null;
      isFileRoot: boolean;
      isLoading: boolean;
      loadError?: string;
      name: string;
      kindLabel: string;
      kindKey: string;
      depth: number;
      node: SymbolNode;
      hasChildren: boolean;
      expanded: boolean;
    }
  | { type: "empty"; key: string; text: string }
  | { type: "error"; key: string; issue: UnresolvedIssue };

export type DiagramLayout = {
  node: { name: string; fullName: string; kind: string };
  width: number;
  height: number;
  children: Array<{ layout: DiagramLayout; x: number; y: number }>;
};

export type DiagramViewport = { x: number; y: number; width: number; height: number };

export type DiagramNode = {
  qualified: string;
  name: string;
  kind: string;
};

export type DiagramNodeOffset = { x: number; y: number };

export type DiagramNodeSize = { width: number; height: number };

export type DiagramFile = {
  version: number;
  diagram_type: DiagramType;
  nodes: DiagramNode[];
  offsets?: Record<string, DiagramNodeOffset>;
  sizes?: Record<string, DiagramNodeSize>;
};

export type MetamodelModifiersView = {
  is_public: boolean;
  is_abstract: boolean;
  is_variation: boolean;
  is_readonly: boolean;
  is_derived: boolean;
  is_parallel: boolean;
};

export type MetamodelAttributeView = {
  name: string;
  qualified_name: string;
  declared_type?: string | null;
  multiplicity?: string | null;
  direction?: string | null;
  documentation?: string | null;
  modifiers: MetamodelModifiersView;
};

export type MetamodelTypeView = {
  name: string;
  qualified_name: string;
  declared_supertypes: string[];
  supertypes: string[];
  documentation?: string | null;
  modifiers: MetamodelModifiersView;
  attributes: MetamodelAttributeView[];
};

export type StdlibCacheSummary = {
  path: string;
  signature: string;
  file_count: number;
};

export type PhaseTimingView = {
  phase: string;
  duration_ms: number;
};

export type StdlibMetamodelDiagnostics = {
  resolved_stdlib_path?: string | null;
  cache_key: string;
  cache_hit: boolean;
  snapshot_hit: boolean;
  cache_lookup_error?: string | null;
  stdlib_cache_snapshot_error?: string | null;
  metamodel_cache_store_error?: string | null;
  failure_reason?: string | null;
  duplicate_qualified_names: string[];
  cache_entries: StdlibCacheSummary[];
  phase_timings: PhaseTimingView[];
  expression_records_error?: string | null;
};

export type ExpressionRecordView = {
  owner_id: number;
  qualified_name: string;
  feature?: string | null;
  expression: string;
};

export type StdlibExpressionRecordView = ExpressionRecordView;

export type StdlibMetamodelView = {
  stdlib_path?: string | null;
  stdlib_cache_hit: boolean;
  type_count: number;
  types: MetamodelTypeView[];
  expression_records: StdlibExpressionRecordView[];
  diagnostics: StdlibMetamodelDiagnostics;
};

export type ProjectModelAttributeView = {
  name: string;
  qualified_name: string;
  declared_type?: string | null;
  multiplicity?: string | null;
  direction?: string | null;
  documentation?: string | null;
  cst_value?: string | null;
  metamodel_attribute_qname?: string | null;
  diagnostics: string[];
};

export type ProjectModelElementView = {
  name: string;
  qualified_name: string;
  kind: string;
  file_path: string;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
  metatype_qname?: string | null;
  declared_supertypes: string[];
  supertypes: string[];
  direct_specializations: string[];
  indirect_specializations: string[];
  documentation?: string | null;
  owned_elements_qnames?: string[];
  attributes: ProjectModelAttributeView[];
  diagnostics: string[];
};

export type ProjectModelView = {
  stdlib_path?: string | null;
  stdlib_cache_hit: boolean;
  project_cache_hit: boolean;
  element_count: number;
  elements: ProjectModelElementView[];
  expression_records?: ExpressionRecordView[];
  diagnostics: string[];
};

export type ProjectElementInheritedAttributeView = {
  name: string;
  qualified_name: string;
  declared_on: string;
  declared_type?: string | null;
  multiplicity?: string | null;
  direction?: string | null;
  documentation?: string | null;
  cst_value?: string | null;
};

export type ProjectElementAttributesView = {
  element_qualified_name: string;
  metatype_qname?: string | null;
  explicit_attributes: ProjectModelAttributeView[];
  inherited_attributes: ProjectElementInheritedAttributeView[];
  diagnostics: string[];
};

export type SymbolMetatypeMappingView = {
  project_root: string;
  symbol_id: string;
  symbol_file_path: string;
  symbol_qualified_name: string;
  symbol_kind: string;
  resolved_metatype_qname?: string | null;
  target_symbol_id?: string | null;
  mapping_source: string;
  confidence: number;
  diagnostic?: string | null;
};

export type SemanticElementResult = {
  name: string;
  qualified_name: string;
  file_path: string;
  attributes?: Record<string, string>;
};
