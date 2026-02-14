//! Stdlib selection/settings commands.
//!
//! Intent: expose read/write access to installed stdlib versions and the current default.

use tauri::command;

use crate::{list_stdlib_versions_from_root, AppState};
use mercurio_core::{get_stdlib_metamodel as core_get_stdlib_metamodel, StdlibMetamodelView};

#[command]
/// Lists installed stdlib versions from the configured stdlib root.
pub fn list_stdlib_versions(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    list_stdlib_versions_from_root(&state.core.stdlib_root)
}

#[command]
/// Builds a runtime metamodel from the currently resolved stdlib for the given project root.
pub async fn get_stdlib_metamodel(
    state: tauri::State<'_, AppState>,
    root: String,
) -> Result<StdlibMetamodelView, String> {
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || core_get_stdlib_metamodel(&core, root))
        .await
        .map_err(|e| e.to_string())?
}

