use mercurio_symbol_index::{Scope, SymbolIndexStore, SymbolRecord};
use mercurio_sysml_core::vfs::Vfs;
use mercurio_sysml_pkg::compile_support::{collect_stdlib_files, stdlib_signature_key};
use mercurio_sysml_semantics::semantic_contract::SemanticElementProjectionView;
use mercurio_sysml_semantics::stdlib::{
    build_metatype_index, load_stdlib_from_path, MetatypeIndex, MetatypeInfo, TypeId,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::project::load_project_config;
use crate::project_root_key::{canonical_project_root, normalize_workspace_path};
use crate::settings::resolve_mercurio_user_dir;
use crate::state::{CoreState, StdlibCache, WorkspaceSnapshotCacheEntry};
use crate::workspace_tree::{collect_tree_manifest, WorkspaceTreeEntryView};
use mercurio_sysml_pkg::mercurio_sysml_semantic_adapter::{ingest_text, Language};

const STDLIB_INDEX_SCHEMA_VERSION: u32 = 2;
const STDLIB_INDEX_CACHE_FILE_NAME: &str = "stdlib-index-v1.bin";
const STDLIB_INDEX_LEGACY_JSON_CACHE_FILE_NAME: &str = "stdlib-index-v1.json";
const STDLIB_INDEX_ROOT_REGISTRY_FILE_NAME: &str = "cache-stdlib-roots.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedStdlibIndex {
    schema_version: u32,
    engine_version: String,
    stdlib_root: String,
    signature: String,
    #[serde(default)]
    library_tree: Vec<WorkspaceTreeEntryView>,
    #[serde(default)]
    symbols: Vec<SymbolRecord>,
    #[serde(default)]
    semantic_projections: Vec<SemanticElementProjectionView>,
}

pub fn list_stdlib_versions_from_root(stdlib_root: &Path) -> Result<Vec<String>, String> {
    mercurio_sysml_pkg::workspace_config::list_stdlib_versions_from_root(stdlib_root)
}

pub(crate) fn resolve_stdlib_path(
    stdlib_root: &Path,
    default_stdlib: Option<&str>,
    config: Option<&crate::LibraryConfig>,
    override_id: Option<&String>,
    project_root: &Path,
) -> ((), Option<PathBuf>) {
    (
        (),
        mercurio_sysml_pkg::workspace_config::resolve_stdlib_path(
            stdlib_root,
            default_stdlib,
            config,
            override_id,
            project_root,
        ),
    )
}

fn canonical_stdlib_root(stdlib_root: &Path) -> String {
    normalize_workspace_path(&stdlib_root.to_string_lossy())
}

fn stdlib_index_cache_file_path(stdlib_root: &Path) -> PathBuf {
    PathBuf::from(canonical_stdlib_root(stdlib_root))
        .join(".mercurio")
        .join("cache")
        .join(STDLIB_INDEX_CACHE_FILE_NAME)
}

fn stdlib_index_legacy_json_cache_file_path(stdlib_root: &Path) -> PathBuf {
    PathBuf::from(canonical_stdlib_root(stdlib_root))
        .join(".mercurio")
        .join("cache")
        .join(STDLIB_INDEX_LEGACY_JSON_CACHE_FILE_NAME)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp_path = path.with_extension("tmp");
    fs::write(&tmp_path, bytes).map_err(|e| e.to_string())?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    match fs::rename(&tmp_path, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = fs::remove_file(&tmp_path);
            Err(err.to_string())
        }
    }
}

fn read_persisted_stdlib_index(stdlib_root: &Path) -> Result<Option<PersistedStdlibIndex>, String> {
    let path = stdlib_index_cache_file_path(stdlib_root);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read(&path).map_err(|e| e.to_string())?;
    let parsed = match bincode::deserialize(&raw) {
        Ok(parsed) => parsed,
        Err(_) => {
            let _ = fs::remove_file(&path);
            return Ok(None);
        }
    };
    Ok(Some(parsed))
}

