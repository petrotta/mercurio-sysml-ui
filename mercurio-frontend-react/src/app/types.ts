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
