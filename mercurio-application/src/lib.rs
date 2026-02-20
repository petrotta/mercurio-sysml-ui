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
    get_project_element_attributes, get_project_model, query_semantic, query_semantic_symbols,
    get_default_stdlib, get_stdlib_metamodel,
    git_checkout_branch, git_commit, git_create_branch, git_list_branches, git_push, git_stage_paths,
    git_status, git_unstage_paths, list_dir, list_stdlib_versions, open_in_explorer, path_exists,
    read_diagram, read_file, rename_path, window_close, window_minimize, window_toggle_maximize,
    call_tool, list_tools,
    write_diagram, write_file, set_default_stdlib,
};


use mercurio_core::{
    cancel_compile as core_cancel_compile,
    compile_project_delta_sync as core_compile_project_delta_sync,
    compile_workspace_sync as core_compile_workspace_sync,
    create_project_descriptor as core_create_project_descriptor,
    ensure_mercurio_paths,
    ensure_project_descriptor as core_ensure_project_descriptor,
    export_model_to_path as core_export_model_to_path,
    get_ast_for_content as core_get_ast_for_content,
    get_ast_for_path as core_get_ast_for_path,
    get_parse_tree_for_content as core_get_parse_tree_for_content,
    get_parse_errors_for_content as core_get_parse_errors_for_content,
    get_project_descriptor_view,
    update_project_descriptor as core_update_project_descriptor,
    query_library_symbols as core_query_library_symbols,
    query_library_summary as core_query_library_summary,
    query_project_symbols as core_query_project_symbols,
    query_symbol_metatype_mapping as core_query_symbol_metatype_mapping,
    query_stdlib_documentation_symbols as core_query_stdlib_documentation_symbols,
    query_symbols_by_metatype as core_query_symbols_by_metatype,
    list_stdlib_versions_from_root,
    load_app_settings,
    save_app_settings,
    AppSettings,
    CompileRequest,
    CompileResponse,
    CoreState,
    IndexedSymbolView,
    LibraryIndexSummaryView,
    LibrarySymbolsRequest,
    LibrarySymbolsResponse,
    SymbolMetatypeMappingView,
    LibraryConfig,
    MercurioPaths,
    ParseErrorsPayload,
    ParseTreeNodeView,
    ProjectDescriptorUpdate,
    ProjectDescriptorView,
    load_library_symbols_sync as core_load_library_symbols_sync,
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
fn get_parse_tree_for_content(path: String, content: String) -> Result<Vec<ParseTreeNodeView>, String> {
    let file_path = PathBuf::from(&path);
    core_get_parse_tree_for_content(&file_path, &content)
}

#[tauri::command]
async fn compile_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    payload: CompileRequest,
) -> Result<CompileResponse, String> {
    let (root, run_id, allow_parse_errors, target_path, unsaved) = payload.into_parts();
    let core = state.core.clone();
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        core_compile_workspace_sync(
            &core,
            root,
            run_id,
            allow_parse_errors,
            target_path,
            unsaved,
            |progress| {
                let _ = app_handle.emit_to(
                    EventTarget::webview_window("main"),
                    "compile-progress",
                    progress,
                );
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

fn collect_model_files_recursive(root: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let read_dir = fs::read_dir(root).map_err(|e| e.to_string())?;
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_model_files_recursive(&path, out)?;
            continue;
        }
        let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
            continue;
        };
        if ext.eq_ignore_ascii_case("sysml") || ext.eq_ignore_ascii_case("kerml") {
            out.push(path);
        }
    }
    Ok(())
}

#[tauri::command]
fn eval_expression(root: String, expression: String) -> Result<String, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }
    let mut files = Vec::<PathBuf>::new();
    collect_model_files_recursive(&root_path, &mut files)?;
    files.sort();
    files.dedup();
    let mut sources = Vec::<String>::new();
    for file in files {
        if let Ok(text) = fs::read_to_string(&file) {
            sources.push(text);
        }
    }
    if sources.is_empty() {
        return Err("No model files found under root".to_string());
    }
    mercurio_sysml::expression_eval::eval_expression_in_sources(&sources, &expression)
}