fn read_validated_persisted_stdlib_index(
    stdlib_root: &Path,
    signature: &str,
) -> Result<Option<PersistedStdlibIndex>, String> {
    let Some(cache) = read_persisted_stdlib_index(stdlib_root)? else {
        return Ok(None);
    };
    if cache.schema_version != STDLIB_INDEX_SCHEMA_VERSION {
        return Ok(None);
    }
    if cache.engine_version != env!("CARGO_PKG_VERSION") {
        return Ok(None);
    }
    if cache.signature != signature {
        return Ok(None);
    }
    if canonical_stdlib_root(stdlib_root) != canonical_stdlib_root(Path::new(&cache.stdlib_root)) {
        return Ok(None);
    }
    Ok(Some(cache))
}

fn stdlib_cache_root_registry_path() -> Result<PathBuf, String> {
    Ok(resolve_mercurio_user_dir().join(STDLIB_INDEX_ROOT_REGISTRY_FILE_NAME))
}

fn load_stdlib_cache_root_registry() -> Result<Vec<String>, String> {
    let path = stdlib_cache_root_registry_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let parsed = match serde_json::from_str::<Vec<String>>(&raw) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(Vec::new()),
    };
    let mut unique = BTreeSet::<String>::new();
    for root in parsed {
        let canonical = normalize_workspace_path(&root);
        if !canonical.trim().is_empty() {
            unique.insert(canonical);
        }
    }
    Ok(unique.into_iter().collect())
}

fn write_stdlib_cache_root_registry(roots: &[String]) -> Result<(), String> {
    let path = stdlib_cache_root_registry_path()?;
    let bytes = serde_json::to_vec(roots).map_err(|e| e.to_string())?;
    write_atomic(&path, &bytes)
}

fn register_stdlib_cache_root(stdlib_root: &Path) -> Result<(), String> {
    let canonical = canonical_stdlib_root(stdlib_root);
    if canonical.trim().is_empty() {
        return Ok(());
    }
    let mut roots = load_stdlib_cache_root_registry()?;
    if roots.iter().any(|existing| existing == &canonical) {
        return Ok(());
    }
    roots.push(canonical);
    roots.sort();
    write_stdlib_cache_root_registry(&roots)
}

pub(crate) fn clear_all_persisted_stdlib_indexes() -> Result<usize, String> {
    let roots = load_stdlib_cache_root_registry()?;
    let mut retained = Vec::<String>::new();
    let mut failures = Vec::<String>::new();
    let mut deleted = 0usize;

    for root in roots {
        let mut root_failed = false;
        for path in [
            stdlib_index_cache_file_path(Path::new(&root)),
            stdlib_index_legacy_json_cache_file_path(Path::new(&root)),
        ] {
            if !path.exists() {
                continue;
            }
            match fs::remove_file(&path) {
                Ok(()) => deleted += 1,
                Err(error) => {
                    root_failed = true;
                    failures.push(format!("{}: {}", path.to_string_lossy(), error));
                }
            }
        }
        if root_failed {
            retained.push(root.clone());
        }
    }

    write_stdlib_cache_root_registry(&retained)?;
    if failures.is_empty() {
        Ok(deleted)
    } else {
        Err(format!(
            "Failed to delete stdlib index cache files: {}",
            failures.join("; ")
        ))
    }
}

fn clear_library_symbols_for_project(state: &CoreState, project_root: &str) -> Result<(), String> {
    let mut store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;
    let files = store
        .library_symbols(project_root, None)
        .into_iter()
        .map(|symbol| symbol.file_path)
        .collect::<BTreeSet<_>>();
    for file_path in files {
        store.delete_symbols_for_file(project_root, &file_path);
    }
    Ok(())
}

