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
    let target = repo.revparse_single("HEAD").ok();
    repo
        .reset_default(target.as_ref(), path_slices.as_slice())
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

#[cfg(test)]
mod tests {
    use super::{detect_git_repo, git_commit, git_push, git_stage_paths, git_status, git_unstage_paths};
    use git2::{Repository, Signature};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(name: &str) -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!("mercurio_git_{name}_{stamp}"));
            fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, content).expect("write file");
    }

    fn commit_all(repo: &Repository, message: &str) {
        let mut index = repo.index().expect("index");
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .expect("add all");
        index.write().expect("write index");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_id).expect("find tree");
        let signature = Signature::now("Mercurio Test", "test@mercurio.local").expect("signature");
        let parents = repo
            .head()
            .ok()
            .and_then(|head| head.target())
            .map(|oid| vec![repo.find_commit(oid).expect("find parent")])
            .unwrap_or_default();
        let parent_refs: Vec<&git2::Commit<'_>> = parents.iter().collect();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &parent_refs,
        )
        .expect("commit");
    }

    #[test]
    fn detect_git_repo_returns_repo_info() {
        let temp = TestDir::new("detect");
        let repo = Repository::init(temp.path()).expect("init repo");
        write_file(&temp.path().join("tracked.sysml"), "package Example {}\n");
        commit_all(&repo, "initial");

        let info = detect_git_repo(temp.path().to_string_lossy().to_string())
            .expect("detect repo")
            .expect("repo info");

        assert!(!info.branch.trim().is_empty());
        assert_ne!(info.branch, "DETACHED");
        assert_eq!(
            PathBuf::from(info.repo_root).canonicalize().expect("canonical repo root"),
            temp.path().canonicalize().expect("canonical temp root")
        );
        assert!(info.clean);
    }

    #[test]
    fn git_status_collects_unstaged_and_untracked_files() {
        let temp = TestDir::new("status");
        let repo = Repository::init(temp.path()).expect("init repo");
        write_file(&temp.path().join("tracked.sysml"), "package Example {}\n");
        commit_all(&repo, "initial");

        write_file(&temp.path().join("tracked.sysml"), "package Example { part x; }\n");
        write_file(&temp.path().join("new.sysml"), "package Added {}\n");

        let status = git_status(temp.path().to_string_lossy().to_string()).expect("git status");

        assert!(status.unstaged.iter().any(|path| path == "tracked.sysml"));
        assert!(status.untracked.iter().any(|path| path == "new.sysml"));
        assert!(status.staged.is_empty());
    }

    #[test]
    fn git_stage_and_unstage_paths_round_trip() {
        let temp = TestDir::new("stage_round_trip");
        let repo = Repository::init(temp.path()).expect("init repo");
        write_file(&temp.path().join("tracked.sysml"), "package Example {}\n");
        commit_all(&repo, "initial");

        write_file(&temp.path().join("tracked.sysml"), "package Example { part x; }\n");
        write_file(&temp.path().join("new.sysml"), "package Added {}\n");

        let staged = git_stage_paths(
            temp.path().to_string_lossy().to_string(),
            vec!["tracked.sysml".to_string(), "new.sysml".to_string()],
        )
        .expect("stage paths");

        assert!(staged.staged.iter().any(|path| path == "tracked.sysml"));
        assert!(staged.staged.iter().any(|path| path == "new.sysml"));

        let unstaged = git_unstage_paths(
            temp.path().to_string_lossy().to_string(),
            vec!["tracked.sysml".to_string(), "new.sysml".to_string()],
        )
        .expect("unstage paths");

        assert!(unstaged.staged.is_empty());
        assert!(unstaged.unstaged.iter().any(|path| path == "tracked.sysml"));
        assert!(unstaged.untracked.iter().any(|path| path == "new.sysml"));
    }

    #[test]
    fn git_commit_requires_non_empty_message() {
        let temp = TestDir::new("commit_message");
        let repo = Repository::init(temp.path()).expect("init repo");
        write_file(&temp.path().join("tracked.sysml"), "package Example {}\n");
        commit_all(&repo, "initial");

        write_file(&temp.path().join("tracked.sysml"), "package Example { part x; }\n");
        let _ = git_stage_paths(
            temp.path().to_string_lossy().to_string(),
            vec!["tracked.sysml".to_string()],
        )
        .expect("stage file");

        let error = git_commit(temp.path().to_string_lossy().to_string(), "   ".to_string())
            .expect_err("empty message should fail");

        assert_eq!(error, "Commit message is required");
    }

    #[test]
    fn git_push_errors_without_remote() {
        let temp = TestDir::new("push_without_remote");
        let repo = Repository::init(temp.path()).expect("init repo");
        write_file(&temp.path().join("tracked.sysml"), "package Example {}\n");
        commit_all(&repo, "initial");

        let error = git_push(temp.path().to_string_lossy().to_string(), None)
            .expect_err("push without remote should fail");

        assert!(
            error.contains("remote") || error.contains("Remote"),
            "unexpected error: {error}"
        );
    }
}
