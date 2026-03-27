use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::fs::File;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::path::BaseDirectory;
use tauri::{
    Emitter, EventTarget, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow,
    Window, WindowEvent,
};
use zip::ZipArchive;

mod agent;
mod commands;
mod logging;

use commands::ai::AgentSessionState;
use commands::{
    ai_agent_run, ai_test_endpoint, app_exit, apply_semantic_edit, call_tool, create_file, create_project,
    detect_git_repo, get_user_projects_root, git_commit, git_push, git_stage_paths, git_status,
    git_unstage_paths, list_dir, list_semantic_edit_actions, preview_semantic_edit, list_tools,
    read_file, show_in_explorer, window_close, window_minimize, window_toggle_maximize, write_file,
};
use logging::{get_logs, log_event, log_frontend, set_app_handle};

use mercurio_core::{
    cancel_compile as core_cancel_compile,
    compile_project_delta_sync_with_options as core_compile_project_delta_sync_with_options,
    ensure_mercurio_paths, ensure_project_descriptor, list_stdlib_versions_from_root,
    load_app_settings, load_project_descriptor, save_app_settings, write_project_descriptor,
    AppSettings, BackgroundCancelSummary, BackgroundJobsSnapshot, CacheClearSummary,
    CompileRequest, CompileResponse, CoreState, LibraryConfig, MercurioPaths, WindowBoundsSettings,
    WindowStateSettings,
};

pub(crate) struct AppState {
    pub(crate) core: CoreState,
    pub(crate) settings_path: PathBuf,
    pub(crate) project_file_watchers: Mutex<HashMap<String, ActiveProjectFileWatcher>>,
    pub(crate) agent_sessions: Mutex<HashMap<String, AgentSessionState>>,
}

const MIN_MAIN_WINDOW_WIDTH: u32 = 960;
const MIN_MAIN_WINDOW_HEIGHT: u32 = 640;
const WINDOWS_MINIMIZED_COORDINATE: i32 = -32000;

#[derive(Serialize)]
pub(crate) struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
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

#[derive(Clone, Serialize)]
struct ProjectFilesChangedPayload {
    root: String,
    path: String,
    kind: String,
}

struct ActiveProjectFileWatcher {
    _watcher: RecommendedWatcher,
}

fn normalize_watcher_display_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("\\\\?\\UNC\\") {
        return format!("\\\\{}", rest);
    }
    if let Some(rest) = path.strip_prefix("\\\\?\\") {
        return rest.to_string();
    }
    path.to_string()
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
async fn compile_project_delta(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    payload: CompileRequest,
) -> Result<CompileResponse, String> {
    let (root, run_id, allow_parse_errors, include_symbols, target_path, unsaved) =
        payload.into_parts();
    let root_for_log = root.clone();
    let target_for_log = target_path
        .as_ref()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "<project>".to_string());
    let unsaved_count = unsaved.len();
    log_event(
        "INFO",
        "compile",
        format!(
            "start run_id={} root={} target={} include_symbols={} unsaved={}",
            run_id, root_for_log, target_for_log, include_symbols, unsaved_count
        ),
    );
    let core = state.core.clone();
    let app_handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        core_compile_project_delta_sync_with_options(
            &core,
            root,
            run_id,
            allow_parse_errors,
            target_path,
            unsaved,
            include_symbols,
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
    .map_err(|e| e.to_string())?;
    match &result {
        Ok(response) => {
            log_event(
                "INFO",
                "compile",
                format!(
                    "done run_id={} ok={} parse_failed={} parsed_files={} unresolved={} total_ms={} parse_ms={} analysis_ms={} stdlib_ms={}",
                    run_id,
                    response.ok,
                    response.parse_failed,
                    response.parsed_files.len(),
                    response.unresolved.len(),
                    response.total_duration_ms,
                    response.parse_duration_ms,
                    response.analysis_duration_ms,
                    response.stdlib_duration_ms,
                ),
            );
        }
        Err(error) => {
            log_event(
                "ERROR",
                "compile",
                format!("error run_id={} error={}", run_id, error),
            );
        }
    }
    result
}