#[tauri::command]
async fn compile_project_delta(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    payload: CompileRequest,
) -> Result<CompileResponse, String> {
    let (root, run_id, allow_parse_errors, target_path, unsaved) = payload.into_parts();
    let core = state.core.clone();
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        core_compile_project_delta_sync(
            &core,
            root,
            run_id,
            allow_parse_errors,
            target_path,
            unsaved,
            |progress| {
                let _ = app_handle.emit_to(
                    EventTarget::webview_window("main"),
                    "compile-progress",
                    progress,
                );
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn load_library_symbols(
    state: tauri::State<'_, AppState>,
    payload: LibrarySymbolsRequest,
) -> Result<LibrarySymbolsResponse, String> {
    let (root, target_path, include_symbols) = payload.into_parts();
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || {
        core_load_library_symbols_sync(&core, root, target_path, include_symbols)
    })
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn query_index_symbols_by_metatype(
    state: tauri::State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<Vec<IndexedSymbolView>, String> {
    let root = payload
        .get("root")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Missing required 'root' argument".to_string())?
        .to_string();
    let metatype_qname = payload
        .get("metatype_qname")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Missing required 'metatype_qname' argument".to_string())?
        .to_string();
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || {
        core_query_symbols_by_metatype(&core, root, metatype_qname)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn query_index_stdlib_documentation_symbols(
    state: tauri::State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<Vec<IndexedSymbolView>, String> {
    let library_key = payload
        .get("library_key")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Missing required 'library_key' argument".to_string())?
        .to_string();
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || {
        core_query_stdlib_documentation_symbols(&core, library_key)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn query_index_library_symbols(
    state: tauri::State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<Vec<IndexedSymbolView>, String> {
    let root = payload
        .get("root")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Missing required 'root' argument".to_string())?
        .to_string();
    let file = payload
        .get("file")
        .or_else(|| payload.get("path"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let offset = payload
        .get("offset")
        .or_else(|| payload.get("skip"))
        .and_then(|value| value.as_u64())
        .map(|value| value as usize);
    let limit = payload
        .get("limit")
        .or_else(|| payload.get("take"))
        .and_then(|value| value.as_u64())
        .map(|value| value as usize);
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || {
        core_query_library_symbols(&core, root, file, offset, limit)
    })
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn query_index_project_symbols(
    state: tauri::State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<Vec<IndexedSymbolView>, String> {
    let root = payload
        .get("root")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Missing required 'root' argument".to_string())?
        .to_string();
    let file = payload
        .get("file")
        .or_else(|| payload.get("path"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let offset = payload
        .get("offset")
        .or_else(|| payload.get("skip"))
        .and_then(|value| value.as_u64())
        .map(|value| value as usize);
    let limit = payload
        .get("limit")
        .or_else(|| payload.get("take"))
        .and_then(|value| value.as_u64())
        .map(|value| value as usize);
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || {
        core_query_project_symbols(&core, root, file, offset, limit)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn query_index_library_summary(
    state: tauri::State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<LibraryIndexSummaryView, String> {
    let root = payload
        .get("root")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Missing required 'root' argument".to_string())?
        .to_string();
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || core_query_library_summary(&core, root))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn query_index_symbol_metatype_mapping(
    state: tauri::State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<Option<SymbolMetatypeMappingView>, String> {
    let root = payload
        .get("root")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Missing required 'root' argument".to_string())?
        .to_string();
    let symbol_qualified_name = payload
        .get("symbol_qualified_name")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Missing required 'symbol_qualified_name' argument".to_string())?
        .to_string();
    let file_path = payload
        .get("file_path")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || {
        core_query_symbol_metatype_mapping(&core, root, symbol_qualified_name, file_path)
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
    core_create_project_descriptor(
        &root_path,
        payload.name,
        payload.author,
        payload.description,
        payload.organization,
        payload.use_default_library,
    )
}

#[tauri::command]
fn ensure_project_descriptor(root: String) -> Result<ProjectDescriptorView, String> {
    let root_path = PathBuf::from(root);
    core_ensure_project_descriptor(&root_path)
}

#[tauri::command]
fn update_project_descriptor(
    state: tauri::State<'_, AppState>,
    payload: UpdateProjectDescriptorPayload,
) -> Result<ProjectDescriptorView, String> {
    let root_path = PathBuf::from(&payload.root);
    let update = ProjectDescriptorUpdate {
        name: payload.name,
        author: payload.author,
        description: payload.description,
        organization: payload.organization,
        src: payload.src,
        import_entries: payload.import_entries,
        stdlib: payload.stdlib,
        library: payload.library,
    };
    core_update_project_descriptor(&root_path, &state.core.stdlib_root, update)
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
            let toggle_terminal = MenuItemBuilder::with_id("view.toggle_terminal", "View Terminal")
                .accelerator("Ctrl+`")
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
                .item(&toggle_terminal)
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
                "view.toggle_terminal" => Some("toggle-terminal"),
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
            get_default_stdlib,
            set_default_stdlib,
            get_stdlib_metamodel,
            get_project_model,
            get_project_element_attributes,
            query_semantic,
            query_semantic_symbols,
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
            get_parse_tree_for_content,
            eval_expression,
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
            compile_project_delta,
            load_library_symbols,
            query_index_symbols_by_metatype,
            query_index_stdlib_documentation_symbols,
            query_index_library_symbols,
            query_index_project_symbols,
            query_index_library_summary,
            query_index_symbol_metatype_mapping,
            cancel_compile,
            export_compiled_model,
            ai_test_endpoint,
            ai_agent_run,
            list_tools,
            call_tool,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


