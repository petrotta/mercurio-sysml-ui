//! Stdlib selection/settings commands.
//!
//! Intent: expose read/write access to installed stdlib versions and the current default.

use tauri::command;

use crate::{list_stdlib_versions_from_root, AppState};

#[command]
/// Lists installed stdlib versions from the configured stdlib root.
pub fn list_stdlib_versions(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    list_stdlib_versions_from_root(&state.core.stdlib_root)
}