#[tauri::command]
fn cancel_compile(state: tauri::State<'_, AppState>, run_id: u64) -> Result<(), String> {
    log_event(
        "WARN",
        "compile",
        format!("cancel requested run_id={}", run_id),
    );
    core_cancel_compile(&state.core, run_id)
}

#[tauri::command]
fn get_background_jobs(
    state: tauri::State<'_, AppState>,
) -> Result<BackgroundJobsSnapshot, String> {
    state.core.background_jobs_snapshot()
}

#[tauri::command]
fn cancel_background_jobs(
    state: tauri::State<'_, AppState>,
) -> Result<BackgroundCancelSummary, String> {
    let summary = state.core.cancel_background_jobs()?;
    log_event(
        "WARN",
        "jobs",
        format!(
            "cancel requested active={} cancelable={} compile_cancel_requests={}",
            summary.active_jobs, summary.cancelable_jobs, summary.compile_cancel_requests
        ),
    );
    Ok(summary)
}

#[tauri::command]
fn clear_all_caches(state: tauri::State<'_, AppState>) -> Result<CacheClearSummary, String> {
    let summary = state.core.clear_runtime_caches()?;
    log_event(
        "INFO",
        "cache",
        format!(
            "cleared workspace_snapshot={} semantic_lookup={} parsed_files={} mtimes={} canceled={} pending_persists={} workspace_ir_deleted={} symbol_index_cleared={}",
            summary.workspace_snapshot_entries,
            summary.project_semantic_lookup_entries,
            summary.parsed_file_entries,
            summary.file_mtime_entries,
            summary.canceled_compile_entries,
            summary.pending_workspace_ir_persists,
            summary.workspace_ir_cache_files_deleted,
            summary.symbol_index_cleared,
        ),
    );
    Ok(summary)
}

#[tauri::command]
fn start_project_file_watcher(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    root: String,
) -> Result<bool, String> {
    let root_path = PathBuf::from(root.trim());
    if root_path.as_os_str().is_empty() {
        return Err("Project root is required".to_string());
    }
    if !root_path.exists() || !root_path.is_dir() {
        return Err(format!(
            "Project root does not exist or is not a directory: {}",
            root_path.display()
        ));
    }
    let canonical_root = root_path
        .canonicalize()
        .map_err(|error| format!("Failed to canonicalize project root: {}", error))?;
    let root_key = normalize_watcher_display_path(&canonical_root.to_string_lossy());
    let mut watchers = state
        .project_file_watchers
        .lock()
        .map_err(|error| format!("Failed to access watcher registry: {}", error))?;
    if watchers.contains_key(&root_key) {
        log_event(
            "INFO",
            "watcher",
            format!("already watching root={}", root_key),
        );
        return Ok(false);
    }

    let root_key_for_event = root_key.clone();
    let root_path_for_watch = canonical_root.clone();
    let app_for_emit = app.clone();
    let watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        let Ok(event) = result else {
            log_event(
                "WARN",
                "watcher",
                format!("watch event error root={}", root_key_for_event),
            );
            return;
        };
        let kind = format!("{:?}", event.kind);
        for path in event.paths {
            let normalized_path = normalize_watcher_display_path(&path.to_string_lossy());
            log_event(
                "INFO",
                "watcher",
                format!(
                    "event root={} kind={} path={}",
                    root_key_for_event, kind, normalized_path
                ),
            );
            let _ = app_for_emit.emit_to(
                EventTarget::webview_window("main"),
                "project-files-changed",
                ProjectFilesChangedPayload {
                    root: root_key_for_event.clone(),
                    path: normalized_path,
                    kind: kind.to_string(),
                },
            );
        }
    })
    .map_err(|error| error.to_string())?;

    let mut watcher = watcher;
    watcher
        .watch(&root_path_for_watch, RecursiveMode::Recursive)
        .map_err(|error| error.to_string())?;
    watchers.insert(
        root_key.clone(),
        ActiveProjectFileWatcher { _watcher: watcher },
    );
    log_event(
        "INFO",
        "watcher",
        format!(
            "started root_input={} canonical_root={} watch_path={}",
            root.trim(),
            root_key,
            root_path_for_watch.display()
        ),
    );
    Ok(true)
}

