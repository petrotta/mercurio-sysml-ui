use crate::logging::log_event;
use crate::types::{AppSettings, AppState, PackagedStdlibManifest, StdlibCache};
use std::fs;
use std::fs::File;
use std::io;
use std::path::{Component, Path, PathBuf};
use syster::base::constants::STDLIB_DIR;
use syster::ide::AnalysisHost;
use syster::project::StdLibLoader;
use syster::syntax::SyntaxFile;
use tauri::path::BaseDirectory;
use tauri::Manager;
use zip::ZipArchive;

fn sanitize_zip_path(path: &Path) -> Result<PathBuf, String> {
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            _ => return Err(format!("Invalid zip entry path: {}", path.display())),
        }
    }
    Ok(clean)
}

fn extract_zip_to_dir(zip_path: &Path, target_dir: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let entry_path = Path::new(entry.name());
        let clean_rel = sanitize_zip_path(entry_path)?;
        let out_path = target_dir.join(clean_rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut outfile = File::create(&out_path).map_err(|e| e.to_string())?;
        io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn dir_has_extension(dir: &Path, extensions: &[&str]) -> Result<bool, String> {
    if !dir.exists() {
        return Ok(false);
    }
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            if dir_has_extension(&path, extensions)? {
                return Ok(true);
            }
            continue;
        }
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        if extensions.iter().any(|value| ext.eq_ignore_ascii_case(value)) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn dir_has_named_file(dir: &Path, names: &[&str]) -> Result<bool, String> {
    if !dir.exists() {
        return Ok(false);
    }
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            if dir_has_named_file(&path, names)? {
                return Ok(true);
            }
            continue;
        }
        let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if names.iter().any(|value| value.eq_ignore_ascii_case(file_name)) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn dir_has_any_file(dir: &Path) -> Result<bool, String> {
    if !dir.exists() {
        return Ok(false);
    }
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            if dir_has_any_file(&path)? {
                return Ok(true);
            }
        } else {
            return Ok(true);
        }
    }
    Ok(false)
}

fn expand_nested_zips(target_dir: &Path) -> Result<bool, String> {
    if !target_dir.exists() {
        return Ok(false);
    }
    let mut expanded = false;
    let entries = fs::read_dir(target_dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_file() {
            let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
            if ext.eq_ignore_ascii_case("zip") {
                extract_zip_to_dir(&path, target_dir)?;
                let _ = fs::remove_file(&path);
                expanded = true;
            }
        }
    }
    Ok(expanded)
}

fn read_packaged_stdlib_manifest(app: &tauri::AppHandle) -> Result<PackagedStdlibManifest, String> {
    let manifest_path = app
        .path()
        .resolve("stdlib-packaged/manifest.json", BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    let content = fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

pub fn list_stdlib_versions_from_root(stdlib_root: &Path) -> Result<Vec<String>, String> {
    let mut versions = Vec::new();
    let entries = fs::read_dir(stdlib_root).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                versions.push(name.to_string());
            }
        }
    }
    versions.sort();
    Ok(versions)
}

