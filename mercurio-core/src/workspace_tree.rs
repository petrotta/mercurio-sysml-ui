use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::project::load_project_config;
use crate::project_root_key::canonical_project_root;
use crate::stdlib::resolve_stdlib_path;
use crate::CoreState;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceTreeEntryView {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceTreeSnapshotView {
    pub project_root: String,
    pub project_tree: Vec<WorkspaceTreeEntryView>,
    pub library_tree: Vec<WorkspaceTreeEntryView>,
    pub library_path: Option<String>,
    pub diagnostics: Vec<String>,
}

pub fn get_workspace_tree_snapshot(
    state: &CoreState,
    root: String,
) -> Result<WorkspaceTreeSnapshotView, String> {
    let canonical_root = canonical_project_root(&root);
    let root_path = PathBuf::from(&canonical_root);
    if root_path.as_os_str().is_empty() {
        return Err("Root path is required".to_string());
    }
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }
    let project_tree = collect_tree_manifest(&root_path)?;
    let (library_path, library_tree) = collect_library_tree_manifest(state, &root_path)?;
    Ok(WorkspaceTreeSnapshotView {
        project_root: canonical_root,
        project_tree,
        library_tree,
        library_path,
        diagnostics: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_root_key::canonical_project_root;
    use crate::settings::AppSettings;
    use crate::state::CoreState;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn workspace_tree_snapshot_reads_live_project_and_library_files() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_workspace_tree_snapshot_{stamp}"));
        let project_dir = root.join("project");
        let library_dir = root.join("stdlib");
        fs::create_dir_all(project_dir.join("sub")).expect("create project dirs");
        fs::create_dir_all(library_dir.join("Kernel")).expect("create library dirs");
        fs::write(project_dir.join("sub").join("a.sysml"), "package A {}").expect("write project file");
        fs::write(library_dir.join("Kernel").join("Kernel.kerml"), "package Kernel {}")
            .expect("write library file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"snapshot\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\",\"**/*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let snapshot =
            get_workspace_tree_snapshot(&state, project_dir.to_string_lossy().to_string())
                .expect("workspace tree snapshot");

        assert!(
            snapshot
                .project_tree
                .iter()
                .any(|entry| entry.path.ends_with("a.sysml"))
        );
        assert_eq!(
            snapshot.project_root,
            canonical_project_root(&project_dir.to_string_lossy())
        );
        assert!(
            snapshot
                .library_tree
                .iter()
                .any(|entry| entry.path.ends_with("Kernel.kerml"))
        );
        assert_eq!(
            snapshot.library_path.as_deref(),
            Some(library_dir.to_string_lossy().as_ref())
        );

        let _ = fs::remove_dir_all(root);
    }
}

pub(crate) fn collect_tree_manifest(root: &Path) -> Result<Vec<WorkspaceTreeEntryView>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::<WorkspaceTreeEntryView>::new();
    collect_tree_manifest_recursive(root, &mut entries)?;
    Ok(entries)
}

pub(crate) fn collect_library_tree_manifest(
    state: &CoreState,
    project_root: &Path,
) -> Result<(Option<String>, Vec<WorkspaceTreeEntryView>), String> {
    let Some(library_path) = resolve_workspace_library_path(state, project_root) else {
        return Ok((None, Vec::new()));
    };
    let library_path_text = library_path.to_string_lossy().to_string();
    let tree = collect_tree_manifest(&library_path)?;
    Ok((Some(library_path_text), tree))
}

pub(crate) fn resolve_workspace_library_path(
    state: &CoreState,
    project_root: &Path,
) -> Option<PathBuf> {
    let default_stdlib = state
        .settings
        .lock()
        .ok()
        .and_then(|settings| settings.default_stdlib.clone());
    let project_config = load_project_config(project_root).ok().flatten();
    let library_config = project_config
        .as_ref()
        .and_then(|config| config.library.as_ref());
    let stdlib_override = project_config
        .as_ref()
        .and_then(|config| config.stdlib.as_ref());
    let (_loader, resolved_path) = resolve_stdlib_path(
        &state.stdlib_root,
        default_stdlib.as_deref(),
        library_config,
        stdlib_override,
        project_root,
    );
    resolved_path
}

fn collect_tree_manifest_recursive(
    dir: &Path,
    out: &mut Vec<WorkspaceTreeEntryView>,
) -> Result<(), String> {
    let mut entries = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    entries.sort_by(|left, right| {
        let left_is_dir = left.path().is_dir();
        let right_is_dir = right.path().is_dir();
        match (left_is_dir, right_is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => left
                .file_name()
                .to_string_lossy()
                .to_ascii_lowercase()
                .cmp(&right.file_name().to_string_lossy().to_ascii_lowercase()),
        }
    });

    for entry in entries {
        let path = entry.path();
        let is_dir = path.is_dir();
        out.push(WorkspaceTreeEntryView {
            name: entry.file_name().to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
            is_dir,
        });
        if is_dir {
            collect_tree_manifest_recursive(&path, out)?;
        }
    }
    Ok(())
}
