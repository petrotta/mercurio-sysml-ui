//! Core app-level commands.
//!
//! Intent: expose small environment/bootstrap helpers used by the UI.

use std::fs;
use std::path::PathBuf;

use tauri::command;

use crate::StartupOpen;

#[command]
/// Returns the current working directory as the default project root.
pub fn get_default_root() -> Result<String, String> {
    std::env::current_dir()
        .map_err(|e| e.to_string())
        .and_then(|path| {
            path.to_str()
                .map(|s| s.to_string())
                .ok_or_else(|| "Failed to resolve current directory".to_string())
        })
}

#[command]
/// Resolves an optional startup path passed as argv[1] and reports whether it is a file or dir.
pub fn get_startup_path() -> Result<Option<StartupOpen>, String> {
    let arg = match std::env::args_os().nth(1) {
        Some(arg) => arg,
        None => return Ok(None),
    };
    let mut path = PathBuf::from(arg);
    if !path.is_absolute() {
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        path = cwd.join(path);
    }
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    let kind = if meta.is_dir() { "dir" } else { "file" };
    Ok(Some(StartupOpen {
        path: path.to_string_lossy().to_string(),
        kind: kind.to_string(),
    }))
}