pub(crate) fn persist_stdlib_index_cache(
    state: &CoreState,
    project_root: &str,
    stdlib_root: Option<&Path>,
    stdlib_signature: &str,
) -> Result<(), String> {
    let Some(stdlib_root) = stdlib_root else {
        return Ok(());
    };
    if stdlib_signature.trim().is_empty() {
        return Ok(());
    }
    let project_root = canonical_project_root(project_root);
    let library_key = normalized_compare_key(stdlib_root);
    let mut symbols = {
        let store = state
            .symbol_index
            .lock()
            .map_err(|_| "Symbol index lock poisoned".to_string())?;
        store
            .library_symbols(&project_root, None)
            .into_iter()
            .filter(|symbol| symbol.library_key.as_deref() == Some(library_key.as_str()))
            .collect::<Vec<_>>()
    };
    symbols.sort_by(|a, b| {
        a.file_path
            .cmp(&b.file_path)
            .then(a.start_line.cmp(&b.start_line))
            .then(a.start_col.cmp(&b.start_col))
            .then(a.qualified_name.cmp(&b.qualified_name))
            .then(a.kind.cmp(&b.kind))
    });
    symbols.dedup_by(|left, right| left.id == right.id);
    let semantic_projections = {
        let cache_key = format!("stdlib-semantic-projection|{library_key}");
        let cache = state
            .workspace_snapshot_cache
            .lock()
            .map_err(|_| "Workspace snapshot cache lock poisoned".to_string())?;
        match cache.get(&cache_key) {
            Some(WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(projections)) => {
                projections.as_ref().clone()
            }
            _ => Vec::new(),
        }
    };
    if symbols.is_empty() && semantic_projections.is_empty() {
        return Ok(());
    }
    let snapshot = PersistedStdlibIndex {
        schema_version: STDLIB_INDEX_SCHEMA_VERSION,
        engine_version: env!("CARGO_PKG_VERSION").to_string(),
        stdlib_root: canonical_stdlib_root(stdlib_root),
        signature: stdlib_signature.to_string(),
        library_tree: collect_tree_manifest(stdlib_root)?,
        symbols,
        semantic_projections,
    };
    let bytes = bincode::serialize(&snapshot).map_err(|e| e.to_string())?;
    write_atomic(&stdlib_index_cache_file_path(stdlib_root), &bytes)?;
    register_stdlib_cache_root(stdlib_root)?;
    Ok(())
}

pub(crate) fn seed_stdlib_index_from_cache_for_project(
    state: &CoreState,
    project_root: &str,
    stdlib_root: Option<&Path>,
    stdlib_signature: &str,
) -> Result<bool, String> {
    let Some(stdlib_root) = stdlib_root else {
        return Ok(false);
    };
    if stdlib_signature.trim().is_empty() {
        return Ok(false);
    }
    let Some(cache) = read_validated_persisted_stdlib_index(stdlib_root, stdlib_signature)? else {
        return Ok(false);
    };
    if cache.symbols.is_empty() {
        return Ok(false);
    }

    let project_root = canonical_project_root(project_root);
    let library_key = normalized_compare_key(stdlib_root);
    clear_library_symbols_for_project(state, &project_root)?;

    let mut grouped = BTreeMap::<String, Vec<SymbolRecord>>::new();
    for mut symbol in cache.symbols {
        symbol.project_root = project_root.clone();
        symbol.scope = Scope::Stdlib;
        symbol.library_key = Some(library_key.clone());
        grouped.entry(symbol.file_path.clone()).or_default().push(symbol);
    }
    let mut store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;
    for (file_path, rows) in grouped {
        store.upsert_symbols_for_file(&project_root, &file_path, rows);
    }
    store.mark_stdlib_indexed(&project_root, &library_key, stdlib_signature);
    store.rebuild_symbol_mappings(&project_root);
    drop(store);
    Ok(true)
}

pub(crate) fn is_stdlib_index_seeded_for_project(
    state: &CoreState,
    project_root: &str,
    stdlib_root: &Path,
    stdlib_signature: &str,
) -> Result<bool, String> {
    let project_root = canonical_project_root(project_root);
    let library_key = normalized_compare_key(stdlib_root);
    let store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;
    Ok(store.is_stdlib_index_fresh(&project_root, &library_key, stdlib_signature))
}

