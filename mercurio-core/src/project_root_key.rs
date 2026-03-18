use std::path::PathBuf;

fn strip_windows_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("\\\\?\\UNC\\") {
        return format!("\\\\{}", rest);
    }
    if let Some(rest) = path.strip_prefix("\\\\?\\") {
        return rest.to_string();
    }
    path.to_string()
}

pub(crate) fn normalize_workspace_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let canonical = PathBuf::from(trimmed)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(trimmed))
        .to_string_lossy()
        .to_string();
    strip_windows_verbatim_prefix(&canonical)
}

pub(crate) fn normalize_display_path(path: &str) -> String {
    strip_windows_verbatim_prefix(path)
}

pub(crate) fn canonical_project_root(project_root: &str) -> String {
    let trimmed = project_root.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    normalize_workspace_path(trimmed)
}
