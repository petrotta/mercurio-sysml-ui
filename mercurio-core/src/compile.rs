use mercurio_sysml_core::parser::Parser;
use mercurio_sysml_semantics::defmap::{DefKind, build_defmap, DefInfo};
use mercurio_sysml_semantics::hir::lower_defmap_with_cst;
use mercurio_sysml_semantics::model_rel::{
    ModelFileAnalysis, build_model_stdlib_relations_from_analyses,
};
use mercurio_sysml_semantics::stdlib::{MetatypeIndex, build_metatype_index_from_hirs};
use mercurio_sysml_semantics::semantic_contract::{
    SemanticElementView, SemanticIndexInput, SemanticPredicate, SemanticQuery, build_semantic_index,
};
use mercurio_symbol_index::{Scope, SymbolIndexStore, SymbolRecord};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Instant, SystemTime};

use crate::project::load_project_config;
use crate::index_contract::{canonical_symbol_record, CanonicalSymbolRecordArgs};
use crate::state::{StdlibCache, StdlibSymbol};
use crate::stdlib::resolve_stdlib_path;
use crate::workspace::{collect_model_files, collect_project_files};
use crate::CoreState;

pub use crate::state::CompileFileResult;

#[derive(Serialize)]
pub struct CompileResponse {
    pub ok: bool,
    pub files: Vec<CompileFileResult>,
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
        return Ok(CompileResponse {
            ok: false,
            files: file_results,
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
            parse_duration_ms: parse_start.elapsed().as_millis(),
            analysis_duration_ms: 0,
            stdlib_duration_ms: 0,
            stdlib_file_count: 0,
            total_duration_ms: compile_start.elapsed().as_millis(),
        });
    }

    let stdlib_start = Instant::now();
    let (stdlib_files, stdlib_metatype_index, stdlib_symbols, stdlib_cache_hit) =
        if include_library_symbols {
            let (
                stdlib_entries,
                stdlib_metatype_index,
                stdlib_symbols,
                stdlib_cache_hit,
                _stdlib_signature,
            ) = load_stdlib_snapshot(state, stdlib_path_for_log.as_deref())?;
            let files = stdlib_entries
                .iter()
                .map(|(path, _)| path.clone())
                .collect::<Vec<_>>();
            (files, stdlib_metatype_index, stdlib_symbols, stdlib_cache_hit)
        } else {
            let files = collect_stdlib_files(stdlib_path_for_log.as_deref())?;
            (
                files,
                Arc::new(MetatypeIndex::default()),
                Arc::new(Vec::new()),
                false,
            )
        };
    let stdlib_duration_ms = stdlib_start.elapsed().as_millis();

    let analysis_start = Instant::now();
    check_cancel()?;
    emit_progress("analysis", None, None, None);

    let project_symbol_files = select_symbol_files(&files, target_path.as_deref());
    let symbol_spans = build_symbol_span_index(&project_symbol_files, &unsaved_map);

    let mut symbols = Vec::new();
    let mut seen = HashSet::new();

    let mut project_symbol_count = 0usize;
    let mut library_symbol_count = 0usize;
    for symbol in project_decl_symbols(&project_symbol_files, &unsaved_map) {
        let key = format!("{}|{}|{}", symbol.file_path, symbol.qualified_name, symbol.name);
        if seen.insert(key) {
            symbols.push(symbol);
            project_symbol_count += 1;
        }
    }
    for symbol in project_connection_end_symbols(&project_symbol_files, &unsaved_map) {
        let key = format!("{}|{}|{}", symbol.file_path, symbol.qualified_name, symbol.name);
        if seen.insert(key) {
            symbols.push(symbol);
            project_symbol_count += 1;
        }
    }
    for symbol in project_import_symbols(&project_symbol_files, &unsaved_map) {
        let key = format!("{}|{}|{}", symbol.file_path, symbol.qualified_name, symbol.name);
        if seen.insert(key) {
            symbols.push(symbol);
            project_symbol_count += 1;
        }
    }
    // Delta compiles prioritize responsiveness for UI symbol tree updates.
    // Skip the expensive semantic projection pass here and rely on defmap-backed symbols.
    if include_library_symbols {
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

    let response = CompileResponse {
        ok: file_results.iter().all(|f| f.ok),
        files: file_results,
        symbols,
        project_symbol_count,
        library_symbol_count,
        unresolved: Vec::new(),
        library_path: stdlib_path_for_log
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        parse_failed: false,
        stdlib_cache_hit,
        parsed_files,
        parse_duration_ms: parse_start.elapsed().as_millis(),
        analysis_duration_ms,
        stdlib_duration_ms,
        stdlib_file_count: stdlib_files.len(),
        total_duration_ms: compile_start.elapsed().as_millis(),
    };
    if include_library_symbols {
        let _ = index_symbols_for_project(
            state,
            &root,
            stdlib_path_for_log.as_deref(),
            &response.symbols,
            true,
            false,
        );
    } else {
        let _ = index_symbols_for_project(
            state,
            &root,
            stdlib_path_for_log.as_deref(),
            &response.symbols,
            false,
            false,
        );
    }
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
    let stdlib_files = collect_stdlib_files(stdlib_path_for_log.as_deref())?;
    let library_files = stdlib_files
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let stdlib_signature = if stdlib_files.is_empty() {
        String::new()
    } else {
        stdlib_signature_key(&stdlib_files)?
    };
    let symbols = if include_symbols {
        let selected_files = select_symbol_files(&stdlib_files, target_path.as_deref());
        let selected = selected_files
            .iter()
            .map(|path| normalized_compare_key(path))
            .collect::<HashSet<_>>();
        let mut loaded = Vec::new();
        for file in &stdlib_files {
            if let Ok(text) = fs::read_to_string(file) {
                loaded.push((file.clone(), text));
            }
        }
        let fast_symbols = build_stdlib_symbols_only(&loaded);
        fast_symbols
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

fn build_stdlib_symbols_only(entries: &[(PathBuf, String)]) -> Vec<StdlibSymbol> {
    let mut symbols = Vec::new();
    for (path, source) in entries {
        let mut parser = Parser::new(source);
        let root = parser.parse_root();
        let defmap = build_defmap(&root, source);
        if let Some(package) = defmap.package.as_ref() {
            if let Some(symbol) = stdlib_symbol_from_def(path, package, source) {
                symbols.push(symbol);
            }
        }
        for import in &defmap.imports {
            if let Some(symbol) = stdlib_symbol_from_def(path, import, source) {
                symbols.push(symbol);
            }
        }
        for def in &defmap.defs {
            if let Some(symbol) = stdlib_symbol_from_def(path, def, source) {
                symbols.push(symbol);
            }
        }
        for dependency in &defmap.dependencies {
            if let Some(symbol) = stdlib_symbol_from_def(path, dependency, source) {
                symbols.push(symbol);
            }
        }
    }
    symbols
}

fn collect_stdlib_files(stdlib_path: Option<&Path>) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let Some(path) = stdlib_path else {
        return Ok(files);
    };
    if path.is_dir() {
        collect_model_files(path, &mut files)?;
    } else if path.is_file() {
        files.push(path.to_path_buf());
    }
    files.sort();
    files.dedup();
    Ok(files)
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
    let Some(stdlib_path) = stdlib_path else {
        return Ok((
            Vec::new(),
            Arc::new(MetatypeIndex::default()),
            Arc::new(Vec::new()),
            false,
            String::new(),
        ));
    };
    let stdlib_path = stdlib_path.to_path_buf();
    let cache_key = normalized_compare_key(&stdlib_path);
    let files = collect_stdlib_files(Some(&stdlib_path))?;
    let signature = stdlib_signature_key(&files)?;

    let mut cache = state
        .stdlib_cache
        .lock()
        .map_err(|_| "Stdlib cache lock poisoned".to_string())?;
    if let Some(entry) = cache.get(&cache_key) {
        if entry.path == stdlib_path && entry.signature == signature {
            return Ok((
                entry.files.clone(),
                entry.metatype_index.clone(),
                entry.symbols.clone(),
                true,
                signature,
            ));
        }
    }

    let mut loaded = Vec::new();
    for file in files {
        if let Ok(text) = fs::read_to_string(&file) {
            loaded.push((file, text));
        }
    }
    let (metatype_index, symbols) = build_stdlib_snapshot(&loaded);
    let metatype_index = Arc::new(metatype_index);
    let symbols = Arc::new(symbols);
    cache.insert(cache_key, StdlibCache {
        path: stdlib_path,
        signature: signature.clone(),
        files: loaded.clone(),
        metatype_index: metatype_index.clone(),
        symbols: symbols.clone(),
    });
    // Keep a small working-set of stdlib snapshots so switching projects does not thrash cache.
    const STDLIB_CACHE_MAX_ENTRIES: usize = 4;
    if cache.len() > STDLIB_CACHE_MAX_ENTRIES {
        if let Some(key) = cache.keys().next().cloned() {
            cache.remove(&key);
        }
    }
    Ok((loaded, metatype_index, symbols, false, signature))
}

fn stdlib_signature_key(files: &[PathBuf]) -> Result<String, String> {
    const STDLIB_SCHEMA_VERSION: &str = "stdlib-snapshot-v2";
    let mut parts = Vec::with_capacity(files.len());
    for path in files {
        let normalized = normalized_compare_key(path);
        let meta = fs::metadata(path).map_err(|e| e.to_string())?;
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let stamp = modified
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        parts.push(format!("{normalized}:{stamp}:{}", meta.len()));
    }
    Ok(format!(
        "{STDLIB_SCHEMA_VERSION}:{}:{}",
        env!("CARGO_PKG_VERSION"),
        parts.join("|")
    ))
}

fn build_stdlib_snapshot(entries: &[(PathBuf, String)]) -> (MetatypeIndex, Vec<StdlibSymbol>) {
    let mut hirs = Vec::new();
    let mut symbols = Vec::new();
    for (path, source) in entries {
        let mut parser = Parser::new(source);
        let root = parser.parse_root();
        let defmap = build_defmap(&root, source);
        hirs.push(lower_defmap_with_cst(&defmap, &root, source));
        if let Some(package) = defmap.package.as_ref() {
            if let Some(symbol) = stdlib_symbol_from_def(path, package, source) {
                symbols.push(symbol);
            }
        }
        for import in &defmap.imports {
            if let Some(symbol) = stdlib_symbol_from_def(path, import, source) {
                symbols.push(symbol);
            }
        }
        for def in &defmap.defs {
            if let Some(symbol) = stdlib_symbol_from_def(path, def, source) {
                symbols.push(symbol);
            }
        }
        for dependency in &defmap.dependencies {
            if let Some(symbol) = stdlib_symbol_from_def(path, dependency, source) {
                symbols.push(symbol);
            }
        }
    }
    (build_metatype_index_from_hirs(&hirs), symbols)
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

fn same_path(left: &Path, right: &Path) -> bool {
    normalized_compare_key(left) == normalized_compare_key(right)
}

fn normalized_compare_key(path: &Path) -> String {
    let normalized = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    normalized
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
}

fn semantic_elements_for_project(
    project_files: &[PathBuf],
    unsaved_map: &HashMap<PathBuf, String>,
    stdlib_index: &MetatypeIndex,
    stdlib_file_count: usize,
) -> Vec<SemanticElementView> {
    let mut analyses = Vec::new();
    for file in project_files {
        let source = unsaved_map
            .get(file)
            .cloned()
            .or_else(|| fs::read_to_string(file).ok());
        let Some(source) = source else {
            continue;
        };
        let mut parser = Parser::new(&source);
        let root = parser.parse_root();
        if !parser.errors().is_empty() {
            continue;
        }
        let defmap = build_defmap(&root, &source);
        let hir = lower_defmap_with_cst(&defmap, &root, &source);
        analyses.push(ModelFileAnalysis {
            file: file.clone(),
            source,
            hir,
        });
    }

    let report = build_model_stdlib_relations_from_analyses(
        project_files.len(),
        stdlib_file_count,
        stdlib_index,
        &analyses,
    );

    build_semantic_index(SemanticIndexInput {
        report: &report,
        stdlib: stdlib_index,
    })
    .query(&SemanticQuery {
        metatype: None,
        metatype_is_a: None,
        predicates: Vec::<SemanticPredicate>::new(),
    })
}

fn project_import_symbols(
    project_files: &[PathBuf],
    unsaved_map: &HashMap<PathBuf, String>,
) -> Vec<SymbolView> {
    let mut out = Vec::new();
    for file in project_files {
        let source = unsaved_map
            .get(file)
            .cloned()
            .or_else(|| fs::read_to_string(file).ok());
        let Some(source) = source else {
            continue;
        };
        let mut parser = Parser::new(&source);
        let root = parser.parse_root();
        if !parser.errors().is_empty() {
            continue;
        }
        let defmap = build_defmap(&root, &source);
        for import in &defmap.imports {
            if let Some(symbol) = project_symbol_from_def(file, import, &source) {
                out.push(symbol);
            }
        }
    }
    out
}

fn project_decl_symbols(
    project_files: &[PathBuf],
    unsaved_map: &HashMap<PathBuf, String>,
) -> Vec<SymbolView> {
    let mut out = Vec::new();
    for file in project_files {
        let source = unsaved_map
            .get(file)
            .cloned()
            .or_else(|| fs::read_to_string(file).ok());
        let Some(source) = source else {
            continue;
        };
        let mut parser = Parser::new(&source);
        let root = parser.parse_root();
        let defmap = build_defmap(&root, &source);
        if let Some(package) = defmap.package.as_ref() {
            if let Some(symbol) = project_symbol_from_def(file, package, &source) {
                out.push(symbol);
            }
        }
        for def in &defmap.defs {
            if let Some(symbol) = project_symbol_from_def(file, def, &source) {
                out.push(symbol);
            }
        }
        for dependency in &defmap.dependencies {
            if let Some(symbol) = project_symbol_from_def(file, dependency, &source) {
                out.push(symbol);
            }
        }
    }
    out
}

fn project_connection_end_symbols(
    project_files: &[PathBuf],
    unsaved_map: &HashMap<PathBuf, String>,
) -> Vec<SymbolView> {
    let mut out = Vec::new();
    for file in project_files {
        let source = unsaved_map
            .get(file)
            .cloned()
            .or_else(|| fs::read_to_string(file).ok());
        let Some(source) = source else {
            continue;
        };
        let mut parser = Parser::new(&source);
        let root = parser.parse_root();
        if !parser.errors().is_empty() {
            continue;
        }
        let defmap = build_defmap(&root, &source);
        let hir = lower_defmap_with_cst(&defmap, &root, &source);
        for def in &hir.defs {
            if def.kind != DefKind::ConnectionDef {
                continue;
            }
            let Some(def_name) = def.name.as_ref() else {
                continue;
            };
            let parent_qname = if def.package_path.is_empty() {
                def_name.clone()
            } else {
                format!("{}::{}", def.package_path.join("::"), def_name)
            };
            let def_span = span_to_line_col(def.span.start, def.span.end, &source);
            for attr in &def.attributes {
                if attr.name.trim().is_empty() {
                    continue;
                }
                let attr_span = find_connection_end_symbol_span(def, &attr.name, &source)
                    .or_else(|| find_ident_span_in_range(def.span.start, def.span.end, &attr.name, &source))
                    .unwrap_or(def_span);
                let qualified_name = format!("{parent_qname}::{}", attr.name);
                out.push(SymbolView {
                    file_path: file.to_string_lossy().to_string(),
                    name: attr.name.clone(),
                    short_name: None,
                    qualified_name,
                    kind: "OwnedEnd".to_string(),
                    file: 0,
                    start_line: attr_span.start_line,
                    start_col: attr_span.start_col,
                    end_line: attr_span.end_line,
                    end_col: attr_span.end_col,
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
                    properties: vec![
                        PropertyItemView {
                            name: "kind".to_string(),
                            label: "kind".to_string(),
                            value: PropertyValueView::Text {
                                value: "OwnedEnd".to_string(),
                            },
                            hint: None,
                            group: None,
                        },
                        PropertyItemView {
                            name: "owner_kind".to_string(),
                            label: "owner_kind".to_string(),
                            value: PropertyValueView::Text {
                                value: "ConnectionDef".to_string(),
                            },
                            hint: None,
                            group: None,
                        },
                    ],
                });
            }
        }
    }
    out
}

fn augment_owned_relationships(symbols: &mut [SymbolView]) {
    let mut qname_to_index = HashMap::<String, usize>::new();
    for (idx, symbol) in symbols.iter().enumerate() {
        qname_to_index.entry(symbol.qualified_name.clone()).or_insert(idx);
    }

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

fn find_connection_end_symbol_span(def: &mercurio_sysml_semantics::hir::HirDef, name: &str, source: &str) -> Option<SymbolSpan> {
    if name.trim().is_empty() {
        return None;
    }
    let start = usize::try_from(def.span.start).ok()?.min(source.len());
    let end = usize::try_from(def.span.end).ok()?.min(source.len());
    if end <= start {
        return None;
    }
    let block = &source[start..end];
    let mut stmt_start = 0usize;
    while stmt_start < block.len() {
        let rel_end = block[stmt_start..]
            .find(';')
            .map(|idx| stmt_start + idx + 1)
            .unwrap_or(block.len());
        let statement = &block[stmt_start..rel_end];
        if let Some((name_start, name_end)) = find_connection_end_name_span_in_statement(statement, name)
        {
            let abs_start = start + stmt_start + name_start;
            let abs_end = start + stmt_start + name_end;
            return Some(span_to_line_col(abs_start as u32, abs_end as u32, source));
        }
        if rel_end == block.len() {
            break;
        }
        stmt_start = rel_end;
    }
    None
}

fn find_connection_end_name_span_in_statement(statement: &str, target_name: &str) -> Option<(usize, usize)> {
    let bytes = statement.as_bytes();
    let mut idx = 0usize;
    let mut seen_end = false;
    while let Some((token, token_start, token_end)) = next_ident_token(statement, idx) {
        if token == "end" {
            seen_end = true;
            idx = token_end;
            continue;
        }
        if seen_end && token == "item" {
            let mut lookahead = token_end;
            while lookahead < bytes.len() {
                let ch = bytes[lookahead] as char;
                if ch.is_ascii_alphanumeric() || ch == '_' {
                    break;
                }
                lookahead += 1;
            }
            if let Some((name_token, name_start, name_end)) = next_ident_token(statement, lookahead) {
                if name_token == target_name {
                    return Some((name_start, name_end));
                }
            }
            return None;
        }
        idx = token_end.max(token_start + 1);
    }
    None
}

fn next_ident_token(text: &str, from: usize) -> Option<(&str, usize, usize)> {
    let bytes = text.as_bytes();
    let mut start = from;
    while start < bytes.len() {
        let ch = bytes[start] as char;
        if ch.is_ascii_alphabetic() || ch == '_' {
            break;
        }
        start += 1;
    }
    if start >= bytes.len() {
        return None;
    }
    let mut end = start + 1;
    while end < bytes.len() {
        let ch = bytes[end] as char;
        if !(ch.is_ascii_alphanumeric() || ch == '_') {
            break;
        }
        end += 1;
    }
    Some((&text[start..end], start, end))
}

fn find_ident_span_in_range(start: u32, end: u32, target_name: &str, source: &str) -> Option<SymbolSpan> {
    if target_name.is_empty() {
        return None;
    }
    let start_idx = usize::try_from(start).ok()?.min(source.len());
    let end_idx = usize::try_from(end).ok()?.min(source.len());
    if end_idx <= start_idx {
        return None;
    }
    let slice = &source[start_idx..end_idx];
    let mut cursor = 0usize;
    while let Some((token, token_start, token_end)) = next_ident_token(slice, cursor) {
        if token == target_name {
            let abs_start = start_idx + token_start;
            let abs_end = start_idx + token_end;
            return Some(span_to_line_col(abs_start as u32, abs_end as u32, source));
        }
        cursor = token_end.max(token_start + 1);
    }
    None
}

fn stdlib_symbol_from_def(path: &Path, def: &DefInfo, source: &str) -> Option<StdlibSymbol> {
    let name = def.name.clone()?;
    let qualified_name = if def.package_path.is_empty() {
        name.clone()
    } else {
        format!("{}::{}", def.package_path.join("::"), name)
    };
    let kind = def_kind_label(def.kind).to_string();
    let span = span_to_line_col(def.span.start, def.span.end, source);
    Some(StdlibSymbol {
        file_path: path.to_string_lossy().to_string(),
        name,
        qualified_name,
        kind,
        start_line: span.start_line,
        start_col: span.start_col,
        end_line: span.end_line,
        end_col: span.end_col,
    })
}

fn project_symbol_from_def(path: &Path, def: &DefInfo, source: &str) -> Option<SymbolView> {
    let name = def.name.clone()?;
    let qualified_name = if def.package_path.is_empty() {
        name.clone()
    } else {
        format!("{}::{}", def.package_path.join("::"), name)
    };
    let kind = def_kind_label(def.kind).to_string();
    let span = span_to_line_col(def.span.start, def.span.end, source);
    Some(SymbolView {
        file_path: path.to_string_lossy().to_string(),
        name,
        short_name: None,
        qualified_name,
        kind: kind.clone(),
        file: 0,
        start_line: span.start_line,
        start_col: span.start_col,
        end_line: span.end_line,
        end_col: span.end_col,
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
            value: PropertyValueView::Text { value: kind },
            hint: None,
            group: None,
        }],
    })
}

fn def_kind_label(kind: DefKind) -> &'static str {
    match kind {
        DefKind::Package => "Package",
        DefKind::Import => "Import",
        DefKind::Documentation => "Documentation",
        DefKind::Comment => "Comment",
        DefKind::PartDef => "PartDef",
        DefKind::ItemDef => "ItemDef",
        DefKind::PortDef => "PortDef",
        DefKind::ConnectionDef => "ConnectionDef",
        DefKind::AllocationDef => "AllocationDef",
        DefKind::RequirementDef => "RequirementDef",
        DefKind::ActionDef => "ActionDef",
        DefKind::AttributeDef => "AttributeDef",
        DefKind::ConstraintDef => "ConstraintDef",
        DefKind::MetadataDef => "MetadataDef",
        DefKind::StructDef => "StructDef",
        DefKind::MetaclassDef => "MetaclassDef",
        DefKind::FunctionDef => "FunctionDef",
        DefKind::Usage => "Usage",
        DefKind::Dependency => "Dependency",
    }
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
    let mut keys = element.attributes.keys().cloned().collect::<Vec<_>>();
    keys.sort();
    let properties = keys
        .into_iter()
        .filter_map(|key| {
            element.attributes.get(&key).map(|value| PropertyItemView {
                name: key.clone(),
                label: key,
                value: PropertyValueView::Text {
                    value: value.clone(),
                },
                hint: None,
                group: None,
            })
        })
        .collect::<Vec<_>>();

    let kind = element
        .metatype_qname
        .as_deref()
        .and_then(|value| value.rsplit("::").next())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .or_else(|| element.attributes.get("kind").cloned())
        .unwrap_or_else(|| "element".to_string());
    let key = symbol_key(&element.file_path, &element.qualified_name);
    let span = symbol_spans.get(&key);

    SymbolView {
        file_path: element.file_path,
        name: element.name.clone(),
        short_name: None,
        qualified_name: element.qualified_name,
        kind,
        file: 0,
        start_line: span.map(|s| s.start_line).unwrap_or(0),
        start_col: span.map(|s| s.start_col).unwrap_or(0),
        end_line: span.map(|s| s.end_line).unwrap_or(0),
        end_col: span.map(|s| s.end_col).unwrap_or(0),
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

fn is_library_symbol_path(symbol_file_path: &str, library_path: Option<&Path>) -> bool {
    let Some(lib) = library_path else {
        return false;
    };
    let symbol_key = normalized_compare_key(Path::new(symbol_file_path));
    let lib_key = normalized_compare_key(lib);
    symbol_key == lib_key || symbol_key.starts_with(&(lib_key + "\\"))
}

fn index_symbols_for_project(
    state: &CoreState,
    project_root: &str,
    library_path: Option<&Path>,
    symbols: &[SymbolView],
    rebuild_mappings: bool,
    non_blocking_lock: bool,
) -> Result<(), String> {
    let mut grouped = HashMap::<String, Vec<SymbolRecord>>::new();
    let library_key = library_path.map(|path| normalized_compare_key(path));
    for symbol in symbols {
        let scope = if is_library_symbol_path(&symbol.file_path, library_path) {
            Scope::Stdlib
        } else {
            Scope::Project
        };
        let normalized_file_key = normalized_compare_key(Path::new(&symbol.file_path));
        let metatype_qname = symbol_metatype_qname(symbol);
        let properties_json = serde_json::to_string(&serde_json::json!({
            "schema": 1,
            "properties": symbol.properties
        })).ok();
        let record = canonical_symbol_record(
            project_root,
            &normalized_file_key,
            library_key.as_deref(),
            CanonicalSymbolRecordArgs {
                scope,
                name: &symbol.name,
                qualified_name: &symbol.qualified_name,
                kind: &symbol.kind,
                metatype_qname: metatype_qname.as_deref(),
                file_path: &symbol.file_path,
                start_line: symbol.start_line,
                start_col: symbol.start_col,
                end_line: symbol.end_line,
                end_col: symbol.end_col,
                doc_text: symbol.doc.as_deref(),
                properties_json: properties_json.as_deref(),
            },
        );
        grouped.entry(symbol.file_path.clone()).or_default().push(record);
    }
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
    let mut file_paths = grouped.keys().cloned().collect::<Vec<_>>();
    file_paths.sort();
    for file_path in file_paths {
        let entries = grouped.remove(&file_path).unwrap_or_default();
        store.upsert_symbols_for_file(project_root, &file_path, entries);
    }
    if rebuild_mappings {
        store.rebuild_symbol_mappings(project_root);
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct SymbolSpan {
    start_line: u32,
    start_col: u32,
    end_line: u32,
    end_col: u32,
}

fn build_symbol_span_index(
    files: &[PathBuf],
    unsaved_map: &HashMap<PathBuf, String>,
) -> HashMap<String, SymbolSpan> {
    let mut out = HashMap::new();

    for path in files {
        let text = unsaved_map
            .get(path)
            .cloned()
            .or_else(|| fs::read_to_string(path).ok());
        let Some(text) = text else {
            continue;
        };
        let mut parser = Parser::new(&text);
        let tree = parser.parse_root();
        let defmap = build_defmap(&tree, &text);

        if let Some(package) = defmap.package.as_ref() {
            insert_span_for_def(path, package, &text, &mut out);
        }
        for def in &defmap.defs {
            insert_span_for_def(path, def, &text, &mut out);
        }
    }

    out
}

fn insert_span_for_def(path: &Path, def: &DefInfo, source: &str, out: &mut HashMap<String, SymbolSpan>) {
    let Some(name) = def.name.as_ref() else {
        return;
    };
    let qualified_name = if def.package_path.is_empty() {
        name.clone()
    } else {
        format!("{}::{}", def.package_path.join("::"), name)
    };
    let key = symbol_key(&path.to_string_lossy(), &qualified_name);
    out.entry(key).or_insert_with(|| span_to_line_col(def.span.start, def.span.end, source));
}

fn symbol_key(file_path: &str, qualified_name: &str) -> String {
    format!("{file_path}|{qualified_name}")
}

fn span_to_line_col(start: u32, end: u32, text: &str) -> SymbolSpan {
    let (start_line, start_col) = offset_to_line_col(text, start as usize);
    let end_offset = if end > start { end - 1 } else { end };
    let (end_line, end_col) = offset_to_line_col(text, end_offset as usize);
    SymbolSpan {
        start_line,
        start_col,
        end_line,
        end_col,
    }
}

fn offset_to_line_col(text: &str, offset: usize) -> (u32, u32) {
    let safe = offset.min(text.len());
    let mut line = 1u32;
    let mut col = 1u32;
    for ch in text[..safe].chars() {
        if ch == '\n' {
            line += 1;
            col = 1;
        } else {
            col += 1;
        }
    }
    (line, col)
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
        let start = text.find("part").expect("part offset") as u32;
        let end = (start as usize + "part def P;".len()) as u32;
        let span = span_to_line_col(start, end, text);
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
    fn compile_workspace_includes_project_import_symbols() {
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

        assert!(response
            .symbols
            .iter()
            .any(|symbol| symbol.kind == "Import" && symbol.file_path.ends_with("main.sysml")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn compile_workspace_connection_end_symbols_are_nested_under_connection_def() {
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

        assert!(response
            .symbols
            .iter()
            .any(|symbol| symbol.kind == "ConnectionDef" && symbol.qualified_name.ends_with("Demo::ProductSelection")));
        assert!(response
            .symbols
            .iter()
            .any(|symbol| symbol.kind == "OwnedEnd" && symbol.qualified_name.ends_with("Demo::ProductSelection::cart")));
        assert!(response
            .symbols
            .iter()
            .any(|symbol| symbol.kind == "OwnedEnd" && symbol.qualified_name.ends_with("Demo::ProductSelection::selectedProduct")));
        assert!(response
            .symbols
            .iter()
            .any(|symbol| symbol.kind == "OwnedEnd" && symbol.qualified_name.ends_with("Demo::ProductSelection::account")));
        let parent = response
            .symbols
            .iter()
            .find(|symbol| symbol.kind == "ConnectionDef" && symbol.qualified_name.ends_with("Demo::ProductSelection"))
            .expect("parent connection symbol");
        assert_eq!(
            parent
                .relationships
                .iter()
                .filter(|rel| rel.kind == "ownedEnd")
                .count(),
            3
        );
        let cart = response
            .symbols
            .iter()
            .find(|symbol| symbol.kind == "OwnedEnd" && symbol.qualified_name.ends_with("Demo::ProductSelection::cart"))
            .expect("cart symbol");
        assert_eq!(cart.start_line, 3);
        assert_eq!(cart.start_col, 19);
        let selected_product = response
            .symbols
            .iter()
            .find(|symbol| {
                symbol.kind == "OwnedEnd"
                    && symbol
                        .qualified_name
                        .ends_with("Demo::ProductSelection::selectedProduct")
            })
            .expect("selectedProduct symbol");
        assert_eq!(selected_product.start_line, 4);
        assert_eq!(selected_product.start_col, 19);
        let account = response
            .symbols
            .iter()
            .find(|symbol| symbol.kind == "OwnedEnd" && symbol.qualified_name.ends_with("Demo::ProductSelection::account"))
            .expect("account symbol");
        assert_eq!(account.start_line, 5);
        assert_eq!(account.start_col, 19);

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
        let project_id_a = crate::index_contract::canonical_symbol_id(
            "rootA",
            Scope::Project,
            &file_key,
            &symbol.qualified_name,
            &symbol.kind,
            symbol.start_line,
            symbol.start_col,
            symbol.end_line,
            symbol.end_col,
        );
        let project_id_b = crate::index_contract::canonical_symbol_id(
            "rootA",
            Scope::Project,
            &file_key,
            &symbol.qualified_name,
            &symbol.kind,
            symbol.start_line,
            symbol.start_col,
            symbol.end_line,
            symbol.end_col,
        );
        let stdlib_id = crate::index_contract::canonical_symbol_id(
            "rootA",
            Scope::Stdlib,
            &file_key,
            &symbol.qualified_name,
            &symbol.kind,
            symbol.start_line,
            symbol.start_col,
            symbol.end_line,
            symbol.end_col,
        );
        let other_root_id = crate::index_contract::canonical_symbol_id(
            "rootB",
            Scope::Project,
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
