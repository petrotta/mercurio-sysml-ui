//! Core app-level commands.
//!
//! Intent: expose small environment/bootstrap helpers used by the UI.

use std::path::{Path, PathBuf};

use tauri::{command, Manager};
use tauri::path::BaseDirectory;
use mercurio_core::{
    create_project_descriptor,
    get_project_element_attributes as core_get_project_element_attributes,
    get_project_model as core_get_project_model,
    query_semantic as core_query_semantic,
    query_semantic_symbols as core_query_semantic_symbols,
    ProjectElementAttributesView, ProjectModelView, SemanticElementView, SemanticQuery, SymbolView,
};

use crate::AppState;

fn validate_project_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Project name is required".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("Project name is not valid".to_string());
    }
    if trimmed
        .chars()
        .any(|ch| matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
    {
        return Err("Project name contains invalid characters: <>:\"/\\|?*".to_string());
    }
    Ok(trimmed)
}

fn create_project_under_parent(
    parent: &Path,
    name: &str,
    author: Option<String>,
    description: Option<String>,
    organization: Option<String>,
    use_default_library: bool,
) -> Result<PathBuf, String> {
    if !parent.exists() || !parent.is_dir() {
        return Err("Parent folder does not exist".to_string());
    }
    let validated_name = validate_project_name(name)?;
    let root = parent.join(validated_name);
    create_project_descriptor(
        &root,
        validated_name.to_string(),
        author.filter(|value| !value.trim().is_empty()),
        description.filter(|value| !value.trim().is_empty()),
        organization.filter(|value| !value.trim().is_empty()),
        use_default_library,
    )?;
    Ok(root)
}

#[command]
/// Returns a user-friendly default location for creating projects.
pub fn get_user_projects_root(app: tauri::AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .resolve("", BaseDirectory::Document)
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[command]
/// Creates a new project folder with a `.project` descriptor.
pub fn create_project(
    parent: String,
    name: String,
    author: Option<String>,
    description: Option<String>,
    organization: Option<String>,
    use_default_library: Option<bool>,
) -> Result<String, String> {
    let parent_path = PathBuf::from(parent.trim());
    let root = create_project_under_parent(
        &parent_path,
        &name,
        author,
        description,
        organization,
        use_default_library.unwrap_or(true),
    )?;
    Ok(root.to_string_lossy().to_string())
}

#[allow(dead_code)]
#[command]
/// Builds a project model view and binds project elements to stdlib metamodel elements.
pub async fn get_project_model(
    state: tauri::State<'_, AppState>,
    root: String,
) -> Result<ProjectModelView, String> {
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || core_get_project_model(&core, root))
        .await
        .map_err(|e| e.to_string())?
}

#[allow(dead_code)]
#[command]
/// Returns explicit and inherited attributes for a project element qualified name.
pub async fn get_project_element_attributes(
    state: tauri::State<'_, AppState>,
    root: String,
    element_qualified_name: String,
    symbol_kind: Option<String>,
) -> Result<ProjectElementAttributesView, String> {
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || {
        core_get_project_element_attributes(&core, root, element_qualified_name, symbol_kind)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[allow(dead_code)]
#[command]
/// Queries semantic attributes extracted from the project model (e.g., short_name, body).
pub async fn query_semantic(
    state: tauri::State<'_, AppState>,
    root: String,
    query: SemanticQuery,
) -> Result<Vec<SemanticElementView>, String> {
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || core_query_semantic(&core, root, query))
        .await
        .map_err(|e| e.to_string())?
}

#[allow(dead_code)]
#[command]
/// Queries semantic elements and projects them to UI SymbolView records in core.
pub async fn query_semantic_symbols(
    state: tauri::State<'_, AppState>,
    root: String,
) -> Result<Vec<SymbolView>, String> {
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || core_query_semantic_symbols(&core, root))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::create_project_under_parent;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("mercurio_app_{name}_{stamp}"))
    }

    #[test]
    fn create_project_under_parent_writes_descriptor() {
        let parent = unique_temp_dir("new_project_parent");
        fs::create_dir_all(&parent).expect("create parent");

        let root = create_project_under_parent(
            &parent,
            "ExampleProject",
            Some("Ada".to_string()),
            Some("Test project".to_string()),
            Some("Mercurio".to_string()),
            true,
        )
        .expect("create project");

        assert!(root.exists());
        assert!(root.join(".project").exists());
        let descriptor = fs::read_to_string(root.join(".project")).expect("read descriptor");
        assert!(descriptor.contains("\"name\": \"ExampleProject\""));
        assert!(descriptor.contains("\"stdlib\": \"default\""));

        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn create_project_under_parent_rejects_nested_names() {
        let parent = unique_temp_dir("invalid_project_parent");
        fs::create_dir_all(&parent).expect("create parent");

        let result = create_project_under_parent(&parent, "nested/project", None, None, None, true);
        assert!(result.is_err());

        let _ = fs::remove_dir_all(&parent);
    }
}
