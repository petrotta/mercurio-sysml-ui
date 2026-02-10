//! Core app-level commands.
//!
//! Intent: expose small environment/bootstrap helpers used by the UI.

use tauri::{command, Manager};
use tauri::path::BaseDirectory;

#[command]
/// Returns a user-friendly default location for creating projects.
pub fn get_user_projects_root(app: tauri::AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .resolve("", BaseDirectory::Document)
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}
