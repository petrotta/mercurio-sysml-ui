use mercurio_sysml_core::parser::Parser;
use mercurio_sysml_pkg::compile_support::{
    PreparedScope, ProjectedPropertyValue, ProjectedSemanticSymbol, RawIndexSymbol,
    StdlibSymbolRow, build_stdlib_snapshot as build_stdlib_snapshot_rows,
    build_canonical_symbol_rows_by_file,
    group_prepared_symbols_by_file,
    load_stdlib_snapshot_with_cache,
    is_library_symbol_path,
    map_semantic_element_to_projected_symbol,
    normalized_compare_key as normalized_compare_key_shared,
    prepare_symbols_for_index,
};
use mercurio_sysml_pkg::project_ingest::ingest_project_texts;
use mercurio_sysml_pkg::semantic_projection::{
    SymbolSpan, UnresolvedRef, collect_unresolved_from_project_diagnostics,
    load_project_sources_for_ingest, semantic_elements_for_project,
};
use mercurio_sysml_semantics::stdlib::MetatypeIndex;
use mercurio_sysml_semantics::semantic_contract::SemanticElementView;
use mercurio_symbol_index::{SymbolIndexStore, SymbolRecord};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Instant, SystemTime};

use crate::project::load_project_config;
use crate::symbol_index::query_project_symbols;
use crate::state::StdlibSymbol;
use crate::stdlib::resolve_stdlib_path;
use crate::workspace::{collect_model_files, collect_project_files};
use crate::CoreState;

pub use crate::state::CompileFileResult;

#[derive(Serialize)]
pub struct CompileResponse {
    pub ok: bool,
    pub files: Vec<CompileFileResult>,
    pub parse_error_categories: Vec<ParseErrorCategoryView>,
    pub performance_warnings: Vec<String>,
    pub symbols: Vec<SymbolView>,
    pub project_symbol_count: usize,
    pub library_symbol_count: usize,
    pub unresolved: Vec<UnresolvedRefView>,
    pub library_path: Option<String>,
    pub parse_failed: bool,
    pub stdlib_cache_hit: bool,
    pub parsed_files: Vec<String>,
    pub parse_duration_ms: u128,
    pub analysis_duration_ms: u128,
    pub stdlib_duration_ms: u128,
    pub stdlib_file_count: usize,
    pub total_duration_ms: u128,
}

#[derive(Serialize)]
pub struct LibrarySymbolsResponse {
    pub ok: bool,
    pub symbols: Vec<SymbolView>,
    pub library_files: Vec<String>,
    pub library_path: Option<String>,
    pub stdlib_cache_hit: bool,
    pub stdlib_duration_ms: u128,
    pub stdlib_file_count: usize,
    pub total_duration_ms: u128,
}

#[derive(Serialize, Clone)]
pub struct ParseErrorCategoryView {
    pub category: String,
    pub count: usize,
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

#[derive(Serialize, Clone)]
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

#[derive(Serialize, Clone)]
pub struct PropertyItemView {
    pub name: String,
    pub label: String,
    pub value: PropertyValueView,
    pub hint: Option<String>,
    pub group: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PropertyValueView {
    Text { value: String },
    List { items: Vec<String> },
    Bool { value: bool },
    Number { value: u64 },
}

#[derive(Serialize, Clone)]
pub struct RelationshipView {
    pub kind: String,
    pub target: String,
    pub resolved_target: Option<String>,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

#[derive(Serialize, Clone)]
pub struct TypeRefPartView {
    pub kind: String,
    pub target: String,
    pub resolved_target: Option<String>,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

#[derive(Serialize, Clone)]
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

#[derive(Deserialize, Clone)]
pub struct UnsavedFileInput {
    pub path: String,
    pub content: String,
}

#[derive(Deserialize, Clone)]
pub struct CompileRequest {
    pub root: String,
    #[serde(default)]
    pub run_id: u64,
    #[serde(default)]
    pub allow_parse_errors: bool,
    #[serde(default)]
    pub unsaved: Vec<UnsavedFileInput>,
    #[serde(default, alias = "file", alias = "path")]
    pub target_path: Option<String>,
}

impl CompileRequest {
    pub fn into_parts(self) -> (String, u64, bool, Option<PathBuf>, Vec<UnsavedFile>) {
        let unsaved = self
            .unsaved
            .into_iter()
            .map(|entry| UnsavedFile {
                path: PathBuf::from(entry.path),
                content: entry.content,
            })
            .collect::<Vec<_>>();
        let target_path = self.target_path.map(PathBuf::from);
        (
            self.root,
            self.run_id,
            self.allow_parse_errors,
            target_path,
            unsaved,
        )
    }
}

#[derive(Deserialize, Clone)]
pub struct LibrarySymbolsRequest {
    pub root: String,
    #[serde(default, alias = "file", alias = "path")]
    pub target_path: Option<String>,
    #[serde(default = "default_include_symbols")]
    pub include_symbols: bool,
}

impl LibrarySymbolsRequest {
    pub fn into_parts(self) -> (String, Option<PathBuf>, bool) {
        (
            self.root,
            self.target_path.map(PathBuf::from),
            self.include_symbols,
        )
    }
}

fn default_include_symbols() -> bool {
    true
}

pub fn cancel_compile(state: &CoreState, run_id: u64) -> Result<(), String> {
    let mut set = state
        .canceled_compiles
        .lock()
        .map_err(|_| "Cancel lock poisoned".to_string())?;
    set.insert(run_id);
    Ok(())
}

fn categorize_parse_error(message: &str) -> String {
    let text = message.to_lowercase();
    if text.contains("expected") {
        return "expected-token".to_string();
    }
    if text.contains("unexpected") {
        return "unexpected-token".to_string();
    }
    if text.contains("unterminated") {
        return "unterminated".to_string();
    }
    if text.contains("invalid") {
        return "invalid-syntax".to_string();
    }
    "other".to_string()
}

fn summarize_parse_error_categories(files: &[CompileFileResult]) -> Vec<ParseErrorCategoryView> {
    let mut categories = HashMap::<String, usize>::new();
    for file in files {
        if file.ok {
            continue;
        }
        for message in &file.errors {
            let key = categorize_parse_error(message);
            *categories.entry(key).or_insert(0) += 1;
        }
    }
    let mut out = categories
        .into_iter()
        .map(|(category, count)| ParseErrorCategoryView { category, count })
        .collect::<Vec<_>>();
    out.sort_by(|a, b| b.count.cmp(&a.count).then(a.category.cmp(&b.category)));
    out
}

fn performance_warnings(
    parse_duration_ms: u128,
    analysis_duration_ms: u128,
    stdlib_duration_ms: u128,
    total_duration_ms: u128,
) -> Vec<String> {
    let mut warnings = Vec::new();
    if total_duration_ms > 2000 {
        warnings.push("compile exceeded 2000 ms performance budget".to_string());
    }
    if parse_duration_ms > 750 {
        warnings.push("parse stage exceeded 750 ms".to_string());
    }
    if analysis_duration_ms > 750 {
        warnings.push("analysis stage exceeded 750 ms".to_string());
    }
    if stdlib_duration_ms > 500 {
        warnings.push("stdlib load exceeded 500 ms".to_string());
    }
    warnings
}

pub fn query_semantic_symbols(state: &CoreState, root: String) -> Result<Vec<SymbolView>, String> {
    let indexed = query_project_symbols(state, root, None, None, None).unwrap_or_default();
    Ok(indexed
        .into_iter()
        .map(|symbol| SymbolView {
            file_path: symbol.file_path,
            name: symbol.name,
            short_name: None,
            qualified_name: symbol.qualified_name,
            kind: symbol.kind,
            file: 0,
            start_line: symbol.start_line,
            start_col: symbol.start_col,
            end_line: symbol.end_line,
            end_col: symbol.end_col,
            expr_start_line: None,
            expr_start_col: None,
            expr_end_line: None,
            expr_end_col: None,
            short_name_start_line: None,
            short_name_start_col: None,
            short_name_end_line: None,
            short_name_end_col: None,
            doc: symbol.doc_text,
            supertypes: Vec::new(),
            relationships: Vec::new(),
            type_refs: Vec::new(),
            is_public: true,
            properties: Vec::new(),
        })
        .collect())
}

pub fn compile_workspace_sync<F: Fn(CompileProgressPayload)>(
    state: &CoreState,
    root: String,
    run_id: u64,
    allow_parse_errors: bool,
    target_path: Option<PathBuf>,
    unsaved: Vec<UnsavedFile>,
    emit_progress: F,
) -> Result<CompileResponse, String> {
    compile_workspace_sync_internal(
        state,
        root,
        run_id,
        allow_parse_errors,
        target_path,
        unsaved,
        true,
        emit_progress,
    )
}

pub fn compile_project_delta_sync<F: Fn(CompileProgressPayload)>(
    state: &CoreState,
    root: String,
    run_id: u64,
    allow_parse_errors: bool,
    target_path: Option<PathBuf>,
    unsaved: Vec<UnsavedFile>,
    emit_progress: F,
) -> Result<CompileResponse, String> {
    compile_workspace_sync_internal(
        state,
        root,
        run_id,
        allow_parse_errors,
        target_path,
        unsaved,
        false,
        emit_progress,
    )
}

fn compile_workspace_sync_internal<F: Fn(CompileProgressPayload)>(
    state: &CoreState,
    root: String,
    run_id: u64,
    allow_parse_errors: bool,
    target_path: Option<PathBuf>,
    unsaved: Vec<UnsavedFile>,
    include_library_symbols: bool,
    emit_progress: F,
) -> Result<CompileResponse, String> {
    let compile_start = Instant::now();
    let root_path = PathBuf::from(&root);
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
    let emit_progress =
        |stage: &str, file: Option<String>, index: Option<usize>, total: Option<usize>| {
            emit_progress(CompileProgressPayload {
                run_id,
                stage: stage.to_string(),
                file,
                index,
                total,
            });
        };

    let project_config = load_project_config(&root_path).ok().flatten();
    let library_config = project_config
        .as_ref()
        .and_then(|config| config.library.as_ref());
    let stdlib_override = project_config
        .as_ref()
        .and_then(|config| config.stdlib.as_ref());
    let (_loader, stdlib_path_for_log) = resolve_stdlib_path(
        &state.stdlib_root,
        default_stdlib.as_deref(),
        library_config,
        stdlib_override,
        &root_path,
    );
    let mut files = Vec::new();
    if let Some(config) = project_config.as_ref() {
        if let Some(src) = config.src.as_ref() {
            files = collect_project_files(&root_path, src)?;
        }
    }
    if files.is_empty() {
        collect_model_files(&root_path, &mut files)?;
    }
    files = filter_out_stdlib_files(files, stdlib_path_for_log.as_deref());
    if files.is_empty() {
        let mut fallback = Vec::new();
        collect_model_files(&root_path, &mut fallback)?;
        files = filter_out_stdlib_files(fallback, stdlib_path_for_log.as_deref());
    }
    if let Some(target) = target_path.as_ref() {
        let should_include_target = target.exists()
            && target
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("sysml") || ext.eq_ignore_ascii_case("kerml"))
                .unwrap_or(false)
            && !is_library_symbol_path(&target.to_string_lossy(), stdlib_path_for_log.as_deref());
        if should_include_target && !files.iter().any(|candidate| same_path(candidate, target)) {
            files.push(target.clone());
        }
    }
    files.sort();
    files.dedup();

