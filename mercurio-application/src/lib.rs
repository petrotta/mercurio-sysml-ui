use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use syster::ide::AnalysisHost;
use syster::project::StdLibLoader;
use syster::hir::SemanticChecker;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::collections::HashSet;
use syster::base::constants::STDLIB_DIR;
use syster::base::FileId;
use syster::hir::{
    extract_symbols_unified, HirRelationship, HirSymbol, SymbolKind, TypeRef, TypeRefKind,
};
use syster::syntax::SyntaxFile;
use syster::syntax::parser::parse_with_result;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, EventTarget, Manager};

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
struct CompileFileResult {
  path: String,
  ok: bool,
  errors: Vec<String>,
  symbol_count: usize,
}

#[derive(Deserialize, Clone)]
#[serde(untagged)]
enum LibraryConfig {
    Default(String),
    Path { path: String },
}

#[derive(Deserialize, Default, Clone)]
struct ProjectConfig {
    library: Option<LibraryConfig>,
    src: Option<Vec<String>>,
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
}

struct StdlibCache {
    path: PathBuf,
    files: Vec<(PathBuf, SyntaxFile)>,
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

fn resolve_default_stdlib_path(root: &Path) -> PathBuf {
    let root_stdlib = root.join(STDLIB_DIR);
    if root_stdlib.exists() && root_stdlib.is_dir() {
        return root_stdlib;
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
    let state = state.inner().clone();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        compile_workspace_sync(app, state, root, run_id)
    })
        .await
        .map_err(|e| e.to_string())?
}

fn compile_workspace_sync(
    app: tauri::AppHandle,
    state: AppState,
    root: String,
    run_id: u64,
) -> Result<CompileResponse, String> {
    let root_path = PathBuf::from(root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }

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
    let mut file_results = Vec::new();
    let mut unresolved = Vec::new();
    let mut analysis_host = AnalysisHost::new();

    let library_config = project_config.and_then(|config| config.library);
    let (stdlib_loader, stdlib_source, stdlib_path_for_log) = match library_config {
        Some(LibraryConfig::Path { path }) => {
            let raw_path = PathBuf::from(&path);
            let resolved = if raw_path.is_absolute() {
                raw_path
            } else {
                root_path.join(raw_path)
            };
            let source = format!("path: {}", resolved.to_string_lossy());
            (StdLibLoader::with_path(resolved.clone()), source, Some(resolved))
        }
        Some(LibraryConfig::Default(value)) => {
            if value.to_lowercase() == "default" {
                let discovered = resolve_default_stdlib_path(&root_path);
                let source = format!("default: {}", discovered.to_string_lossy());
                (StdLibLoader::new(), source, Some(discovered))
            } else {
                let raw_path = PathBuf::from(&value);
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
            let discovered = resolve_default_stdlib_path(&root_path);
            let source = format!("default: {}", discovered.to_string_lossy());
            (StdLibLoader::new(), source, Some(discovered))
        }
    };
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
    if stdlib_path_exists {
        if let Some(stdlib_path) = stdlib_path_for_log.as_ref() {
            let cached_files = load_stdlib_cached(&state, stdlib_path)?;
            for (path, file) in cached_files {
                analysis_host.set_file(path, file);
            }
        }
    } else {
        stdlib_loader.load_into_host(&mut analysis_host)?;
    }
    let stdlib_files_after = analysis_host.file_count();
    let stdlib_file_delta = stdlib_files_after.saturating_sub(stdlib_files_before);
    println!("stdlib: loaded files={}", stdlib_file_delta);
    println!("stdlib: symbols=skipped (counting stdlib symbols can overflow the stack)");

    println!("compile: parsing project files count={}", files.len());
    let mut has_parse_errors = false;
    emit_progress("parsing", None, None, Some(files.len()));
    for (index, path) in files.iter().enumerate() {
        check_cancel()?;
        emit_progress(
            "parsing",
            Some(path.to_string_lossy().to_string()),
            Some(index + 1),
            Some(files.len()),
        );
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
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

        file_results.push(CompileFileResult {
            path: path.to_string_lossy().to_string(),
            ok,
            errors,
            symbol_count,
        });
    }
    println!(
        "compile: parsing done host_files={}",
        analysis_host.file_count()
    );
    if has_parse_errors {
        return Ok(CompileResponse {
            ok: false,
            files: file_results,
            symbols,
            unresolved,
            library_path: stdlib_path_for_log
                .as_ref()
                .map(|path| path.to_string_lossy().to_string()),
            parse_failed: true,
        });
    }

    if analysis_host.file_count() > 0 {
        let analysis_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            check_cancel()?;
            emit_progress("analysis", None, None, None);
            println!("analysis: start");
            let _ = analysis_host.analysis();
            println!("analysis: done");
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
                println!("semantic: done");
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

            let mut all_paths = analysis_host
                .files()
                .keys()
                .cloned()
                .collect::<Vec<_>>();
            all_paths.sort_by(|a, b| {
                a.to_string_lossy()
                    .to_lowercase()
                    .cmp(&b.to_string_lossy().to_lowercase())
            });
            println!("symbols: start");
            symbols = Vec::new();
            for (index, path) in all_paths.iter().enumerate() {
                check_cancel()?;
                if let Some(syntax) = analysis_host.files().get(path) {
                    let file_id = FileId::new(index as u32);
                    let file_symbols = extract_symbols_unified(file_id, syntax);
                    symbols.extend(
                        file_symbols
                            .into_iter()
                            .map(|symbol| symbol_to_view(symbol, path)),
                    );
                }
            }
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

    Ok(CompileResponse {
        ok: file_results.iter().all(|f| f.ok),
        files: file_results,
        symbols,
        unresolved,
        library_path: stdlib_path_for_log
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        parse_failed: false,
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

fn load_project_config(root: &Path) -> Result<Option<ProjectConfig>, String> {
    let config_path = root.join(".project.json");
    if !config_path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(config_path).map_err(|e| e.to_string())?;
    let parsed: ProjectConfig = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(Some(parsed))
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
        return Err("Path is outside the project root".to_string());
    }
    Ok(normalized)
}

fn symbol_to_view(symbol: HirSymbol, file_path: &Path) -> SymbolView {
    SymbolView {
        file_path: file_path.to_string_lossy().to_string(),
        name: symbol.name.as_ref().to_string(),
        short_name: symbol.short_name.as_ref().map(|s| s.to_string()),
        qualified_name: symbol.qualified_name.as_ref().to_string(),
        kind: symbol_kind_label(symbol.kind),
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

fn symbol_kind_label(kind: SymbolKind) -> String {
    kind.display().to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            watcher: Arc::new(Mutex::new(None)),
            stdlib_cache: Arc::new(Mutex::new(None)),
            canceled_compiles: Arc::new(Mutex::new(HashSet::new())),
        })
        .menu(|app| {
            let open_folder = MenuItemBuilder::with_id("file.open_folder", "Open Folder...")
                .accelerator("Ctrl+Shift+O")
                .build(app)?;
            let open_file = MenuItemBuilder::with_id("file.open_file", "Open File...")
                .accelerator("Ctrl+O")
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
            list_dir,
            read_file,
            path_exists,
            write_file,
            create_file,
            create_dir,
            rename_path,
            delete_path,
            set_watch_root,
            open_in_explorer,
            get_parse_errors,
            get_parse_errors_for_content,
            window_minimize,
            window_toggle_maximize,
            window_close,
            compile_workspace,
            cancel_compile
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
