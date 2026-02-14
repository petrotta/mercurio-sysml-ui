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

export type TabKind = "file" | "descriptor" | "diagram" | "ai" | "data" | "project-model";

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

export type SymbolView = {
  name: string;
  kind: string;
  file_path: string;
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
  | { type: "section"; key: string; section: "project" | "library" | "errors"; label: string; countLabel: string }
  | {
      type: "symbol";
      key: string;
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

export type StdlibMetamodelView = {
  stdlib_path?: string | null;
  stdlib_cache_hit: boolean;
  type_count: number;
  types: MetamodelTypeView[];
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
  attributes: ProjectModelAttributeView[];
  diagnostics: string[];
};

export type ProjectModelView = {
  stdlib_path?: string | null;
  stdlib_cache_hit: boolean;
  project_cache_hit: boolean;
  element_count: number;
  elements: ProjectModelElementView[];
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
