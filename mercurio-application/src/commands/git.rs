use git2::{BranchType, Repository, Status, StatusOptions};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct GitRepoInfo {
    repo_root: String,
    branch: String,
    ahead: usize,
    behind: usize,
    clean: bool,
    remote_url: Option<String>,
}

#[derive(Serialize)]
pub struct GitStatus {
    staged: Vec<String>,
    unstaged: Vec<String>,
    untracked: Vec<String>,
}

#[derive(Serialize)]
pub struct GitBranches {
    current: String,
    branches: Vec<String>,
}

fn repo_root_path(repo: &Repository) -> Result<PathBuf, String> {
    let mut root = if let Some(workdir) = repo.workdir() {
        workdir.to_path_buf()
    } else {
        let git_dir = repo.path();
        git_dir
            .parent()
            .map(|path| path.to_path_buf())
            .ok_or_else(|| "Failed to resolve repo root".to_string())?
    };
    if let Some(name) = root.file_name().and_then(|value| value.to_str()) {
        if name.eq_ignore_ascii_case(".git") {
            if let Some(parent) = root.parent() {
                root = parent.to_path_buf();
            }
        }
    }
    Ok(root.canonicalize().unwrap_or(root))
}

fn get_branch_and_ahead_behind(repo: &Repository) -> Result<(String, usize, usize), String> {
    let head = repo.head().map_err(|e| e.to_string())?;
    let branch_name = head
        .shorthand()
        .map(|name| name.to_string())
        .unwrap_or_else(|| "DETACHED".to_string());
    if !head.is_branch() {
        return Ok((branch_name, 0, 0));
    }
    let local_branch = repo
        .find_branch(&branch_name, BranchType::Local)
        .map_err(|e| e.to_string())?;
    let upstream = match local_branch.upstream() {
        Ok(branch) => branch,
        Err(_) => return Ok((branch_name, 0, 0)),
    };
    let local_oid = local_branch
        .get()
        .target()
        .ok_or_else(|| "Missing local branch target".to_string())?;
    let upstream_oid = upstream
        .get()
        .target()
        .ok_or_else(|| "Missing upstream branch target".to_string())?;
    let (ahead, behind) = repo
        .graph_ahead_behind(local_oid, upstream_oid)
        .map_err(|e| e.to_string())?;
    Ok((branch_name, ahead, behind))
}

fn collect_status(repo: &Repository) -> Result<GitStatus, String> {
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo.statuses(Some(&mut options)).map_err(|e| e.to_string())?;
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();
    for entry in statuses.iter() {
        let path = match entry.path() {
            Some(path) => path.to_string(),
            None => continue,
        };
        let status = entry.status();
        if status.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        ) {
            staged.push(path.clone());
        }
        if status.intersects(
            Status::WT_MODIFIED
                | Status::WT_DELETED
                | Status::WT_RENAMED
                | Status::WT_TYPECHANGE,
        ) {
            unstaged.push(path.clone());
        }
        if status.intersects(Status::WT_NEW) {
            untracked.push(path);
        }
    }
    Ok(GitStatus {
        staged,
        unstaged,
        untracked,
    })
}

fn get_head_branch(repo: &Repository) -> Result<String, String> {
    let head = repo.head().map_err(|e| e.to_string())?;
    if !head.is_branch() {
        return Err("HEAD is detached".to_string());
    }
    head.shorthand()
        .map(|name| name.to_string())
        .ok_or_else(|| "Missing branch name".to_string())
}

#[tauri::command]
pub fn detect_git_repo(root: String) -> Result<Option<GitRepoInfo>, String> {
    let root_path = PathBuf::from(root);
    if !root_path.exists() {
        return Ok(None);
    }
    let repo = match Repository::discover(&root_path) {
        Ok(repo) => repo,
        Err(_) => return Ok(None),
    };
    let repo_root = repo_root_path(&repo)?;
    let (branch, ahead, behind) = get_branch_and_ahead_behind(&repo)?;
    let status = collect_status(&repo)?;
    let clean = status.staged.is_empty() && status.unstaged.is_empty() && status.untracked.is_empty();
    let remote_url = repo
        .find_remote("origin")
        .ok()
        .and_then(|remote| remote.url().map(|value| value.to_string()));
    Ok(Some(GitRepoInfo {
        repo_root: repo_root.to_string_lossy().to_string(),
        branch,
        ahead,
        behind,
        clean,
        remote_url,
    }))
}

#[tauri::command]
pub fn git_status(repo_root: String) -> Result<GitStatus, String> {
    let repo = Repository::discover(repo_root).map_err(|e| e.to_string())?;
    collect_status(&repo)
}

