//! Filesystem commands for project browsing and editing.
//!
//! Intent: centralize path-safe file operations called from the frontend tree/editor UI.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::command;

use crate::{resolve_under_root, DirEntry};

#[command]
/// Lists directory entries, returning folders first and then files alphabetically.
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

#[command]
/// Reads a UTF-8 text file from disk.
pub fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[command]
/// Returns whether a path exists on disk.
pub fn path_exists(path: String) -> Result<bool, String> {
    Ok(PathBuf::from(path).exists())
}

#[command]
/// Writes text content to a file, creating parent directories when needed.
pub fn write_file(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(target, content).map_err(|e| e.to_string())
}

#[command]
/// Creates an empty file under the project root with root-bound path validation.
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

#[command]
/// Creates a folder under the project root with root-bound path validation.
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

#[command]
/// Renames a file or folder within the project root.
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

#[command]
/// Opens a path in the system file explorer and selects files when possible.
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
