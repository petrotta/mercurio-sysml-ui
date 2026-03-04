//! Window chrome commands.
//!
//! Intent: provide frontend hooks for native window actions (minimize/maximize/close).

use std::path::PathBuf;
use std::process::Command;
use tauri::command;
use tauri::Manager;

#[command]
/// Minimizes the main application window.
pub fn window_minimize(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.minimize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
/// Toggles the main window between maximized and restored states.
pub fn window_toggle_maximize(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_maximized().map_err(|e| e.to_string())? {
            window.unmaximize().map_err(|e| e.to_string())?;
        } else {
            window.maximize().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[command]
/// Closes the main application window.
pub fn window_close(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
/// Exits the whole application.
pub fn app_exit(app: tauri::AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

#[command]
/// Reveals a file (or opens a directory) in the host file explorer.
pub fn show_in_explorer(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path is required".to_string());
    }
    let requested = PathBuf::from(trimmed);
    let mut resolved = requested.canonicalize().unwrap_or(requested);

    #[cfg(target_os = "windows")]
    {
        let raw = resolved.to_string_lossy();
        if let Some(stripped) = raw.strip_prefix(r"\\?\") {
            resolved = PathBuf::from(stripped);
        }
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer.exe");
        if resolved.is_file() {
            command.arg("/select,").arg(&resolved);
        } else {
            command.arg(&resolved);
        }
        command.spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if resolved.is_file() {
            command.arg("-R").arg(&resolved);
        } else {
            command.arg(&resolved);
        }
        command.spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = if resolved.is_dir() {
            resolved.clone()
        } else {
            resolved
                .parent()
                .map(|parent| parent.to_path_buf())
                .unwrap_or(resolved.clone())
        };
        Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("Show in explorer is not supported on this platform".to_string())
}
