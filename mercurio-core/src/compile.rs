use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::time::{Instant, SystemTime};

use syster::base::FileId;
use syster::hir::extract_symbols_unified;
use syster::ide::AnalysisHost;
use syster::syntax::parser::parse_with_result;

use crate::project::load_project_config;
use crate::stdlib::{load_stdlib_into_host, resolve_stdlib_path};
use crate::symbols::{build_symbols_from_walk, build_usage_views, collect_expr_spans};
use crate::workspace::{collect_model_files, collect_project_files, collect_project_imports, load_imports_into_host};
use crate::CoreState;

// Compile types + functions follow.

pub use crate::state::CompileFileResult;

#[derive(Serialize)]
pub struct CompileResponse {
    pub ok: bool,
    pub files: Vec<CompileFileResult>,
    pub symbols: Vec<SymbolView>,
    pub unresolved: Vec<UnresolvedRefView>,
    pub library_path: Option<String>,
    pub parse_failed: bool,
    pub stdlib_cache_hit: bool,
    pub parsed_files: Vec<String>,
    pub parse_duration_ms: u128,
    pub analysis_duration_ms: u128,
    pub stdlib_duration_ms: u128,
    pub total_duration_ms: u128,
}

#[derive(Serialize, Clone)]
pub struct CompileProgressPayload {
    pub run_id: u64,
    pub stage: String,
    pub file: Option<String>,
    pub index: Option<usize>,
    pub total: Option<usize>,
}

#[derive(Serialize)]
pub struct UnresolvedRefView {
    pub file_path: String,
    pub message: String,
    pub line: u32,
    pub column: u32,
    pub code: Option<String>,
}

#[derive(Serialize)]
pub struct SymbolView {
    pub file_path: String,
    pub name: String,
    pub short_name: Option<String>,
    pub qualified_name: String,
    pub kind: String,
    pub file: u32,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub expr_start_line: Option<u32>,
    pub expr_start_col: Option<u32>,
    pub expr_end_line: Option<u32>,
    pub expr_end_col: Option<u32>,
    pub short_name_start_line: Option<u32>,
    pub short_name_start_col: Option<u32>,
    pub short_name_end_line: Option<u32>,
    pub short_name_end_col: Option<u32>,
    pub doc: Option<String>,
    pub supertypes: Vec<String>,
    pub relationships: Vec<RelationshipView>,
    pub type_refs: Vec<TypeRefView>,
    pub is_public: bool,
    pub properties: Vec<PropertyItemView>,
}

#[derive(Serialize)]
pub struct PropertyItemView {
    pub name: String,
    pub label: String,
    pub value: PropertyValueView,
    pub hint: Option<String>,
    pub group: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PropertyValueView {
    Text { value: String },
    List { items: Vec<String> },
    Bool { value: bool },
    Number { value: u64 },
}

#[derive(Serialize)]
pub struct RelationshipView {
    pub kind: String,
    pub target: String,
    pub resolved_target: Option<String>,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

#[derive(Serialize)]
pub struct TypeRefPartView {
    pub kind: String,
    pub target: String,
    pub resolved_target: Option<String>,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TypeRefView {
    Simple { part: TypeRefPartView },
    Chain { parts: Vec<TypeRefPartView> },
}

#[derive(Clone)]
pub struct UnsavedFile {
    pub path: PathBuf,
    pub content: String,
}

pub fn cancel_compile(state: &CoreState, run_id: u64) -> Result<(), String> {
    let mut set = state
        .canceled_compiles
        .lock()
        .map_err(|_| "Cancel lock poisoned".to_string())?;
    set.insert(run_id);
    Ok(())
}

pub fn compile_workspace_sync<F: Fn(CompileProgressPayload)>(
    state: &CoreState,
    root: String,
    run_id: u64,
    allow_parse_errors: bool,
    unsaved: Vec<UnsavedFile>,
    emit_progress: F,
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
        emit_progress(CompileProgressPayload {
            run_id,
            stage: stage.to_string(),
            file,
            index,
            total,
        });
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

    let library_config = project_config.as_ref().and_then(|config| config.library.as_ref());
    let stdlib_override = project_config.as_ref().and_then(|config| config.stdlib.as_ref());
    let (_stdlib_loader, stdlib_path_for_log) = resolve_stdlib_path(
        &state.stdlib_root,
        default_stdlib.as_deref(),
        library_config,
        stdlib_override,
        &root_path,
    );
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

        let stdlib_start = Instant::now();
        if let Some(stdlib_path) = stdlib_path_for_log.as_ref() {
            stdlib_cache_hit = load_stdlib_into_host(state, &mut analysis_host, stdlib_path)?;
        }
        stdlib_duration_ms = stdlib_start.elapsed().as_millis();
    }

    let parse_start = Instant::now();
    let mut has_parse_errors = false;
    emit_progress("parsing", None, None, Some(files.len()));

    let mut unsaved_map = HashMap::new();
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
    if has_parse_errors && !allow_parse_errors {
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
            let _ = analysis_host.analysis();
            analysis_duration_ms = analysis_start.elapsed().as_millis();
            check_cancel()?;

            let project_file_ids = files
                .iter()
                .filter_map(|path| analysis_host.get_file_id_for_path(path))
                .collect::<Vec<_>>();
            if !project_file_ids.is_empty() {
                check_cancel()?;
                let semantic_total = project_file_ids.len();
                emit_progress("semantic", None, Some(0), Some(semantic_total));
                let symbol_index = analysis_host.symbol_index().clone();
                let canceled_compiles = state.canceled_compiles.clone();
                let run_id = run_id;
                let semantic_result = std::thread::Builder::new()
                    .name("semantic-check".to_string())
                    .stack_size(64 * 1024 * 1024)
                    .spawn(move || {
                        let mut checker = syster::hir::SemanticChecker::new(&symbol_index);
                        for (_index, file_id) in project_file_ids.into_iter().enumerate() {
                            let canceled = canceled_compiles
                                .lock()
                                .map(|set| set.contains(&run_id))
                                .unwrap_or(false);
                            if canceled {
                                return Err("Compile canceled".to_string());
                            }
                            checker.check_file(file_id);
                        }
                        Ok(checker.finish())
                    })
                    .map_err(|e| e.to_string())?
                    .join()
                    .map_err(|_| "Semantic checker thread panicked".to_string())?;
                let semantic_result = semantic_result?;
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

            check_cancel()?;
            let expr_spans_by_file = collect_expr_spans(analysis_host.files());
            symbols = build_symbols_from_walk(analysis_host.files(), &expr_spans_by_file);
            symbols.extend(build_usage_views(analysis_host.files()));
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
        stdlib_cache_hit,
        parsed_files,
        parse_duration_ms: parse_start.elapsed().as_millis(),
        analysis_duration_ms,
        stdlib_duration_ms,
        total_duration_ms: compile_start.elapsed().as_millis(),
    })
}

struct CancelGuard {
    canceled: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<u64>>>,
    run_id: u64,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        if let Ok(mut canceled) = self.canceled.lock() {
            canceled.remove(&self.run_id);
        }
    }
}
