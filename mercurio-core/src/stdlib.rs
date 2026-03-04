use mercurio_sysml_core::vfs::Vfs;
use mercurio_sysml_semantics::stdlib::{
    build_metatype_index, load_stdlib_from_path, MetatypeIndex, MetatypeInfo, TypeId,
};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::state::{CoreState, StdlibCache, WorkspaceSnapshotCacheEntry};
use mercurio_sysml_pkg::mercurio_sysml_semantic_adapter::{ingest_text, Language};

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
        self.phase_timings.push(PhaseTimingView::new(phase, duration));
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

    let project_config = crate::project::load_project_config(&root_path).ok().flatten();
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
        diagnostics.failure_reason = Some(
            "Unable to resolve a stdlib path for the requested project root".to_string(),
        );
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
) -> (Vec<StdlibCacheSummary>, Option<String>, Option<Arc<MetatypeIndex>>) {
    match state.workspace_snapshot_cache.try_lock() {
        Ok(cache) => {
            let stdlib_entries = cache
                .values()
                .filter_map(|entry| match entry {
                    WorkspaceSnapshotCacheEntry::Stdlib(value) => Some(value),
                    WorkspaceSnapshotCacheEntry::ProjectSemantic(_) => None,
                })
                .collect::<Vec<_>>();
            let summaries = cache
                .values()
                .filter_map(|entry| match entry {
                    WorkspaceSnapshotCacheEntry::Stdlib(value) => Some(value),
                    WorkspaceSnapshotCacheEntry::ProjectSemantic(_) => None,
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
