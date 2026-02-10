import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "./types";

export async function readFileText(path: string): Promise<string> {
  const content = await invoke<string>("read_file", { path });
  return content || "";
}

export async function listDirEntries(path: string): Promise<FileEntry[]> {
  const entries = await invoke<FileEntry[]>("list_dir", { path });
  return entries || [];
}

export async function getAstForPath(path: string): Promise<string> {
  const ast = await invoke<string>("get_ast_for_path", { path });
  return ast || "";
}

export async function getAstForContent(path: string, content: string): Promise<string> {
  const ast = await invoke<string>("get_ast_for_content", { path, content });
  return ast || "";
}