#[tauri::command]
fn stop_project_file_watcher(
    state: tauri::State<'_, AppState>,
    root: String,
) -> Result<bool, String> {
    let root_path = PathBuf::from(root.trim());
    if root_path.as_os_str().is_empty() {
        return Err("Project root is required".to_string());
    }
    let canonical_root = root_path
        .canonicalize()
        .map_err(|error| format!("Failed to canonicalize project root: {}", error))?;
    let root_key = normalize_watcher_display_path(&canonical_root.to_string_lossy());
    let mut watchers = state
        .project_file_watchers
        .lock()
        .map_err(|error| format!("Failed to access watcher registry: {}", error))?;
    let removed = watchers.remove(&root_key).is_some();
    log_event(
        "INFO",
        "watcher",
        format!("stopped root={} removed={}", root_key, removed),
    );
    Ok(removed)
}

#[tauri::command]
fn set_project_stdlib_path(
    state: tauri::State<'_, AppState>,
    root: String,
    stdlib_path: String,
) -> Result<String, String> {
    let root_path = PathBuf::from(root.trim());
    if root_path.as_os_str().is_empty() {
        return Err("Project root is required".to_string());
    }
    if !root_path.exists() || !root_path.is_dir() {
        return Err(format!(
            "Project root does not exist or is not a directory: {}",
            root_path.display()
        ));
    }

    let mut selected_path = PathBuf::from(stdlib_path.trim());
    if selected_path.as_os_str().is_empty() {
        return Err("Stdlib path is required".to_string());
    }
    if !selected_path.exists() || !selected_path.is_dir() {
        return Err(format!(
            "Stdlib path does not exist or is not a directory: {}",
            selected_path.display()
        ));
    }
    if let Ok(canonical) = selected_path.canonicalize() {
        selected_path = canonical;
    }

    // Ensure descriptor exists so path updates are always persisted in project config.
    let _ = ensure_project_descriptor(&root_path)?;
    let mut descriptor = load_project_descriptor(&root_path)?
        .ok_or_else(|| "Failed to load project descriptor".to_string())?;
    descriptor.config.library = Some(LibraryConfig::Path {
        path: selected_path.to_string_lossy().to_string(),
    });
    descriptor.config.stdlib = None;
    let _ = write_project_descriptor(&root_path, &descriptor)?;

    let _ = state.core.clear_runtime_caches();

    Ok(selected_path.to_string_lossy().to_string())
}

