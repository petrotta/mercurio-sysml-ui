use std::path::{Path, PathBuf};

use syster::base::constants::STDLIB_DIR;
use syster::ide::AnalysisHost;
use syster::project::StdLibLoader;

use crate::state::CoreState;
use crate::syster_host::load_stdlib_cached;

pub(crate) fn resolve_default_stdlib_path(
    root: &Path,
    stdlib_root: &Path,
    default_stdlib: Option<&str>,
) -> PathBuf {
    let root_stdlib = root.join(STDLIB_DIR);
    if root_stdlib.exists() && root_stdlib.is_dir() {
        return root_stdlib;
    }

    if let Some(version) = default_stdlib {
        let candidate = stdlib_root.join(version);
        if candidate.exists() && candidate.is_dir() {
            return candidate;
        }
    }
    if let Ok(versions) = list_stdlib_versions_from_root(stdlib_root) {
        if let Some(first) = versions.first() {
            let candidate = stdlib_root.join(first);
            if candidate.exists() && candidate.is_dir() {
                return candidate;
            }
        }
    }

    discover_stdlib_path()
}

pub fn list_stdlib_versions_from_root(stdlib_root: &Path) -> Result<Vec<String>, String> {
    if !stdlib_root.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(stdlib_root).map_err(|e| e.to_string())?;
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
                entries.push(name.to_string());
            }
        }
    }
    entries.sort();
    Ok(entries)
}

pub(crate) fn load_stdlib_into_host(
    state: &CoreState,
    host: &mut AnalysisHost,
    stdlib_path: &Path,
) -> Result<bool, String> {
    let stdlib_path_exists = stdlib_path.exists() && stdlib_path.is_dir();
    if stdlib_path_exists {
        let cached_files = load_stdlib_cached(state, stdlib_path)?;
        for (path, file) in cached_files {
            host.set_file(path, file);
        }
        return Ok(true);
    }
    let loader = StdLibLoader::with_path(stdlib_path.to_path_buf());
    loader.load_into_host(host)?;
    Ok(false)
}

pub(crate) fn resolve_stdlib_path(
    stdlib_root: &Path,
    default_stdlib: Option<&str>,
    config: Option<&crate::LibraryConfig>,
    override_id: Option<&String>,
    project_root: &Path,
) -> (StdLibLoader, Option<PathBuf>) {
    match config {
        Some(crate::LibraryConfig::Path { path }) => {
            if path.trim().is_empty() {
                let discovered = resolve_default_stdlib_path(project_root, stdlib_root, default_stdlib);
                (StdLibLoader::new(), Some(discovered))
            } else {
                let raw_path = PathBuf::from(path);
                let resolved = if raw_path.is_absolute() {
                    raw_path
                } else {
                    project_root.join(raw_path)
                };
                (StdLibLoader::with_path(resolved.clone()), Some(resolved))
            }
        }
        Some(crate::LibraryConfig::Default(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("default") {
                let discovered = resolve_default_stdlib_path(project_root, stdlib_root, default_stdlib);
                (StdLibLoader::new(), Some(discovered))
            } else {
                let raw_path = PathBuf::from(trimmed);
                let resolved = if raw_path.is_absolute() {
                    raw_path
                } else {
                    project_root.join(raw_path)
                };
                (StdLibLoader::with_path(resolved.clone()), Some(resolved))
            }
        }
        None => {
            if let Some(stdlib_id) = override_id {
                let trimmed = stdlib_id.trim();
                if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("default") {
                    let discovered = resolve_default_stdlib_path(project_root, stdlib_root, default_stdlib);
                    (StdLibLoader::new(), Some(discovered))
                } else {
                    let resolved = stdlib_root.join(trimmed);
                    (StdLibLoader::new(), Some(resolved))
                }
            } else {
                let discovered = resolve_default_stdlib_path(project_root, stdlib_root, default_stdlib);
                (StdLibLoader::new(), Some(discovered))
            }
        }
    }
}

fn discover_stdlib_path() -> PathBuf {
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
    {
        let stdlib_next_to_exe = exe_dir.join(STDLIB_DIR);
        if stdlib_next_to_exe.exists() && stdlib_next_to_exe.is_dir() {
            return stdlib_next_to_exe;
        }
    }

    PathBuf::from(STDLIB_DIR)
}