    let mut workspace = state
        .workspace
        .lock()
        .map_err(|_| "Workspace lock poisoned".to_string())?;

    let parse_start = Instant::now();
    let mut has_parse_errors = false;
    emit_progress("parsing", None, None, Some(files.len()));

    let mut unsaved_map = HashMap::new();
    for entry in unsaved {
        let path = if entry.path.is_absolute() {
            entry.path
        } else {
            root_path.join(entry.path)
        };
        unsaved_map.insert(path, entry.content);
    }
    let target_path = target_path.map(|path| {
        if path.is_absolute() {
            path
        } else {
            root_path.join(path)
        }
    });

    let mut parsed_files = Vec::new();

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
        if let Some(content) = unsaved_content_for_path(&unsaved_map, path) {
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
            let mut parser = Parser::new(&content);
            let _ = parser.parse_root();
            let errors = parser
                .errors()
                .iter()
                .map(|e| e.message.clone())
                .collect::<Vec<_>>();
            let ok = errors.is_empty();
            if !ok {
                has_parse_errors = true;
            }

            workspace.file_cache.insert(
                path.to_path_buf(),
                CompileFileResult {
                    path: path.to_string_lossy().to_string(),
                    ok,
                    errors,
                    symbol_count: 0,
                },
            );
        } else if let Some(result) = workspace.file_cache.get(path) {
            if !result.ok {
                has_parse_errors = true;
            }
        }
    }

    let mut file_results: Vec<CompileFileResult> = files
        .iter()
        .filter_map(|path| workspace.file_cache.get(path).cloned())
        .collect();
    file_results.sort_by(|a, b| a.path.cmp(&b.path));
    drop(workspace);

    if has_parse_errors && !allow_parse_errors {
        let parse_duration_ms = parse_start.elapsed().as_millis();
        let analysis_duration_ms = 0;
        let stdlib_duration_ms = 0;
        let total_duration_ms = compile_start.elapsed().as_millis();
        let parse_error_categories = summarize_parse_error_categories(&file_results);
        let performance_warnings = performance_warnings(
            parse_duration_ms,
            analysis_duration_ms,
            stdlib_duration_ms,
            total_duration_ms,
        );
        return Ok(CompileResponse {
            ok: false,
            files: file_results,
            parse_error_categories,
            performance_warnings,
            symbols: Vec::new(),
            project_symbol_count: 0,
            library_symbol_count: 0,
            unresolved: Vec::new(),
            library_path: stdlib_path_for_log
                .as_ref()
                .map(|path| path.to_string_lossy().to_string()),
            parse_failed: true,
            stdlib_cache_hit: false,
            parsed_files,
            parse_duration_ms,
            analysis_duration_ms,
            stdlib_duration_ms,
            stdlib_file_count: 0,
            total_duration_ms,
        });
    }

    let stdlib_start = Instant::now();
    let (stdlib_files, stdlib_metatype_index, stdlib_symbols, stdlib_cache_hit) = {
        let (
            stdlib_entries,
            stdlib_metatype_index,
            stdlib_snapshot_symbols,
            stdlib_cache_hit,
            _stdlib_signature,
        ) = load_stdlib_snapshot(state, stdlib_path_for_log.as_deref())?;
        let files = stdlib_entries
            .iter()
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();
        let symbols = if include_library_symbols {
            stdlib_snapshot_symbols
        } else {
            Arc::new(Vec::new())
        };
        (files, stdlib_metatype_index, symbols, stdlib_cache_hit)
    };
    let stdlib_duration_ms = stdlib_start.elapsed().as_millis();

    let analysis_start = Instant::now();
    check_cancel()?;
    emit_progress("analysis", None, None, None);

    let project_symbol_files = select_symbol_files(&files, target_path.as_deref());
    let symbol_spans = build_symbol_span_seed_from_index(state, &root, &project_symbol_files);
    let unresolved_files = if include_library_symbols {
        files.clone()
    } else {
        project_symbol_files.clone()
    };
    let unresolved = if unresolved_files.is_empty() {
        Vec::new()
    } else {
        let project_sources = load_project_sources_for_ingest(&unresolved_files, &unsaved_map)?;
        match ingest_project_texts(project_sources.clone()) {
            Ok(ingest) => collect_unresolved_from_project_diagnostics(ingest.diagnostics, &project_sources)
                .into_iter()
                .map(
                    |UnresolvedRef {
                         file_path,
                         message,
                         line,
                         column,
                         code,
                     }| UnresolvedRefView {
                        file_path,
                        message,
                        line,
                        column,
                        code,
                    },
                )
                .collect(),
            Err(_) => Vec::new(),
        }
    };

    let mut symbols = Vec::new();
    let mut seen = HashSet::new();

