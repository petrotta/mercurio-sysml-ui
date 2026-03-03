use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::fs::File;
use std::io;
use std::path::{Component, Path, PathBuf};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::path::BaseDirectory;
use tauri::{Emitter, EventTarget, Manager};
use zip::ZipArchive;

mod commands;

use commands::{call_tool, list_dir, read_file, write_file};

use mercurio_core::{
    cancel_compile as core_cancel_compile,
    compile_project_delta_sync as core_compile_project_delta_sync,
    ensure_mercurio_paths,
    list_stdlib_versions_from_root,
    load_app_settings,
    save_app_settings,
    AppSettings,
    CompileRequest,
    CompileResponse,
    CoreState,
    MercurioPaths,
};

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) core: CoreState,
    pub(crate) settings_path: PathBuf,
}

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
fn cancel_compile(state: tauri::State<'_, AppState>, run_id: u64) -> Result<(), String> {
    core_cancel_compile(&state.core, run_id)
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
            let compile = MenuItemBuilder::with_id("build.compile", "Build")
                .accelerator("Ctrl+B")
                .build(app)?;
            let about = MenuItemBuilder::with_id("help.about", "About").build(app)?;

            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&open_folder)
                .item(&open_file)
                .separator()
                .item(&PredefinedMenuItem::close_window(app, None)?)
                .build()?;
            let build_menu = SubmenuBuilder::new(app, "Build").item(&compile).build()?;
            let help_menu = SubmenuBuilder::new(app, "Help").item(&about).build()?;

            MenuBuilder::new(app)
                .item(&file_menu)
                .item(&build_menu)
                .item(&help_menu)
                .build()
        })
        .on_menu_event(|app, event| {
            let action = match event.id().as_ref() {
                "file.open_folder" => Some("open-folder"),
                "file.open_file" => Some("open-file"),
                "build.compile" => Some("compile-workspace"),
                "help.about" => Some("about"),
                _ => None,
            };
            if let Some(action) = action {
                let _ = app.emit_to(EventTarget::webview_window("main"), "menu-action", action);
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_file,
            write_file,
            compile_project_delta,
            cancel_compile,
            call_tool,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
