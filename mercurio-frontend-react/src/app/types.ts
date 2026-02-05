export type FileEntry = {
  path: string;
  name: string;
  is_dir: boolean;
  is_parent?: boolean;
  is_action?: boolean;
};

export type TabKind = "file" | "descriptor" | "diagram" | "ai" | "data";

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

export type DiagramManualNode = {
  id: string;
  type: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pending: boolean;
};

export type DiagramViewport = { x: number; y: number; width: number; height: number };
