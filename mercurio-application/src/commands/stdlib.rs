//! Stdlib selection/settings commands.
//!
//! Intent: expose read/write access to installed stdlib versions and the current default.

use tauri::command;

use crate::{list_stdlib_versions_from_root, save_app_settings, AppState};

#[command]
/// Lists installed stdlib versions from the configured stdlib root.
pub fn list_stdlib_versions(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    list_stdlib_versions_from_root(&state.stdlib_root)
}

#[command]
/// Returns the currently selected default stdlib version, if any.
pub fn get_default_stdlib(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "Settings lock poisoned".to_string())?;
    Ok(settings.default_stdlib.clone())
}

#[command]
/// Sets the default stdlib version and persists it to settings.
pub fn set_default_stdlib(state: tauri::State<'_, AppState>, version: String) -> Result<(), String> {
    let trimmed = version.trim().to_string();
    if !trimmed.is_empty() {
        let candidate = state.stdlib_root.join(&trimmed);
        if !candidate.exists() || !candidate.is_dir() {
            return Err("Stdlib version not found".to_string());
        }
    }
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "Settings lock poisoned".to_string())?;
    settings.default_stdlib = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    };
    save_app_settings(&state.settings_path, &settings)?;
    Ok(())
}