    let mut project_symbol_count = 0usize;
    let mut library_symbol_count = 0usize;
    // Delegate project symbol extraction to mercurio-sysml semantic projection.
    // This keeps symbol and metatype semantics sourced from one authoritative path,
    // including nested members (for example attributes inside a part definition).
    // For delta mode this remains bounded because `project_symbol_files` is scoped
    // to the changed target file.
    for element in semantic_elements_for_project(
        &project_symbol_files,
        &unsaved_map,
        stdlib_metatype_index.as_ref(),
        stdlib_files.len(),
    ) {
        let key = format!(
            "{}|{}|{}",
            element.file_path, element.qualified_name, element.name
        );
        if seen.insert(key) {
            symbols.push(map_semantic_element_to_symbol(element, &symbol_spans));
            project_symbol_count += 1;
        }
    }
    if include_library_symbols {
        for symbol in stdlib_symbols.iter().map(map_stdlib_symbol_to_symbol_view) {
            let key = format!(
                "{}|{}|{}",
                symbol.file_path, symbol.qualified_name, symbol.name
            );
            if seen.insert(key) {
                symbols.push(symbol);
                library_symbol_count += 1;
            }
        }
    }
    augment_owned_relationships(&mut symbols);

    let mut symbol_counts = HashMap::<String, usize>::new();
    for symbol in &symbols {
        *symbol_counts.entry(symbol.file_path.clone()).or_insert(0) += 1;
    }
    for file in &mut file_results {
        file.symbol_count = symbol_counts.get(&file.path).copied().unwrap_or(0);
    }

    let analysis_duration_ms = analysis_start.elapsed().as_millis();

