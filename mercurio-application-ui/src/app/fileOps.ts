import { invoke } from "@tauri-apps/api/core";
import type { ParseTreeNodeView } from "./contracts";
import type { FileEntry } from "./types";

export type ProjectFilesChangedEvent = {
  root: string;
  path: string;
  kind: string;
};

export async function readFileText(path: string): Promise<string> {
  const content = await invoke<string>("read_file", { path });
  return content || "";
}

export async function listDirEntries(path: string): Promise<FileEntry[]> {
  const entries = await invoke<FileEntry[]>("list_dir", { path });
  return entries || [];
}

export async function createProjectFile(root: string, parent: string, name: string): Promise<string> {
  const createdPath = await invoke<string>("create_file", { root, parent, name });
  return createdPath || "";
}

export async function createProject(
  parent: string,
  name: string,
  author?: string,
  description?: string,
  organization?: string,
  useDefaultLibrary = true,
): Promise<string> {
  const createdRoot = await invoke<string>("create_project", {
    parent,
    name,
    author,
    description,
    organization,
    useDefaultLibrary,
  });
  return createdRoot || "";
}

export async function getUserProjectsRoot(): Promise<string> {
  const root = await invoke<string>("get_user_projects_root");
  return root || "";
}

export async function getAstForPath(path: string): Promise<string> {
  const ast = await invoke<string>("get_ast_for_path", { path });
  return ast || "";
}

export async function getAstForContent(path: string, content: string): Promise<string> {
  const ast = await invoke<string>("get_ast_for_content", { path, content });
  return ast || "";
}

export async function getParseTreeForContent(path: string, content: string): Promise<ParseTreeNodeView[]> {
  const rows = await invoke<ParseTreeNodeView[]>("get_parse_tree_for_content", { path, content });
  return rows || [];
}

export async function startProjectFileWatcher(path: string): Promise<boolean> {
  const result = await invoke<boolean>("start_project_file_watcher", { root: path });
  return !!result;
}

export async function stopProjectFileWatcher(path: string): Promise<boolean> {
  const result = await invoke<boolean>("stop_project_file_watcher", { root: path });
  return !!result;
}
