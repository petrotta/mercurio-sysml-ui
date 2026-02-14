use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::fs;
use std::fs::File;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::env;
use std::sync::{Arc, Mutex};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::path::BaseDirectory;
use tauri::{Emitter, EventTarget, Manager};
use zip::ZipArchive;

mod commands;
mod agent;

// Re-exported Tauri commands from focused modules.
use commands::{
    ai_agent_run, ai_test_endpoint, create_dir, create_file, detect_git_repo, get_user_projects_root,
    get_project_element_attributes, get_project_model, query_semantic,
    get_stdlib_metamodel,
    git_checkout_branch, git_commit, git_create_branch, git_list_branches, git_push, git_stage_paths,
    git_status, git_unstage_paths, list_dir, list_stdlib_versions, open_in_explorer, path_exists,
    read_diagram, read_file, rename_path, window_close, window_minimize, window_toggle_maximize,
    write_diagram, write_file,
};


use mercurio_core::{
    cancel_compile as core_cancel_compile,
    compile_workspace_sync as core_compile_workspace_sync,
    ensure_mercurio_paths,
    export_model_to_path as core_export_model_to_path,
    get_ast_for_content as core_get_ast_for_content,
    get_ast_for_path as core_get_ast_for_path,
    get_parse_errors_for_content as core_get_parse_errors_for_content,
    get_project_descriptor_view,
    list_stdlib_versions_from_root,
    load_app_settings,
    save_app_settings,
    AppSettings,
    CompileResponse,
    CoreState,
    LibraryConfig,
    MercurioPaths,
    ParseErrorsPayload,
    ProjectConfig,
    ProjectDescriptor,
    ProjectDescriptorView,
    UnsavedFile,
    load_project_descriptor,
};

#[derive(Serialize)]
pub(crate) struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
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

#[derive(Deserialize)]
struct UpdateProjectDescriptorPayload {
    root: String,
    name: Option<String>,
    author: Option<String>,
    description: Option<String>,
    organization: Option<String>,
    src: Option<Vec<String>>,
    #[serde(rename = "import", alias = "import_entries")]
    import_entries: Option<Vec<String>>,
    stdlib: Option<String>,
    library: Option<LibraryConfig>,
}

#[derive(Serialize, Clone)]
struct FsEventPayload {
    path: String,
    kind: String,
}

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
    pub(crate) core: CoreState,
    pub(crate) settings_path: PathBuf,
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

fn is_path_under_root(root: &Path, path: &Path) -> bool {
    let mut root_iter = root.components();
    let mut path_iter = path.components();
    loop {
        match (root_iter.next(), path_iter.next()) {
            (None, _) => return true,
            (Some(root_comp), Some(path_comp)) => {
                if root_comp != path_comp {
                    return false;
                }
            }
            (Some(_), None) => return false,
        }
    }
}

fn resolve_under_root(root: &Path, target: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let joined = if target.is_absolute() {
        target.to_path_buf()
    } else {
        root.join(target)
    };
    let normalized = normalize_path(&joined);
    let canonical = normalized.canonicalize().unwrap_or(normalized);
    if !is_path_under_root(&root, &canonical) {
        return Err("Path escapes root".to_string());
    }
    Ok(canonical)
}

fn build_default_descriptor(name: Option<String>) -> ProjectDescriptor {
    ProjectDescriptor {
        name,
        author: None,
        description: None,
        organization: None,
        config: ProjectConfig {
            library: None,
            stdlib: Some("default".to_string()),
            src: Some(vec!["**/*.sysml".to_string(), "**/*.kerml".to_string()]),
            import_entries: Some(vec!["**/*.sysmlx".to_string(), "**/*.kermlx".to_string()]),
        },
    }
}

