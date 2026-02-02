mod compile;
mod fs_ops;
mod llm;
mod logging;
mod parse;
mod paths;
mod stdlib;
mod symbols;
mod types;

use crate::logging::log_event;
use crate::paths::ensure_mercurio_paths;
use crate::stdlib::{ensure_packaged_stdlibs, load_app_settings};
use crate::types::{AppState, WorkspaceState};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use syster::ide::AnalysisHost;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, EventTarget, Manager};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Resolve user-scoped storage and settings before bringing up the UI.
    let paths = ensure_mercurio_paths().unwrap_or_else(|err| {
        eprintln!("mercurio: failed to initialize user data dir: {}", err);
        let fallback_root = env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(".mercurio");
        let stdlib_root = fallback_root.join("stdlib");
        let _ = fs::create_dir_all(&stdlib_root);
        let settings_path = fallback_root.join("settings.json");
        crate::types::MercurioPaths {
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
            log_event("INFO", "startup", "app setup".to_string());
            let state = app.state::<AppState>();
            if let Ok(mut settings) = state.settings.lock() {
                let handle = app.handle();
                if let Err(err) = ensure_packaged_stdlibs(
                    &handle,
                    &state.stdlib_root,
                    &state.settings_path,
                    &mut settings,
                ) {
                    log_event("ERROR", "startup", format!("stdlib extraction failed: {}", err));
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
            fs_ops::get_default_root,
            fs_ops::get_startup_path,
            stdlib::list_stdlib_versions,
            stdlib::get_default_stdlib,
            stdlib::set_default_stdlib,
            fs_ops::list_dir,
            fs_ops::read_file,
            fs_ops::path_exists,
            fs_ops::write_file,
            fs_ops::create_file,
            fs_ops::create_dir,
            fs_ops::rename_path,
            fs_ops::delete_path,
            fs_ops::set_watch_root,
            fs_ops::open_in_explorer,
            parse::get_parse_errors,
            parse::get_parse_errors_for_content,
            window_minimize,
            window_toggle_maximize,
            window_close,
            compile::compile_workspace,
            compile::cancel_compile,
            compile::export_compiled_model,
            llm::read_llm_instructions,
            llm::read_llm_hints,
            llm::get_llm_hints_meta,
            logging::get_logs,
            logging::log_frontend
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
