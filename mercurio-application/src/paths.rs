use crate::types::MercurioPaths;
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

pub fn resolve_user_local_dir() -> PathBuf {
    if cfg!(target_os = "windows") {
        env::var_os("LOCALAPPDATA")
            .or_else(|| env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    } else {
        env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    }
}

pub fn ensure_mercurio_paths() -> Result<MercurioPaths, String> {
    let root = resolve_user_local_dir().join(".mercurio");
    let stdlib_root = root.join("stdlib");
    fs::create_dir_all(&stdlib_root).map_err(|e| e.to_string())?;
    let settings_path = root.join("settings.json");
    Ok(MercurioPaths {
        stdlib_root,
        settings_path,
    })
}

pub fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new("\\")),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(segment) => normalized.push(segment),
        }
    }
    normalized
}

pub fn resolve_under_root(root: &Path, target: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let joined = if target.is_absolute() {
        target.to_path_buf()
    } else {
        root.join(target)
    };
    let normalized = normalize_path(&joined);
    if !normalized.starts_with(&root) {
        return Err("Path is outside the project root".to_string());
    }
    Ok(normalized)
}

pub fn is_path_under_root(root: &Path, path: &str) -> bool {
    let root_norm = root.canonicalize().ok();
    let path_norm = PathBuf::from(path).canonicalize().ok();
    if let (Some(root_norm), Some(path_norm)) = (root_norm, path_norm) {
        return path_norm.starts_with(&root_norm);
    }
    let root_str = root.to_string_lossy().to_lowercase();
    let path_str = path.to_lowercase();
    if root_str.is_empty() || path_str.is_empty() {
        return false;
    }
    path_str.starts_with(&root_str)
}
