use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct WindowBoundsSettings {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct WindowStateSettings {
    pub bounds: Option<WindowBoundsSettings>,
    pub maximized: bool,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct AppSettings {
    pub default_stdlib: Option<String>,
    pub main_window: Option<WindowStateSettings>,
}

pub struct MercurioPaths {
    pub stdlib_root: PathBuf,
    pub settings_path: PathBuf,
}

pub fn resolve_user_local_dir() -> PathBuf {
    if cfg!(target_os = "windows") {
        env::var_os("LOCALAPPDATA")
            .or_else(|| env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    } else {
        env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    }
}

pub fn resolve_mercurio_user_dir() -> PathBuf {
    resolve_user_local_dir().join(".mercurio")
}

pub fn ensure_mercurio_paths() -> Result<MercurioPaths, String> {
    let root = resolve_mercurio_user_dir();
    let stdlib_root = root.join("stdlib");
    fs::create_dir_all(&stdlib_root).map_err(|e| e.to_string())?;
    let settings_path = root.join("settings.json");
    Ok(MercurioPaths {
        stdlib_root,
        settings_path,
    })
}

pub fn load_app_settings(path: &Path) -> AppSettings {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => AppSettings::default(),
    }
}

pub fn save_app_settings(path: &Path, settings: &AppSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let payload = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, payload).map_err(|e| e.to_string())
}