pub(crate) fn seed_stdlib_semantic_projection_cache_for_project(
    state: &CoreState,
    project_root: &str,
) -> Result<bool, String> {
    let project_root = canonical_project_root(project_root);
    if project_root.trim().is_empty() {
        return Ok(false);
    }

    let root_path = PathBuf::from(&project_root);
    if !root_path.exists() {
        return Ok(false);
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
    let (_loader, stdlib_path) = resolve_stdlib_path(
        &state.stdlib_root,
        default_stdlib.as_deref(),
        library_config,
        stdlib_override,
        &root_path,
    );
    let Some(stdlib_path) = stdlib_path else {
        return Ok(false);
    };
    let stdlib_files = collect_stdlib_files(Some(&stdlib_path))?;
    if stdlib_files.is_empty() {
        return Ok(false);
    }
    let signature = stdlib_signature_key(&stdlib_files)?;
    let Some(cache) = read_validated_persisted_stdlib_index(&stdlib_path, &signature)? else {
        return Ok(false);
    };
    if cache.semantic_projections.is_empty() {
        return Ok(false);
    }

    let library_key = normalized_compare_key(&stdlib_path);
    let mut workspace_cache = state
        .workspace_snapshot_cache
        .lock()
        .map_err(|_| "Workspace snapshot cache lock poisoned".to_string())?;
    workspace_cache.insert(
        format!("stdlib-semantic-projection|{library_key}"),
        WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(Arc::new(
            cache.semantic_projections,
        )),
    );
    Ok(true)
}

pub(crate) fn seed_stdlib_index_if_missing(
    state: &CoreState,
    project_root: &str,
) -> Result<bool, String> {
    let project_root = canonical_project_root(project_root);
    if project_root.trim().is_empty() {
        return Ok(false);
    }
    let need_seed = {
        let store = state
            .symbol_index
            .lock()
            .map_err(|_| "Symbol index lock poisoned".to_string())?;
        store.library_symbols(&project_root, None).is_empty()
    };
    if !need_seed {
        return Ok(false);
    }

    let root_path = PathBuf::from(&project_root);
    if !root_path.exists() {
        return Ok(false);
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
    let (_loader, stdlib_path) = resolve_stdlib_path(
        &state.stdlib_root,
        default_stdlib.as_deref(),
        library_config,
        stdlib_override,
        &root_path,
    );
    let Some(stdlib_path) = stdlib_path else {
        return Ok(false);
    };
    let stdlib_files = collect_stdlib_files(Some(&stdlib_path))?;
    if stdlib_files.is_empty() {
        return Ok(false);
    }
    let signature = stdlib_signature_key(&stdlib_files)?;
    seed_stdlib_index_from_cache_for_project(
        state,
        &project_root,
        Some(&stdlib_path),
        &signature,
    )
}

#[derive(Serialize, Clone)]
pub struct StdlibMetamodelView {
    pub stdlib_path: Option<String>,
    pub workspace_snapshot_hit: bool,
    pub type_count: usize,
    pub types: Vec<MetamodelTypeView>,
    pub expression_records: Vec<StdlibExpressionRecordView>,
    pub diagnostics: StdlibMetamodelDiagnostics,
}

#[derive(Serialize, Clone)]
pub struct StdlibExpressionRecordView {
    pub owner_id: u64,
    pub qualified_name: String,
    pub feature: Option<String>,
    pub expression: String,
}

#[derive(Serialize, Clone)]
pub struct MetamodelTypeView {
    pub name: String,
    pub qualified_name: String,
    pub declared_supertypes: Vec<String>,
    pub supertypes: Vec<String>,
    pub documentation: Option<String>,
    pub modifiers: MetamodelModifiersView,
    pub attributes: Vec<MetamodelAttributeView>,
}

#[derive(Serialize, Clone)]
pub struct MetamodelAttributeView {
    pub name: String,
    pub qualified_name: String,
    pub declared_type: Option<String>,
    pub multiplicity: Option<String>,
    pub direction: Option<String>,
    pub documentation: Option<String>,
    pub modifiers: MetamodelModifiersView,
}

#[derive(Serialize, Clone)]
pub struct MetamodelModifiersView {
    pub is_public: bool,
    pub is_abstract: bool,
    pub is_variation: bool,
    pub is_readonly: bool,
    pub is_derived: bool,
    pub is_parallel: bool,
}

#[derive(Serialize, Clone)]
pub struct StdlibMetamodelDiagnostics {
    pub resolved_stdlib_path: Option<String>,
    pub cache_key: String,
    pub cache_hit: bool,
    pub workspace_snapshot_hit: bool,
    pub cache_lookup_error: Option<String>,
    pub workspace_snapshot_error: Option<String>,
    pub metamodel_cache_store_error: Option<String>,
    pub failure_reason: Option<String>,
    pub duplicate_qualified_names: Vec<String>,
    pub cache_entries: Vec<StdlibCacheSummary>,
    pub phase_timings: Vec<PhaseTimingView>,
    pub expression_records_error: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct StdlibCacheSummary {
    pub path: String,
    pub signature: String,
    pub file_count: usize,
}

#[derive(Serialize, Clone)]
pub struct PhaseTimingView {
    pub phase: String,
    pub duration_ms: u128,
}

impl StdlibMetamodelDiagnostics {
    fn new(cache_key: String, resolved_stdlib_path: Option<String>) -> Self {
        Self {
            resolved_stdlib_path,
            cache_key,
            cache_hit: false,
            workspace_snapshot_hit: false,
            cache_lookup_error: None,
            workspace_snapshot_error: None,
            metamodel_cache_store_error: None,
            failure_reason: None,
            duplicate_qualified_names: Vec::new(),
            cache_entries: Vec::new(),
            phase_timings: Vec::new(),
            expression_records_error: None,
        }
    }

    fn record_phase(&mut self, phase: &str, duration: Duration) {
        self.phase_timings
            .push(PhaseTimingView::new(phase, duration));
    }
}

impl StdlibCacheSummary {
    fn from_entry(entry: &StdlibCache) -> Self {
        Self {
            path: entry.path.to_string_lossy().to_string(),
            signature: entry.signature.clone(),
            file_count: entry.files.len(),
        }
    }
}

impl PhaseTimingView {
    fn new(phase: &str, duration: Duration) -> Self {
        Self {
            phase: phase.to_string(),
            duration_ms: duration.as_millis() as u128,
        }
    }
}

pub fn get_stdlib_metamodel(
    state: &CoreState,
    root: String,
) -> Result<StdlibMetamodelView, String> {
    let root_path = PathBuf::from(root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }

    let default_stdlib = state
        .settings
        .lock()
        .ok()
        .and_then(|settings| settings.default_stdlib.clone());

    let project_config = crate::project::load_project_config(&root_path)
        .ok()
        .flatten();
    let library_config = project_config
        .as_ref()
        .and_then(|config| config.library.as_ref());
    let stdlib_override = project_config
        .as_ref()
        .and_then(|config| config.stdlib.as_ref());

    let resolution_start = Instant::now();
    let (_loader, stdlib_path) = resolve_stdlib_path(
        &state.stdlib_root,
        default_stdlib.as_deref(),
        library_config,
        stdlib_override,
        &root_path,
    );
    let resolved_stdlib_path = stdlib_path
        .as_ref()
        .map(|path| path.to_string_lossy().to_string());
    let normalized_stdlib_path = stdlib_path
        .as_ref()
        .map(|path| normalized_compare_key(path));
    let cache_key = normalized_stdlib_path
        .clone()
        .unwrap_or_else(|| "<none>".to_string());

    let mut diagnostics =
        StdlibMetamodelDiagnostics::new(cache_key.clone(), resolved_stdlib_path.clone());
    diagnostics.record_phase("resolve_stdlib_path", resolution_start.elapsed());

    let cache_lookup_start = Instant::now();
    diagnostics.record_phase("metamodel_cache_lookup", cache_lookup_start.elapsed());

    let snapshot_start = Instant::now();
    let (cache_entries, snapshot_error, snapshot_index) =
        collect_stdlib_cache_snapshot(state, normalized_stdlib_path.as_deref());
    diagnostics.cache_entries = cache_entries;
    diagnostics.workspace_snapshot_error = snapshot_error;
    diagnostics.record_phase("workspace_snapshot_lookup", snapshot_start.elapsed());
    if snapshot_index.is_some() {
        diagnostics.workspace_snapshot_hit = true;
    }

    let mut types = Vec::new();
    let mut duplicates = Vec::new();
    let mut workspace_snapshot_hit = false;
    let mut vfs = Vfs::new();
    let mut files = Vec::new();

    if let Some(path) = stdlib_path.as_ref() {
        files = load_stdlib_from_path(&mut vfs, path);
        if let Some(index) = snapshot_index {
            let projection_start = Instant::now();
            let (snapshot_types, snapshot_duplicates) = metamodel_types_from_index(index.as_ref());
            diagnostics.record_phase("metamodel_projection", projection_start.elapsed());
            types = snapshot_types;
            duplicates = snapshot_duplicates;
            workspace_snapshot_hit = true;
        } else {
            let build_start = Instant::now();
            let index = build_metatype_index(&vfs, &files);
            diagnostics.record_phase("stdlib_load_and_index", build_start.elapsed());

            if files.is_empty() {
                diagnostics.failure_reason =
                    Some("Stdlib path resolved but no loadable files were found".to_string());
            }

            let projection_start = Instant::now();
            let (built_types, built_duplicates) = metamodel_types_from_index(&index);
            diagnostics.record_phase("metamodel_projection", projection_start.elapsed());
            types = built_types;
            duplicates = built_duplicates;
        }
    } else if diagnostics.failure_reason.is_none() {
        diagnostics.failure_reason =
            Some("Unable to resolve a stdlib path for the requested project root".to_string());
    }

    types.sort_by(|a, b| a.qualified_name.cmp(&b.qualified_name));
    diagnostics.duplicate_qualified_names = duplicates;
    let expression_records = collect_expression_records(&files, &vfs, &mut diagnostics);

    let view = StdlibMetamodelView {
        stdlib_path: resolved_stdlib_path,
        workspace_snapshot_hit,
        type_count: types.len(),
        types,
        expression_records,
        diagnostics,
    };

    Ok(view)
}

fn normalized_compare_key(path: &Path) -> String {
    let normalized = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    normalized
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
}

fn collect_expression_records(
    files: &[PathBuf],
    vfs: &Vfs,
    diagnostics: &mut StdlibMetamodelDiagnostics,
) -> Vec<StdlibExpressionRecordView> {
    let mut out = Vec::new();
    for path in files {
        let text = match read_stdlib_file_text(vfs, path) {
            Some(text) => text,
            None => continue,
        };
        match ingest_text(&text, Language::SysML) {
            Ok(output) => {
                for record in output.expression_records() {
                    out.push(StdlibExpressionRecordView {
                        owner_id: record.owner_id.0,
                        qualified_name: record.qualified_name,
                        feature: record.feature,
                        expression: record.expression,
                    });
                }
            }
            Err(err) => {
                if diagnostics.expression_records_error.is_none() {
                    diagnostics.expression_records_error = Some(err.to_string());
                }
            }
        }
    }
    out
}

fn read_stdlib_file_text(vfs: &Vfs, path: &Path) -> Option<String> {
    if let Some(id) = vfs.file_id_by_path(path) {
        if let Some(text) = vfs.file_text(id) {
            return Some(text.to_string());
        }
    }
    fs::read_to_string(path).ok()
}

fn collect_stdlib_cache_snapshot(
    state: &CoreState,
    normalized_stdlib_key: Option<&str>,
) -> (
    Vec<StdlibCacheSummary>,
    Option<String>,
    Option<Arc<MetatypeIndex>>,
) {
    match state.workspace_snapshot_cache.try_lock() {
        Ok(cache) => {
            let stdlib_entries = cache
                .values()
                .filter_map(|entry| match entry {
                    WorkspaceSnapshotCacheEntry::Stdlib(value) => Some(value),
                    WorkspaceSnapshotCacheEntry::ProjectSemantic(_)
                    | WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(_) => None,
                })
                .collect::<Vec<_>>();
            let summaries = cache
                .values()
                .filter_map(|entry| match entry {
                    WorkspaceSnapshotCacheEntry::Stdlib(value) => Some(value),
                    WorkspaceSnapshotCacheEntry::ProjectSemantic(_)
                    | WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(_) => None,
                })
                .map(StdlibCacheSummary::from_entry)
                .collect::<Vec<_>>();
            let snapshot_index = normalized_stdlib_key.and_then(|normalized| {
                stdlib_entries
                    .iter()
                    .find(|entry| normalized_compare_key(&entry.path) == normalized)
                    .map(|entry| entry.metatype_index.clone())
            });
            (summaries, None, snapshot_index)
        }
        Err(err) => (Vec::new(), Some(format!("{:?}", err)), None),
    }
}

fn metamodel_types_from_index(index: &MetatypeIndex) -> (Vec<MetamodelTypeView>, Vec<String>) {
    let qname_by_id = index
        .infos
        .iter()
        .map(|info| (info.id, info.qualified_name.clone()))
        .collect::<HashMap<_, _>>();
    let mut types = Vec::with_capacity(index.infos.len());
    for info in &index.infos {
        types.push(metamodel_type_from_info(info, index, &qname_by_id));
    }
    let duplicates = collect_duplicate_qualified_names(&types);
    (types, duplicates)
}

fn metamodel_type_from_info(
    info: &MetatypeInfo,
    index: &MetatypeIndex,
    qname_by_id: &HashMap<TypeId, String>,
) -> MetamodelTypeView {
    let supertypes = index
        .supertypes
        .get(&info.id)
        .map(|ids| {
            ids.iter()
                .filter_map(|id| qname_by_id.get(id).cloned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let attributes = index
        .all_attributes
        .get(&info.id)
        .map(|attrs| {
            attrs
                .iter()
                .map(|attr| MetamodelAttributeView {
                    name: attr.name.clone(),
                    qualified_name: format!("{}::{}", info.qualified_name, attr.name),
                    declared_type: attr.ty.clone(),
                    multiplicity: attr.multiplicity.clone(),
                    direction: None,
                    documentation: None,
                    modifiers: default_modifiers(),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    MetamodelTypeView {
        name: info.name.clone(),
        qualified_name: info.qualified_name.clone(),
        declared_supertypes: info.bases.clone(),
        supertypes,
        documentation: info.doc.clone(),
        modifiers: default_modifiers(),
        attributes,
    }
}

fn collect_duplicate_qualified_names(types: &[MetamodelTypeView]) -> Vec<String> {
    let mut counts = HashMap::new();
    for ty in types {
        *counts.entry(ty.qualified_name.clone()).or_insert(0) += 1;
    }
    let mut duplicates = counts
        .into_iter()
        .filter_map(|(name, count)| if count > 1 { Some(name) } else { None })
        .collect::<Vec<_>>();
    duplicates.sort();
    duplicates
}

fn default_modifiers() -> MetamodelModifiersView {
    MetamodelModifiersView {
        is_public: true,
        is_abstract: false,
        is_variation: false,
        is_readonly: false,
        is_derived: false,
        is_parallel: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn corrupt_persisted_stdlib_index_is_treated_as_cache_miss() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let stdlib_root =
            std::env::temp_dir().join(format!("mercurio_stdlib_corrupt_cache_{stamp}"));
        let cache_file = stdlib_index_cache_file_path(&stdlib_root);
        fs::create_dir_all(
            cache_file
                .parent()
                .expect("stdlib cache directory parent must exist"),
        )
        .expect("create stdlib cache dir");
        fs::write(&cache_file, b"not-bincode").expect("write corrupt cache");

        let restored = read_persisted_stdlib_index(&stdlib_root).expect("read cache");
        assert!(restored.is_none());
        assert!(!cache_file.exists());

        let _ = fs::remove_dir_all(&stdlib_root);
    }
}
