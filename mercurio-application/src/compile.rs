use crate::logging::log_event;
use crate::paths::{is_path_under_root, resolve_under_root};
use crate::stdlib::{load_stdlib_cached, resolve_default_stdlib_path};
use crate::symbols::symbol_to_view;
use crate::types::{
    AppState, CompileFileResult, CompileProgressPayload, CompileResponse, LibraryConfig,
    ProjectConfig, UnresolvedRefView, UnsavedFile,
};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};
use syster::base::FileId;
use syster::hir::SemanticChecker;
use syster::ide::AnalysisHost;
use syster::interchange::{
    detect_format, model_from_symbols, restore_ids_from_symbols, symbols_from_model, JsonLd, Kpar,
    ModelFormat, Xmi,
};
use syster::project::StdLibLoader;
use syster::syntax::parser::parse_with_result;
use tauri::{Emitter, EventTarget};

struct CancelGuard {
    canceled: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<u64>>>,
    run_id: u64,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = self.canceled.lock() {
            set.remove(&self.run_id);
        }
    }
}

#[tauri::command]
pub async fn compile_workspace(
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
    .map_err(|e| {
        let message = e.to_string();
        log_event("ERROR", "compile", format!("panic run_id={} err={}", run_id, message));
        message
    })?
    .map_err(|e| {
        log_event("ERROR", "compile", format!("failed run_id={} err={}", run_id, e));
        e
    })
}

fn compile_workspace_sync(
    app: tauri::AppHandle,
    state: AppState,
    root: String,
    run_id: u64,
    allow_parse_errors: bool,
    unsaved: Vec<UnsavedFile>,
) -> Result<CompileResponse, String> {
    // Main compile pipeline: parse, analysis, semantic checks, symbol extraction.
    let compile_start = Instant::now();
    let root_path = PathBuf::from(root);
    if !root_path.exists() {
        let message = "Root path does not exist".to_string();
        log_event("ERROR", "compile", message.clone());
        return Err(message);
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

    log_event(
        "INFO",
        "compile",
        format!(
            "start root={} run_id={} allow_parse_errors={} unsaved={}",
            root_path.to_string_lossy(),
            run_id,
            allow_parse_errors,
            unsaved.len()
        ),
    );

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
    log_event(
        "INFO",
        "stdlib",
        format!(
            "resolve source={} path={}",
            stdlib_source,
            stdlib_path_for_log
                .as_ref()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| "none".to_string())
        ),
    );
    let project_set: HashSet<PathBuf> = files.iter().cloned().collect();
    let root_changed = workspace.root.as_ref() != Some(&root_path);
    let stdlib_changed = workspace.stdlib_path.as_ref() != stdlib_path_for_log.as_ref();
    let imports_changed = workspace.import_files != import_set;
    let needs_reset = root_changed || stdlib_changed || imports_changed;
    log_event(
        "INFO",
        "stdlib",
        format!(
            "workspace reset={} root_changed={} stdlib_changed={} imports_changed={}",
            needs_reset, root_changed, stdlib_changed, imports_changed
        ),
    );

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
            log_event("INFO", "stdlib", format!("cwd={}", cwd.to_string_lossy()));
        }
        let stdlib_path_exists = stdlib_path_for_log
            .as_ref()
            .map(|path| path.exists() && path.is_dir())
            .unwrap_or(false);
        log_event(
            "INFO",
            "stdlib",
            format!("loading ({}) exists={}", stdlib_source, stdlib_path_exists),
        );
        if !stdlib_path_exists {
            log_event(
                "WARN",
                "stdlib",
                "path missing; no stdlib files will load".to_string(),
            );
        }
        let stdlib_files_before = analysis_host.file_count();
        let stdlib_start = Instant::now();
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
        log_event(
            "INFO",
            "stdlib",
            format!(
                "loaded files={} duration_ms={}",
                stdlib_file_delta,
                stdlib_start.elapsed().as_millis()
            ),
        );
        log_event(
            "INFO",
            "stdlib",
            "symbols=skipped (counting stdlib symbols can overflow the stack)".to_string(),
        );
    } else {
        log_event("INFO", "stdlib", "reuse cached stdlib workspace; no reload".to_string());
    }

    log_event(
        "INFO",
        "compile",
        format!("parsing project files count={}", files.len()),
    );
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
                let file_symbols = syster::hir::extract_symbols_unified(file_id, &syntax);
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
    log_event(
        "INFO",
        "compile",
        format!(
            "parsing done host_files={} duration_ms={}",
            analysis_host.file_count(),
            parse_start.elapsed().as_millis()
        ),
    );
    if has_parse_errors && !allow_parse_errors {
        log_event(
            "WARN",
            "compile",
            format!(
                "parse failed duration_ms={} total_duration_ms={}",
                parse_start.elapsed().as_millis(),
                compile_start.elapsed().as_millis()
            ),
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
        });
    }

    if analysis_host.file_count() > 0 {
        let analysis_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            check_cancel()?;
            emit_progress("analysis", None, None, None);
            let analysis_start = Instant::now();
            log_event("INFO", "compile", "analysis: start".to_string());
            let _ = analysis_host.analysis();
            log_event(
                "INFO",
                "compile",
                format!("analysis: done duration_ms={}", analysis_start.elapsed().as_millis()),
            );
            check_cancel()?;

            let project_file_ids = files
                .iter()
                .filter_map(|path| analysis_host.get_file_id_for_path(path))
                .collect::<Vec<_>>();
            if project_file_ids.is_empty() {
                log_event("INFO", "compile", "semantic: skipped (no project files)".to_string());
            } else {
                check_cancel()?;
                let semantic_total = project_file_ids.len();
                emit_progress("semantic", None, Some(0), Some(semantic_total));
                let semantic_start = Instant::now();
                log_event("INFO", "compile", "semantic: start".to_string());
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
                log_event(
                    "INFO",
                    "compile",
                    format!("semantic: done duration_ms={}", semantic_start.elapsed().as_millis()),
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

            log_event("INFO", "compile", "symbols: start".to_string());
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
            log_event(
                "INFO",
                "compile",
                format!("symbols: done count={}", symbols.len()),
            );
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

    log_event(
        "INFO",
        "compile",
        format!("done total_duration_ms={}", compile_start.elapsed().as_millis()),
    );
    if !unresolved.is_empty() {
        log_event(
            "WARN",
            "compile",
            format!("unresolved_references={}", unresolved.len()),
        );
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
pub fn cancel_compile(state: tauri::State<'_, AppState>, run_id: u64) -> Result<(), String> {
    let mut set = state
        .canceled_compiles
        .lock()
        .map_err(|_| "Cancel lock poisoned".to_string())?;
    set.insert(run_id);
    log_event("INFO", "compile", format!("cancel requested run_id={}", run_id));
    Ok(())
}

#[tauri::command]
pub async fn export_compiled_model(
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

fn load_project_config(root: &Path) -> Result<Option<ProjectConfig>, String> {
    let config_path = root.join(".project.json");
    if !config_path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(config_path).map_err(|e| e.to_string())?;
    let parsed: ProjectConfig = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(Some(parsed))
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

pub fn is_model_file(path: &Path) -> bool {
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
                return Err(format!("Unsupported import format: {}", path.display()));
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