pub fn ensure_packaged_stdlibs(
    app: &tauri::AppHandle,
    stdlib_root: &Path,
    settings_path: &Path,
    settings: &mut AppSettings,
) -> Result<(), String> {
    let manifest = read_packaged_stdlib_manifest(app)?;
    for entry in &manifest.stdlibs {
        let target_dir = stdlib_root.join(&entry.id);
        let has_models = dir_has_extension(&target_dir, &["sysml", "kerml"])?;
        let has_projects = dir_has_named_file(&target_dir, &[".project", ".project.json", "project.json"])?;
        let has_zip = dir_has_extension(&target_dir, &["zip"])?;
        let has_any = dir_has_any_file(&target_dir)?;
        if has_models || has_projects {
            continue;
        }
        if has_any && !has_zip {
            continue;
        }
        let zip_path = app
            .path()
            .resolve(&entry.zip, BaseDirectory::Resource)
            .map_err(|e| e.to_string())?;
        log_event(
            "INFO",
            "stdlib",
            format!(
                "extract packaged stdlib id={} zip={}",
                entry.id,
                zip_path.to_string_lossy()
            ),
        );
        if !target_dir.exists() {
            fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
        }
        extract_zip_to_dir(&zip_path, &target_dir)?;
        if expand_nested_zips(&target_dir)? {
            log_event(
                "INFO",
                "stdlib",
                format!("expanded nested stdlib zip for id={}", entry.id),
            );
        }
    }
    let installed = list_stdlib_versions_from_root(stdlib_root)?;
    let default_missing = settings
        .default_stdlib
        .as_ref()
        .map(|id| !installed.contains(id))
        .unwrap_or(true);
    if default_missing {
        if let Some(first) = manifest.stdlibs.first().map(|entry| entry.id.clone()) {
            settings.default_stdlib = Some(first);
            save_app_settings(settings_path, settings)?;
        }
    }
    Ok(())
}

pub fn discover_stdlib_path() -> PathBuf {
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
    {
        let stdlib_next_to_exe = exe_dir.join(STDLIB_DIR);
        if stdlib_next_to_exe.exists() && stdlib_next_to_exe.is_dir() {
            return stdlib_next_to_exe;
        }
    }

    PathBuf::from(STDLIB_DIR)
}

pub fn resolve_default_stdlib_path(
    root: &Path,
    stdlib_root: &Path,
    default_stdlib: Option<&str>,
) -> PathBuf {
    let root_stdlib = root.join(STDLIB_DIR);
    if root_stdlib.exists() && root_stdlib.is_dir() {
        return root_stdlib;
    }

    if let Some(version) = default_stdlib {
        let candidate = stdlib_root.join(version);
        if candidate.exists() && candidate.is_dir() {
            return candidate;
        }
    }
    if let Ok(versions) = list_stdlib_versions_from_root(stdlib_root) {
        if let Some(first) = versions.first() {
            let candidate = stdlib_root.join(first);
            if candidate.exists() && candidate.is_dir() {
                return candidate;
            }
        }
    }

    discover_stdlib_path()
}

pub fn load_stdlib_cached(
    state: &AppState,
    stdlib_path: &Path,
) -> Result<Vec<(PathBuf, SyntaxFile)>, String> {
    let mut guard = state
        .stdlib_cache
        .lock()
        .map_err(|_| "Stdlib cache lock poisoned".to_string())?;
    if let Some(cache) = guard.as_ref() {
        if cache.path == stdlib_path {
            log_event(
                "INFO",
                "stdlib",
                format!(
                    "cache hit path={} files={}",
                    stdlib_path.to_string_lossy(),
                    cache.files.len()
                ),
            );
            return Ok(cache.files.clone());
        }
    }

    log_event(
        "INFO",
        "stdlib",
        format!("cache miss path={} (parsing stdlib)", stdlib_path.to_string_lossy()),
    );
    let mut host = AnalysisHost::new();
    let loader = StdLibLoader::with_path(stdlib_path.to_path_buf());
    loader.load_into_host(&mut host)?;
    let files = host
        .files()
        .iter()
        .map(|(path, file)| (path.clone(), file.clone()))
        .collect::<Vec<_>>();
    *guard = Some(StdlibCache {
        path: stdlib_path.to_path_buf(),
        files: files.clone(),
    });
    log_event(
        "INFO",
        "stdlib",
        format!("cache stored path={} files={}", stdlib_path.to_string_lossy(), files.len()),
    );
    Ok(files)
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

#[tauri::command]
pub fn list_stdlib_versions(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    list_stdlib_versions_from_root(&state.stdlib_root)
}

#[tauri::command]
pub fn get_default_stdlib(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "Settings lock poisoned".to_string())?;
    Ok(settings.default_stdlib.clone())
}

#[tauri::command]
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