fn write_project_descriptor(root: &Path, descriptor: &ProjectDescriptor) -> Result<ProjectDescriptorView, String> {
    let content = serde_json::to_string_pretty(descriptor).map_err(|e| e.to_string())?;
    let config_path = root.join(".project");
    fs::write(config_path, &content).map_err(|e| e.to_string())?;
    get_project_descriptor_view(root)?
        .ok_or_else(|| "Failed to load project descriptor".to_string())
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
fn get_parse_errors_for_content(path: String, content: String) -> Result<ParseErrorsPayload, String> {
    let file_path = PathBuf::from(&path);
    core_get_parse_errors_for_content(&file_path, &content)
}

#[tauri::command]
fn get_ast_for_path(path: String) -> Result<String, String> {
    let file_path = PathBuf::from(&path);
    core_get_ast_for_path(&file_path)
}

#[tauri::command]
fn get_ast_for_content(path: String, content: String) -> Result<String, String> {
    let file_path = PathBuf::from(&path);
    core_get_ast_for_content(&file_path, &content)
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
    let core = state.core.clone();
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        core_compile_workspace_sync(&core, root, run_id, allow_parse_errors, unsaved, |progress| {
            let _ = app_handle.emit_to(
                EventTarget::webview_window("main"),
                "compile-progress",
                progress,
            );
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_compile(state: tauri::State<'_, AppState>, run_id: u64) -> Result<(), String> {
    core_cancel_compile(&state.core, run_id)
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
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || {
        core_export_model_to_path(&core, root, output, format, include_stdlib)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_project_descriptor(root: String) -> Result<Option<ProjectDescriptorView>, String> {
    let root_path = PathBuf::from(root);
    get_project_descriptor_view(&root_path)
}

#[tauri::command]
fn create_project_descriptor(payload: CreateProjectDescriptorPayload) -> Result<ProjectDescriptorView, String> {
    let root_path = PathBuf::from(payload.root);
    if root_path.exists() {
        return Err("Project folder already exists".to_string());
    }
    fs::create_dir_all(&root_path).map_err(|e| e.to_string())?;
    let config = ProjectConfig {
        library: None,
        stdlib: if payload.use_default_library {
            Some("default".to_string())
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
    write_project_descriptor(&root_path, &descriptor)
}

#[tauri::command]
fn ensure_project_descriptor(root: String) -> Result<ProjectDescriptorView, String> {
    let root_path = PathBuf::from(root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }

    let config_path = root_path.join(".project");
    if config_path.exists() {
        return get_project_descriptor_view(&root_path)?
            .ok_or_else(|| "Failed to load project descriptor".to_string());
    }

    if let Some(legacy) = load_project_descriptor(&root_path)? {
        write_project_descriptor(&root_path, &legacy)
    } else {
        let name = root_path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|value| value.to_string());
        let descriptor = build_default_descriptor(name);
        write_project_descriptor(&root_path, &descriptor)
    }
}

#[tauri::command]
fn update_project_descriptor(
    state: tauri::State<'_, AppState>,
    payload: UpdateProjectDescriptorPayload,
) -> Result<ProjectDescriptorView, String> {
    let root_path = PathBuf::from(&payload.root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }

    if let Some(stdlib_id) = payload.stdlib.as_ref() {
        let trimmed = stdlib_id.trim();
        if !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("default") {
            let candidate = state.core.stdlib_root.join(trimmed);
            if !candidate.exists() || !candidate.is_dir() {
                return Err("Stdlib version not found".to_string());
            }
        }
    }

    let descriptor = ProjectDescriptor {
        name: payload.name,
        author: payload.author,
        description: payload.description,
        organization: payload.organization,
        config: ProjectConfig {
            library: payload.library,
            stdlib: payload.stdlib,
            src: payload.src,
            import_entries: payload.import_entries,
        },
    };
    write_project_descriptor(&root_path, &descriptor)
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
    let core = CoreState::new(paths.stdlib_root.clone(), settings);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            watcher: Arc::new(Mutex::new(None)),
            core,
            settings_path: paths.settings_path.clone(),
        })
        .setup(|app| {
            let state = app.state::<AppState>();
            if let Ok(mut settings) = state.core.settings.lock() {
                let handle = app.handle();
                if let Err(err) = ensure_packaged_stdlibs(
                    &handle,
                    &state.core.stdlib_root,
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
            let project_properties = MenuItemBuilder::with_id("file.project_properties", "Project Properties...")
                .build(app)?;
            let compile = MenuItemBuilder::with_id("build.compile", "Build")
                .accelerator("Ctrl+B")
                .build(app)?;
            let build_options = MenuItemBuilder::with_id("build.options", "Show Build Options")
                .accelerator("Ctrl+Shift+B")
                .build(app)?;
            let toggle_project = MenuItemBuilder::with_id("view.toggle_project", "Toggle Project")
                .accelerator("Ctrl+Shift+P")
                .build(app)?;
            let about = MenuItemBuilder::with_id("help.about", "About").build(app)?;

            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&open_folder)
                .item(&open_file)
                .item(&project_properties)
                .separator()
                .item(&PredefinedMenuItem::close_window(app, None)?)
                .build()?;
            let build_menu = SubmenuBuilder::new(app, "Build")
                .item(&compile)
                .item(&build_options)
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
                "file.project_properties" => Some("project-properties"),
                "build.compile" => Some("compile-workspace"),
                "build.options" => Some("build-options"),
                "view.toggle_project" => Some("toggle-project"),
                "help.about" => Some("about"),
                _ => None,
            };
            if let Some(action) = action {
                let _ = app.emit_to(EventTarget::webview_window("main"), "menu-action", action);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_user_projects_root,
            list_stdlib_versions,
            get_stdlib_metamodel,
            get_project_model,
            get_project_element_attributes,
            query_semantic,
            list_dir,
            read_file,
            path_exists,
            write_file,
            read_diagram,
            write_diagram,
            create_file,
            create_dir,
            rename_path,
            set_watch_root,
            open_in_explorer,
            get_parse_errors_for_content,
            get_ast_for_path,
            get_ast_for_content,
            get_project_descriptor,
            create_project_descriptor,
            ensure_project_descriptor,
            update_project_descriptor,
            detect_git_repo,
            git_commit,
            git_create_branch,
            git_checkout_branch,
            git_list_branches,
            git_push,
            git_stage_paths,
            git_status,
            git_unstage_paths,
            window_minimize,
            window_toggle_maximize,
            window_close,
            compile_workspace,
            cancel_compile,
            export_compiled_model,
            ai_test_endpoint,
            ai_agent_run
            ,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


