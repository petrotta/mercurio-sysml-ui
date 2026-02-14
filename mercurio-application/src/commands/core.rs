//! Core app-level commands.
//!
//! Intent: expose small environment/bootstrap helpers used by the UI.

use tauri::{command, Manager};
use tauri::path::BaseDirectory;
use mercurio_core::{
    get_project_element_attributes as core_get_project_element_attributes,
    get_project_model as core_get_project_model,
    query_semantic as core_query_semantic,
    ProjectElementAttributesView, ProjectModelView, SemanticElementView, SemanticQuery,
};

use crate::AppState;

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
