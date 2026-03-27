import { invoke } from "@tauri-apps/api/core";
import type { GitRepoInfo, GitStatus } from "./types";

export const detectGitRepo = async (root: string) => {
  return invoke<GitRepoInfo | null>("detect_git_repo", { root });
};

export const getGitStatus = async (repoRoot: string) => {
  return invoke<GitStatus>("git_status", { repoRoot });
};

export const stageGitPaths = async (repoRoot: string, paths: string[]) => {
  return invoke<GitStatus>("git_stage_paths", { repoRoot, paths });
};

export const unstageGitPaths = async (repoRoot: string, paths: string[]) => {
  return invoke<GitStatus>("git_unstage_paths", { repoRoot, paths });
};

export const commitGit = async (repoRoot: string, message: string) => {
  return invoke<string>("git_commit", { repoRoot, message });
};

export const pushGit = async (repoRoot: string, remote?: string | null) => {
  return invoke<void>("git_push", { repoRoot, remote: remote ?? null });
};
