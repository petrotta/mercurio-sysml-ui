use mercurio_symbol_index::{SymbolIndexStore, SymbolMetatypeMappingRecord, SymbolRecord};
use mercurio_sysml_semantics::semantic_contract::{
    SemanticElementProjectionView, SemanticElementView, SemanticFeatureView, SemanticValueView,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::project_model_seed::seed_symbol_index_if_empty;
use crate::project_root_key::canonical_project_root;
use crate::state::{ProjectSemanticLookup, WorkspaceSnapshotCacheEntry};
use crate::CoreState;

#[derive(Debug, Clone, Serialize)]
pub struct IndexedSymbolView {
    pub id: String,
    pub project_root: String,
    pub library_key: Option<String>,
    pub scope: String,
    pub name: String,
    pub qualified_name: String,
    pub parent_qualified_name: Option<String>,
    pub kind: String,
    pub metatype_qname: Option<String>,
    pub file_path: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub doc_text: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LibraryIndexSummaryView {
    pub file_count: usize,
    pub symbol_count: usize,
    pub kind_counts: Vec<(String, usize)>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SymbolMetatypeMappingView {
    pub project_root: String,
    pub symbol_id: String,
    pub symbol_file_path: String,
    pub symbol_qualified_name: String,
    pub symbol_kind: String,
    pub resolved_metatype_qname: Option<String>,
    pub target_symbol_id: Option<String>,
    pub mapping_source: String,
    pub confidence: f32,
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexedSemanticElementView {
    pub name: String,
    pub qualified_name: String,
    pub file_path: String,
    pub attributes: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexedSemanticProjectionElementView {
    pub name: String,
    pub qualified_name: String,
    pub file_path: String,
    pub metatype_qname: Option<String>,
    pub features: Vec<mercurio_sysml_semantics::semantic_contract::SemanticFeatureView>,
}

fn to_view(record: SymbolRecord) -> IndexedSymbolView {
    IndexedSymbolView {
        id: record.id,
        project_root: record.project_root,
        library_key: record.library_key,
        scope: match record.scope {
            mercurio_symbol_index::Scope::Stdlib => "stdlib".to_string(),
            mercurio_symbol_index::Scope::Project => "project".to_string(),
        },
        name: record.name,
        qualified_name: record.qualified_name,
        parent_qualified_name: record.parent_qualified_name,
        kind: record.kind,
        metatype_qname: record.metatype_qname,
        file_path: record.file_path,
        start_line: record.start_line,
        start_col: record.start_col,
        end_line: record.end_line,
        end_col: record.end_col,
        doc_text: record.doc_text,
    }
}

fn to_mapping_view(record: SymbolMetatypeMappingRecord) -> SymbolMetatypeMappingView {
    SymbolMetatypeMappingView {
        project_root: record.project_root,
        symbol_id: record.symbol_id,
        symbol_file_path: record.symbol_file_path,
        symbol_qualified_name: record.symbol_qualified_name,
        symbol_kind: record.symbol_kind,
        resolved_metatype_qname: record.resolved_metatype_qname,
        target_symbol_id: record.target_symbol_id,
        mapping_source: record.mapping_source,
        confidence: record.confidence,
        diagnostic: record.diagnostic,
    }
}

pub(crate) fn refresh_project_semantic_lookup(
    state: &CoreState,
    project_root: &str,
    semantic_elements: &[SemanticElementView],
    semantic_projections: &[SemanticElementProjectionView],
) -> Result<(), String> {
    let project_root = canonical_project_root(project_root);
    let lookup = build_project_semantic_lookup(semantic_elements, semantic_projections);
    let mut cache = state
        .project_semantic_lookup_cache
        .lock()
        .map_err(|_| "Project semantic lookup cache lock poisoned".to_string())?;
    cache.insert(project_root, lookup);
    Ok(())
}

fn ensure_project_semantic_lookup_loaded(
    state: &CoreState,
    project_root: &str,
) -> Result<ProjectSemanticLookup, String> {
    let project_root = canonical_project_root(project_root);
    if let Ok(cache) = state.project_semantic_lookup_cache.lock() {
        if let Some(existing) = cache.get(&project_root) {
            return Ok(existing.clone());
        }
    }

    let root_prefix = format!("project-semantic|{}|", project_root);
    let mut semantic_elements = Vec::<SemanticElementView>::new();
    let mut semantic_projections = Vec::<SemanticElementProjectionView>::new();
    if let Ok(cache) = state.workspace_snapshot_cache.lock() {
        for (key, entry) in cache.iter() {
            if !key.starts_with(&root_prefix) {
                continue;
            }
            match entry {
                WorkspaceSnapshotCacheEntry::ProjectSemantic(elements) => {
                    semantic_elements.extend(elements.iter().cloned());
                }
                WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(elements) => {
                    semantic_projections.extend(elements.iter().cloned());
                }
                WorkspaceSnapshotCacheEntry::Stdlib(_) => {}
            }
        }
    }
    let lookup = build_project_semantic_lookup(&semantic_elements, &semantic_projections);
    let mut cache = state
        .project_semantic_lookup_cache
        .lock()
        .map_err(|_| "Project semantic lookup cache lock poisoned".to_string())?;
    cache.insert(project_root, lookup.clone());
    Ok(lookup)
}

fn build_project_semantic_lookup(
    semantic_elements: &[SemanticElementView],
    semantic_projections: &[SemanticElementProjectionView],
) -> ProjectSemanticLookup {
    let mut lookup = ProjectSemanticLookup::default();

    for element in semantic_elements {
        let file_key = normalized_compare_key(Path::new(&element.file_path));
        let file_qname_key = (file_key, element.qualified_name.clone());

        let replace_file_entry = lookup
            .elements_by_file_qname
            .get(&file_qname_key)
            .map(|current| semantic_element_score(element) > semantic_element_score(current))
            .unwrap_or(true);
        if replace_file_entry {
            lookup
                .elements_by_file_qname
                .insert(file_qname_key, element.clone());
        }

        let qname_key = element.qualified_name.clone();
        let replace_best_entry = lookup
            .best_elements_by_qname
            .get(&qname_key)
            .map(|current| semantic_element_score(element) > semantic_element_score(current))
            .unwrap_or(true);
        if replace_best_entry {
            lookup
                .best_elements_by_qname
                .insert(qname_key, element.clone());
        }
    }

    for projection in semantic_projections {
        let file_key = normalized_compare_key(Path::new(&projection.file_path));
        let file_qname_key = (file_key, projection.qualified_name.clone());

        let replace_file_entry = lookup
            .projections_by_file_qname
            .get(&file_qname_key)
            .map(|current| projection.features.len() > current.features.len())
            .unwrap_or(true);
        if replace_file_entry {
            lookup
                .projections_by_file_qname
                .insert(file_qname_key, projection.clone());
        }

        let qname_key = projection.qualified_name.clone();
        let replace_best_entry = lookup
            .best_projections_by_qname
            .get(&qname_key)
            .map(|current| projection.features.len() > current.features.len())
            .unwrap_or(true);
        if replace_best_entry {
            lookup
                .best_projections_by_qname
                .insert(qname_key, projection.clone());
        }
    }

    lookup
}

pub fn query_symbols_by_metatype(
    state: &CoreState,
    project_root: String,
    metatype_qname: String,
) -> Result<Vec<IndexedSymbolView>, String> {
    let project_root = canonical_project_root(&project_root);
    let store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;
    Ok(store
        .symbols_by_metatype(&project_root, &metatype_qname)
        .into_iter()
        .map(to_view)
        .collect())
}

pub fn query_stdlib_documentation_symbols(
    state: &CoreState,
    library_key: String,
) -> Result<Vec<IndexedSymbolView>, String> {
    let store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;
    Ok(store
        .stdlib_documentation_symbols(&library_key)
        .into_iter()
        .map(to_view)
        .collect())
}

pub fn query_library_symbols(
    state: &CoreState,
    project_root: String,
    file_path: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Vec<IndexedSymbolView>, String> {
    let project_root = canonical_project_root(&project_root);
    seed_symbol_index_if_empty(state, &project_root)?;
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(usize::MAX);
    let store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;
    Ok(store
        .library_symbols_paged(&project_root, file_path.as_deref(), offset, limit)
        .into_iter()
        .map(to_view)
        .collect())
}

pub fn query_project_symbols(
    state: &CoreState,
    project_root: String,
    file_path: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Vec<IndexedSymbolView>, String> {
    let project_root = canonical_project_root(&project_root);
    seed_symbol_index_if_empty(state, &project_root)?;
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(usize::MAX);
    let store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;
    Ok(store
        .project_symbols_paged(&project_root, file_path.as_deref(), offset, limit)
        .into_iter()
        .map(to_view)
        .collect())
}

pub fn query_project_symbols_for_files(
    state: &CoreState,
    project_root: String,
    file_paths: Vec<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Vec<IndexedSymbolView>, String> {
    let project_root = canonical_project_root(&project_root);
    seed_symbol_index_if_empty(state, &project_root)?;
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(usize::MAX);
    let unique_file_paths = file_paths
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>();
    if unique_file_paths.is_empty() {
        return Ok(Vec::new());
    }
    let store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;
    let mut symbols = unique_file_paths
        .iter()
        .flat_map(|file_path| store.project_symbols(&project_root, Some(file_path)))
        .collect::<Vec<_>>();
    symbols.sort_by(|a, b| {
        a.file_path
            .cmp(&b.file_path)
            .then(a.start_line.cmp(&b.start_line))
            .then(a.start_col.cmp(&b.start_col))
            .then(a.qualified_name.cmp(&b.qualified_name))
    });
    symbols.dedup_by(|left, right| left.id == right.id);
    Ok(symbols
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(to_view)
        .collect())
}

pub fn query_library_summary(
    state: &CoreState,
    project_root: String,
) -> Result<LibraryIndexSummaryView, String> {
    let project_root = canonical_project_root(&project_root);
    let store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;
    let (file_count, symbol_count, kind_counts) = store.library_summary(&project_root);
    Ok(LibraryIndexSummaryView {
        file_count,
        symbol_count,
        kind_counts,
    })
}

pub fn query_symbol_metatype_mapping(
    state: &CoreState,
    project_root: String,
    symbol_qualified_name: String,
    file_path: Option<String>,
) -> Result<Option<SymbolMetatypeMappingView>, String> {
    let project_root = canonical_project_root(&project_root);
    let store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;
    Ok(store
        .symbol_mapping(&project_root, &symbol_qualified_name, file_path.as_deref())
        .map(to_mapping_view))
}

pub fn query_project_semantic_element_by_qualified_name(
    state: &CoreState,
    project_root: String,
    qualified_name: String,
    file_path: Option<String>,
) -> Result<Option<IndexedSemanticElementView>, String> {
    let project_root = canonical_project_root(&project_root);
    seed_symbol_index_if_empty(state, &project_root)?;
    let target = qualified_name.trim();
    if target.is_empty() {
        return Ok(None);
    }
    let lookup = ensure_project_semantic_lookup_loaded(state, &project_root)?;
    let requested_file_key = file_path
        .as_deref()
        .map(|value| normalized_compare_key(Path::new(value)));
    if let Some(requested_key) = requested_file_key {
        if let Some(element) = lookup
            .elements_by_file_qname
            .get(&(requested_key, target.to_string()))
        {
            return Ok(Some(semantic_element_to_indexed_view(element)));
        }
    }
    Ok(lookup
        .best_elements_by_qname
        .get(target)
        .map(semantic_element_to_indexed_view))
}

pub fn query_project_semantic_projection_by_qualified_name(
    state: &CoreState,
    project_root: String,
    qualified_name: String,
    file_path: Option<String>,
) -> Result<Option<IndexedSemanticProjectionElementView>, String> {
    let project_root = canonical_project_root(&project_root);
    seed_symbol_index_if_empty(state, &project_root)?;
    let target = qualified_name.trim();
    if target.is_empty() {
        return Ok(None);
    }
    let lookup = ensure_project_semantic_lookup_loaded(state, &project_root)?;
    let requested_file_key = file_path
        .as_deref()
        .map(|value| normalized_compare_key(Path::new(value)));
    if let Some(requested_key) = requested_file_key {
        if let Some(projection) = lookup
            .projections_by_file_qname
            .get(&(requested_key, target.to_string()))
        {
            return Ok(Some(projection_element_to_indexed_view(projection)));
        }
    }
    if let Some(projection) = lookup.best_projections_by_qname.get(target) {
        return Ok(Some(projection_element_to_indexed_view(projection)));
    }

    query_project_semantic_element_by_qualified_name(state, project_root, qualified_name, file_path)
        .map(|legacy| legacy.map(fallback_projection_view_from_legacy_element))
}

fn fallback_projection_view_from_legacy_element(
    element: IndexedSemanticElementView,
) -> IndexedSemanticProjectionElementView {
    let metatype_qname = element
        .attributes
        .get("emf::metatype")
        .cloned()
        .or_else(|| element.attributes.get("metatype_qname").cloned());
    let mut features = element
        .attributes
        .into_iter()
        .map(|(name, value)| {
            let parsed = if value == "true" || value == "false" {
                SemanticValueView::Bool {
                    value: value == "true",
                }
            } else if let Ok(v) = value.parse::<i64>() {
                SemanticValueView::I64 { value: v }
            } else if let Ok(v) = value.parse::<u64>() {
                SemanticValueView::U64 { value: v }
            } else if let Ok(v) = value.parse::<f64>() {
                SemanticValueView::F64 { value: v }
            } else {
                SemanticValueView::Text { value }
            };
            SemanticFeatureView {
                name,
                feature_kind: "attribute".to_string(),
                many: false,
                containment: false,
                declared_type_qname: None,
                metamodel_feature_qname: None,
                value: parsed,
                diagnostics: Vec::new(),
            }
        })
        .collect::<Vec<_>>();
    features.sort_by(|left, right| left.name.cmp(&right.name));
    IndexedSemanticProjectionElementView {
        name: element.name,
        qualified_name: element.qualified_name,
        file_path: element.file_path,
        metatype_qname,
        features,
    }
}

fn semantic_element_to_indexed_view(
    element: &mercurio_sysml_semantics::semantic_contract::SemanticElementView,
) -> IndexedSemanticElementView {
    let mut attributes = BTreeMap::<String, String>::new();
    for (key, value) in &element.attributes {
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        attributes.insert(key.to_string(), value.to_string());
    }
    attributes
        .entry("emf::qualifiedName".to_string())
        .or_insert_with(|| element.qualified_name.clone());
    attributes
        .entry("emf::name".to_string())
        .or_insert_with(|| element.name.clone());
    if let Some(metatype) = element.metatype_qname.as_ref() {
        attributes
            .entry("emf::metatype".to_string())
            .or_insert_with(|| metatype.clone());
    }
    IndexedSemanticElementView {
        name: element.name.clone(),
        qualified_name: element.qualified_name.clone(),
        file_path: element.file_path.clone(),
        attributes,
    }
}

fn projection_element_to_indexed_view(
    element: &SemanticElementProjectionView,
) -> IndexedSemanticProjectionElementView {
    IndexedSemanticProjectionElementView {
        name: element.name.clone(),
        qualified_name: element.qualified_name.clone(),
        file_path: element.file_path.clone(),
        metatype_qname: element.metatype_qname.clone(),
        features: element.features.clone(),
    }
}

fn semantic_element_score(candidate: &SemanticElementView) -> usize {
    let mut score = candidate.attributes.len();
    let metatype_present = candidate
        .attributes
        .get("metatype_qname")
        .or_else(|| candidate.attributes.get("emf::metatype"))
        .or_else(|| candidate.metatype_qname.as_ref())
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    if metatype_present {
        score += 500;
    }
    let metatype_source = candidate
        .attributes
        .get("metatype_source")
        .or_else(|| candidate.attributes.get("mercurio::metatypeSource"))
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !metatype_source.is_empty() {
        if metatype_source == "unresolved" {
            score = score.saturating_sub(200);
        } else {
            score += 200;
        }
    }
    score
}

fn normalized_compare_key(path: &Path) -> String {
    let normalized = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    normalized
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        compile_project_delta_sync, compile_project_delta_sync_with_options,
        compile_workspace_sync, load_library_symbols_sync, settings::AppSettings, CoreState,
    };
    use std::fs;
    use std::path::Path;
    use std::thread;
    use std::time::Duration;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn normalized_compare_key(path: &Path) -> String {
        let normalized = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        normalized
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase()
    }

    #[test]
    fn queries_return_indexed_symbols_after_compile_and_library_load() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_symbol_index_query_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { doc /* d */ package Root { metaclass Action specializes Element {} } }",
        )
        .expect("write library file");
        fs::write(
            project_dir.join("main.sysml"),
            "package P { action def DoThing; }\n",
        )
        .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"index\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let _ = compile_workspace_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            1,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile");
        let _ = load_library_symbols_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            None,
            true,
        )
        .expect("load library symbols");

        let mapping = query_symbol_metatype_mapping(
            &state,
            project_dir.to_string_lossy().to_string(),
            "P".to_string(),
            Some(project_dir.join("main.sysml").to_string_lossy().to_string()),
        )
        .expect("query symbol mapping")
        .expect("mapping exists");
        assert_eq!(mapping.symbol_qualified_name, "P");
        assert!(!mapping.mapping_source.is_empty());
        let mapped_metatype = mapping
            .resolved_metatype_qname
            .clone()
            .expect("resolved metatype");
        let mapped_symbols = query_symbols_by_metatype(
            &state,
            project_dir.to_string_lossy().to_string(),
            mapped_metatype,
        )
        .expect("query by mapped metatype");
        assert!(!mapped_symbols.is_empty());

        let docs = query_stdlib_documentation_symbols(&state, normalized_compare_key(&library_dir))
            .expect("query docs");
        assert!(!docs.is_empty());

        let all_stdlib = query_library_symbols(
            &state,
            project_dir.to_string_lossy().to_string(),
            None,
            Some(0),
            Some(10_000),
        )
        .expect("query all stdlib symbols");
        assert!(!all_stdlib.is_empty());

        let paged_stdlib = query_library_symbols(
            &state,
            project_dir.to_string_lossy().to_string(),
            None,
            Some(0),
            Some(1),
        )
        .expect("query paged stdlib symbols");
        assert_eq!(paged_stdlib.len(), 1);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ui_like_flow_populates_project_and_library_symbols() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_ui_like_flow_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { package Root { metaclass Action specializes Element {} } }",
        )
        .expect("write library file");
        fs::write(
            project_dir.join("main.sysml"),
            "package P { action def DoThing; part def Car; }\n",
        )
        .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"ui-like\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"**/*.sysml\",\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let project_root = project_dir.to_string_lossy().to_string();

        // UI startup path: metadata-only library load (files known, symbols deferred).
        let metadata_only = load_library_symbols_sync(&state, project_root.clone(), None, false)
            .expect("metadata-only library load");
        assert!(metadata_only.ok);
        assert!(!metadata_only.library_files.is_empty());
        assert_eq!(metadata_only.symbols.len(), 0);

        // UI background compile path: project delta compile (no library symbols in response).
        let delta = compile_project_delta_sync(
            &state,
            project_root.clone(),
            42,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("delta compile");
        assert!(delta.ok);
        assert!(delta.project_symbol_count > 0);
        assert!(delta.symbols.iter().any(|s| s.qualified_name == "P"));

        // UI fallback/index query path: project symbols should become queryable.
        let mut indexed_project = Vec::new();
        for _ in 0..20 {
            indexed_project =
                query_project_symbols(&state, project_root.clone(), None, Some(0), Some(10_000))
                    .expect("query indexed project symbols");
            if !indexed_project.is_empty() {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        assert!(
            !indexed_project.is_empty(),
            "indexed project symbols should not remain empty after UI-like flow"
        );
        assert!(indexed_project.iter().any(|s| s.qualified_name == "P"));

        // UI bootstrap path: explicit library symbol load.
        let library_full = load_library_symbols_sync(&state, project_root.clone(), None, true)
            .expect("full library load");
        assert!(library_full.ok);
        assert!(!library_full.symbols.is_empty());

        let indexed_library =
            query_library_symbols(&state, project_root, None, Some(0), Some(10_000))
                .expect("query indexed library symbols");
        assert!(!indexed_library.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn query_symbol_endpoints_seed_from_workspace_ir_cache() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_symbol_index_seed_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { package Root { metaclass Action specializes Element {} } }",
        )
        .expect("write library file");
        fs::write(
            project_dir.join("main.sysml"),
            "package P { action def DoThing; part def Car; }\n",
        )
        .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"seed\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"**/*.sysml\",\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let project_root = project_dir.to_string_lossy().to_string();

        let compile = compile_project_delta_sync(
            &state,
            project_root.clone(),
            42,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile");
        assert!(compile.ok);

        let library = load_library_symbols_sync(&state, project_root.clone(), None, true)
            .expect("load library symbols");
        assert!(library.ok);
        assert!(!library.symbols.is_empty());

        state.clear_runtime_caches().expect("clear runtime caches");

        let indexed_library =
            query_library_symbols(&state, project_root.clone(), None, Some(0), Some(10_000))
                .expect("query cached library symbols");
        assert!(!indexed_library.is_empty());

        let indexed_project =
            query_project_symbols(&state, project_root.clone(), None, Some(0), Some(10_000))
                .expect("query cached project symbols");
        assert!(indexed_project
            .iter()
            .any(|symbol| symbol.qualified_name == "P"));

        let file_project = query_project_symbols_for_files(
            &state,
            project_root,
            vec![project_dir.join("main.sysml").to_string_lossy().to_string()],
            Some(0),
            Some(10_000),
        )
        .expect("query cached project symbols for file");
        assert!(file_project
            .iter()
            .any(|symbol| symbol.qualified_name == "P"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn query_project_semantic_element_by_qualified_name_uses_semantic_cache() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_semantic_qname_lookup_{stamp}"));
        let project_dir = root.join("project");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            project_dir.join("main.sysml"),
            "package P { action def DoThing; }\n",
        )
        .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            "{\"name\":\"lookup\",\"src\":[\"*.sysml\"]}",
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let project_root = project_dir.to_string_lossy().to_string();
        let _ = compile_project_delta_sync(
            &state,
            project_root.clone(),
            77,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile");

        let found = query_project_semantic_element_by_qualified_name(
            &state,
            project_root.clone(),
            "P".to_string(),
            None,
        )
        .expect("query by qname")
        .expect("semantic row exists");
        assert_eq!(found.qualified_name, "P");
        assert_eq!(
            found
                .attributes
                .get("emf::qualifiedName")
                .map(|value| value.as_str()),
            Some("P")
        );

        let missing = query_project_semantic_element_by_qualified_name(
            &state,
            project_root,
            "DoesNotExist".to_string(),
            None,
        )
        .expect("query missing");
        assert!(missing.is_none());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn query_project_semantic_element_prefers_requested_file_path() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("mercurio_semantic_qname_file_lookup_{stamp}"));
        let project_dir = root.join("project");
        fs::create_dir_all(&project_dir).expect("create project dir");
        let left = project_dir.join("left.sysml");
        let right = project_dir.join("right.sysml");
        fs::write(&left, "package P { action def LeftAction; }\n").expect("write left file");
        fs::write(&right, "package P { action def RightAction; }\n").expect("write right file");
        fs::write(
            project_dir.join(".project"),
            "{\"name\":\"lookup\",\"src\":[\"*.sysml\"]}",
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let project_root = project_dir.to_string_lossy().to_string();
        let _ = compile_project_delta_sync(
            &state,
            project_root.clone(),
            91,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile");

        let right_row = query_project_semantic_element_by_qualified_name(
            &state,
            project_root,
            "P".to_string(),
            Some(right.to_string_lossy().to_string()),
        )
        .expect("query by qname with file")
        .expect("semantic row exists");
        assert_eq!(
            normalized_compare_key(Path::new(&right_row.file_path)),
            normalized_compare_key(&right)
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn query_project_semantic_element_resolves_package_metatype_in_delta_compile_without_symbols() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "mercurio_semantic_pkg_metatype_delta_no_symbols_{stamp}"
        ));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            library_dir.join("Kernel.kerml"),
            "standard library package Kernel { package Root { metaclass Element {} metaclass PackageDefinition specializes Element {} metaclass ActionDefinition specializes Element {} } }",
        )
        .expect("write stdlib file");
        let main_file = project_dir.join("main.sysml");
        fs::write(
            &main_file,
            "package P { action def Focus { out xrsl: Exposure; } }\n",
        )
        .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"semantic-pkg\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let project_root = project_dir.to_string_lossy().to_string();
        let response = compile_project_delta_sync_with_options(
            &state,
            project_root.clone(),
            901,
            true,
            None,
            Vec::new(),
            false,
            |_| {},
        )
        .expect("delta compile");
        assert!(response.ok);
        assert_eq!(response.symbols.len(), 0);
        assert!(response.stdlib_file_count >= 1);

        let package = query_project_semantic_element_by_qualified_name(
            &state,
            project_root.clone(),
            "P".to_string(),
            Some(main_file.to_string_lossy().to_string()),
        )
        .expect("query package semantic row")
        .expect("package semantic row");
        assert_eq!(
            package
                .attributes
                .get("metatype_source")
                .map(|value| value.as_str()),
            Some("inferred-kind")
        );
        assert!(
            package
                .attributes
                .get("metatype_qname")
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false),
            "package metatype_qname should be present"
        );

        let action = query_project_semantic_element_by_qualified_name(
            &state,
            project_root,
            "P::Focus".to_string(),
            Some(main_file.to_string_lossy().to_string()),
        )
        .expect("query action semantic row")
        .expect("action semantic row");
        assert_eq!(
            action
                .attributes
                .get("metatype_source")
                .map(|value| value.as_str()),
            Some("inferred-kind")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn query_project_semantic_element_prefers_resolved_candidate_without_file_hint() {
        let state = CoreState::new(
            std::env::temp_dir().join("mercurio_semantic_candidate_pref"),
            AppSettings::default(),
        );
        let project_root = "C:\\tmp\\semantic-candidate-pref".to_string();
        let unresolved = mercurio_sysml_semantics::semantic_contract::SemanticElementView {
            name: "P".to_string(),
            qualified_name: "P".to_string(),
            metatype_qname: None,
            file_path: "C:\\tmp\\left.sysml".to_string(),
            attributes: std::collections::HashMap::from([
                ("metatype_source".to_string(), "unresolved".to_string()),
                ("kind".to_string(), "Package".to_string()),
            ]),
        };
        let resolved = mercurio_sysml_semantics::semantic_contract::SemanticElementView {
            name: "P".to_string(),
            qualified_name: "P".to_string(),
            metatype_qname: Some("sysml::Package".to_string()),
            file_path: "C:\\tmp\\right.sysml".to_string(),
            attributes: std::collections::HashMap::from([
                ("metatype_source".to_string(), "inferred-kind".to_string()),
                ("metatype_qname".to_string(), "sysml::Package".to_string()),
                ("kind".to_string(), "Package".to_string()),
            ]),
        };
        {
            let mut cache = state
                .workspace_snapshot_cache
                .lock()
                .expect("workspace cache lock");
            cache.insert(
                format!("project-semantic|{}|a", project_root),
                WorkspaceSnapshotCacheEntry::ProjectSemantic(std::sync::Arc::new(vec![unresolved])),
            );
            cache.insert(
                format!("project-semantic|{}|b", project_root),
                WorkspaceSnapshotCacheEntry::ProjectSemantic(std::sync::Arc::new(vec![resolved])),
            );
        }

        let found = query_project_semantic_element_by_qualified_name(
            &state,
            project_root,
            "P".to_string(),
            None,
        )
        .expect("semantic query")
        .expect("semantic row");
        assert_eq!(
            found
                .attributes
                .get("metatype_source")
                .map(|value| value.as_str()),
            Some("inferred-kind")
        );
        assert_eq!(
            found
                .attributes
                .get("metatype_qname")
                .map(|value| value.as_str()),
            Some("sysml::Package")
        );
    }

    #[test]
    fn query_project_semantic_projection_reads_typed_cache_entry() {
        let state = CoreState::new(
            std::env::temp_dir().join("mercurio_semantic_projection_cache"),
            AppSettings::default(),
        );
        let project_root = "C:\\tmp\\semantic-projection".to_string();
        let projection =
            mercurio_sysml_semantics::semantic_contract::SemanticElementProjectionView {
                name: "w".to_string(),
                qualified_name: "Example::w".to_string(),
                metatype_qname: Some("sysml::PartUsage".to_string()),
                file_path: "C:\\tmp\\Example.sysml".to_string(),
                features: vec![
                    mercurio_sysml_semantics::semantic_contract::SemanticFeatureView {
                        name: "name".to_string(),
                        feature_kind: "attribute".to_string(),
                        many: false,
                        containment: false,
                        declared_type_qname: None,
                        metamodel_feature_qname: Some("sysml::Element::name".to_string()),
                        value:
                            mercurio_sysml_semantics::semantic_contract::SemanticValueView::Text {
                                value: "w".to_string(),
                            },
                        diagnostics: Vec::new(),
                    },
                ],
            };
        {
            let mut cache = state
                .workspace_snapshot_cache
                .lock()
                .expect("workspace cache lock");
            cache.insert(
                format!("project-semantic|{}|typed", project_root),
                WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(std::sync::Arc::new(vec![
                    projection,
                ])),
            );
        }

        let found = query_project_semantic_projection_by_qualified_name(
            &state,
            project_root,
            "Example::w".to_string(),
            None,
        )
        .expect("semantic projection query")
        .expect("semantic projection row");
        assert_eq!(found.qualified_name, "Example::w");
        assert_eq!(found.features.len(), 1);
        assert_eq!(found.features[0].name, "name");
    }

    #[test]
    fn query_project_semantic_projection_returns_fresh_rows_after_recompile() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_projection_refresh_{stamp}"));
        let project_dir = root.join("project");
        fs::create_dir_all(&project_dir).expect("create project dir");
        let main_file = project_dir.join("main.sysml");
        fs::write(&main_file, "package P { action def OldAction; }\n")
            .expect("write initial project file");
        fs::write(
            project_dir.join(".project"),
            "{\"name\":\"projection-refresh\",\"src\":[\"*.sysml\"]}",
        )
        .expect("write project descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let project_root = project_dir.to_string_lossy().to_string();

        let first_compile = compile_workspace_sync(
            &state,
            project_root.clone(),
            1,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("first compile");
        assert!(first_compile.ok);

        let old_row = query_project_semantic_projection_by_qualified_name(
            &state,
            project_root.clone(),
            "P::OldAction".to_string(),
            Some(main_file.to_string_lossy().to_string()),
        )
        .expect("query old projection")
        .expect("old projection row");
        assert_eq!(old_row.qualified_name, "P::OldAction");

        fs::write(&main_file, "package P { action def NewAction; }\n")
            .expect("write updated project file");
        let second_compile = compile_project_delta_sync(
            &state,
            project_root.clone(),
            2,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("second compile");
        assert!(second_compile.ok);

        let old_after_recompile = query_project_semantic_projection_by_qualified_name(
            &state,
            project_root.clone(),
            "P::OldAction".to_string(),
            Some(main_file.to_string_lossy().to_string()),
        )
        .expect("query stale projection");
        assert!(old_after_recompile.is_none());

        let new_row = query_project_semantic_projection_by_qualified_name(
            &state,
            project_root.clone(),
            "P::NewAction".to_string(),
            Some(main_file.to_string_lossy().to_string()),
        )
        .expect("query new projection")
        .expect("new projection row");
        assert_eq!(new_row.qualified_name, "P::NewAction");
        assert!(new_row
            .features
            .iter()
            .any(|feature| feature.name == "name"));

        let cache = state
            .workspace_snapshot_cache
            .lock()
            .expect("workspace cache lock");
        let root_prefix = format!("project-semantic|{}|", project_root);
        assert!(cache.iter().any(|(key, entry)| {
            key.starts_with(&root_prefix)
                && matches!(
                    entry,
                    WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(_)
                )
        }));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn query_project_semantic_projection_seeds_from_workspace_ir_cache() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_projection_seed_{stamp}"));
        fs::create_dir_all(&root).expect("create root");
        let project_root = root.to_string_lossy().to_string();
        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());

        {
            let mut store = state.symbol_index.lock().expect("index lock");
            store.upsert_symbols_for_file(
                &project_root,
                "main.sysml",
                vec![mercurio_symbol_index::SymbolRecord {
                    id: "p1".to_string(),
                    project_root: project_root.clone(),
                    library_key: None,
                    scope: mercurio_symbol_index::Scope::Project,
                    name: "Main".to_string(),
                    qualified_name: "Demo::Main".to_string(),
                    parent_qualified_name: Some("Demo".to_string()),
                    kind: "Package".to_string(),
                    metatype_qname: Some("sysml::Package".to_string()),
                    file_path: "main.sysml".to_string(),
                    start_line: 1,
                    start_col: 1,
                    end_line: 1,
                    end_col: 1,
                    doc_text: None,
                    properties_json: None,
                }],
            );
            store.rebuild_symbol_mappings(&project_root);
        }
        {
            let mut cache = state
                .workspace_snapshot_cache
                .lock()
                .expect("workspace cache lock");
            cache.insert(
                format!("project-semantic|{}|typed", project_root),
                WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(std::sync::Arc::new(vec![
                    mercurio_sysml_semantics::semantic_contract::SemanticElementProjectionView {
                        name: "Main".to_string(),
                        qualified_name: "Demo::Main".to_string(),
                        metatype_qname: Some("sysml::Package".to_string()),
                        file_path: "main.sysml".to_string(),
                        features: vec![
                            mercurio_sysml_semantics::semantic_contract::SemanticFeatureView {
                                name: "name".to_string(),
                                feature_kind: "attribute".to_string(),
                                many: false,
                                containment: false,
                                declared_type_qname: None,
                                metamodel_feature_qname: Some("sysml::Element::name".to_string()),
                                value: mercurio_sysml_semantics::semantic_contract::SemanticValueView::Text {
                                    value: "Main".to_string(),
                                },
                                diagnostics: Vec::new(),
                            },
                        ],
                    },
                ])),
            );
        }
        crate::workspace_ir_cache::persist_workspace_ir_cache(&state, &project_root, None)
            .expect("persist workspace cache");
        state.clear_runtime_caches().expect("clear runtime caches");

        let found = query_project_semantic_projection_by_qualified_name(
            &state,
            project_root.clone(),
            "Demo::Main".to_string(),
            Some("main.sysml".to_string()),
        )
        .expect("semantic projection query")
        .expect("semantic projection row");
        assert_eq!(found.qualified_name, "Demo::Main");
        assert_eq!(found.features.len(), 1);
        assert_eq!(found.features[0].name, "name");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn query_project_symbols_for_files_returns_combined_rows() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_batch_symbol_query_{stamp}"));
        let project_dir = root.join("project");
        fs::create_dir_all(&project_dir).expect("create project dir");
        let left = project_dir.join("left.sysml");
        let right = project_dir.join("right.sysml");
        fs::write(&left, "package LeftPkg { action def LeftAction; }\n").expect("write left file");
        fs::write(&right, "package RightPkg { action def RightAction; }\n")
            .expect("write right file");
        fs::write(
            project_dir.join(".project"),
            "{\"name\":\"batch\",\"src\":[\"*.sysml\"]}",
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let project_root = project_dir.to_string_lossy().to_string();
        let _ = compile_project_delta_sync(
            &state,
            project_root.clone(),
            111,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile");

        let rows = query_project_symbols_for_files(
            &state,
            project_root,
            vec![
                left.to_string_lossy().to_string(),
                right.to_string_lossy().to_string(),
            ],
            Some(0),
            Some(10_000),
        )
        .expect("batch query");
        assert!(rows.iter().any(|row| row.qualified_name == "LeftPkg"));
        assert!(rows.iter().any(|row| row.qualified_name == "RightPkg"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn project_symbol_queries_accept_raw_and_canonical_roots() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_root_canonical_{stamp}"));
        let project_dir = root.join("project");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            project_dir.join("main.sysml"),
            "package P { part def A; }\n",
        )
        .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            "{\"name\":\"canonical-root\",\"src\":[\"*.sysml\"]}",
        )
        .expect("write descriptor");

        let raw_project_root = project_dir.join(".").to_string_lossy().to_string();
        let canonical_project_root = project_dir
            .canonicalize()
            .expect("canonicalize project root")
            .to_string_lossy()
            .to_string();
        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());

        let response = compile_project_delta_sync(
            &state,
            raw_project_root.clone(),
            333,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile");
        assert!(response.ok);

        let canonical_rows = query_project_symbols(
            &state,
            canonical_project_root.clone(),
            None,
            Some(0),
            Some(10_000),
        )
        .expect("canonical root query");
        assert!(canonical_rows.iter().any(|row| row.qualified_name == "P"));

        let raw_rows = query_project_symbols(&state, raw_project_root, None, Some(0), Some(10_000))
            .expect("raw root query");
        assert!(raw_rows.iter().any(|row| row.qualified_name == "P"));

        let _ = fs::remove_dir_all(root);
    }
}