fn remember_main_window_state(state: &AppState, window: &Window) -> Result<(), String> {
    if window.is_minimized().map_err(|e| e.to_string())? {
        return Ok(());
    }
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let maximized = window.is_maximized().map_err(|e| e.to_string())?;
    let bounds = WindowBoundsSettings {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    if !is_valid_main_window_bounds(&bounds) {
        return Ok(());
    }
    let mut settings = state
        .core
        .settings
        .lock()
        .map_err(|_| "Settings lock poisoned".to_string())?;
    settings.main_window = Some(WindowStateSettings {
        bounds: Some(bounds),
        maximized,
    });
    Ok(())
}

fn persist_main_window_state(state: &AppState, window: &Window) -> Result<(), String> {
    remember_main_window_state(state, window)?;
    let settings = state
        .core
        .settings
        .lock()
        .map_err(|_| "Settings lock poisoned".to_string())?
        .clone();
    save_app_settings(&state.settings_path, &settings)
}

fn is_valid_main_window_bounds(bounds: &WindowBoundsSettings) -> bool {
    bounds.width >= MIN_MAIN_WINDOW_WIDTH
        && bounds.height >= MIN_MAIN_WINDOW_HEIGHT
        && bounds.x > WINDOWS_MINIMIZED_COORDINATE
        && bounds.y > WINDOWS_MINIMIZED_COORDINATE
}

fn clear_main_window_state(state: &AppState) -> Result<(), String> {
    let settings = {
        let mut settings = state
            .core
            .settings
            .lock()
            .map_err(|_| "Settings lock poisoned".to_string())?;
        settings.main_window = None;
        settings.clone()
    };
    save_app_settings(&state.settings_path, &settings)
}

fn restore_main_window_state(state: &AppState, window: &WebviewWindow) -> Result<(), String> {
    let window_state = state
        .core
        .settings
        .lock()
        .map_err(|_| "Settings lock poisoned".to_string())?
        .main_window
        .clone();
    let Some(window_state) = window_state else {
        return Ok(());
    };
    if let Some(bounds) = window_state.bounds {
        if is_valid_main_window_bounds(&bounds) {
            window
                .set_size(Size::Physical(PhysicalSize::new(
                    bounds.width,
                    bounds.height,
                )))
                .map_err(|e| e.to_string())?;
            window
                .set_position(Position::Physical(PhysicalPosition::new(
                    bounds.x, bounds.y,
                )))
                .map_err(|e| e.to_string())?;
        } else {
            clear_main_window_state(state)?;
            log_event(
                "WARN",
                "window",
                format!(
                    "discarded invalid saved bounds x={} y={} width={} height={}",
                    bounds.x, bounds.y, bounds.width, bounds.height
                ),
            );
        }
    }
    if window_state.maximized {
        window.maximize().map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let paths = ensure_mercurio_paths().unwrap_or_else(|err| {
        log_event(
            "ERROR",
            "app",
            format!("failed to initialize user data dir: {}", err),
        );
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
            core,
            settings_path: paths.settings_path.clone(),
            project_file_watchers: Mutex::new(HashMap::new()),
            agent_sessions: Mutex::new(HashMap::new()),
        })
        .setup(move |app| {
            set_app_handle(app.handle().clone());
            log_event(
                "INFO",
                "app",
                format!(
                    "application starting stdlib_root={} settings_path={}",
                    paths.stdlib_root.display(),
                    paths.settings_path.display()
                ),
            );
            let state = app.state::<AppState>();
            if let Ok(mut settings) = state.core.settings.lock() {
                let handle = app.handle();
                if let Err(err) = ensure_packaged_stdlibs(
                    &handle,
                    &state.core.stdlib_root,
                    &state.settings_path,
                    &mut settings,
                ) {
                    log_event("ERROR", "stdlib", format!("extraction failed: {}", err));
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                if let Err(err) = restore_main_window_state(state.inner(), &window) {
                    log_event("ERROR", "window", format!("state restore failed: {}", err));
                }
                if let Err(err) = window.show() {
                    log_event(
                        "ERROR",
                        "window",
                        format!("failed to show main window: {}", err),
                    );
                }
            }
            log_event("INFO", "app", "startup complete".to_string());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            let state = window.app_handle().state::<AppState>();
            match event {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    let _ = remember_main_window_state(state.inner(), window);
                }
                WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
                    let _ = persist_main_window_state(state.inner(), window);
                }
                _ => {}
            }
        })
        .menu(|app| {
            let new_project = MenuItemBuilder::with_id("file.new_project", "New Project...")
                .accelerator("Ctrl+N")
                .build(app)?;
            let open_folder = MenuItemBuilder::with_id("file.open_folder", "Open Folder...")
                .accelerator("Ctrl+Shift+O")
                .build(app)?;
            let open_file = MenuItemBuilder::with_id("file.open_file", "Open File...")
                .accelerator("Ctrl+O")
                .build(app)?;
            let save = MenuItemBuilder::with_id("file.save", "Save")
                .accelerator("Ctrl+S")
                .build(app)?;
            let compile_project =
                MenuItemBuilder::with_id("build.compile_project", "Compile Project")
                    .accelerator("Ctrl+B")
                    .build(app)?;
            let compile_file =
                MenuItemBuilder::with_id("build.compile_file", "Compile Active File")
                    .accelerator("Ctrl+Shift+B")
                    .build(app)?;
            let clear_caches = MenuItemBuilder::with_id("build.clear_caches", "Clear Caches")
                .accelerator("Ctrl+Shift+K")
                .build(app)?;
            let show_logs = MenuItemBuilder::with_id("view.show_logs", "Show Logs")
                .accelerator("Ctrl+Alt+L")
                .build(app)?;
            let show_expressions =
                MenuItemBuilder::with_id("view.show_expressions", "Show Expressions")
                    .accelerator("Ctrl+Alt+E")
                    .build(app)?;
            let show_commit_manager =
                MenuItemBuilder::with_id("view.show_commit_manager", "Show Commit Manager")
                    .build(app)?;
            let select_stdlib_path =
                MenuItemBuilder::with_id("settings.select_stdlib_path", "Select Stdlib Path...")
                    .build(app)?;
            let toggle_theme = MenuItemBuilder::with_id("settings.theme_toggle", "Toggle Theme")
                .accelerator("Ctrl+Alt+T")
                .build(app)?;
            let light_theme =
                MenuItemBuilder::with_id("settings.theme_light", "Light Theme").build(app)?;
            let dark_theme =
                MenuItemBuilder::with_id("settings.theme_dark", "Dark Theme").build(app)?;
            let about = MenuItemBuilder::with_id("help.about", "About").build(app)?;
            let exit_app = MenuItemBuilder::with_id("file.exit", "Exit")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?;

            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&new_project)
                .separator()
                .item(&open_folder)
                .item(&open_file)
                .item(&save)
                .separator()
                .item(&exit_app)
                .build()?;
            let build_menu = SubmenuBuilder::new(app, "Build")
                .item(&compile_project)
                .item(&compile_file)
                .separator()
                .item(&clear_caches)
                .build()?;
            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&show_logs)
                .item(&show_expressions)
                .item(&show_commit_manager)
                .build()?;
            let settings_menu = SubmenuBuilder::new(app, "Settings")
                .item(&select_stdlib_path)
                .separator()
                .item(&toggle_theme)
                .separator()
                .item(&light_theme)
                .item(&dark_theme)
                .build()?;
            let help_menu = SubmenuBuilder::new(app, "Help").item(&about).build()?;

            MenuBuilder::new(app)
                .item(&file_menu)
                .item(&build_menu)
                .item(&view_menu)
                .item(&settings_menu)
                .item(&help_menu)
                .build()
        })
        .on_menu_event(|app, event| {
            let action = match event.id().as_ref() {
                "file.new_project" => Some("new-project"),
                "file.open_folder" => Some("open-folder"),
                "file.open_file" => Some("open-file"),
                "file.save" => Some("save-active"),
                "build.compile_project" => Some("compile-workspace"),
                "build.compile_file" => Some("compile-file"),
                "build.clear_caches" => Some("clear-caches"),
                "view.show_logs" => Some("show-logs"),
                "view.show_expressions" => Some("show-expressions"),
                "view.show_commit_manager" => Some("show-commit-manager"),
                "settings.select_stdlib_path" => Some("select-stdlib-path"),
                "settings.theme_toggle" => Some("theme-toggle"),
                "settings.theme_light" => Some("theme-light"),
                "settings.theme_dark" => Some("theme-dark"),
                "file.exit" => Some("close-window"),
                "help.about" => Some("about"),
                _ => None,
            };
            if let Some(action) = action {
                let _ = app.emit_to(EventTarget::webview_window("main"), "menu-action", action);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_user_projects_root,
            list_dir,
            read_file,
            write_file,
            create_file,
            create_project,
            window_minimize,
            window_toggle_maximize,
            app_exit,
            window_close,
            show_in_explorer,
            compile_project_delta,
            cancel_compile,
            get_background_jobs,
            cancel_background_jobs,
            clear_all_caches,
            start_project_file_watcher,
            stop_project_file_watcher,
            set_project_stdlib_path,
            list_semantic_edit_actions,
            preview_semantic_edit,
            apply_semantic_edit,
            detect_git_repo,
            ai_test_endpoint,
            ai_agent_run,
            git_status,
            git_stage_paths,
            git_unstage_paths,
            git_commit,
            git_push,
            list_tools,
            call_tool,
            get_logs,
            log_frontend,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