    let parse_duration_ms = parse_start.elapsed().as_millis();
    let total_duration_ms = compile_start.elapsed().as_millis();
    let parse_error_categories = summarize_parse_error_categories(&file_results);
    let performance_warnings = performance_warnings(
        parse_duration_ms,
        analysis_duration_ms,
        stdlib_duration_ms,
        total_duration_ms,
    );
    let response = CompileResponse {
        ok: file_results.iter().all(|f| f.ok),
        files: file_results,
        parse_error_categories,
        performance_warnings,
        symbols,
        project_symbol_count,
        library_symbol_count,
        unresolved,
        library_path: stdlib_path_for_log
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        parse_failed: false,
        stdlib_cache_hit,
        parsed_files,
        parse_duration_ms,
        analysis_duration_ms,
        stdlib_duration_ms,
        stdlib_file_count: stdlib_files.len(),
        total_duration_ms,
    };
    let _ = index_symbols_for_project(
        state,
        &root,
        stdlib_path_for_log.as_deref(),
        &response.symbols,
        true,
        false,
    );
    Ok(response)
}

fn filter_out_stdlib_files(files: Vec<PathBuf>, stdlib_path: Option<&Path>) -> Vec<PathBuf> {
    match stdlib_path {
        None => files,
        Some(stdlib_root) => files
            .into_iter()
            .filter(|file| !is_library_symbol_path(&file.to_string_lossy(), Some(stdlib_root)))
            .collect(),
    }
}

pub fn load_library_symbols_sync(
    state: &CoreState,
    root: String,
    target_path: Option<PathBuf>,
    include_symbols: bool,
) -> Result<LibrarySymbolsResponse, String> {
    let start = Instant::now();
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
    let library_config = project_config
        .as_ref()
        .and_then(|config| config.library.as_ref());
    let stdlib_override = project_config
        .as_ref()
        .and_then(|config| config.stdlib.as_ref());
    let (_loader, stdlib_path_for_log) = resolve_stdlib_path(
        &state.stdlib_root,
        default_stdlib.as_deref(),
        library_config,
        stdlib_override,
        &root_path,
    );

    let stdlib_start = Instant::now();
    let (
        stdlib_entries,
        _stdlib_metatype_index,
        stdlib_snapshot_symbols,
        _stdlib_snapshot_hit,
        stdlib_signature,
    ) = load_stdlib_snapshot(state, stdlib_path_for_log.as_deref())?;
    let stdlib_files = stdlib_entries
        .iter()
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    let library_files = stdlib_files
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let symbols = if include_symbols {
        let selected_files = select_symbol_files(&stdlib_files, target_path.as_deref());
        let selected = selected_files
            .iter()
            .map(|path| normalized_compare_key(path))
            .collect::<HashSet<_>>();
        stdlib_snapshot_symbols
            .iter()
            .cloned()
            .into_iter()
            .filter(|symbol| {
                target_path.is_none()
                    || selected.contains(&normalized_compare_key(Path::new(&symbol.file_path)))
            })
            .map(|symbol| map_stdlib_symbol_to_symbol_view(&symbol))
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let stdlib_cache_hit = !stdlib_signature.is_empty()
        && stdlib_path_for_log.as_ref().is_some_and(|path| {
            let key = normalized_compare_key(path);
            state
                .symbol_index
                .lock()
                .ok()
                .map(|store| store.is_stdlib_index_fresh(&root, &key, &stdlib_signature))
                .unwrap_or(false)
        });
    let stdlib_file_count = stdlib_files.len();
    let stdlib_duration_ms = stdlib_start.elapsed().as_millis();

    let library_path_text = stdlib_path_for_log
        .as_ref()
        .map(|path| path.to_string_lossy().to_string());
    let library_key = stdlib_path_for_log
        .as_ref()
        .map(|path| normalized_compare_key(path));
    let can_mark_freshness = target_path.is_none() && !stdlib_signature.is_empty();
    let should_index_stdlib = if let Some(key) = library_key.as_ref() {
        if !include_symbols {
            false
        } else if can_mark_freshness {
            let store = state
                .symbol_index
                .lock()
                .map_err(|_| "Symbol index lock poisoned".to_string())?;
            !store.is_stdlib_index_fresh(&root, key, &stdlib_signature)
        } else {
            include_symbols
        }
    } else {
        include_symbols
    };
    let response = LibrarySymbolsResponse {
        ok: true,
        symbols,
        library_files,
        library_path: library_path_text,
        stdlib_cache_hit,
        stdlib_duration_ms,
        stdlib_file_count,
        total_duration_ms: start.elapsed().as_millis(),
    };
    if should_index_stdlib {
        let symbols_for_index = response.symbols.clone();
        let _ = index_symbols_for_project(
            state,
            &root,
            stdlib_path_for_log.as_deref(),
            &symbols_for_index,
            true,
            false,
        );
        if let (Some(key), true) = (library_key.as_ref(), can_mark_freshness) {
            if let Ok(mut store) = state.symbol_index.lock() {
                store.mark_stdlib_indexed(&root, key, &stdlib_signature);
            }
        }
    }
    Ok(response)
}

fn load_stdlib_snapshot(
    state: &CoreState,
    stdlib_path: Option<&Path>,
) -> Result<
    (
        Vec<(PathBuf, String)>,
        Arc<MetatypeIndex>,
        Arc<Vec<StdlibSymbol>>,
        bool,
        String,
    ),
    String,
> {
    let mut cache = state
        .stdlib_cache
        .lock()
        .map_err(|_| "Stdlib cache lock poisoned".to_string())?;
    load_stdlib_snapshot_with_cache(stdlib_path, &mut cache, build_stdlib_snapshot)
}

fn build_stdlib_snapshot(entries: &[(PathBuf, String)]) -> (MetatypeIndex, Vec<StdlibSymbol>) {
    let (index, symbols) = build_stdlib_snapshot_rows(entries);
    (index, symbols.into_iter().map(map_stdlib_symbol_row).collect())
}

fn map_stdlib_symbol_row(row: StdlibSymbolRow) -> StdlibSymbol {
    StdlibSymbol {
        file_path: row.file_path,
        name: row.name,
        qualified_name: row.qualified_name,
        kind: row.kind,
        start_line: row.start_line,
        start_col: row.start_col,
        end_line: row.end_line,
        end_col: row.end_col,
    }
}

fn select_symbol_files(candidates: &[PathBuf], target_path: Option<&Path>) -> Vec<PathBuf> {
    match target_path {
        None => candidates.to_vec(),
        Some(target) => candidates
            .iter()
            .filter(|candidate| same_path(candidate, target))
            .cloned()
            .collect(),
    }
}

fn build_symbol_span_seed_from_index(
    state: &CoreState,
    project_root: &str,
    files: &[PathBuf],
) -> HashMap<String, SymbolSpan> {
    if files.is_empty() {
        return HashMap::new();
    }
    let file_keys = files
        .iter()
        .map(|path| normalized_compare_key(path))
        .collect::<HashSet<_>>();
    let Ok(store) = state.symbol_index.lock() else {
        return HashMap::new();
    };
    store
        .project_symbols(project_root, None)
        .into_iter()
        .filter(|symbol| file_keys.contains(&normalized_compare_key(Path::new(&symbol.file_path))))
        .map(|symbol| {
            (
                symbol_key(&symbol.file_path, &symbol.qualified_name),
                SymbolSpan {
                    start_line: symbol.start_line,
                    start_col: symbol.start_col,
                    end_line: symbol.end_line,
                    end_col: symbol.end_col,
                },
            )
        })
        .collect()
}

fn same_path(left: &Path, right: &Path) -> bool {
    normalized_compare_key(left) == normalized_compare_key(right)
}

fn normalized_compare_key(path: &Path) -> String {
    normalized_compare_key_shared(path)
}

fn unsaved_content_for_path<'a>(
    unsaved_map: &'a HashMap<PathBuf, String>,
    path: &Path,
) -> Option<&'a String> {
    unsaved_map.get(path).or_else(|| {
        unsaved_map
            .iter()
            .find(|(candidate, _)| same_path(candidate, path))
            .map(|(_, content)| content)
    })
}

fn augment_owned_relationships(symbols: &mut [SymbolView]) {
    fn is_owned_attribute_symbol(symbol: &SymbolView) -> bool {
        if symbol.kind.to_ascii_lowercase().contains("attribute") {
            return true;
        }
        symbol_metatype_qname(symbol)
            .map(|metatype| metatype.to_ascii_lowercase().contains("attribute"))
            .unwrap_or(false)
    }

    let mut qname_to_index = HashMap::<String, usize>::new();
    for (idx, symbol) in symbols.iter().enumerate() {
        qname_to_index.entry(symbol.qualified_name.clone()).or_insert(idx);
    }
    let is_attribute_by_qname = symbols
        .iter()
        .map(|symbol| {
            (
                symbol.qualified_name.clone(),
                is_owned_attribute_symbol(symbol),
            )
        })
        .collect::<HashMap<_, _>>();

    let mut relationships_by_parent = HashMap::<usize, Vec<RelationshipView>>::new();
    for symbol in symbols.iter() {
        let Some((parent_qname, _)) = symbol.qualified_name.rsplit_once("::") else {
            continue;
        };
        let Some(parent_idx) = qname_to_index.get(parent_qname).copied() else {
            continue;
        };
        let relationship_kind = if symbol.kind == "OwnedEnd" {
            "ownedEnd"
        } else {
            "ownedMember"
        };
        relationships_by_parent
            .entry(parent_idx)
            .or_default()
            .push(RelationshipView {
                kind: relationship_kind.to_string(),
                target: symbol.qualified_name.clone(),
                resolved_target: Some(symbol.qualified_name.clone()),
                start_line: symbol.start_line,
                start_col: symbol.start_col,
                end_line: symbol.end_line,
                end_col: symbol.end_col,
            });
    }

    for (parent_idx, mut edges) in relationships_by_parent {
        let parent = &mut symbols[parent_idx];
        edges.sort_by(|a, b| {
            a.start_line
                .cmp(&b.start_line)
                .then(a.start_col.cmp(&b.start_col))
                .then(a.target.cmp(&b.target))
        });
        for edge in edges {
            let exists = parent
                .relationships
                .iter()
                .any(|existing| existing.kind == edge.kind && existing.target == edge.target);
            if !exists {
                parent.relationships.push(edge);
            }
        }
        let owned_member_count = parent
            .relationships
            .iter()
            .filter(|rel| rel.kind == "ownedMember")
            .count() as u64;
        upsert_number_property(
            &mut parent.properties,
            "owned_member_count",
            owned_member_count,
            Some("ownership"),
        );
        let owned_end_count = parent
            .relationships
            .iter()
            .filter(|rel| rel.kind == "ownedEnd")
            .count() as u64;
        if owned_end_count > 0 {
            upsert_number_property(
                &mut parent.properties,
                "owned_end_count",
                owned_end_count,
                Some("connection"),
            );
        }
        let mut owned_attributes = Vec::<String>::new();
        for rel in parent.relationships.iter().filter(|rel| rel.kind == "ownedMember") {
            let Some(is_attribute) = is_attribute_by_qname.get(&rel.target) else {
                continue;
            };
            if *is_attribute
                && !owned_attributes.iter().any(|target| target == &rel.target)
            {
                owned_attributes.push(rel.target.clone());
            }
        }
        if !owned_attributes.is_empty() {
            upsert_list_property(
                &mut parent.properties,
                "ownedAttributes",
                owned_attributes,
                Some("ownership"),
            );
        }
    }
}

fn upsert_number_property(
    properties: &mut Vec<PropertyItemView>,
    name: &str,
    value: u64,
    group: Option<&str>,
) {
    if let Some(property) = properties.iter_mut().find(|prop| prop.name == name) {
        property.value = PropertyValueView::Number { value };
        property.group = group.map(|value| value.to_string());
        return;
    }
    properties.push(PropertyItemView {
        name: name.to_string(),
        label: name.to_string(),
        value: PropertyValueView::Number { value },
        hint: None,
        group: group.map(|value| value.to_string()),
    });
}

fn upsert_list_property(
    properties: &mut Vec<PropertyItemView>,
    name: &str,
    items: Vec<String>,
    group: Option<&str>,
) {
    if let Some(property) = properties.iter_mut().find(|prop| prop.name == name) {
        property.value = PropertyValueView::List { items };
        property.group = group.map(|value| value.to_string());
        return;
    }
    properties.push(PropertyItemView {
        name: name.to_string(),
        label: name.to_string(),
        value: PropertyValueView::List { items },
        hint: None,
        group: group.map(|value| value.to_string()),
    });
}

fn map_stdlib_symbol_to_symbol_view(symbol: &StdlibSymbol) -> SymbolView {
    SymbolView {
        file_path: symbol.file_path.clone(),
        name: symbol.name.clone(),
        short_name: None,
        qualified_name: symbol.qualified_name.clone(),
        kind: symbol.kind.clone(),
        file: 0,
        start_line: symbol.start_line,
        start_col: symbol.start_col,
        end_line: symbol.end_line,
        end_col: symbol.end_col,
        expr_start_line: None,
        expr_start_col: None,
        expr_end_line: None,
        expr_end_col: None,
        short_name_start_line: None,
        short_name_start_col: None,
        short_name_end_line: None,
        short_name_end_col: None,
        doc: None,
        supertypes: Vec::new(),
        relationships: Vec::new(),
        type_refs: Vec::new(),
        is_public: true,
        properties: vec![PropertyItemView {
            name: "kind".to_string(),
            label: "kind".to_string(),
            value: PropertyValueView::Text {
                value: symbol.kind.clone(),
            },
            hint: None,
            group: None,
        }],
    }
}

fn map_semantic_element_to_symbol(
    element: SemanticElementView,
    symbol_spans: &HashMap<String, SymbolSpan>,
) -> SymbolView {
    let projected = map_semantic_element_to_projected_symbol(element, symbol_spans);
    map_projected_semantic_symbol(projected)
}

fn map_projected_semantic_symbol(symbol: ProjectedSemanticSymbol) -> SymbolView {
    SymbolView {
        file_path: symbol.file_path,
        name: symbol.name,
        short_name: None,
        qualified_name: symbol.qualified_name,
        kind: symbol.kind,
        file: 0,
        start_line: symbol.start_line,
        start_col: symbol.start_col,
        end_line: symbol.end_line,
        end_col: symbol.end_col,
        expr_start_line: None,
        expr_start_col: None,
        expr_end_line: None,
        expr_end_col: None,
        short_name_start_line: None,
        short_name_start_col: None,
        short_name_end_line: None,
        short_name_end_col: None,
        doc: symbol.doc,
        supertypes: symbol.supertypes,
        relationships: symbol
            .relationships
            .into_iter()
            .map(|rel| RelationshipView {
                kind: rel.kind,
                target: rel.target,
                resolved_target: rel.resolved_target,
                start_line: rel.start_line,
                start_col: rel.start_col,
                end_line: rel.end_line,
                end_col: rel.end_col,
            })
            .collect(),
        type_refs: Vec::new(),
        is_public: symbol.is_public,
        properties: symbol
            .properties
            .into_iter()
            .map(|item| PropertyItemView {
                name: item.name,
                label: item.label,
                value: map_projected_property_value(item.value),
                hint: item.hint,
                group: item.group,
            })
            .collect(),
    }
}

fn map_projected_property_value(value: ProjectedPropertyValue) -> PropertyValueView {
    match value {
        ProjectedPropertyValue::Text { value } => PropertyValueView::Text { value },
        ProjectedPropertyValue::List { items } => PropertyValueView::List { items },
        ProjectedPropertyValue::Bool { value } => PropertyValueView::Bool { value },
        ProjectedPropertyValue::Number { value } => PropertyValueView::Number { value },
    }
}

fn symbol_metatype_qname(symbol: &SymbolView) -> Option<String> {
    for property in &symbol.properties {
        if property.name != "metatype_qname" {
            continue;
        }
        if let PropertyValueView::Text { value } = &property.value {
            if !value.trim().is_empty() {
                return Some(value.clone());
            }
        }
    }
    None
}

fn index_symbols_for_project(
    state: &CoreState,
    project_root: &str,
    library_path: Option<&Path>,
    symbols: &[SymbolView],
    rebuild_mappings: bool,
    non_blocking_lock: bool,
) -> Result<(), String> {
    let library_key = library_path.map(|path| normalized_compare_key(path));
    let raw = symbols
        .iter()
        .map(|symbol| RawIndexSymbol {
            file_path: symbol.file_path.clone(),
            name: symbol.name.clone(),
            qualified_name: symbol.qualified_name.clone(),
            kind: symbol.kind.clone(),
            metatype_qname: symbol_metatype_qname(symbol),
            start_line: symbol.start_line,
            start_col: symbol.start_col,
            end_line: symbol.end_line,
            end_col: symbol.end_col,
            doc_text: symbol.doc.clone(),
            properties_json: serde_json::to_string(&serde_json::json!({
                "schema": 1,
                "properties": symbol.properties
            }))
            .ok(),
        })
        .collect::<Vec<_>>();
    let prepared = prepare_symbols_for_index(raw, library_path);
    let grouped = group_prepared_symbols_by_file(prepared);
    let canonical_rows_by_file =
        build_canonical_symbol_rows_by_file(project_root, library_key.as_deref(), grouped);
    let mut store = if non_blocking_lock {
        state
            .symbol_index
            .try_lock()
            .map_err(|_| "Symbol index busy".to_string())?
    } else {
        state
            .symbol_index
            .lock()
            .map_err(|_| "Symbol index lock poisoned".to_string())?
    };
    for (file_path, rows) in canonical_rows_by_file {
        let entries = rows
            .into_iter()
            .map(|row| SymbolRecord {
                id: row.id,
                project_root: row.project_root,
                library_key: row.library_key,
                scope: match row.scope {
                    PreparedScope::Stdlib => mercurio_symbol_index::Scope::Stdlib,
                    PreparedScope::Project => mercurio_symbol_index::Scope::Project,
                },
                name: row.name,
                qualified_name: row.qualified_name,
                kind: row.kind,
                metatype_qname: row.metatype_qname,
                file_path: row.file_path,
                start_line: row.start_line,
                start_col: row.start_col,
                end_line: row.end_line,
                end_col: row.end_col,
                doc_text: row.doc_text,
                properties_json: row.properties_json,
            })
            .collect::<Vec<SymbolRecord>>();
        store.upsert_symbols_for_file(project_root, &file_path, entries);
    }
    if rebuild_mappings {
        store.rebuild_symbol_mappings(project_root);
    }
    Ok(())
}

fn symbol_key(file_path: &str, qualified_name: &str) -> String {
    format!("{file_path}|{qualified_name}")
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

#[cfg(test)]
mod tests {
    use super::*;
    use mercurio_sysml_pkg::compile_support::canonical_symbol_id as canonical_symbol_id_shared;
    use crate::settings::AppSettings;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn stdlib_snapshot_includes_comments_docs_and_metaclass_defs() {
        let source = "\
standard library package KerML {
  doc /* package doc */
  comment cmt /* named */

  package Root {
    metaclass AnnotatingElement specializes Element {
      derived var feature annotation : Annotation[0..*] ordered;
    }
  }
}
";
        let entries = vec![(PathBuf::from("KerML.kerml"), source.to_string())];
        let (_index, symbols) = build_stdlib_snapshot(&entries);

        assert!(symbols.iter().any(|symbol| symbol.kind == "Package"));
        assert!(symbols
            .iter()
            .any(|symbol| symbol.kind == "Documentation" && symbol.qualified_name.starts_with("KerML::doc@")));
        assert!(symbols
            .iter()
            .any(|symbol| symbol.kind == "Comment" && symbol.qualified_name == "KerML::cmt"));
        assert!(symbols.iter().any(|symbol| {
            symbol.kind == "MetaclassDef"
                && symbol.qualified_name == "KerML::Root::AnnotatingElement"
        }));
    }

    #[test]
    fn compile_workspace_emits_library_metaclass_symbol_for_tree() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_library_smoke_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");

        let library_source = "\
standard library package KerML {
  package Root {
    metaclass AnnotatingElement specializes Element {}
  }
}
";
        fs::write(library_dir.join("KerML.kerml"), library_source).expect("write library file");
        fs::write(project_dir.join("main.sysml"), "package P {}\n").expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"smoke\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write project descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let response = compile_workspace_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            1,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile response");

        assert!(response.ok);
        assert!(response.stdlib_file_count >= 1);
        assert!(response
            .symbols
            .iter()
            .any(|symbol| symbol.kind == "MetaclassDef"
                && symbol.name == "AnnotatingElement"
                && symbol.qualified_name.ends_with("KerML::Root::AnnotatingElement")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn compile_workspace_file_scoped_still_emits_library_symbols() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_library_scoped_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");

        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { package Root { metaclass AnnotatingElement specializes Element {} } }",
        )
        .expect("write library file");
        let project_file = project_dir.join("main.sysml");
        fs::write(&project_file, "package P { part def A; }\n").expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"scoped\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write project descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let response = compile_workspace_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            1,
            true,
            Some(project_file),
            Vec::new(),
            |_| {},
        )
        .expect("compile response");

        assert!(response.ok);
        assert!(response.symbols.iter().any(|symbol| {
            symbol.kind == "MetaclassDef" && symbol.qualified_name.ends_with("KerML::Root::AnnotatingElement")
        }));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn span_to_line_col_is_one_based() {
        let text = "package A {\n  part def P;\n}\n";
        let file = PathBuf::from("main.sysml");
        let mut unsaved = HashMap::new();
        unsaved.insert(file.clone(), text.to_string());
        let spans = build_symbol_span_index(&[file.clone()], &unsaved);
        let key = symbol_key(&file.to_string_lossy(), "A::P");
        let span = spans.get(&key).expect("symbol span for A::P");
        assert_eq!(span.start_line, 2);
        assert_eq!(span.start_col, 3);
        assert_eq!(span.end_line, 2);
        assert!(span.end_col >= span.start_col);
    }

    #[test]
    fn library_snapshot_cache_invalidates_when_file_changes() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_stdlib_cache_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(project_dir.join("main.sysml"), "package P {}\n").expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"cache\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write project descriptor");

        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { package Root { metaclass A specializes Element {} } }",
        )
        .expect("write initial library file");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let first = load_library_symbols_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            None,
            true,
        )
        .expect("first load");
        assert!(!first.stdlib_cache_hit);

        let second = load_library_symbols_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            None,
            true,
        )
        .expect("second load");
        assert!(second.stdlib_cache_hit);

        std::thread::sleep(std::time::Duration::from_millis(5));
        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { package Root { metaclass B specializes Element {} } }",
        )
        .expect("update library file");

        let third = load_library_symbols_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            None,
            true,
        )
        .expect("third load");
        assert!(!third.stdlib_cache_hit);
        assert!(third
            .symbols
            .iter()
            .any(|symbol| symbol.kind == "MetaclassDef" && symbol.name == "B"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stdlib_snapshot_comments2_emits_package_docs_and_comments() {
        let source = "\
package Comments2 {
  doc /* Documentation Comment */
  doc /* Documentation about Package */
  comment cmt /* Named Comment */
  comment cmt_cmt about cmt /* Comment about Comment */
  comment about C /* Documention Comment on Part Def */
  part def C {
    doc /* Documentation in Part Def */
    comment /* Comment in Part Def */
    comment about Comments2 /* Comment about Package */
  }
}
";
        let entries = vec![(PathBuf::from("Comments2.sysml"), source.to_string())];
        let (_index, symbols) = build_stdlib_snapshot(&entries);

        assert!(symbols
            .iter()
            .any(|symbol| symbol.kind == "Package" && symbol.qualified_name == "Comments2"));
        assert!(symbols.iter().any(|symbol| {
            symbol.kind == "Documentation" && symbol.qualified_name.starts_with("Comments2::doc@")
        }));
        assert!(symbols
            .iter()
            .any(|symbol| symbol.kind == "Comment" && symbol.name == "cmt"));
        assert!(symbols
            .iter()
            .any(|symbol| symbol.kind == "Comment" && symbol.name == "cmt_cmt"));
    }

    #[test]
    fn load_library_symbols_file_scope_only_returns_requested_file() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_library_file_scope_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(project_dir.join("main.sysml"), "package P {}\n").expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"scope\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write project descriptor");

        let kerml_a = library_dir.join("A.kerml");
        let kerml_b = library_dir.join("B.kerml");
        fs::write(
            &kerml_a,
            "standard library package KerMLA { package Root { metaclass A specializes Element {} } }",
        )
        .expect("write A library file");
        fs::write(
            &kerml_b,
            "standard library package KerMLB { package Root { metaclass B specializes Element {} } }",
        )
        .expect("write B library file");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let response = load_library_symbols_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            Some(kerml_b.clone()),
            true,
        )
        .expect("file scoped load");

        assert_eq!(response.library_files.len(), 2);
        assert!(!response.symbols.is_empty());
        let target = normalized_compare_key(&kerml_b);
        assert!(response
            .symbols
            .iter()
            .all(|symbol| normalized_compare_key(Path::new(&symbol.file_path)) == target));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn load_library_symbols_without_symbols_still_returns_library_files() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_library_files_only_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(project_dir.join("main.sysml"), "package P {}\n").expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"scope\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write project descriptor");
        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { package Root { metaclass A specializes Element {} } }",
        )
        .expect("write library file");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let response = load_library_symbols_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            None,
            false,
        )
        .expect("load files only");
        assert_eq!(response.symbols.len(), 0);
        assert_eq!(response.library_files.len(), 1);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn compile_project_delta_excludes_library_symbols() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_project_delta_symbols_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { package Root { metaclass AnnotatingElement specializes Element {} } }",
        )
        .expect("write library file");
        fs::write(project_dir.join("main.sysml"), "package P { part def A; }\n")
            .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"delta\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write project descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let response = compile_project_delta_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            1,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("delta compile");

        assert!(response.ok);
        assert_eq!(response.library_symbol_count, 0);
        assert!(response
            .symbols
            .iter()
            .all(|symbol| !symbol.qualified_name.contains("KerML::Root::AnnotatingElement")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn compile_project_delta_symbol_span_is_one_based() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_delta_span_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { package Root { metaclass Element specializes Anything {} } }",
        )
        .expect("write library file");
        let project_file = project_dir.join("main.sysml");
        fs::write(&project_file, "package P {\n  part def A;\n}\n").expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"delta-span\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write project descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let response = compile_project_delta_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            1,
            true,
            Some(project_file),
            Vec::new(),
            |_| {},
        )
        .expect("delta compile");

        let symbol = response
            .symbols
            .iter()
            .find(|symbol| symbol.name == "A")
            .expect("part symbol A present");
        assert_eq!(symbol.start_line, 2);
        assert_eq!(symbol.start_col, 3);
        assert!(symbol.end_line >= symbol.start_line);
        assert!(symbol.end_col >= symbol.start_col);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stdlib_snapshot_kerml_multimetaclass_symbols_present() {
        let source = "\
standard library package KerML {
  private import ScalarValues::*;
  public import Kernel::*;
  package Root {
    metaclass AnnotatingElement specializes Element {}
    metaclass Annotation specializes Relationship {}
  }
}
";
        let entries = vec![(PathBuf::from("KerML.kerml"), source.to_string())];
        let (_index, symbols) = build_stdlib_snapshot(&entries);
        assert!(symbols
            .iter()
            .any(|symbol| symbol.kind == "Import" && symbol.qualified_name.contains("ScalarValues")));
        assert!(symbols
            .iter()
            .any(|symbol| symbol.kind == "Import" && symbol.qualified_name.contains("Kernel")));
        assert!(symbols.iter().any(|symbol| {
            symbol.kind == "MetaclassDef"
                && symbol.qualified_name == "KerML::Root::AnnotatingElement"
        }));
        assert!(symbols.iter().any(|symbol| {
            symbol.kind == "MetaclassDef" && symbol.qualified_name == "KerML::Root::Annotation"
        }));
        let metaclass_count = symbols
            .iter()
            .filter(|symbol| symbol.kind == "MetaclassDef")
            .count();
        assert!(metaclass_count >= 2);
    }

    #[test]
    fn load_library_symbols_includes_import_symbols() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_library_import_symbols_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(project_dir.join("main.sysml"), "package P {}\n").expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"imports\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write project descriptor");
        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { private import ScalarValues::*; package Root { metaclass A specializes Element {} } }",
        )
        .expect("write library file");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let response = load_library_symbols_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            None,
            true,
        )
        .expect("library load");
        assert!(response
            .symbols
            .iter()
            .any(|symbol| symbol.kind == "Import" && symbol.qualified_name.contains("ScalarValues")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn compile_workspace_library_symbol_count_includes_imports() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_compile_import_count_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { private import ScalarValues::*; package Root { metaclass A specializes Element {} } }",
        )
        .expect("write library file");
        fs::write(project_dir.join("main.sysml"), "package P { part def A; }\n")
            .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"count\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write project descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let response = compile_workspace_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            1,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile response");

        assert!(response.library_symbol_count >= 2);
        assert!(response
            .symbols
            .iter()
            .any(|symbol| symbol.kind == "Import" && symbol.qualified_name.contains("ScalarValues")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn compile_workspace_does_not_synthesize_project_import_symbols() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_project_import_symbols_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { package Root { metaclass Element specializes Anything {} } }",
        )
        .expect("write library file");
        fs::write(
            project_dir.join("main.sysml"),
            "package P {\n  private import ScalarValues::Real;\n  part def A;\n}\n",
        )
        .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"project-imports\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write project descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let response = compile_workspace_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            1,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile response");

        assert!(!response
            .symbols
            .iter()
            .any(|symbol| symbol.kind == "Import" && symbol.file_path.ends_with("main.sysml")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn compile_workspace_does_not_synthesize_connection_end_symbols_locally() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_connection_end_symbols_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { package Root { metaclass Element specializes Anything {} } }",
        )
        .expect("write library file");
        fs::write(
            project_dir.join("main.sysml"),
            "package Demo {\nconnection def ProductSelection {\n  end [0..1] item cart: ShoppingCart[1];\n  end [0..*] item selectedProduct: Product[1];\n  end [1..1] item account : Account[1];\n}\n}\n",
        )
        .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"connection-ends\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write project descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let response = compile_workspace_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            1,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile response");

        assert!(!response
            .symbols
            .iter()
            .any(|symbol| symbol.kind == "OwnedEnd" && symbol.file_path.ends_with("main.sysml")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn compile_workspace_assigns_general_owned_member_relationships() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_owned_member_symbols_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { package Root { metaclass Element specializes Anything {} } }",
        )
        .expect("write library file");
        fs::write(
            project_dir.join("main.sysml"),
            "package Demo {\npart def A;\n}\n",
        )
        .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"owned-member\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write project descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let response = compile_workspace_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            1,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile response");

        let package = response
            .symbols
            .iter()
            .find(|symbol| symbol.kind == "Package" && symbol.qualified_name == "Demo")
            .expect("package symbol");
        assert!(package
            .relationships
            .iter()
            .any(|rel| rel.kind == "ownedMember" && rel.target == "Demo::A"));
        assert!(package.properties.iter().any(|prop| {
            prop.name == "owned_member_count"
                && matches!(prop.value, PropertyValueView::Number { value } if value >= 1)
        }));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn augment_owned_relationships_adds_owned_attributes_property() {
        fn symbol(kind: &str, qualified_name: &str, start_line: u32) -> SymbolView {
            let name = qualified_name
                .rsplit("::")
                .next()
                .unwrap_or(qualified_name)
                .to_string();
            SymbolView {
                file_path: "main.sysml".to_string(),
                name,
                short_name: None,
                qualified_name: qualified_name.to_string(),
                kind: kind.to_string(),
                file: 0,
                start_line,
                start_col: 1,
                end_line: start_line,
                end_col: 10,
                expr_start_line: None,
                expr_start_col: None,
                expr_end_line: None,
                expr_end_col: None,
                short_name_start_line: None,
                short_name_start_col: None,
                short_name_end_line: None,
                short_name_end_col: None,
                doc: None,
                supertypes: Vec::new(),
                relationships: Vec::new(),
                type_refs: Vec::new(),
                is_public: true,
                properties: Vec::new(),
            }
        }

        let mut symbols = vec![
            symbol("PartDef", "Demo::ScenarioState", 1),
            symbol("AttributeUsage", "Demo::ScenarioState::speed", 2),
            symbol("AttributeUsage", "Demo::ScenarioState::heading", 3),
            symbol("PartDef", "Demo::ScenarioState::nestedPart", 4),
        ];
        augment_owned_relationships(&mut symbols);

        let parent = symbols
            .iter()
            .find(|symbol| symbol.qualified_name == "Demo::ScenarioState")
            .expect("scenario state symbol");
        let owned_attrs_prop = parent
            .properties
            .iter()
            .find(|prop| prop.name == "ownedAttributes")
            .expect("ownedAttributes property");
        match &owned_attrs_prop.value {
            PropertyValueView::List { items } => {
                assert_eq!(
                    items,
                    &vec![
                        "Demo::ScenarioState::speed".to_string(),
                        "Demo::ScenarioState::heading".to_string()
                    ]
                );
            }
            _ => panic!("ownedAttributes should be a list"),
        }
    }

    #[test]
    fn augment_owned_relationships_detects_attribute_usage_via_metatype() {
        fn symbol(
            kind: &str,
            qualified_name: &str,
            start_line: u32,
            metatype_qname: Option<&str>,
        ) -> SymbolView {
            let mut properties = Vec::new();
            if let Some(metatype) = metatype_qname {
                properties.push(PropertyItemView {
                    name: "metatype_qname".to_string(),
                    label: "metatype_qname".to_string(),
                    value: PropertyValueView::Text {
                        value: metatype.to_string(),
                    },
                    hint: None,
                    group: None,
                });
            }
            let name = qualified_name
                .rsplit("::")
                .next()
                .unwrap_or(qualified_name)
                .to_string();
            SymbolView {
                file_path: "main.sysml".to_string(),
                name,
                short_name: None,
                qualified_name: qualified_name.to_string(),
                kind: kind.to_string(),
                file: 0,
                start_line,
                start_col: 1,
                end_line: start_line,
                end_col: 10,
                expr_start_line: None,
                expr_start_col: None,
                expr_end_line: None,
                expr_end_col: None,
                short_name_start_line: None,
                short_name_start_col: None,
                short_name_end_line: None,
                short_name_end_col: None,
                doc: None,
                supertypes: Vec::new(),
                relationships: Vec::new(),
                type_refs: Vec::new(),
                is_public: true,
                properties,
            }
        }

        let mut symbols = vec![
            symbol("PartDef", "Demo::ScenarioState", 1, None),
            symbol(
                "Usage",
                "Demo::ScenarioState::speed",
                2,
                Some("sysml::AttributeUsage"),
            ),
            symbol(
                "Usage",
                "Demo::ScenarioState::sensor",
                3,
                Some("sysml::PartUsage"),
            ),
        ];
        augment_owned_relationships(&mut symbols);

        let parent = symbols
            .iter()
            .find(|symbol| symbol.qualified_name == "Demo::ScenarioState")
            .expect("scenario state symbol");
        let owned_attrs_prop = parent
            .properties
            .iter()
            .find(|prop| prop.name == "ownedAttributes")
            .expect("ownedAttributes property");
        match &owned_attrs_prop.value {
            PropertyValueView::List { items } => {
                assert_eq!(items, &vec!["Demo::ScenarioState::speed".to_string()]);
            }
            _ => panic!("ownedAttributes should be a list"),
        }
    }

    #[test]
    fn map_semantic_element_parses_emf_owned_elements_as_list_property() {
        let mut attrs = HashMap::new();
        attrs.insert("emf::name".to_string(), "ScenarioState".to_string());
        attrs.insert(
            "emf::qualifiedName".to_string(),
            "Demo::ScenarioState".to_string(),
        );
        attrs.insert(
            "emf::ownedElements".to_string(),
            "Demo::ScenarioState::speed, Demo::ScenarioState::heading".to_string(),
        );
        let element = SemanticElementView {
            name: "ScenarioState".to_string(),
            qualified_name: "Demo::ScenarioState".to_string(),
            metatype_qname: Some("sysml::PartDefinition".to_string()),
            file_path: "main.sysml".to_string(),
            attributes: attrs,
        };
        let symbol = map_semantic_element_to_symbol(element, &HashMap::new());
        let owned_elements = symbol
            .properties
            .iter()
            .find(|prop| prop.name == "emf::ownedElements")
            .expect("emf::ownedElements property");
        match &owned_elements.value {
            PropertyValueView::List { items } => {
                assert_eq!(
                    items,
                    &vec![
                        "Demo::ScenarioState::speed".to_string(),
                        "Demo::ScenarioState::heading".to_string()
                    ]
                );
            }
            _ => panic!("emf::ownedElements should be a list"),
        }
    }

    #[test]
    fn map_semantic_element_uses_semantic_span_when_index_missing() {
        let mut attrs = HashMap::new();
        attrs.insert("emf::name".to_string(), "x".to_string());
        attrs.insert(
            "emf::qualifiedName".to_string(),
            "ActionTest::A::x".to_string(),
        );
        attrs.insert("emf::startLine".to_string(), "6".to_string());
        attrs.insert("emf::startColumn".to_string(), "9".to_string());
        attrs.insert("emf::endLine".to_string(), "6".to_string());
        attrs.insert("emf::endColumn".to_string(), "10".to_string());
        let element = SemanticElementView {
            name: "x".to_string(),
            qualified_name: "ActionTest::A::x".to_string(),
            metatype_qname: Some("sysml::Usage".to_string()),
            file_path: "ActionTest.sysml".to_string(),
            attributes: attrs,
        };

        let symbol = map_semantic_element_to_symbol(element, &HashMap::new());
        assert_eq!(symbol.start_line, 6);
        assert_eq!(symbol.start_col, 9);
        assert_eq!(symbol.end_line, 6);
        assert_eq!(symbol.end_col, 10);
    }

    #[test]
    fn map_semantic_element_prefers_index_span_over_semantic_span() {
        let mut attrs = HashMap::new();
        attrs.insert("emf::name".to_string(), "x".to_string());
        attrs.insert(
            "emf::qualifiedName".to_string(),
            "ActionTest::A::x".to_string(),
        );
        attrs.insert("emf::startLine".to_string(), "6".to_string());
        attrs.insert("emf::startColumn".to_string(), "9".to_string());
        attrs.insert("emf::endLine".to_string(), "6".to_string());
        attrs.insert("emf::endColumn".to_string(), "10".to_string());
        let element = SemanticElementView {
            name: "x".to_string(),
            qualified_name: "ActionTest::A::x".to_string(),
            metatype_qname: Some("sysml::Usage".to_string()),
            file_path: "ActionTest.sysml".to_string(),
            attributes: attrs,
        };
        let mut index = HashMap::new();
        index.insert(
            symbol_key("ActionTest.sysml", "ActionTest::A::x"),
            SymbolSpan {
                start_line: 12,
                start_col: 2,
                end_line: 12,
                end_col: 5,
            },
        );

        let symbol = map_semantic_element_to_symbol(element, &index);
        assert_eq!(symbol.start_line, 12);
        assert_eq!(symbol.start_col, 2);
        assert_eq!(symbol.end_line, 12);
        assert_eq!(symbol.end_col, 5);
    }

    #[test]
    fn stdlib_cache_retained_across_project_switches() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_stdlib_switch_cache_{stamp}"));
        let stdlib_a = root.join("stdlib_a");
        let stdlib_b = root.join("stdlib_b");
        let project_a = root.join("project_a");
        let project_b = root.join("project_b");
        fs::create_dir_all(&stdlib_a).expect("create stdlib a");
        fs::create_dir_all(&stdlib_b).expect("create stdlib b");
        fs::create_dir_all(&project_a).expect("create project a");
        fs::create_dir_all(&project_b).expect("create project b");
        fs::write(
            stdlib_a.join("KerML.kerml"),
            "standard library package KA { package Root { metaclass A specializes Element {} } }",
        )
        .expect("write stdlib a");
        fs::write(
            stdlib_b.join("KerML.kerml"),
            "standard library package KB { package Root { metaclass B specializes Element {} } }",
        )
        .expect("write stdlib b");
        fs::write(project_a.join("main.sysml"), "package P {}\n").expect("write project a file");
        fs::write(project_b.join("main.sysml"), "package P {}\n").expect("write project b file");
        fs::write(
            project_a.join(".project"),
            format!(
                "{{\"name\":\"a\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                stdlib_a.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write project a descriptor");
        fs::write(
            project_b.join(".project"),
            format!(
                "{{\"name\":\"b\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                stdlib_b.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write project b descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let a1 = load_library_symbols_sync(&state, project_a.to_string_lossy().to_string(), None, true)
            .expect("load a1");
        assert!(!a1.stdlib_cache_hit);

        let b1 = load_library_symbols_sync(&state, project_b.to_string_lossy().to_string(), None, true)
            .expect("load b1");
        assert!(!b1.stdlib_cache_hit);

        let a2 = load_library_symbols_sync(&state, project_a.to_string_lossy().to_string(), None, true)
            .expect("load a2");
        assert!(a2.stdlib_cache_hit);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn compile_response_includes_parse_error_categories() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_parse_category_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { package Root { metaclass Element specializes Anything {} } }",
        )
        .expect("write library file");
        fs::write(project_dir.join("main.sysml"), "package P {\n  part def A\n}\n")
            .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"parse-categories\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let response = compile_project_delta_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            99,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile response");

        assert!(!response.ok);
        assert!(!response.parse_error_categories.is_empty());
        let total_categorized = response
            .parse_error_categories
            .iter()
            .map(|row| row.count)
            .sum::<usize>();
        assert!(total_categorized >= 1);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn compile_response_includes_unresolved_refs_from_project_ingest() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_unresolved_project_ingest_{stamp}"));
        let project_dir = root.join("project");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            project_dir.join("a.sysml"),
            "package A {\n  part def Wheel;\n}\n",
        )
        .expect("write a.sysml");
        fs::write(
            project_dir.join("b.sysml"),
            "package B {\n  dependency from Missing to Wheel;\n}\n",
        )
        .expect("write b.sysml");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let response = compile_project_delta_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            101,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile response");

        assert!(!response.unresolved.is_empty());
        assert!(response
            .unresolved
            .iter()
            .any(|issue| issue.message.contains("unresolved_ref")));
        assert!(response
            .unresolved
            .iter()
            .any(|issue| issue.file_path.ends_with("b.sysml")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn performance_warning_thresholds_are_reported() {
        let warnings = super::performance_warnings(800, 900, 600, 2100);
        assert!(warnings.iter().any(|w| w.contains("compile exceeded")));
        assert!(warnings.iter().any(|w| w.contains("parse stage exceeded")));
        assert!(warnings.iter().any(|w| w.contains("analysis stage exceeded")));
        assert!(warnings.iter().any(|w| w.contains("stdlib load exceeded")));
    }

    #[test]
    fn query_semantic_symbols_returns_project_symbol_views() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_semantic_symbols_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { package Root { metaclass Element specializes Anything {} } }",
        )
        .expect("write library file");
        fs::write(
            project_dir.join("main.sysml"),
            "package Demo {\n  part def Engine;\n}\n",
        )
        .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"semantic\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let project_root = project_dir.to_string_lossy().to_string();
        let _ = compile_project_delta_sync(
            &state,
            project_root.clone(),
            7,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile response");

        let semantic = query_semantic_symbols(&state, project_root).expect("query semantic symbols");
        assert!(!semantic.is_empty());
        assert!(semantic.iter().any(|symbol| symbol.qualified_name == "Demo"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn canonical_symbol_record_id_is_stable_and_scope_aware() {
        let symbol = SymbolView {
            name: "P".to_string(),
            short_name: None,
            kind: "Package".to_string(),
            file_path: "C:/tmp/project/main.sysml".to_string(),
            qualified_name: "P".to_string(),
            file: 0,
            start_line: 1,
            start_col: 2,
            end_line: 3,
            end_col: 4,
            expr_start_line: None,
            expr_start_col: None,
            expr_end_line: None,
            expr_end_col: None,
            short_name_start_line: None,
            short_name_start_col: None,
            short_name_end_line: None,
            short_name_end_col: None,
            doc: None,
            supertypes: Vec::new(),
            relationships: Vec::new(),
            type_refs: Vec::new(),
            is_public: true,
            properties: Vec::new(),
        };
        let file_key = normalized_compare_key(Path::new(&symbol.file_path));
        let project_id_a = canonical_symbol_id_shared(
            "rootA",
            PreparedScope::Project,
            &file_key,
            &symbol.qualified_name,
            &symbol.kind,
            symbol.start_line,
            symbol.start_col,
            symbol.end_line,
            symbol.end_col,
        );
        let project_id_b = canonical_symbol_id_shared(
            "rootA",
            PreparedScope::Project,
            &file_key,
            &symbol.qualified_name,
            &symbol.kind,
            symbol.start_line,
            symbol.start_col,
            symbol.end_line,
            symbol.end_col,
        );
        let stdlib_id = canonical_symbol_id_shared(
            "rootA",
            PreparedScope::Stdlib,
            &file_key,
            &symbol.qualified_name,
            &symbol.kind,
            symbol.start_line,
            symbol.start_col,
            symbol.end_line,
            symbol.end_col,
        );
        let other_root_id = canonical_symbol_id_shared(
            "rootB",
            PreparedScope::Project,
            &file_key,
            &symbol.qualified_name,
            &symbol.kind,
            symbol.start_line,
            symbol.start_col,
            symbol.end_line,
            symbol.end_col,
        );

        assert_eq!(project_id_a, project_id_b);
        assert_ne!(project_id_a, stdlib_id);
        assert_ne!(project_id_a, other_root_id);
        assert!(project_id_a.starts_with("v2|rootA|project|"));
    }
}
