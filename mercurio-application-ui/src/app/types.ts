import type { DiagramDocument, DiagramPoint, DiagramViewport } from "./diagrams/file";
import type {
  SymbolView,
} from "./contracts";

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
  | { type: "empty"; key: string; text: string };

export type DiagramLayout = {
  node: { name: string; fullName: string; kind: string };
  width: number;
  height: number;
  children: Array<{ layout: DiagramLayout; x: number; y: number }>;
};

export type DiagramNodeOffset = DiagramPoint;

export type DiagramNodeSize = { width: number; height: number };

export type DiagramFile = DiagramDocument;
export type { DiagramViewport };

