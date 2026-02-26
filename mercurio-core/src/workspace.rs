use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use mercurio_sysml_semantics::semantic_contract::{SemanticElementView, SemanticQuery};
use mercurio_sysml_semantics::workspace::{Workspace, WorkspaceFileKind};

use crate::files::resolve_under_root;
use crate::project::load_project_config;
use crate::state::CoreState;
use crate::stdlib::resolve_stdlib_path;

pub(crate) fn collect_project_files(root: &Path, src: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for entry in src {
        let pattern = entry.trim();
        if pattern.is_empty() {
            continue;
        }
        let normalized = pattern.replace('\\', "/");
        if let Some((recursive, ext)) = parse_ext_pattern(&normalized) {
            if recursive {
                collect_model_files_by_extension(root, &ext, &mut out, &mut seen)?;
            } else {
                collect_model_files_in_root_by_extension(root, &ext, &mut out, &mut seen)?;
            }
            continue;
        }

        let resolved = resolve_under_root(root, Path::new(pattern))?;
        if resolved.is_file() {
            let key = resolved.to_string_lossy().to_string();
            if seen.insert(key.clone()) {
                out.push(PathBuf::from(key));
            }
        }
    }

    Ok(out)
}

fn parse_ext_pattern(pattern: &str) -> Option<(bool, String)> {
    let pattern = pattern.trim();
    if pattern.starts_with("**/") {
        let rest = &pattern[3..];
        if let Some(ext) = parse_simple_ext_pattern(rest) {
            return Some((true, ext));
        }
    }
    if pattern.contains('/') {
        return None;
    }
    parse_simple_ext_pattern(pattern).map(|ext| (false, ext))
}

fn parse_simple_ext_pattern(pattern: &str) -> Option<String> {
    let pattern = pattern.trim();
    if pattern.starts_with("*.") && pattern.len() > 2 {
        return Some(pattern[2..].to_lowercase());
    }
    None
}

fn collect_model_files_in_root_by_extension(
    root: &Path,
    ext: &str,
    out: &mut Vec<PathBuf>,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    let read_dir = fs::read_dir(root).map_err(|e| e.to_string())?;
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            continue;
        }
        if let Some(file_ext) = path.extension().and_then(|ext| ext.to_str()) {
            if file_ext.eq_ignore_ascii_case(ext) {
                let key = path.to_string_lossy().to_string();
                if seen.insert(key.clone()) {
                    out.push(PathBuf::from(key));
                }
            }
        }
    }
    Ok(())
}

fn collect_model_files_by_extension(
    root: &Path,
    ext: &str,
    out: &mut Vec<PathBuf>,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    let read_dir = fs::read_dir(root).map_err(|e| e.to_string())?;
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_model_files_by_extension(&path, ext, out, seen)?;
            continue;
        }
        if let Some(file_ext) = path.extension().and_then(|ext| ext.to_str()) {
            if file_ext.eq_ignore_ascii_case(ext) {
                let key = path.to_string_lossy().to_string();
                if seen.insert(key.clone()) {
                    out.push(PathBuf::from(key));
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn collect_model_files(root: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    collect_model_files_by_extension(root, "sysml", out, &mut HashSet::new())?;
    collect_model_files_by_extension(root, "kerml", out, &mut HashSet::new())?;
    Ok(())
}

fn collect_stdlib_model_files(root: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    collect_model_files(root, out)
}

pub fn query_semantic(
    state: &CoreState,
    root: String,
    query: SemanticQuery,
) -> Result<Vec<SemanticElementView>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }

    let default_stdlib = state
        .settings
        .lock()
        .ok()
        .and_then(|settings| settings.default_stdlib.clone());

    let project_config = load_project_config(&root_path).ok().flatten();
    let mut project_files = Vec::new();
    if let Some(config) = project_config.as_ref() {
        if let Some(src) = config.src.as_ref() {
            project_files = collect_project_files(&root_path, src)?;
        }
    }
    if project_files.is_empty() {
        collect_model_files(&root_path, &mut project_files)?;
    }
    project_files.sort();
    project_files.dedup();

    let library_config = project_config
        .as_ref()
        .and_then(|config| config.library.as_ref());
    let stdlib_override = project_config
        .as_ref()
        .and_then(|config| config.stdlib.as_ref());
    let (_loader, stdlib_path) = resolve_stdlib_path(
        &state.stdlib_root,
        default_stdlib.as_deref(),
        library_config,
        stdlib_override,
        &root_path,
    );

    let mut ws = Workspace::new();

    if let Some(path) = stdlib_path.as_ref() {
        let mut stdlib_files = Vec::new();
        if path.is_dir() {
            collect_stdlib_model_files(path, &mut stdlib_files)?;
        } else if path.is_file() {
            stdlib_files.push(path.clone());
        }
        stdlib_files.sort();
        stdlib_files.dedup();

        for file in stdlib_files {
            if let Ok(text) = fs::read_to_string(&file) {
                ws.upsert_text(WorkspaceFileKind::Stdlib, file, text);
            }
        }
    }

    for file in project_files {
        if let Ok(text) = fs::read_to_string(&file) {
            ws.upsert_text(WorkspaceFileKind::Model, file, text);
        }
    }

    Ok(ws.semantic_query(&query))
}