#[tauri::command]
pub fn git_commit(repo_root: String, message: String) -> Result<String, String> {
    let repo = Repository::discover(&repo_root).map_err(|e| e.to_string())?;
    let message = message.trim();
    if message.is_empty() {
        return Err("Commit message is required".to_string());
    }
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;
    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    if let Ok(head) = repo.head() {
        if let Ok(head_commit) = head.peel_to_commit() {
            if head_commit.tree_id() == tree_id {
                return Err("No staged changes".to_string());
            }
        }
    }
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let signature = repo
        .signature()
        .or_else(|_| git2::Signature::now("Mercurio", "mercurio@local"))
        .map_err(|e| e.to_string())?;
    let head = repo.head();
    let parents = if let Ok(head) = head {
        if let Some(oid) = head.target() {
            let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
            vec![commit]
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let oid = repo
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &parent_refs,
        )
        .map_err(|e| e.to_string())?;
    Ok(oid.to_string())
}

#[tauri::command]
pub fn git_stage_paths(repo_root: String, paths: Vec<String>) -> Result<GitStatus, String> {
    let repo = Repository::discover(&repo_root).map_err(|e| e.to_string())?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    for path in paths {
        if path.trim().is_empty() {
            continue;
        }
        let status = repo
            .status_file(PathBuf::from(&path).as_path())
            .unwrap_or(Status::WT_NEW);
        if status.intersects(Status::WT_DELETED) {
            let _ = index.remove_path(PathBuf::from(&path).as_path());
        } else {
            index.add_path(PathBuf::from(&path).as_path()).map_err(|e| e.to_string())?;
        }
    }
    index.write().map_err(|e| e.to_string())?;
    collect_status(&repo)
}

#[tauri::command]
pub fn git_unstage_paths(repo_root: String, paths: Vec<String>) -> Result<GitStatus, String> {
    let repo = Repository::discover(&repo_root).map_err(|e| e.to_string())?;
    let path_refs: Vec<PathBuf> = paths
        .into_iter()
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .collect();
    let path_slices: Vec<&std::path::Path> = path_refs.iter().map(|path| path.as_path()).collect();
    repo
        .reset_default(None, path_slices.as_slice())
        .map_err(|e| e.to_string())?;
    collect_status(&repo)
}

#[tauri::command]
pub fn git_push(repo_root: String, remote: Option<String>) -> Result<(), String> {
    let repo = Repository::discover(&repo_root).map_err(|e| e.to_string())?;
    let branch = get_head_branch(&repo)?;
    let remote_name = remote.unwrap_or_else(|| "origin".to_string());
    let mut remote = repo.find_remote(&remote_name).map_err(|e| e.to_string())?;
    let refspec = format!("refs/heads/{0}:refs/heads/{0}", branch);
    remote
        .push(&[refspec], None)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn git_list_branches(repo_root: String) -> Result<GitBranches, String> {
    let repo = Repository::discover(&repo_root).map_err(|e| e.to_string())?;
    let current = get_head_branch(&repo)?;
    let mut branches = Vec::new();
    let iter = repo
        .branches(Some(BranchType::Local))
        .map_err(|e| e.to_string())?;
    for entry in iter {
        let (branch, _) = entry.map_err(|e| e.to_string())?;
        if let Some(name) = branch.name().ok().flatten() {
            branches.push(name.to_string());
        }
    }
    branches.sort();
    Ok(GitBranches { current, branches })
}

#[tauri::command]
pub fn git_create_branch(repo_root: String, name: String, checkout: bool) -> Result<(), String> {
    let repo = Repository::discover(&repo_root).map_err(|e| e.to_string())?;
    let name = name.trim();
    if name.is_empty() {
        return Err("Branch name is required".to_string());
    }
    let head = repo.head().map_err(|e| e.to_string())?;
    let target = head.peel_to_commit().map_err(|e| e.to_string())?;
    repo.branch(name, &target, false).map_err(|e| e.to_string())?;
    if checkout {
        let refname = format!("refs/heads/{}", name);
        repo.set_head(&refname).map_err(|e| e.to_string())?;
        repo.checkout_head(None).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn git_checkout_branch(repo_root: String, name: String) -> Result<(), String> {
    let repo = Repository::discover(&repo_root).map_err(|e| e.to_string())?;
    let name = name.trim();
    if name.is_empty() {
        return Err("Branch name is required".to_string());
    }
    let refname = format!("refs/heads/{}", name);
    repo.set_head(&refname).map_err(|e| e.to_string())?;
    repo.checkout_head(None).map_err(|e| e.to_string())?;
    Ok(())
}
