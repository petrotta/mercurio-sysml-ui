use crate::paths::resolve_under_root;
use crate::types::{AppState, DirEntry, FsEventPayload, StartupOpen};
use notify::{EventKind, RecursiveMode, Watcher};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{Emitter, EventTarget};

#[tauri::command]
pub fn get_default_root() -> Result<String, String> {
    std::env::current_dir()
        .map_err(|e| e.to_string())
        .and_then(|path| {
            path.to_str()
                .map(|s| s.to_string())
                .ok_or_else(|| "Failed to resolve current directory".to_string())
        })
}

#[tauri::command]
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

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries = Vec::new();
    let read_dir = fs::read_dir(&path).map_err(|e| e.to_string())?;

    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry_path.is_dir();
        entries.push(DirEntry {
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn path_exists(path: String) -> Result<bool, String> {
    Ok(PathBuf::from(path).exists())
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(target, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_file(root: String, parent: String, name: String) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("File name is required".to_string());
    }
    let root_path = PathBuf::from(root);
    let parent_path = resolve_under_root(&root_path, Path::new(&parent))?;
    let new_path = resolve_under_root(&root_path, &parent_path.join(name))?;
    if let Some(parent_dir) = new_path.parent() {
        fs::create_dir_all(parent_dir).map_err(|e| e.to_string())?;
    }
    fs::write(&new_path, "").map_err(|e| e.to_string())?;
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_dir(root: String, parent: String, name: String) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("Folder name is required".to_string());
    }
    let root_path = PathBuf::from(root);
    let parent_path = resolve_under_root(&root_path, Path::new(&parent))?;
    let new_path = resolve_under_root(&root_path, &parent_path.join(name))?;
    fs::create_dir_all(&new_path).map_err(|e| e.to_string())?;
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn rename_path(root: String, path: String, new_name: String) -> Result<String, String> {
    if new_name.trim().is_empty() {
        return Err("New name is required".to_string());
    }
    let root_path = PathBuf::from(root);
    let target_path = resolve_under_root(&root_path, Path::new(&path))?;
    let parent = target_path
        .parent()
        .ok_or_else(|| "Cannot rename root".to_string())?;
    let new_path = resolve_under_root(&root_path, &parent.join(new_name))?;
    fs::rename(&target_path, &new_path).map_err(|e| e.to_string())?;
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_path(root: String, path: String) -> Result<(), String> {
    let root_path = PathBuf::from(root);
    let target_path = resolve_under_root(&root_path, Path::new(&path))?;
    if target_path.is_dir() {
        fs::remove_dir_all(&target_path).map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(&target_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err("Path does not exist".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new("explorer");
        if target.is_file() {
            command.arg("/select,");
            command.arg(target);
        } else {
            command.arg(target);
        }
        command.spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");
        if target.is_file() {
            command.arg("-R");
        }
        command.arg(target);
        command.spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut command = std::process::Command::new("xdg-open");
        let open_path = if target.is_file() {
            target.parent().unwrap_or(&target)
        } else {
            &target
        };
        command.arg(open_path);
        command.spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
}

#[tauri::command]
pub fn set_watch_root(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    root: String,
) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }

    // Replace any existing watcher so we don't emit stale events.
    let mut guard = state
        .watcher
        .lock()
        .map_err(|_| "Watcher lock poisoned".to_string())?;
    *guard = None;

    let app_handle = app.clone();
    let watcher = notify::recommended_watcher(move |res| {
        let event: notify::Event = match res {
            Ok(event) => event,
            Err(_) => return,
        };
        let kind = match event.kind {
            EventKind::Create(_) => "create",
            EventKind::Modify(_) => "modify",
            EventKind::Remove(_) => "remove",
            EventKind::Any => "any",
            _ => "other",
        };
        for path in event.paths {
            if let Some(path_str) = path.to_str() {
                let payload = FsEventPayload {
                    path: path_str.to_string(),
                    kind: kind.to_string(),
                };
                let _ = app_handle.emit_to(EventTarget::webview_window("main"), "fs-changed", payload);
            }
        }
    })
    .map_err(|e| e.to_string())?;

    let mut watcher = watcher;
    watcher
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    *guard = Some(watcher);
    Ok(())
}
