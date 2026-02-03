use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use syster::ide::AnalysisHost;
use syster::project::StdLibLoader;
use syster::hir::SemanticChecker;
use std::fs;
use std::fs::File;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::env;
use std::time::{Instant, SystemTime};
use std::sync::{Arc, Mutex};
use std::collections::HashSet;
use syster::base::constants::STDLIB_DIR;
use syster::base::FileId;
use syster::hir::{
    extract_symbols_unified, HirRelationship, HirSymbol, SymbolKind, TypeRef, TypeRefKind,
};
use syster::syntax::SyntaxFile;
use syster::syntax::parser::parse_with_result;
use syster::interchange::{
    detect_format, JsonLd, Kpar, ModelFormat, Xmi, model_from_symbols, restore_ids_from_symbols,
    symbols_from_model,
};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::path::BaseDirectory;
use tauri::{Emitter, EventTarget, Manager};
use zip::ZipArchive;

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize, Clone)]
struct CompileFileResult {
  path: String,
  ok: bool,
  errors: Vec<String>,
  symbol_count: usize,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(untagged)]
enum LibraryConfig {
    Default(String),
    Path { path: String },
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct ProjectConfig {
    library: Option<LibraryConfig>,
    src: Option<Vec<String>>,
    #[serde(rename = "import")]
    import_entries: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct ProjectDescriptor {
    name: Option<String>,
    author: Option<String>,
    description: Option<String>,
    organization: Option<String>,
    #[serde(flatten)]
    config: ProjectConfig,
}

#[derive(Serialize, Clone)]
struct ProjectDescriptorView {
    name: Option<String>,
    author: Option<String>,
    description: Option<String>,
    organization: Option<String>,
    default_library: bool,
    raw_json: String,
}

#[derive(Deserialize)]
struct CreateProjectDescriptorPayload {
    root: String,
    name: String,
    author: Option<String>,
    description: Option<String>,
    organization: Option<String>,
    use_default_library: bool,
}

#[derive(Serialize, Clone)]
struct ParseErrorView {
    message: String,
    line: usize,
    column: usize,
    kind: String,
}

#[derive(Serialize, Clone)]
struct ParseErrorsPayload {
    path: String,
    errors: Vec<ParseErrorView>,
}

#[derive(Serialize)]
struct StartupOpen {
    path: String,
    kind: String,
}

#[derive(Serialize, Clone)]
struct FsEventPayload {
    path: String,
    kind: String,
}

#[derive(Clone)]
struct AppState {
    watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
    stdlib_cache: Arc<Mutex<Option<StdlibCache>>>,
    canceled_compiles: Arc<Mutex<HashSet<u64>>>,
    analysis_host: Arc<Mutex<AnalysisHost>>,
    workspace: Arc<Mutex<WorkspaceState>>,
    stdlib_root: PathBuf,
    settings_path: PathBuf,
    settings: Arc<Mutex<AppSettings>>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct AppSettings {
    default_stdlib: Option<String>,
}

struct MercurioPaths {
    stdlib_root: PathBuf,
    settings_path: PathBuf,
}

struct StdlibCache {
    path: PathBuf,
    files: Vec<(PathBuf, SyntaxFile)>,
}

#[derive(Clone)]
struct UnsavedFile {
    path: PathBuf,
    content: String,
}

#[derive(Default)]
struct WorkspaceState {
    root: Option<PathBuf>,
    project_files: HashSet<PathBuf>,
    import_files: HashSet<PathBuf>,
    stdlib_path: Option<PathBuf>,
    file_mtimes: std::collections::HashMap<PathBuf, SystemTime>,
    file_cache: std::collections::HashMap<PathBuf, CompileFileResult>,
}

#[derive(Deserialize)]
struct PackagedStdlibManifest {
    stdlibs: Vec<PackagedStdlibEntry>,
}

#[derive(Deserialize)]
struct PackagedStdlibEntry {
    id: String,
    zip: String,
}

fn resolve_user_local_dir() -> PathBuf {
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

fn ensure_mercurio_paths() -> Result<MercurioPaths, String> {
    let root = resolve_user_local_dir().join(".mercurio");
    let stdlib_root = root.join("stdlib");
    fs::create_dir_all(&stdlib_root).map_err(|e| e.to_string())?;
    let settings_path = root.join("settings.json");
    Ok(MercurioPaths {
        stdlib_root,
        settings_path,
    })
}

fn load_app_settings(path: &Path) -> AppSettings {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => AppSettings::default(),
    }
}

fn save_app_settings(path: &Path, settings: &AppSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let payload = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, payload).map_err(|e| e.to_string())
}

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

fn read_packaged_stdlib_manifest(app: &tauri::AppHandle) -> Result<PackagedStdlibManifest, String> {
    let manifest_path = app
        .path()
        .resolve("stdlib-packaged/manifest.json", BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    let content = fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

fn list_stdlib_versions_from_root(stdlib_root: &Path) -> Result<Vec<String>, String> {
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

fn ensure_packaged_stdlibs(
    app: &tauri::AppHandle,
    stdlib_root: &Path,
    settings_path: &Path,
    settings: &mut AppSettings,
) -> Result<(), String> {
    let manifest = read_packaged_stdlib_manifest(app)?;
    for entry in &manifest.stdlibs {
        let target_dir = stdlib_root.join(&entry.id);
        if target_dir.exists() {
            continue;
        }
        let zip_path = app
            .path()
            .resolve(&entry.zip, BaseDirectory::Resource)
            .map_err(|e| e.to_string())?;
        extract_zip_to_dir(&zip_path, &target_dir)?;
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

struct CancelGuard {
    canceled: Arc<Mutex<HashSet<u64>>>,
    run_id: u64,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = self.canceled.lock() {
            set.remove(&self.run_id);
        }
    }
}

#[derive(Serialize)]
struct CompileResponse {
    ok: bool,
    files: Vec<CompileFileResult>,
    symbols: Vec<SymbolView>,
    unresolved: Vec<UnresolvedRefView>,
    library_path: Option<String>,
    parse_failed: bool,
    stdlib_cache_hit: bool,
    parsed_files: Vec<String>,
    parse_duration_ms: u128,
    analysis_duration_ms: u128,
    stdlib_duration_ms: u128,
    total_duration_ms: u128,
}

#[derive(Serialize, Clone)]
struct CompileProgressPayload {
    run_id: u64,
    stage: String,
    file: Option<String>,
    index: Option<usize>,
    total: Option<usize>,
}

#[derive(Serialize)]
struct UnresolvedRefView {
    file_path: String,
    message: String,
    line: u32,
    column: u32,
    code: Option<String>,
}

#[derive(Serialize)]
struct SymbolView {
    file_path: String,
    name: String,
    short_name: Option<String>,
    qualified_name: String,
    kind: String,
    file: u32,
    start_line: u32,
    start_col: u32,
    end_line: u32,
    end_col: u32,
    short_name_start_line: Option<u32>,
    short_name_start_col: Option<u32>,
    short_name_end_line: Option<u32>,
    short_name_end_col: Option<u32>,
    doc: Option<String>,
    supertypes: Vec<String>,
    relationships: Vec<RelationshipView>,
    type_refs: Vec<TypeRefView>,
    is_public: bool,
    properties: Vec<PropertyItemView>,
}

#[derive(Serialize)]
struct PropertyItemView {
    name: String,
    label: String,
    value: PropertyValueView,
    hint: Option<String>,
    group: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum PropertyValueView {
    Text { value: String },
    List { items: Vec<String> },
    Bool { value: bool },
    Number { value: u64 },
}

struct PropertyDescriptor {
    name: &'static str,
    label: &'static str,
    hint: Option<&'static str>,
    group: Option<&'static str>,
    getter: fn(&HirSymbol, &Path) -> PropertyValueView,
}

#[derive(Serialize)]
struct RelationshipView {
    kind: String,
    target: String,
    resolved_target: Option<String>,
    start_line: u32,
    start_col: u32,
    end_line: u32,
    end_col: u32,
}

#[derive(Serialize)]
struct TypeRefPartView {
    kind: String,
    target: String,
    resolved_target: Option<String>,
    start_line: u32,
    start_col: u32,
    end_line: u32,
    end_col: u32,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum TypeRefView {
    Simple { part: TypeRefPartView },
    Chain { parts: Vec<TypeRefPartView> },
}

#[tauri::command]
fn get_default_root() -> Result<String, String> {
    std::env::current_dir()
        .map_err(|e| e.to_string())
        .and_then(|path| {
            path.to_str()
                .map(|s| s.to_string())
                .ok_or_else(|| "Failed to resolve current directory".to_string())
        })
}

#[tauri::command]
fn list_stdlib_versions(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    list_stdlib_versions_from_root(&state.stdlib_root)
}

#[tauri::command]
fn get_default_stdlib(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "Settings lock poisoned".to_string())?;
    Ok(settings.default_stdlib.clone())
}

#[tauri::command]
fn set_default_stdlib(state: tauri::State<'_, AppState>, version: String) -> Result<(), String> {
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

#[tauri::command]
fn get_startup_path() -> Result<Option<StartupOpen>, String> {
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
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries = Vec::new();
    let read_dir = fs::read_dir(&path).map_err(|e| e.to_string())?;

    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let name = entry
            .file_name()
            .to_string_lossy()
            .to_string();
        let is_dir = entry_path.is_dir();
        entries.push(DirEntry {
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir,
        });
    }

    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn path_exists(path: String) -> Result<bool, String> {
    Ok(PathBuf::from(path).exists())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(target, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_file(root: String, parent: String, name: String) -> Result<String, String> {
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
fn create_dir(root: String, parent: String, name: String) -> Result<String, String> {
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
fn create_package(payload: serde_json::Value) -> Result<(), String> {
    let root = payload
        .get("root")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Missing required 'root' argument".to_string())?
        .to_string();
    let file = payload
        .get("file")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Missing required 'file' argument".to_string())?
        .to_string();
    let name = payload
        .get("name")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Missing required 'name' argument".to_string())?
        .trim()
        .to_string();
    if name.is_empty() {
        return Err("Package name is required".to_string());
    }
    let root_path = PathBuf::from(root);
    let target_path = resolve_under_root(&root_path, Path::new(&file))?;
    let mut content = fs::read_to_string(&target_path).unwrap_or_default();
    if !content.ends_with('\n') && !content.is_empty() {
        content.push('\n');
    }
    content.push('\n');
    content.push_str(&format!("package {} {{\n}}\n", name));
    fs::write(&target_path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn rename_path(root: String, path: String, new_name: String) -> Result<String, String> {
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
fn delete_path(root: String, path: String) -> Result<(), String> {
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
fn open_in_explorer(path: String) -> Result<(), String> {
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

#[derive(Deserialize)]
struct AiEndpointPayload {
    url: String,
    r#type: String,
    model: Option<String>,
    token: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct AiMessagePayload {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct AiChatPayload {
    url: String,
    model: Option<String>,
    token: Option<String>,
    messages: Vec<AiMessagePayload>,
    max_tokens: Option<u32>,
}

fn normalize_ai_url(base: &str, suffix: &str) -> String {
    if base.contains(suffix) {
        return base.to_string();
    }
    let trimmed = base.trim_end_matches('/');
    if trimmed.ends_with("/v1") {
        format!("{}{}", trimmed, suffix)
    } else {
        format!("{}/v1{}", trimmed, suffix)
    }
}

#[tauri::command]
async fn ai_test_endpoint(payload: AiEndpointPayload) -> Result<serde_json::Value, String> {
    let endpoint_type = payload.r#type.to_lowercase();
    let url = if endpoint_type == "embeddings" {
        normalize_ai_url(&payload.url, "/embeddings")
    } else {
        normalize_ai_url(&payload.url, "/chat/completions")
    };
    let body = if endpoint_type == "embeddings" {
        serde_json::json!({
            "model": payload.model.unwrap_or_else(|| "text-embedding-3-small".to_string()),
            "input": "ping",
        })
    } else {
        serde_json::json!({
            "model": payload.model.unwrap_or_else(|| "gpt-4o-mini".to_string()),
            "messages": [{ "role": "user", "content": "ping" }],
            "max_tokens": 1,
        })
    };
    let client = reqwest::Client::new();
    let mut request = client.post(url).header("Content-Type", "application/json");
    if let Some(token) = payload.token {
        if !token.trim().is_empty() {
            request = request.header("Authorization", format!("Bearer {}", token));
        }
    }
    let response = request.json(&body).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let detail = response.text().await.unwrap_or_else(|_| "".to_string());
        return Ok(serde_json::json!({ "ok": false, "status": status, "detail": detail }));
    }
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
async fn ai_chat_completion(payload: AiChatPayload) -> Result<serde_json::Value, String> {
    let url = normalize_ai_url(&payload.url, "/chat/completions");
    let body = serde_json::json!({
        "model": payload.model.unwrap_or_else(|| "gpt-4o-mini".to_string()),
        "messages": payload.messages,
        "max_tokens": payload.max_tokens.unwrap_or(512),
    });
    let client = reqwest::Client::new();
    let mut request = client.post(url).header("Content-Type", "application/json");
    if let Some(token) = payload.token {
        if !token.trim().is_empty() {
            request = request.header("Authorization", format!("Bearer {}", token));
        }
    }
    let response = request.json(&body).send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("{} {}", status.as_u16(), text));
    }
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(value)
}

#[tauri::command]
fn set_watch_root(app: tauri::AppHandle, state: tauri::State<AppState>, root: String) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }

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

#[tauri::command]
fn get_parse_errors(path: String) -> Result<ParseErrorsPayload, String> {
    let file_path = PathBuf::from(&path);
    if !file_path.exists() {
        return Err("File does not exist".to_string());
    }
    if !is_model_file(&file_path) {
        return Ok(ParseErrorsPayload {
            path: path.clone(),
            errors: Vec::new(),
        });
    }
    let content = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let parse = parse_with_result(&content, &file_path);
    let errors = parse
        .errors
        .iter()
        .map(|err| ParseErrorView {
            message: err.message.clone(),
            line: err.position.line,
            column: err.position.column,
            kind: format!("{:?}", err.kind),
        })
        .collect::<Vec<_>>();
    Ok(ParseErrorsPayload {
        path: path.clone(),
        errors,
    })
}

#[tauri::command]
fn get_parse_errors_for_content(path: String, content: String) -> Result<ParseErrorsPayload, String> {
    let file_path = PathBuf::from(&path);
    if !is_model_file(&file_path) {
        return Ok(ParseErrorsPayload {
            path: path.clone(),
            errors: Vec::new(),
        });
    }
    let parse = parse_with_result(&content, &file_path);
    let errors = parse
        .errors
        .iter()
        .map(|err| ParseErrorView {
            message: err.message.clone(),
            line: err.position.line,
            column: err.position.column,
            kind: format!("{:?}", err.kind),
        })
        .collect::<Vec<_>>();
    Ok(ParseErrorsPayload {
        path: path.clone(),
        errors,
    })
}

#[tauri::command]
fn window_minimize(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.minimize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn window_toggle_maximize(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_maximized().map_err(|e| e.to_string())? {
            window.unmaximize().map_err(|e| e.to_string())?;
        } else {
            window.maximize().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn window_close(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn discover_stdlib_path() -> PathBuf {
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

fn resolve_default_stdlib_path(
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

fn load_stdlib_cached(
    state: &AppState,
    stdlib_path: &Path,
) -> Result<Vec<(PathBuf, SyntaxFile)>, String> {
    let mut guard = state
        .stdlib_cache
        .lock()
        .map_err(|_| "Stdlib cache lock poisoned".to_string())?;
    if let Some(cache) = guard.as_ref() {
        if cache.path == stdlib_path {
            println!("stdlib: cache hit");
            return Ok(cache.files.clone());
        }
    }

    println!("stdlib: cache miss (parsing stdlib)");
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
    Ok(files)
}

#[tauri::command]
async fn compile_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<CompileResponse, String> {
    let root = payload
        .get("root")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Missing required 'root' argument".to_string())?
        .to_string();
    let run_id = payload
        .get("run_id")
        .or_else(|| payload.get("runId"))
        .or_else(|| payload.get("runld"))
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let allow_parse_errors = payload
        .get("allow_parse_errors")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let unsaved = payload
        .get("unsaved")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|entry| {
                    let path = entry.get("path").and_then(|v| v.as_str())?;
                    let content = entry.get("content").and_then(|v| v.as_str())?;
                    Some(UnsavedFile {
                        path: PathBuf::from(path),
                        content: content.to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let state = state.inner().clone();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        compile_workspace_sync(app, state, root, run_id, allow_parse_errors, unsaved)
    })
        .await
        .map_err(|e| e.to_string())?
}

fn compile_workspace_sync(
    app: tauri::AppHandle,
    state: AppState,
    root: String,
    run_id: u64,
    allow_parse_errors: bool,
    unsaved: Vec<UnsavedFile>,
) -> Result<CompileResponse, String> {
    let compile_start = Instant::now();
    let mut stdlib_cache_hit = false;
    let mut parsed_files: Vec<String> = Vec::new();
    let mut analysis_duration_ms: u128 = 0;
    let mut stdlib_duration_ms: u128 = 0;
    let root_path = PathBuf::from(root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }
    let default_stdlib = state
        .settings
        .lock()
        .ok()
        .and_then(|settings| settings.default_stdlib.clone());

    let _cancel_guard = CancelGuard {
        canceled: state.canceled_compiles.clone(),
        run_id,
    };

    let is_canceled = || {
        state
            .canceled_compiles
            .lock()
            .map(|set| set.contains(&run_id))
            .unwrap_or(false)
    };
    let check_cancel = || {
        if is_canceled() {
            return Err("Compile canceled".to_string());
        }
        Ok(())
    };
    let emit_progress = |stage: &str, file: Option<String>, index: Option<usize>, total: Option<usize>| {
        let payload = CompileProgressPayload {
            run_id,
            stage: stage.to_string(),
            file,
            index,
            total,
        };
        let _ = app.emit_to(
            EventTarget::webview_window("main"),
            "compile-progress",
            payload,
        );
    };

    let mut files = Vec::new();
    let mut used_project_src = false;
    let project_config = load_project_config(&root_path).ok().flatten();
    if let Some(config) = project_config.clone() {
        if let Some(src) = config.src {
            files = collect_project_files(&root_path, &src)?;
            used_project_src = true;
        }
    }
    if !used_project_src {
        collect_model_files(&root_path, &mut files)?;
    }
    check_cancel()?;

    let mut symbols = Vec::new();
    let mut file_results: Vec<CompileFileResult>;
    let mut unresolved = Vec::new();

    let mut analysis_host = state
        .analysis_host
        .lock()
        .map_err(|_| "Analysis host lock poisoned".to_string())?;
    let mut workspace = state
        .workspace
        .lock()
        .map_err(|_| "Workspace lock poisoned".to_string())?;

    let import_files = project_config
        .as_ref()
        .and_then(|config| config.import_entries.as_ref())
        .map(|imports| collect_project_imports(&root_path, imports))
        .transpose()?
        .unwrap_or_default();
    let import_set: HashSet<PathBuf> = import_files.iter().cloned().collect();

    let library_config = project_config.clone().and_then(|config| config.library);
    let (stdlib_loader, stdlib_source, stdlib_path_for_log) = match library_config {
        Some(LibraryConfig::Path { path }) => {
            if path.trim().is_empty() {
                let discovered = resolve_default_stdlib_path(
                    &root_path,
                    &state.stdlib_root,
                    default_stdlib.as_deref(),
                );
                let source = format!("default: {}", discovered.to_string_lossy());
                (StdLibLoader::new(), source, Some(discovered))
            } else {
                let raw_path = PathBuf::from(&path);
                let resolved = if raw_path.is_absolute() {
                    raw_path
                } else {
                    root_path.join(raw_path)
                };
                let source = format!("path: {}", resolved.to_string_lossy());
                (StdLibLoader::with_path(resolved.clone()), source, Some(resolved))
            }
        }
        Some(LibraryConfig::Default(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("default") {
                let discovered = resolve_default_stdlib_path(
                    &root_path,
                    &state.stdlib_root,
                    default_stdlib.as_deref(),
                );
                let source = format!("default: {}", discovered.to_string_lossy());
                (StdLibLoader::new(), source, Some(discovered))
            } else {
                let raw_path = PathBuf::from(trimmed);
                let resolved = if raw_path.is_absolute() {
                    raw_path
                } else {
                    root_path.join(raw_path)
                };
                let source = format!("path: {}", resolved.to_string_lossy());
                (StdLibLoader::with_path(resolved.clone()), source, Some(resolved))
            }
        }
        None => {
            let discovered = resolve_default_stdlib_path(
                &root_path,
                &state.stdlib_root,
                default_stdlib.as_deref(),
            );
            let source = format!("default: {}", discovered.to_string_lossy());
            (StdLibLoader::new(), source, Some(discovered))
        }
    };
    let project_set: HashSet<PathBuf> = files.iter().cloned().collect();
    let needs_reset = workspace.root.as_ref() != Some(&root_path)
        || workspace.stdlib_path.as_ref() != stdlib_path_for_log.as_ref()
        || workspace.import_files != import_set;

    if needs_reset {
        *analysis_host = AnalysisHost::new();
        workspace.root = Some(root_path.clone());
        workspace.stdlib_path = stdlib_path_for_log.clone();
        workspace.import_files = import_set.clone();
        workspace.project_files.clear();
        workspace.file_mtimes.clear();
        workspace.file_cache.clear();

        if !import_files.is_empty() {
            load_imports_into_host(&mut analysis_host, &import_files)?;
        }

        if let Ok(cwd) = std::env::current_dir() {
            println!("stdlib: cwd={}", cwd.to_string_lossy());
        }
        let stdlib_path_exists = stdlib_path_for_log
            .as_ref()
            .map(|path| path.exists() && path.is_dir())
            .unwrap_or(false);
        println!(
            "stdlib: loading ({}) exists={}",
            stdlib_source, stdlib_path_exists
        );
        if !stdlib_path_exists {
            println!("stdlib: path missing; no stdlib files will load");
        }
        let stdlib_files_before = analysis_host.file_count();
        let stdlib_start = Instant::now();
        if stdlib_path_exists {
            if let Some(stdlib_path) = stdlib_path_for_log.as_ref() {
                let cached_files = load_stdlib_cached(&state, stdlib_path)?;
                for (path, file) in cached_files {
                    analysis_host.set_file(path, file);
                }
                stdlib_cache_hit = true;
            }
        } else {
            stdlib_loader.load_into_host(&mut analysis_host)?;
        }
        let stdlib_files_after = analysis_host.file_count();
        let stdlib_file_delta = stdlib_files_after.saturating_sub(stdlib_files_before);
        stdlib_duration_ms = stdlib_start.elapsed().as_millis();
        println!(
            "stdlib: loaded files={} duration_ms={}",
            stdlib_file_delta,
            stdlib_duration_ms
        );
        println!("stdlib: symbols=skipped (counting stdlib symbols can overflow the stack)");
    }

    println!("compile: parsing project files count={}", files.len());
    let parse_start = Instant::now();
    let mut has_parse_errors = false;
    emit_progress("parsing", None, None, Some(files.len()));

    let mut unsaved_map = std::collections::HashMap::new();
    for entry in unsaved {
        unsaved_map.insert(entry.path, entry.content);
    }

    let removed: Vec<PathBuf> = workspace
        .project_files
        .difference(&project_set)
        .cloned()
        .collect();
    for path in &removed {
        analysis_host.remove_file_path(path);
        workspace.file_mtimes.remove(path);
        workspace.file_cache.remove(path);
    }
    for path in &project_set {
        if !workspace.project_files.contains(path) {
            workspace.project_files.insert(path.clone());
        }
    }

    for (index, path) in files.iter().enumerate() {
        check_cancel()?;
        emit_progress(
            "parsing",
            Some(path.to_string_lossy().to_string()),
            Some(index + 1),
            Some(files.len()),
        );

        let mut should_parse = false;
        let mut content_override = None;
        if let Some(content) = unsaved_map.get(path) {
            should_parse = true;
            content_override = Some(content.as_str());
        } else {
            let meta = fs::metadata(path).map_err(|e| e.to_string())?;
            let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let known = workspace.file_mtimes.get(path);
            if known.is_none() || known != Some(&modified) {
                should_parse = true;
                workspace.file_mtimes.insert(path.clone(), modified);
            }
        }

        if should_parse || !workspace.file_cache.contains_key(path) {
            parsed_files.push(path.to_string_lossy().to_string());
            let content = match content_override {
                Some(value) => value.to_string(),
                None => fs::read_to_string(path).map_err(|e| e.to_string())?,
            };
            let parse = parse_with_result(&content, path);
            let errors = parse
                .errors
                .iter()
                .map(|e| format!("{:?}", e))
                .collect::<Vec<_>>();
            let ok = parse.content.is_some() && errors.is_empty();
            if !ok {
                has_parse_errors = true;
            }
            let mut symbol_count = 0;

            if let Some(syntax) = parse.content {
                let file_id = FileId::new(index as u32);
                let file_symbols = extract_symbols_unified(file_id, &syntax);
                symbol_count = file_symbols.len();
                analysis_host.set_file(path.to_path_buf(), syntax);
            }

            workspace.file_cache.insert(
                path.to_path_buf(),
                CompileFileResult {
                    path: path.to_string_lossy().to_string(),
                    ok,
                    errors,
                    symbol_count,
                },
            );
        } else if let Some(result) = workspace.file_cache.get(path) {
            if !result.ok {
                has_parse_errors = true;
            }
        }
    }

    file_results = workspace
        .project_files
        .iter()
        .filter_map(|path| workspace.file_cache.get(path).cloned())
        .collect();
    file_results.sort_by(|a, b| a.path.cmp(&b.path));
    println!(
        "compile: parsing done host_files={} duration_ms={}",
        analysis_host.file_count(),
        parse_start.elapsed().as_millis()
    );
    if has_parse_errors && !allow_parse_errors {
        println!(
            "compile: parse failed duration_ms={} total_duration_ms={}",
            parse_start.elapsed().as_millis(),
            compile_start.elapsed().as_millis()
        );
        return Ok(CompileResponse {
            ok: false,
            files: file_results,
            symbols,
            unresolved,
            library_path: stdlib_path_for_log
                .as_ref()
                .map(|path| path.to_string_lossy().to_string()),
            parse_failed: true,
            stdlib_cache_hit,
            parsed_files,
            parse_duration_ms: parse_start.elapsed().as_millis(),
            analysis_duration_ms,
            stdlib_duration_ms,
            total_duration_ms: compile_start.elapsed().as_millis(),
        });
    }

    if analysis_host.file_count() > 0 {
        let analysis_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            check_cancel()?;
            emit_progress("analysis", None, None, None);
            let analysis_start = Instant::now();
            println!("analysis: start");
            let _ = analysis_host.analysis();
            println!(
                "analysis: done duration_ms={}",
                analysis_start.elapsed().as_millis()
            );
            analysis_duration_ms = analysis_start.elapsed().as_millis();
            check_cancel()?;

            let project_file_ids = files
                .iter()
                .filter_map(|path| analysis_host.get_file_id_for_path(path))
                .collect::<Vec<_>>();
            if project_file_ids.is_empty() {
                println!("semantic: skipped (no project files)");
            } else {
                check_cancel()?;
                let semantic_total = project_file_ids.len();
                emit_progress("semantic", None, Some(0), Some(semantic_total));
                let semantic_start = Instant::now();
                println!("semantic: start");
                let symbol_index = analysis_host.symbol_index().clone();
                let canceled_compiles = state.canceled_compiles.clone();
                let run_id = run_id;
                let app = app.clone();
                let semantic_result = std::thread::Builder::new()
                    .name("semantic-check".to_string())
                    .stack_size(64 * 1024 * 1024)
                    .spawn(move || {
                        let mut checker = SemanticChecker::new(&symbol_index);
                        for (index, file_id) in project_file_ids.into_iter().enumerate() {
                            let canceled = canceled_compiles
                                .lock()
                                .map(|set| set.contains(&run_id))
                                .unwrap_or(false);
                            if canceled {
                                return Err("Compile canceled".to_string());
                            }
                            let _ = app.emit_to(
                                EventTarget::webview_window("main"),
                                "compile-progress",
                                CompileProgressPayload {
                                    run_id,
                                    stage: "semantic".to_string(),
                                    file: None,
                                    index: Some(index + 1),
                                    total: Some(semantic_total),
                                },
                            );
                            checker.check_file(file_id);
                        }
                        Ok(checker.finish())
                    })
                    .map_err(|e| e.to_string())?
                    .join()
                    .map_err(|_| "Semantic checker thread panicked".to_string())?;
                let semantic_result = semantic_result?;
                println!(
                    "semantic: done duration_ms={}",
                    semantic_start.elapsed().as_millis()
                );
                unresolved = semantic_result
                    .into_iter()
                    .filter(|diag| diag.message.to_lowercase().contains("undefined reference"))
                    .filter_map(|diag| {
                        let path = analysis_host.get_file_path(diag.file)?;
                        Some(UnresolvedRefView {
                            file_path: path.to_string(),
                            message: diag.message.to_string(),
                            line: diag.start_line,
                            column: diag.start_col,
                            code: diag.code.map(|c| c.to_string()),
                        })
                    })
                    .collect();
            }

            println!("symbols: start");
            check_cancel()?;
            let analysis_snapshot = analysis_host.analysis();
            let mut all_symbols: Vec<_> = analysis_snapshot
                .symbol_index()
                .all_symbols()
                .cloned()
                .collect();
            all_symbols.sort_by(|a, b| {
                let a_path = analysis_snapshot.get_file_path(a.file).unwrap_or("");
                let b_path = analysis_snapshot.get_file_path(b.file).unwrap_or("");
                match a_path.cmp(b_path) {
                    std::cmp::Ordering::Equal => a
                        .qualified_name
                        .as_ref()
                        .cmp(b.qualified_name.as_ref()),
                    other => other,
                }
            });
            symbols = all_symbols
                .into_iter()
                .map(|symbol| {
                    let file_path = analysis_snapshot.get_file_path(symbol.file).unwrap_or("");
                    symbol_to_view(symbol, Path::new(file_path))
                })
                .collect();
            println!("symbols: done count={}", symbols.len());
            Ok::<(), String>(())
        }));

        match analysis_result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => return Err(err),
            Err(_) => {
                return Err("Compile failed during analysis (panic).".to_string());
            }
        }
    }

    println!(
        "compile: done total_duration_ms={}",
        compile_start.elapsed().as_millis()
    );
    Ok(CompileResponse {
        ok: file_results.iter().all(|f| f.ok),
        files: file_results,
        symbols,
        unresolved,
        library_path: stdlib_path_for_log
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        parse_failed: false,
        stdlib_cache_hit,
        parsed_files,
        parse_duration_ms: parse_start.elapsed().as_millis(),
        analysis_duration_ms,
        stdlib_duration_ms,
        total_duration_ms: compile_start.elapsed().as_millis(),
    })
}

#[tauri::command]
fn cancel_compile(state: tauri::State<'_, AppState>, run_id: u64) -> Result<(), String> {
    let mut set = state
        .canceled_compiles
        .lock()
        .map_err(|_| "Cancel lock poisoned".to_string())?;
    set.insert(run_id);
    Ok(())
}

#[tauri::command]
async fn export_compiled_model(
    state: tauri::State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<(), String> {
    let root = payload
        .get("root")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Missing required 'root' argument".to_string())?
        .to_string();
    let output = payload
        .get("output")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Missing required 'output' argument".to_string())?
        .to_string();
    let format = payload
        .get("format")
        .and_then(|value| value.as_str())
        .unwrap_or("xmi")
        .to_string();
    let include_stdlib = payload
        .get("include_stdlib")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        export_model_to_path(state, root, output, format, include_stdlib)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn load_project_descriptor(root: &Path) -> Result<Option<ProjectDescriptor>, String> {
    let config_path = root.join(".project.json");
    if !config_path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(config_path).map_err(|e| e.to_string())?;
    let parsed: ProjectDescriptor = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(Some(parsed))
}

fn load_project_config(root: &Path) -> Result<Option<ProjectConfig>, String> {
    Ok(load_project_descriptor(root)?.map(|descriptor| descriptor.config))
}

#[tauri::command]
fn get_project_descriptor(root: String) -> Result<Option<ProjectDescriptorView>, String> {
    let root_path = PathBuf::from(root);
    let descriptor = match load_project_descriptor(&root_path)? {
        Some(value) => value,
        None => return Ok(None),
    };
    let default_library = matches!(
        descriptor.config.library,
        Some(LibraryConfig::Default(ref value)) if value == "default"
    );
    let raw_json = serde_json::to_string_pretty(&descriptor).map_err(|e| e.to_string())?;
    Ok(Some(ProjectDescriptorView {
        name: descriptor.name,
        author: descriptor.author,
        description: descriptor.description,
        organization: descriptor.organization,
        default_library,
        raw_json,
    }))
}

#[tauri::command]
fn create_project_descriptor(payload: CreateProjectDescriptorPayload) -> Result<ProjectDescriptorView, String> {
    let root_path = PathBuf::from(payload.root);
    if root_path.exists() {
        return Err("Project folder already exists".to_string());
    }
    fs::create_dir_all(&root_path).map_err(|e| e.to_string())?;
    let config = ProjectConfig {
        library: if payload.use_default_library {
            Some(LibraryConfig::Default("default".to_string()))
        } else {
            None
        },
        src: Some(vec!["**/*.sysml".to_string(), "**/*.kerml".to_string()]),
        import_entries: Some(vec!["**/*.sysmlx".to_string(), "**/*.kermlx".to_string()]),
    };
    let descriptor = ProjectDescriptor {
        name: Some(payload.name),
        author: payload.author,
        description: payload.description,
        organization: payload.organization,
        config,
    };
    let content = serde_json::to_string_pretty(&descriptor).map_err(|e| e.to_string())?;
    let config_path = root_path.join(".project.json");
    fs::write(config_path, &content).map_err(|e| e.to_string())?;
    Ok(ProjectDescriptorView {
        name: descriptor.name,
        author: descriptor.author,
        description: descriptor.description,
        organization: descriptor.organization,
        default_library: matches!(
            descriptor.config.library,
            Some(LibraryConfig::Default(ref value)) if value == "default"
        ),
        raw_json: content,
    })
}

fn export_model_to_path(
    state: AppState,
    root: String,
    output: String,
    format: String,
    include_stdlib: bool,
) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }
    let default_stdlib = state
        .settings
        .lock()
        .ok()
        .and_then(|settings| settings.default_stdlib.clone());

    let project_config = load_project_config(&root_path).ok().flatten();
    let mut analysis_host = AnalysisHost::new();

    if let Some(imports) = project_config
        .as_ref()
        .and_then(|config| config.import_entries.as_ref())
    {
        let import_files = collect_project_imports(&root_path, imports)?;
        if !import_files.is_empty() {
            load_imports_into_host(&mut analysis_host, &import_files)?;
        }
    }

    let library_config = project_config.clone().and_then(|config| config.library);
    let (stdlib_loader, stdlib_path_for_log) = match library_config {
        Some(LibraryConfig::Path { path }) => {
            if path.trim().is_empty() {
                let discovered = resolve_default_stdlib_path(
                    &root_path,
                    &state.stdlib_root,
                    default_stdlib.as_deref(),
                );
                (StdLibLoader::new(), Some(discovered))
            } else {
                let raw_path = PathBuf::from(&path);
                let resolved = if raw_path.is_absolute() {
                    raw_path
                } else {
                    root_path.join(raw_path)
                };
                (StdLibLoader::with_path(resolved.clone()), Some(resolved))
            }
        }
        Some(LibraryConfig::Default(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("default") {
                let discovered = resolve_default_stdlib_path(
                    &root_path,
                    &state.stdlib_root,
                    default_stdlib.as_deref(),
                );
                (StdLibLoader::new(), Some(discovered))
            } else {
                let raw_path = PathBuf::from(trimmed);
                let resolved = if raw_path.is_absolute() {
                    raw_path
                } else {
                    root_path.join(raw_path)
                };
                (StdLibLoader::with_path(resolved.clone()), Some(resolved))
            }
        }
        None => {
            let discovered = resolve_default_stdlib_path(
                &root_path,
                &state.stdlib_root,
                default_stdlib.as_deref(),
            );
            (StdLibLoader::new(), Some(discovered))
        }
    };
    let stdlib_path_exists = stdlib_path_for_log
        .as_ref()
        .map(|path| path.exists() && path.is_dir())
        .unwrap_or(false);
    if stdlib_path_exists {
        stdlib_loader.load_into_host(&mut analysis_host)?;
    } else {
        stdlib_loader.load_into_host(&mut analysis_host)?;
    }

    let mut files = Vec::new();
    let mut used_project_src = false;
    if let Some(config) = project_config.clone() {
        if let Some(src) = config.src {
            files = collect_project_files(&root_path, &src)?;
            used_project_src = true;
        }
    }
    if !used_project_src {
        collect_model_files(&root_path, &mut files)?;
    }

    for path in &files {
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let parse = parse_with_result(&content, path);
        if parse.content.is_none() || !parse.errors.is_empty() {
            let name = path.to_string_lossy();
            return Err(format!("Parse failed for {}", name));
        }
        if let Some(syntax) = parse.content {
            analysis_host.set_file(path.to_path_buf(), syntax);
        }
    }

    let analysis = analysis_host.analysis();
    let mut symbols: Vec<_> = analysis.symbol_index().all_symbols().cloned().collect();
    if !include_stdlib {
        if let Some(stdlib_root) = stdlib_path_for_log.as_ref() {
            symbols.retain(|symbol| {
                if let Some(file_path) = analysis.get_file_path(symbol.file) {
                    !is_path_under_root(stdlib_root, file_path)
                } else {
                    true
                }
            });
        }
    }
    let mut model = model_from_symbols(&symbols);
    model = restore_ids_from_symbols(model, analysis.symbol_index());

    let format = match format.to_lowercase().as_str() {
        "sysmlx" | "kermlx" | "xmi" => "xmi",
        "kpar" => "kpar",
        "json" | "jsonld" | "json-ld" => "jsonld",
        other => return Err(format!("Unsupported export format: {}", other)),
    };
    let bytes = match format {
        "xmi" => Xmi.write(&model).map_err(|e| e.to_string())?,
        "kpar" => Kpar.write(&model).map_err(|e| e.to_string())?,
        "jsonld" => JsonLd.write(&model).map_err(|e| e.to_string())?,
        _ => return Err(format!("Unsupported export format: {}", format)),
    };

    fs::write(&output, bytes).map_err(|e| e.to_string())?;
    Ok(())
}

fn collect_project_files(root: &Path, src: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for entry in src {
        let pattern = entry.trim();
        if pattern.is_empty() {
            continue;
        }
        let normalized = pattern.replace('\\', "/");
        if let Some((recursive, ext)) = parse_ext_pattern(&normalized) {
            if recursive {
                collect_model_files_by_extension(root, &ext, &mut out, &mut seen)?;
            } else {
                collect_model_files_in_root_by_extension(root, &ext, &mut out, &mut seen)?;
            }
            continue;
        }

        let resolved = resolve_under_root(root, Path::new(pattern))?;
        if resolved.is_file() {
            let key = resolved.to_string_lossy().to_string();
            if seen.insert(key.clone()) {
                out.push(PathBuf::from(key));
            }
        }
    }

    Ok(out)
}

fn collect_project_imports(root: &Path, imports: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for entry in imports {
        let pattern = entry.trim();
        if pattern.is_empty() {
            continue;
        }
        let normalized = pattern.replace('\\', "/");
        if let Some((recursive, ext)) = parse_ext_pattern(&normalized) {
            if recursive {
                collect_model_files_by_extension(root, &ext, &mut out, &mut seen)?;
            } else {
                collect_model_files_in_root_by_extension(root, &ext, &mut out, &mut seen)?;
            }
            continue;
        }

        let resolved = resolve_under_root(root, Path::new(pattern))?;
        if resolved.is_file() && is_import_file(&resolved) {
            let key = resolved.to_string_lossy().to_string();
            if seen.insert(key.clone()) {
                out.push(PathBuf::from(key));
            }
        }
    }

    Ok(out)
}

fn parse_ext_pattern(pattern: &str) -> Option<(bool, String)> {
    let pattern = pattern.trim();
    if pattern.starts_with("**/") {
        let rest = &pattern[3..];
        if let Some(ext) = parse_simple_ext_pattern(rest) {
            return Some((true, ext));
        }
    }
    if pattern.contains('/') {
        return None;
    }
    parse_simple_ext_pattern(pattern).map(|ext| (false, ext))
}

fn parse_simple_ext_pattern(pattern: &str) -> Option<String> {
    let pattern = pattern.trim();
    if pattern.starts_with("*.") && pattern.len() > 2 {
        return Some(pattern[2..].to_lowercase());
    }
    None
}

fn collect_model_files_in_root_by_extension(
    root: &Path,
    ext: &str,
    out: &mut Vec<PathBuf>,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    let read_dir = fs::read_dir(root).map_err(|e| e.to_string())?;
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_file() {
            if let Some(file_ext) = path.extension().and_then(|v| v.to_str()) {
                if file_ext.eq_ignore_ascii_case(ext) {
                    let key = path.to_string_lossy().to_string();
                    if seen.insert(key.clone()) {
                        out.push(PathBuf::from(key));
                    }
                }
            }
        }
    }
    Ok(())
}

fn collect_model_files_by_extension(
    root: &Path,
    ext: &str,
    out: &mut Vec<PathBuf>,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    let read_dir = fs::read_dir(root).map_err(|e| e.to_string())?;
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if should_skip_dir(&name) {
                continue;
            }
            collect_model_files_by_extension(&path, ext, out, seen)?;
        } else if path.is_file() {
            if let Some(file_ext) = path.extension().and_then(|v| v.to_str()) {
                if file_ext.eq_ignore_ascii_case(ext) {
                    let key = path.to_string_lossy().to_string();
                    if seen.insert(key.clone()) {
                        out.push(PathBuf::from(key));
                    }
                }
            }
        }
    }
    Ok(())
}

fn collect_model_files(root: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let read_dir = fs::read_dir(root).map_err(|e| e.to_string())?;
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if should_skip_dir(&name) {
                continue;
            }
            collect_model_files(&path, out)?;
        } else if is_model_file(&path) {
            out.push(path);
        }
    }
    Ok(())
}

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "build" | ".idea" | ".vscode"
    )
}

fn is_model_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_lowercase().as_str(), "sysml" | "kerml"))
        .unwrap_or(false)
}

fn is_import_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| is_import_extension(ext))
        .unwrap_or(false)
}

fn is_import_extension(ext: &str) -> bool {
    matches!(
        ext.to_lowercase().as_str(),
        "xmi" | "sysmlx" | "kermlx" | "kpar" | "jsonld" | "json"
    )
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new("\\")),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(segment) => normalized.push(segment),
        }
    }
    normalized
}

fn resolve_under_root(root: &Path, target: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let joined = if target.is_absolute() {
        target.to_path_buf()
    } else {
        root.join(target)
    };
    let normalized = normalize_path(&joined);
    if !normalized.starts_with(&root) {
        let root_str = root.to_string_lossy();
        let path_str = normalized.to_string_lossy();
        let strip = |value: &str| {
            let value = value.replace('/', "\\").to_lowercase();
            value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
        };
        let root_cmp = strip(&root_str);
        let path_cmp = strip(&path_str);
        if !path_cmp.starts_with(&root_cmp) {
            return Err("Path is outside the project root".to_string());
        }
    }
    Ok(normalized)
}

fn is_path_under_root(root: &Path, path: &str) -> bool {
    let root_norm = root.canonicalize().ok();
    let path_norm = PathBuf::from(path).canonicalize().ok();
    if let (Some(root_norm), Some(path_norm)) = (root_norm, path_norm) {
        return path_norm.starts_with(&root_norm);
    }
    let root_str = root.to_string_lossy().to_lowercase();
    let path_str = path.to_lowercase();
    if root_str.is_empty() || path_str.is_empty() {
        return false;
    }
    path_str.starts_with(&root_str)
}

fn import_model_into_host(host: &mut AnalysisHost, path: &Path) -> Result<(), String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    let format_hint = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("xmi")
        .to_lowercase();
    let model = match format_hint.as_str() {
        "xmi" | "sysmlx" | "kermlx" => Xmi.read(&bytes).map_err(|e| e.to_string())?,
        "kpar" => Kpar.read(&bytes).map_err(|e| e.to_string())?,
        "jsonld" | "json" => JsonLd.read(&bytes).map_err(|e| e.to_string())?,
        _ => {
            if let Some(format) = detect_format(path) {
                format.read(&bytes).map_err(|e| e.to_string())?
            } else {
                return Err(format!(
                    "Unsupported import format: {}",
                    path.display()
                ));
            }
        }
    };
    let symbols = symbols_from_model(&model);
    host.add_symbols_from_model(symbols);
    Ok(())
}

fn load_imports_into_host(host: &mut AnalysisHost, import_paths: &[PathBuf]) -> Result<(), String> {
    for path in import_paths {
        import_model_into_host(host, path)?;
    }
    Ok(())
}

fn symbol_to_view(symbol: HirSymbol, file_path: &Path) -> SymbolView {
    let kind_label = symbol_kind_label(symbol.kind);
    let properties = build_properties(&symbol, file_path, &kind_label);
    SymbolView {
        file_path: file_path.to_string_lossy().to_string(),
        name: symbol.name.as_ref().to_string(),
        short_name: symbol.short_name.as_ref().map(|s| s.to_string()),
        qualified_name: symbol.qualified_name.as_ref().to_string(),
        kind: kind_label,
        file: symbol.file.into(),
        start_line: symbol.start_line,
        start_col: symbol.start_col,
        end_line: symbol.end_line,
        end_col: symbol.end_col,
        short_name_start_line: symbol.short_name_start_line,
        short_name_start_col: symbol.short_name_start_col,
        short_name_end_line: symbol.short_name_end_line,
        short_name_end_col: symbol.short_name_end_col,
        doc: symbol.doc.as_ref().map(|s| s.to_string()),
        supertypes: symbol
            .supertypes
            .into_iter()
            .map(|s| s.to_string())
            .collect(),
        relationships: symbol
            .relationships
            .into_iter()
            .map(relationship_to_view)
            .collect(),
        type_refs: symbol
            .type_refs
            .into_iter()
            .map(type_ref_to_view)
            .collect(),
        is_public: symbol.is_public,
        properties,
    }
}

fn relationship_to_view(rel: HirRelationship) -> RelationshipView {
    RelationshipView {
        kind: rel.kind.display().to_string(),
        target: rel.target.as_ref().to_string(),
        resolved_target: rel.resolved_target.as_ref().map(|s| s.to_string()),
        start_line: rel.start_line,
        start_col: rel.start_col,
        end_line: rel.end_line,
        end_col: rel.end_col,
    }
}

fn type_ref_to_view(type_ref: TypeRefKind) -> TypeRefView {
    match type_ref {
        TypeRefKind::Simple(r) => TypeRefView::Simple {
            part: type_ref_part_view(r),
        },
        TypeRefKind::Chain(chain) => TypeRefView::Chain {
            parts: chain.parts.into_iter().map(type_ref_part_view).collect(),
        },
    }
}

fn type_ref_part_view(type_ref: TypeRef) -> TypeRefPartView {
    TypeRefPartView {
        kind: type_ref.kind.display().to_string(),
        target: type_ref.target.as_ref().to_string(),
        resolved_target: type_ref.resolved_target.as_ref().map(|s| s.to_string()),
        start_line: type_ref.start_line,
        start_col: type_ref.start_col,
        end_line: type_ref.end_line,
        end_col: type_ref.end_col,
    }
}

const BASE_PROPERTY_DESCRIPTORS: &[PropertyDescriptor] = &[
    PropertyDescriptor {
        name: "name",
        label: "Name",
        hint: None,
        group: None,
        getter: prop_name,
    },
    PropertyDescriptor {
        name: "short_name",
        label: "Short name",
        hint: None,
        group: None,
        getter: prop_short_name,
    },
    PropertyDescriptor {
        name: "qualified_name",
        label: "Qualified name",
        hint: Some("qualified"),
        group: None,
        getter: prop_qualified_name,
    },
    PropertyDescriptor {
        name: "kind",
        label: "Kind",
        hint: None,
        group: None,
        getter: prop_kind,
    },
    PropertyDescriptor {
        name: "file_path",
        label: "File path",
        hint: Some("path"),
        group: None,
        getter: prop_file_path,
    },
    PropertyDescriptor {
        name: "public",
        label: "Public",
        hint: None,
        group: None,
        getter: prop_public,
    },
    PropertyDescriptor {
        name: "doc",
        label: "Doc",
        hint: Some("doc"),
        group: None,
        getter: prop_doc,
    },
    PropertyDescriptor {
        name: "supertypes",
        label: "Supertypes",
        hint: Some("list"),
        group: None,
        getter: prop_supertypes,
    },
    PropertyDescriptor {
        name: "relationships",
        label: "Relationships",
        hint: Some("list"),
        group: None,
        getter: prop_relationships,
    },
    PropertyDescriptor {
        name: "type_refs",
        label: "Type refs",
        hint: Some("list"),
        group: None,
        getter: prop_type_refs,
    },
];

const PARSE_PROPERTY_DESCRIPTORS: &[PropertyDescriptor] = &[
    PropertyDescriptor {
        name: "file_id",
        label: "File id",
        hint: None,
        group: Some("parse"),
        getter: prop_file_id,
    },
    PropertyDescriptor {
        name: "start_line",
        label: "Start line",
        hint: None,
        group: Some("parse"),
        getter: prop_start_line,
    },
    PropertyDescriptor {
        name: "start_col",
        label: "Start column",
        hint: None,
        group: Some("parse"),
        getter: prop_start_col,
    },
    PropertyDescriptor {
        name: "end_line",
        label: "End line",
        hint: None,
        group: Some("parse"),
        getter: prop_end_line,
    },
    PropertyDescriptor {
        name: "end_col",
        label: "End column",
        hint: None,
        group: Some("parse"),
        getter: prop_end_col,
    },
];

fn property_descriptors_for_kind(kind_label: &str) -> Vec<&'static PropertyDescriptor> {
    let mut descriptors: Vec<&'static PropertyDescriptor> = Vec::new();
    descriptors.extend(BASE_PROPERTY_DESCRIPTORS);
    descriptors.extend(PARSE_PROPERTY_DESCRIPTORS);
    let _kind = kind_label.to_lowercase();
    descriptors
}

fn build_properties(
    symbol: &HirSymbol,
    file_path: &Path,
    kind_label: &str,
) -> Vec<PropertyItemView> {
    property_descriptors_for_kind(kind_label)
        .into_iter()
        .map(|descriptor| PropertyItemView {
            name: descriptor.name.to_string(),
            label: descriptor.label.to_string(),
            value: (descriptor.getter)(symbol, file_path),
            hint: descriptor.hint.map(|hint| hint.to_string()),
            group: descriptor.group.map(|group| group.to_string()),
        })
        .collect()
}

fn prop_name(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Text {
        value: symbol.name.as_ref().to_string(),
    }
}

fn prop_short_name(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Text {
        value: symbol
            .short_name
            .as_ref()
            .map(|s| s.to_string())
            .unwrap_or_default(),
    }
}

fn prop_qualified_name(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Text {
        value: symbol.qualified_name.as_ref().to_string(),
    }
}

fn prop_kind(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Text {
        value: symbol_kind_label(symbol.kind),
    }
}

fn prop_file_path(_symbol: &HirSymbol, file_path: &Path) -> PropertyValueView {
    PropertyValueView::Text {
        value: file_path.to_string_lossy().to_string(),
    }
}

fn prop_public(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Bool {
        value: symbol.is_public,
    }
}

fn prop_doc(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Text {
        value: symbol.doc.as_ref().map(|s| s.to_string()).unwrap_or_default(),
    }
}

fn prop_supertypes(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::List {
        items: symbol.supertypes.iter().map(|s| s.to_string()).collect(),
    }
}

fn prop_relationships(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    let items = symbol
        .relationships
        .iter()
        .map(|rel| {
            let target = rel
                .resolved_target
                .as_ref()
                .unwrap_or(&rel.target)
                .as_ref()
                .to_string();
            format!("{} -> {}", rel.kind.display(), target)
        })
        .collect::<Vec<_>>();
    PropertyValueView::List { items }
}

fn prop_type_refs(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    let items = symbol
        .type_refs
        .iter()
        .filter_map(type_ref_display_target)
        .collect::<Vec<_>>();
    PropertyValueView::List { items }
}

fn prop_file_id(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    let file_id: u32 = symbol.file.into();
    PropertyValueView::Number {
        value: file_id as u64,
    }
}

fn prop_start_line(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Number {
        value: symbol.start_line as u64 + 1,
    }
}

fn prop_start_col(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Number {
        value: symbol.start_col as u64 + 1,
    }
}

fn prop_end_line(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Number {
        value: symbol.end_line as u64 + 1,
    }
}

fn prop_end_col(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Number {
        value: symbol.end_col as u64 + 1,
    }
}

fn type_ref_display_target(type_ref: &TypeRefKind) -> Option<String> {
    match type_ref {
        TypeRefKind::Simple(part) => Some(
            part.resolved_target
                .as_ref()
                .unwrap_or(&part.target)
                .as_ref()
                .to_string(),
        ),
        TypeRefKind::Chain(chain) => chain.parts.last().map(|part| {
            part.resolved_target
                .as_ref()
                .unwrap_or(&part.target)
                .as_ref()
                .to_string()
        }),
    }
}

fn symbol_kind_label(kind: SymbolKind) -> String {
    kind.display().to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let paths = ensure_mercurio_paths().unwrap_or_else(|err| {
        eprintln!("mercurio: failed to initialize user data dir: {}", err);
        let fallback_root = env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(".mercurio");
        let stdlib_root = fallback_root.join("stdlib");
        let _ = fs::create_dir_all(&stdlib_root);
        let settings_path = fallback_root.join("settings.json");
        MercurioPaths {
            stdlib_root,
            settings_path,
        }
    });
    let settings = load_app_settings(&paths.settings_path);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            watcher: Arc::new(Mutex::new(None)),
            stdlib_cache: Arc::new(Mutex::new(None)),
            canceled_compiles: Arc::new(Mutex::new(HashSet::new())),
            analysis_host: Arc::new(Mutex::new(AnalysisHost::new())),
            workspace: Arc::new(Mutex::new(WorkspaceState::default())),
            stdlib_root: paths.stdlib_root.clone(),
            settings_path: paths.settings_path.clone(),
            settings: Arc::new(Mutex::new(settings)),
        })
        .setup(|app| {
            let state = app.state::<AppState>();
            if let Ok(mut settings) = state.settings.lock() {
                let handle = app.handle();
                if let Err(err) = ensure_packaged_stdlibs(
                    &handle,
                    &state.stdlib_root,
                    &state.settings_path,
                    &mut settings,
                ) {
                    eprintln!("mercurio: stdlib extraction failed: {}", err);
                }
            }
            Ok(())
        })
        .menu(|app| {
            let open_folder = MenuItemBuilder::with_id("file.open_folder", "Open Folder...")
                .accelerator("Ctrl+Shift+O")
                .build(app)?;
            let open_file = MenuItemBuilder::with_id("file.open_file", "Open File...")
                .accelerator("Ctrl+O")
                .build(app)?;
            let export_model = MenuItemBuilder::with_id("file.export_model", "Export Model...")
                .build(app)?;
            let compile = MenuItemBuilder::with_id("build.compile", "Compile Workspace")
                .accelerator("Ctrl+Shift+B")
                .build(app)?;
            let toggle_project = MenuItemBuilder::with_id("view.toggle_project", "Toggle Project")
                .accelerator("Ctrl+Shift+P")
                .build(app)?;
            let about = MenuItemBuilder::with_id("help.about", "About").build(app)?;

            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&open_folder)
                .item(&open_file)
                .separator()
                .item(&export_model)
                .separator()
                .item(&PredefinedMenuItem::close_window(app, None)?)
                .build()?;
            let build_menu = SubmenuBuilder::new(app, "Build")
                .item(&compile)
                .build()?;
            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&toggle_project)
                .separator()
                .item(&PredefinedMenuItem::fullscreen(app, None)?)
                .build()?;
            let help_menu = SubmenuBuilder::new(app, "Help")
                .item(&about)
                .build()?;

            MenuBuilder::new(app)
                .item(&file_menu)
                .item(&build_menu)
                .item(&view_menu)
                .item(&help_menu)
                .build()
        })
        .on_menu_event(|app, event| {
            let action = match event.id().as_ref() {
                "file.open_folder" => Some("open-folder"),
                "file.open_file" => Some("open-file"),
                "file.export_model" => Some("export-model"),
                "build.compile" => Some("compile-workspace"),
                "view.toggle_project" => Some("toggle-project"),
                "help.about" => Some("about"),
                _ => None,
            };
            if let Some(action) = action {
                let _ = app.emit_to(EventTarget::webview_window("main"), "menu-action", action);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_default_root,
            get_startup_path,
            list_stdlib_versions,
            get_default_stdlib,
            set_default_stdlib,
            list_dir,
            read_file,
            path_exists,
            write_file,
            create_file,
            create_dir,
            create_package,
            rename_path,
            delete_path,
            set_watch_root,
            open_in_explorer,
            get_parse_errors,
            get_parse_errors_for_content,
            get_project_descriptor,
            create_project_descriptor,
            window_minimize,
            window_toggle_maximize,
            window_close,
            compile_workspace,
            cancel_compile,
            export_compiled_model,
            ai_test_endpoint,
            ai_chat_completion
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
