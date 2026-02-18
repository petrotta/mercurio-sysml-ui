//! Stdlib selection/settings commands.
//!
//! Intent: expose read/write access to installed stdlib versions and the current default.

use tauri::command;

use crate::{list_stdlib_versions_from_root, save_app_settings, AppState};
use mercurio_core::{get_stdlib_metamodel as core_get_stdlib_metamodel, StdlibMetamodelView};

#[command]
/// Lists installed stdlib versions from the configured stdlib root.
pub fn list_stdlib_versions(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    list_stdlib_versions_from_root(&state.core.stdlib_root)
}

#[command]
/// Returns the currently configured default stdlib id, if set.
pub fn get_default_stdlib(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    let settings = state
        .core
        .settings
        .lock()
        .map_err(|_| "Settings lock poisoned".to_string())?;
    Ok(settings.default_stdlib.clone())
}

#[command]
/// Sets the default stdlib id used when project config resolves to "default".
pub fn set_default_stdlib(
    state: tauri::State<'_, AppState>,
    stdlib: Option<String>,
) -> Result<Option<String>, String> {
    let installed = list_stdlib_versions_from_root(&state.core.stdlib_root)?;
    let normalized = stdlib
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    if let Some(id) = normalized.as_ref() {
        if !installed.iter().any(|installed_id| installed_id == id) {
            return Err(format!("Stdlib version not installed: {id}"));
        }
    }

    let mut settings = state
        .core
        .settings
        .lock()
        .map_err(|_| "Settings lock poisoned".to_string())?;
    settings.default_stdlib = normalized;
    save_app_settings(&state.settings_path, &settings)?;
    Ok(settings.default_stdlib.clone())
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

