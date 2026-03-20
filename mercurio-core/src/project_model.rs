use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use mercurio_symbol_index::{SymbolIndexStore, SymbolRecord};
use mercurio_sysml_pkg::project_model_projection::{
    collect_direct_metatype_attributes, collect_inherited_attributes,
    collect_inherited_metatype_attributes, collect_project_expression_records,
    resolve_mapped_metatype, symbol_to_attribute_rows, SymbolMetatypeMappingData,
};
pub use mercurio_sysml_pkg::project_model_projection::{
    ProjectExpressionRecordView, ProjectExpressionRecordsView,
};
pub use mercurio_sysml_semantics::semantic_project_model_contract::{
    ProjectElementAttributesView, ProjectElementInheritedAttributeView, ProjectModelAttributeView,
    ProjectModelElementView, ProjectModelView,
};
use mercurio_sysml_semantics::stdlib::MetatypeIndex;
use serde::{Deserialize, Serialize};

use crate::project::load_project_config;
use crate::project_model_seed::seed_symbol_index_if_empty;
use crate::project_root_key::canonical_project_root;
use crate::state::{CoreState, WorkspaceSnapshotCacheEntry};
use crate::stdlib::resolve_stdlib_path;
use crate::symbol_index::{
    query_project_semantic_projection_by_qualified_name, IndexedSemanticProjectionElementView,
};
use crate::workspace::collect_project_files;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ElementSourceScope {
    Project,
    Library,
}

impl ElementSourceScope {
    fn from_option(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some(value) if value.eq_ignore_ascii_case("library") => Self::Library,
            Some(value) if value.eq_ignore_ascii_case("stdlib") => Self::Library,
            _ => Self::Project,
        }
    }

    fn missing_symbol_message(self) -> &'static str {
        match self {
            Self::Project => "Element not found in current project symbol index.",
            Self::Library => "Element not found in current stdlib symbol index.",
        }
    }

    fn missing_semantic_message(self) -> &'static str {
        match self {
            Self::Project => "No semantic row in EMF cache. Run Compile to refresh.",
            Self::Library => "No semantic row in stdlib semantic cache. Run Compile to refresh.",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectElementPropertyRowView {
    pub key: String,
    pub label: String,
    pub value: String,
    pub qualified_name: Option<String>,
    pub is_empty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectElementPropertySectionView {
    pub key: String,
    pub label: String,
    pub collapsible: bool,
    pub rows: Vec<ProjectElementPropertyRowView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectElementPropertySectionsView {
    pub element_qualified_name: String,
    pub metatype_qname: Option<String>,
    pub direct_metatype_attributes: Vec<ProjectElementInheritedAttributeView>,
    pub inherited_metatype_attributes: Vec<ProjectElementInheritedAttributeView>,
    pub sections: Vec<ProjectElementPropertySectionView>,
    pub diagnostics: Vec<String>,
}

fn resolve_symbol_metatype(
    store: &dyn SymbolIndexStore,
    root: &str,
    symbol: &SymbolRecord,
) -> (Option<String>, Vec<String>) {
    let mapping = store
        .symbol_mapping(root, &symbol.qualified_name, Some(&symbol.file_path))
        .or_else(|| store.symbol_mapping(root, &symbol.qualified_name, None))
        .map(|row| SymbolMetatypeMappingData {
            resolved_metatype_qname: row.resolved_metatype_qname,
            mapping_source: row.mapping_source,
            confidence: row.confidence,
            diagnostic: row.diagnostic,
        });
    resolve_mapped_metatype(
        &symbol.qualified_name,
        symbol.metatype_qname.as_deref(),
        symbol.properties_json.as_deref(),
        mapping.as_ref(),
    )
}

pub fn get_project_element_attributes(
    state: &CoreState,
    root: String,
    element_qualified_name: String,
    symbol_kind: Option<String>,
) -> Result<ProjectElementAttributesView, String> {
    get_element_attributes_internal(
        state,
        root,
        element_qualified_name,
        symbol_kind,
        ElementSourceScope::Project,
    )
}

fn get_element_attributes_internal(
    state: &CoreState,
    root: String,
    element_qualified_name: String,
    symbol_kind: Option<String>,
    source_scope: ElementSourceScope,
) -> Result<ProjectElementAttributesView, String> {
    let root = canonical_project_root(&root);
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }
    seed_symbol_index_if_empty(state, &root)?;

    let (symbol, metatype_qname, mut diagnostics) = {
        let store = state
            .symbol_index
            .lock()
            .map_err(|_| "Symbol index lock poisoned".to_string())?;
        let symbol = match source_scope {
            ElementSourceScope::Project => {
                store.project_symbol(&root, &element_qualified_name, symbol_kind.as_deref())
            }
            ElementSourceScope::Library => find_library_symbol(
                &*store,
                &root,
                &element_qualified_name,
                symbol_kind.as_deref(),
            ),
        };
        let Some(symbol) = symbol
        else {
            return Ok(ProjectElementAttributesView {
                element_qualified_name,
                metatype_qname: None,
                explicit_attributes: Vec::new(),
                inherited_attributes: Vec::new(),
                direct_metatype_attributes: Vec::new(),
                inherited_metatype_attributes: Vec::new(),
                expressions: Vec::new(),
                diagnostics: vec![source_scope.missing_symbol_message().to_string()],
            });
        };
        let (metatype_qname, diagnostics) = resolve_symbol_metatype(&*store, &root, &symbol);
        (symbol, metatype_qname, diagnostics)
    };

    if metatype_qname.is_none() {
        if diagnostics.is_empty() {
            diagnostics.push(format!(
                "Metatype unresolved: no mapping found for element '{}' (kind='{}', file='{}').",
                symbol.qualified_name, symbol.kind, symbol.file_path
            ));
        } else {
            diagnostics.push(format!(
                "Metatype unresolved for element '{}' (kind='{}').",
                symbol.qualified_name, symbol.kind
            ));
        }
        diagnostics.push(
            "Metatype mapping is unavailable for this symbol in the current index state."
                .to_string(),
        );
        diagnostics.push(
            "No per-request semantic refresh is performed in this endpoint; run compile to refresh symbol and metatype data.".to_string(),
        );
    }
    let explicit_attributes = symbol_to_attribute_rows(
        &symbol.qualified_name,
        &symbol.name,
        symbol.properties_json.as_deref(),
        metatype_qname.as_deref(),
    );
    let symbol_qualified_name = symbol.qualified_name.clone();
    let expressions = match source_scope {
        ElementSourceScope::Project => {
            let expression_view = get_project_expression_records(state, root.clone())?;
            diagnostics.extend(expression_view.diagnostics);
            expression_view
                .records
                .into_iter()
                .filter(|record| {
                    record.owner_qualified_name == symbol_qualified_name
                        || record.qualified_name == symbol_qualified_name
                })
                .collect::<Vec<_>>()
        }
        ElementSourceScope::Library => Vec::new(),
    };
    let (direct_metatype_attributes, inherited_metatype_attributes, inherited_attributes) =
        match load_stdlib_metatype_index(state, &root) {
            Ok(Some(index)) => {
                let direct = collect_direct_metatype_attributes(
                    &index,
                    metatype_qname.as_deref(),
                    &mut diagnostics,
                );
                let inherited_metatype = collect_inherited_metatype_attributes(
                    &index,
                    metatype_qname.as_deref(),
                    &mut diagnostics,
                );
                let inherited = collect_inherited_attributes(
                    &index,
                    metatype_qname.as_deref(),
                    &explicit_attributes,
                    &mut diagnostics,
                );
                (direct, inherited_metatype, inherited)
            }
            Ok(None) => {
                diagnostics.push(
                    "Inherited attributes unavailable because stdlib metatype index is unresolved."
                        .to_string(),
                );
                (Vec::new(), Vec::new(), Vec::new())
            }
            Err(error) => {
                diagnostics.push(format!("Unable to load stdlib metatype index: {error}"));
                (Vec::new(), Vec::new(), Vec::new())
            }
        };

    Ok(ProjectElementAttributesView {
        element_qualified_name,
        metatype_qname: metatype_qname.clone(),
        explicit_attributes,
        inherited_attributes,
        direct_metatype_attributes,
        inherited_metatype_attributes,
        expressions,
        diagnostics,
    })
}

pub fn get_project_element_property_sections(
    state: &CoreState,
    root: String,
    element_qualified_name: String,
    file_path: Option<String>,
    symbol_kind: Option<String>,
    source_scope: Option<String>,
) -> Result<ProjectElementPropertySectionsView, String> {
    let source_scope = ElementSourceScope::from_option(source_scope.as_deref());
    let attrs = get_element_attributes_internal(
        state,
        root.clone(),
        element_qualified_name.clone(),
        symbol_kind,
        source_scope,
    )?;
    let semantic_projection = match source_scope {
        ElementSourceScope::Project => query_project_semantic_projection_by_qualified_name(
            state,
            root,
            element_qualified_name.clone(),
            file_path,
        )?,
        ElementSourceScope::Library => query_stdlib_semantic_projection_by_qualified_name(
            state,
            root,
            element_qualified_name.clone(),
            file_path,
        )?,
    };

    let mut diagnostics = attrs.diagnostics.clone();
    let resolved_metatype_qname = semantic_projection
        .as_ref()
        .and_then(|projection| projection.metatype_qname.clone())
        .or_else(|| attrs.metatype_qname.clone());
    let direct_metatype_attributes = attrs.direct_metatype_attributes.clone();
    let inherited_metatype_attributes = if !attrs.inherited_metatype_attributes.is_empty() {
        attrs.inherited_metatype_attributes.clone()
    } else {
        attrs.inherited_attributes.clone()
    };
    let sections = build_project_element_property_sections(
        semantic_projection.as_ref(),
        &attrs,
        &element_qualified_name,
        &mut diagnostics,
        source_scope.missing_semantic_message(),
    );

    Ok(ProjectElementPropertySectionsView {
        element_qualified_name,
        metatype_qname: resolved_metatype_qname,
        direct_metatype_attributes,
        inherited_metatype_attributes,
        sections,
        diagnostics,
    })
}

fn find_library_symbol(
    store: &dyn SymbolIndexStore,
    root: &str,
    element_qualified_name: &str,
    symbol_kind: Option<&str>,
) -> Option<SymbolRecord> {
    let mut out = store
        .library_symbols(root, None)
        .into_iter()
        .filter(|symbol| symbol.qualified_name == element_qualified_name)
        .collect::<Vec<_>>();
    if let Some(kind) = symbol_kind {
        if let Some(exact) = out
            .iter()
            .find(|symbol| symbol.kind.eq_ignore_ascii_case(kind))
        {
            return Some(exact.clone());
        }
    }
    out.sort_by(|a, b| {
        a.file_path
            .cmp(&b.file_path)
            .then(a.start_line.cmp(&b.start_line))
            .then(a.start_col.cmp(&b.start_col))
    });
    out.into_iter().next()
}

fn query_stdlib_semantic_projection_by_qualified_name(
    state: &CoreState,
    root: String,
    qualified_name: String,
    file_path: Option<String>,
) -> Result<Option<IndexedSemanticProjectionElementView>, String> {
    let root = canonical_project_root(&root);
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }

    let target = qualified_name.trim();
    if target.is_empty() {
        return Ok(None);
    }

    let library_key = resolve_current_stdlib_library_key(state, &root_path)?;
    let Some(library_key) = library_key else {
        return Ok(None);
    };
    let cache_key = format!("stdlib-semantic-projection|{library_key}");
    let cache = state
        .workspace_snapshot_cache
        .lock()
        .map_err(|_| "Workspace snapshot cache lock poisoned".to_string())?;
    let Some(WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(projections)) =
        cache.get(&cache_key)
    else {
        return Ok(None);
    };

    let requested_file_key = file_path
        .as_deref()
        .map(|value| normalize_compare_key(std::path::Path::new(value)));
    if let Some(requested_key) = requested_file_key {
        if let Some(projection) = projections.iter().find(|projection| {
            projection.qualified_name == target
                && normalize_compare_key(std::path::Path::new(&projection.file_path)) == requested_key
        }) {
            return Ok(Some(indexed_projection_view(projection)));
        }
    }

    Ok(projections
        .iter()
        .filter(|projection| projection.qualified_name == target)
        .max_by_key(|projection| projection.features.len())
        .map(indexed_projection_view))
}

fn indexed_projection_view(
    projection: &mercurio_sysml_semantics::semantic_contract::SemanticElementProjectionView,
) -> IndexedSemanticProjectionElementView {
    IndexedSemanticProjectionElementView {
        name: projection.name.clone(),
        qualified_name: projection.qualified_name.clone(),
        file_path: projection.file_path.clone(),
        metatype_qname: projection.metatype_qname.clone(),
        features: projection.features.clone(),
    }
}

pub fn get_project_expressions_view(
    root: String,
    file_path: Option<String>,
    qualified_name: Option<String>,
    xtext_export_path: Option<String>,
) -> Result<ProjectExpressionRecordsView, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }
    mercurio_sysml_pkg::mcp_api::get_project_expressions_view(
        root_path.as_path(),
        file_path.as_deref(),
        qualified_name.as_deref(),
        xtext_export_path.as_deref(),
    )
}

pub fn evaluate_project_expression(root: String, expression: String) -> Result<String, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }

    let project_config = load_project_config(&root_path).ok().flatten();
    let src_patterns = project_config
        .as_ref()
        .and_then(|config| config.src.as_deref())
        .unwrap_or(&[]);
    let project_files = collect_project_files(&root_path, src_patterns)?;
    let mut project_sources = Vec::<String>::new();
    for path in project_files {
        project_sources.push(
            fs::read_to_string(&path)
                .map_err(|error| format!("Failed to read '{}': {}", path.display(), error))?,
        );
    }
    mercurio_sysml_pkg::expression_eval::eval_expression_in_sources(&project_sources, &expression)
}

fn load_stdlib_metatype_index(
    state: &CoreState,
    root: &str,
) -> Result<Option<Arc<MetatypeIndex>>, String> {
    let root_path = PathBuf::from(root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }

    let library_key = resolve_current_stdlib_library_key(state, &root_path)?;
    let Some(target_key) = library_key else {
        return Ok(None);
    };
    let cache = state
        .workspace_snapshot_cache
        .lock()
        .map_err(|_| "Workspace snapshot cache lock poisoned".to_string())?;
    for entry in cache.values() {
        if let WorkspaceSnapshotCacheEntry::Stdlib(snapshot) = entry {
            if normalize_compare_key(&snapshot.path) == target_key {
                return Ok(Some(snapshot.metatype_index.clone()));
            }
        }
    }
    Ok(None)
}

fn resolve_current_stdlib_library_key(
    state: &CoreState,
    root_path: &std::path::Path,
) -> Result<Option<String>, String> {
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
        root_path,
    );
    Ok(stdlib_path.as_ref().map(|path| normalize_compare_key(path)))
}

fn normalize_compare_key(path: &std::path::Path) -> String {
    let normalized = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    normalized
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
}

pub fn get_project_model(state: &CoreState, root: String) -> Result<ProjectModelView, String> {
    let root = canonical_project_root(&root);
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }
    seed_symbol_index_if_empty(state, &root)?;

    let store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;
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
    let indexed = store.project_symbols(&root, None);
    let indexed_library = store.library_symbols(&root, None);

    let mut elements = Vec::new();
    for symbol in indexed.into_iter().chain(indexed_library.into_iter()) {
        let (metatype_qname, diagnostics) = resolve_symbol_metatype(&*store, &root, &symbol);
        let attributes = symbol_to_attribute_rows(
            &symbol.qualified_name,
            &symbol.name,
            symbol.properties_json.as_deref(),
            metatype_qname.as_deref(),
        );
        elements.push(ProjectModelElementView {
            name: symbol.name,
            qualified_name: symbol.qualified_name,
            kind: symbol.kind,
            file_path: symbol.file_path,
            start_line: symbol.start_line,
            start_col: symbol.start_col,
            end_line: symbol.end_line,
            end_col: symbol.end_col,
            metatype_qname,
            declared_supertypes: Vec::new(),
            supertypes: Vec::new(),
            direct_specializations: Vec::new(),
            indirect_specializations: Vec::new(),
            documentation: symbol.doc_text,
            attributes,
            diagnostics,
        });
    }
    elements.sort_by(|a, b| a.qualified_name.cmp(&b.qualified_name));
    let expression_view = collect_project_expression_records(
        elements
            .iter()
            .map(|element| element.file_path.as_str())
            .filter(|path| !path.is_empty()),
    );
    let mut diagnostics = expression_view.diagnostics;
    diagnostics.push("Project model is generated from persisted symbol index.".to_string());

    Ok(ProjectModelView {
        stdlib_path: stdlib_path.map(|path| path.to_string_lossy().to_string()),
        workspace_snapshot_hit: false,
        project_cache_hit: false,
        element_count: elements.len(),
        elements,
        expressions: expression_view.records,
        diagnostics,
    })
}

fn build_project_element_property_sections(
    semantic_projection: Option<&IndexedSemanticProjectionElementView>,
    attrs: &ProjectElementAttributesView,
    selected_element_qname: &str,
    diagnostics: &mut Vec<String>,
    missing_semantic_message: &str,
) -> Vec<ProjectElementPropertySectionView> {
    let direct_metatype_attributes = attrs.direct_metatype_attributes.as_slice();
    let inherited_metatype_attributes = if !attrs.inherited_metatype_attributes.is_empty() {
        attrs.inherited_metatype_attributes.as_slice()
    } else {
        attrs.inherited_attributes.as_slice()
    };
    let expressions = attrs.expressions.as_slice();

    if let Some(projection) = semantic_projection {
        if !direct_metatype_attributes.is_empty() || !inherited_metatype_attributes.is_empty() {
            return build_metatype_reconciled_sections(
                projection,
                attrs,
                selected_element_qname,
                direct_metatype_attributes,
                inherited_metatype_attributes,
                expressions,
            );
        }
        return build_semantic_fallback_sections(
            Some(projection),
            expressions,
            selected_element_qname,
            None,
        );
    }

    let message = if attrs
        .diagnostics
        .iter()
        .any(|line| line.contains("Element not found"))
    {
        missing_semantic_message.to_string()
    } else {
        diagnostics.push(missing_semantic_message.to_string());
        missing_semantic_message.to_string()
    };
    build_semantic_fallback_sections(None, expressions, selected_element_qname, Some(message))
}

fn build_metatype_reconciled_sections(
    projection: &IndexedSemanticProjectionElementView,
    attrs: &ProjectElementAttributesView,
    selected_element_qname: &str,
    direct_metatype_attributes: &[ProjectElementInheritedAttributeView],
    inherited_metatype_attributes: &[ProjectElementInheritedAttributeView],
    expressions: &[ProjectExpressionRecordView],
) -> Vec<ProjectElementPropertySectionView> {
    let mut used_semantic_feature_indexes = HashSet::<usize>::new();
    let mut seen_attribute_keys = HashSet::<String>::new();
    let mut seen_row_keys = HashSet::<String>::new();
    let mut metatype_rows = Vec::<ProjectElementPropertyRowView>::new();
    let mut all_metatype_attributes = Vec::<ProjectElementInheritedAttributeView>::new();
    all_metatype_attributes.extend_from_slice(direct_metatype_attributes);
    all_metatype_attributes.extend_from_slice(inherited_metatype_attributes);

    for (index, attribute) in all_metatype_attributes.iter().enumerate() {
        let normalized_attribute_qname = normalize_lookup_key(&attribute.qualified_name);
        let attribute_key = if !normalized_attribute_qname.is_empty() {
            normalized_attribute_qname
        } else {
            let declared_on = normalize_lookup_key(&attribute.declared_on);
            let name = normalize_lookup_key(&attribute.name);
            if declared_on.is_empty() && name.is_empty() {
                format!("attribute-{index}")
            } else {
                format!("{declared_on}|{name}")
            }
        };
        if !seen_attribute_keys.insert(attribute_key.clone()) {
            continue;
        }

        let mut matched_feature_index = None;
        let mut matched_feature = None;
        for (feature_index, feature) in projection.features.iter().enumerate() {
            if used_semantic_feature_indexes.contains(&feature_index) {
                continue;
            }
            if semantic_feature_matches_attribute(feature, attribute) {
                matched_feature_index = Some(feature_index);
                matched_feature = Some(feature);
                break;
            }
        }
        if matched_feature.is_none() {
            for (feature_index, feature) in projection.features.iter().enumerate() {
                if semantic_feature_matches_attribute(feature, attribute) {
                    matched_feature_index = Some(feature_index);
                    matched_feature = Some(feature);
                    break;
                }
            }
        }
        if let Some(feature_index) = matched_feature_index {
            used_semantic_feature_indexes.insert(feature_index);
        }

        let explicit_value = find_explicit_attribute_value(attribute, &attrs.explicit_attributes);
        let row_value = matched_feature
            .map(|feature| semantic_value_to_text(&feature.value))
            .or(explicit_value)
            .unwrap_or_else(|| "-".to_string());
        let qualified_name =
            matched_feature.and_then(|feature| semantic_value_to_qualified_name(&feature.value));
        let row_key = canonical_metatype_row_key(attribute, matched_feature, &row_value);
        if !seen_row_keys.insert(row_key) {
            continue;
        }
        metatype_rows.push(project_element_property_row(
            format!("metatype-attribute-{attribute_key}"),
            format_attribute_signature(attribute),
            row_value,
            qualified_name,
        ));
    }

    let mut sections = vec![ProjectElementPropertySectionView {
        key: "metatype".to_string(),
        label: "Metatype Attributes".to_string(),
        collapsible: false,
        rows: metatype_rows,
    }];

    let remaining_semantic_rows = projection
        .features
        .iter()
        .enumerate()
        .filter(|(index, _)| !used_semantic_feature_indexes.contains(index))
        .map(|(index, feature)| {
            project_element_property_row(
                format!("semantic-extra-feature-{index}-{}", feature.name),
                format_semantic_feature_label(feature),
                semantic_value_to_text(&feature.value),
                semantic_value_to_qualified_name(&feature.value),
            )
        })
        .collect::<Vec<_>>();
    if !remaining_semantic_rows.is_empty() {
        sections.push(ProjectElementPropertySectionView {
            key: "semantic-extra".to_string(),
            label: "Additional Semantics".to_string(),
            collapsible: true,
            rows: remaining_semantic_rows,
        });
    }

    if !expressions.is_empty() {
        sections.push(ProjectElementPropertySectionView {
            key: "expressions".to_string(),
            label: "Expressions".to_string(),
            collapsible: false,
            rows: build_expression_rows(expressions, selected_element_qname),
        });
    }

    sections
}

fn build_semantic_fallback_sections(
    projection: Option<&IndexedSemanticProjectionElementView>,
    expressions: &[ProjectExpressionRecordView],
    selected_element_qname: &str,
    missing_message: Option<String>,
) -> Vec<ProjectElementPropertySectionView> {
    let semantic_rows = if let Some(projection) = projection {
        if projection.features.is_empty() {
            vec![project_element_property_row(
                "semantic-empty".to_string(),
                "semantic.type_attributes".to_string(),
                "-".to_string(),
                None,
            )]
        } else {
            projection
                .features
                .iter()
                .enumerate()
                .map(|(index, feature)| {
                    project_element_property_row(
                        format!("semantic-feature-{index}-{}", feature.name),
                        format_semantic_feature_label(feature),
                        semantic_value_to_text(&feature.value),
                        semantic_value_to_qualified_name(&feature.value),
                    )
                })
                .collect::<Vec<_>>()
        }
    } else {
        vec![project_element_property_row(
            "semantic-status".to_string(),
            "semantic.status".to_string(),
            missing_message.unwrap_or_else(|| "Select an element".to_string()),
            None,
        )]
    };

    let mut sections = vec![ProjectElementPropertySectionView {
        key: "semantic".to_string(),
        label: "Semantics".to_string(),
        collapsible: false,
        rows: semantic_rows,
    }];
    if !expressions.is_empty() {
        sections.push(ProjectElementPropertySectionView {
            key: "expressions".to_string(),
            label: "Expressions".to_string(),
            collapsible: false,
            rows: build_expression_rows(expressions, selected_element_qname),
        });
    }
    sections
}

fn build_expression_rows(
    expressions: &[ProjectExpressionRecordView],
    selected_element_qname: &str,
) -> Vec<ProjectElementPropertyRowView> {
    expressions
        .iter()
        .enumerate()
        .map(|(index, record)| {
            project_element_property_row(
                format!("expression-{index}-{}", record.qualified_name),
                format_project_expression_label(record, selected_element_qname),
                {
                    let expression = record.expression.trim();
                    if expression.is_empty() {
                        "-".to_string()
                    } else {
                        expression.to_string()
                    }
                },
                None,
            )
        })
        .collect()
}

fn project_element_property_row(
    key: String,
    label: String,
    value: String,
    qualified_name: Option<String>,
) -> ProjectElementPropertyRowView {
    let is_empty = {
        let trimmed = value.trim();
        trimmed.is_empty() || trimmed == "-"
    };
    ProjectElementPropertyRowView {
        key,
        label,
        value,
        qualified_name,
        is_empty,
    }
}

fn canonical_metatype_row_key(
    attribute: &ProjectElementInheritedAttributeView,
    matched_feature: Option<&mercurio_sysml_semantics::semantic_contract::SemanticFeatureView>,
    row_value: &str,
) -> String {
    let feature_key = matched_feature.map_or_else(
        || String::new(),
        |feature| {
            let metamodel_feature_qname = feature
                .metamodel_feature_qname
                .as_deref()
                .unwrap_or("")
                .trim();
            if metamodel_feature_qname.is_empty() {
                normalize_lookup_key(&feature.name)
            } else {
                normalize_lookup_key(metamodel_feature_qname)
            }
        },
    );
    let declared_on_key = tail_lookup_key(&attribute.declared_on);
    let signature_key = normalize_lookup_key(&format_attribute_signature(attribute));
    let value_key = normalize_lookup_key(row_value);
    format!("{feature_key}|{declared_on_key}|{signature_key}|{value_key}")
}

fn semantic_value_to_text(
    value: &mercurio_sysml_semantics::semantic_contract::SemanticValueView,
) -> String {
    use mercurio_sysml_semantics::semantic_contract::SemanticValueView;

    match value {
        SemanticValueView::Null => "-".to_string(),
        SemanticValueView::Text { value } => value.clone(),
        SemanticValueView::Bool { value } => {
            if *value {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        SemanticValueView::I64 { value } => value.to_string(),
        SemanticValueView::U64 { value } => value.to_string(),
        SemanticValueView::F64 { value } => value.to_string(),
        SemanticValueView::Enum { literal, .. } => literal.clone(),
        SemanticValueView::Ref {
            qualified_name,
            proxy_text,
            ..
        } => qualified_name
            .as_deref()
            .or(proxy_text.as_deref())
            .unwrap_or("-")
            .to_string(),
        SemanticValueView::List { items } => {
            let joined = items
                .iter()
                .map(semantic_value_to_text)
                .collect::<Vec<_>>()
                .join(", ");
            if joined.trim().is_empty() {
                "-".to_string()
            } else {
                joined
            }
        }
    }
}

fn semantic_value_to_qualified_name(
    value: &mercurio_sysml_semantics::semantic_contract::SemanticValueView,
) -> Option<String> {
    use mercurio_sysml_semantics::semantic_contract::SemanticValueView;

    match value {
        SemanticValueView::Ref {
            qualified_name,
            proxy_text,
            ..
        } => sanitize_qualified_name(qualified_name.as_deref().or(proxy_text.as_deref())),
        SemanticValueView::List { items } => {
            let refs = items
                .iter()
                .filter_map(|item| match item {
                    SemanticValueView::Ref {
                        qualified_name,
                        proxy_text,
                        ..
                    } => {
                        sanitize_qualified_name(qualified_name.as_deref().or(proxy_text.as_deref()))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            if refs.len() == 1 {
                refs.into_iter().next()
            } else {
                None
            }
        }
        SemanticValueView::Text { value } => sanitize_qualified_name(Some(value.as_str())),
        _ => None,
    }
}

fn sanitize_qualified_name(value: Option<&str>) -> Option<String> {
    let qname = value?.trim();
    if qname.is_empty() || !qname.contains("::") || qname.chars().any(char::is_whitespace) {
        return None;
    }
    Some(qname.to_string())
}

fn split_qualified_name(value: &str) -> Vec<&str> {
    value
        .split("::")
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect()
}

fn format_feature_qname(value: &str) -> Option<String> {
    let segments = split_qualified_name(value);
    if segments.is_empty() {
        return None;
    }
    if segments.len() == 1 {
        return Some(segments[0].to_string());
    }
    let owner = segments.get(segments.len() - 2)?;
    let property = segments.last()?;
    Some(format!("{owner}.{property}"))
}

fn format_semantic_feature_label(
    feature: &mercurio_sysml_semantics::semantic_contract::SemanticFeatureView,
) -> String {
    let metamodel_feature_qname = feature
        .metamodel_feature_qname
        .as_deref()
        .unwrap_or("")
        .trim();
    if !metamodel_feature_qname.is_empty() {
        if let Some(formatted) = format_feature_qname(metamodel_feature_qname) {
            return formatted;
        }
    }

    let feature_name = feature.name.trim();
    let declared_type_qname = feature.declared_type_qname.as_deref().unwrap_or("").trim();
    if !declared_type_qname.is_empty() && !feature_name.is_empty() {
        let type_segments = split_qualified_name(declared_type_qname);
        if let Some(short_type_name) = type_segments.last() {
            return format!("{short_type_name}.{feature_name}");
        }
    }

    if !feature_name.is_empty() {
        if let Some(formatted) = format_feature_qname(feature_name) {
            return formatted;
        }
        return feature_name.to_string();
    }

    "(unnamed)".to_string()
}

fn format_attribute_signature(attribute: &ProjectElementInheritedAttributeView) -> String {
    let name = attribute.name.trim();
    let name = if name.is_empty() { "(unnamed)" } else { name };
    let declared_type = attribute.declared_type.as_deref().unwrap_or("").trim();
    let multiplicity = attribute.multiplicity.as_deref().unwrap_or("").trim();
    if declared_type.is_empty() {
        return name.to_string();
    }
    if multiplicity.is_empty() {
        return format!("{name} : {declared_type}");
    }
    let multiplicity_text = if multiplicity.starts_with('[') {
        multiplicity.to_string()
    } else {
        format!("[{multiplicity}]")
    };
    format!("{name} : {declared_type}{multiplicity_text}")
}

fn format_expression_kind(value: &str) -> String {
    let normalized = value.trim().replace('_', " ");
    if normalized.is_empty() {
        "expression".to_string()
    } else {
        normalized
    }
}

fn short_qualified_tail(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let segments = split_qualified_name(trimmed);
    segments.last().copied().unwrap_or(trimmed).to_string()
}

fn format_project_expression_label(
    record: &ProjectExpressionRecordView,
    selected_element_qname: &str,
) -> String {
    let slot = record.slot.trim();
    let kind = format_expression_kind(&record.expression_kind);
    let owner = record.owner_qualified_name.trim();
    let owner_prefix = if !owner.is_empty()
        && normalize_lookup_key(owner) != normalize_lookup_key(selected_element_qname)
    {
        format!("{}.", short_qualified_tail(owner))
    } else {
        String::new()
    };

    if !slot.is_empty() {
        return format!("{owner_prefix}{slot} ({kind})");
    }
    if !owner_prefix.is_empty() {
        return format!("{owner_prefix}{kind}");
    }
    kind
}

fn normalize_lookup_key(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn tail_lookup_key(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let qualified_tail = trimmed.rsplit("::").next().unwrap_or(trimmed);
    let property_tail = qualified_tail.rsplit('.').next().unwrap_or(qualified_tail);
    normalize_lookup_key(property_tail)
}

fn semantic_feature_matches_attribute(
    feature: &mercurio_sysml_semantics::semantic_contract::SemanticFeatureView,
    attribute: &ProjectElementInheritedAttributeView,
) -> bool {
    let attribute_qname = normalize_lookup_key(&attribute.qualified_name);
    let attribute_name = normalize_lookup_key(&attribute.name);
    let attribute_tail = tail_lookup_key(if !attribute.qualified_name.is_empty() {
        &attribute.qualified_name
    } else {
        &attribute.name
    });
    let feature_metamodel_qname =
        normalize_lookup_key(feature.metamodel_feature_qname.as_deref().unwrap_or(""));
    let feature_name = normalize_lookup_key(&feature.name);
    let feature_tail = tail_lookup_key(
        if feature
            .metamodel_feature_qname
            .as_deref()
            .is_some_and(|value| !value.is_empty())
        {
            feature.metamodel_feature_qname.as_deref().unwrap_or("")
        } else {
            &feature.name
        },
    );

    (!attribute_qname.is_empty() && feature_metamodel_qname == attribute_qname)
        || (!attribute_name.is_empty() && feature_name == attribute_name)
        || (!attribute_name.is_empty()
            && feature_metamodel_qname.ends_with(&format!("::{attribute_name}")))
        || (!attribute_tail.is_empty() && feature_tail == attribute_tail)
        || (!attribute_tail.is_empty() && feature_name == attribute_tail)
}

fn find_explicit_attribute_value(
    attribute: &ProjectElementInheritedAttributeView,
    explicit_attributes: &[ProjectModelAttributeView],
) -> Option<String> {
    let attribute_qname = normalize_lookup_key(&attribute.qualified_name);
    let attribute_name = normalize_lookup_key(&attribute.name);
    let attribute_tail = tail_lookup_key(if !attribute.qualified_name.is_empty() {
        &attribute.qualified_name
    } else {
        &attribute.name
    });
    let matched = explicit_attributes.iter().find(|candidate| {
        let explicit_metamodel_qname =
            normalize_lookup_key(candidate.metamodel_attribute_qname.as_deref().unwrap_or(""));
        let explicit_name = normalize_lookup_key(&candidate.name);
        let explicit_tail = tail_lookup_key(
            if candidate
                .metamodel_attribute_qname
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            {
                candidate.metamodel_attribute_qname.as_deref().unwrap_or("")
            } else {
                &candidate.name
            },
        );
        (!attribute_qname.is_empty() && explicit_metamodel_qname == attribute_qname)
            || (!attribute_name.is_empty() && explicit_name == attribute_name)
            || (!attribute_tail.is_empty() && explicit_tail == attribute_tail)
    })?;
    let value = matched.cst_value.as_deref().unwrap_or("").trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

pub fn get_project_expression_records(
    state: &CoreState,
    root: String,
) -> Result<ProjectExpressionRecordsView, String> {
    let root = canonical_project_root(&root);
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }
    seed_symbol_index_if_empty(state, &root)?;

    let store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;

    let indexed = store.project_symbols(&root, None);
    let indexed_library = store.library_symbols(&root, None);
    let mut file_paths = HashSet::<String>::new();
    for symbol in indexed.into_iter().chain(indexed_library.into_iter()) {
        if !symbol.file_path.is_empty() {
            file_paths.insert(symbol.file_path);
        }
    }
    Ok(collect_project_expression_records(file_paths.into_iter()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compile::compile_workspace_sync;
    use crate::settings::AppSettings;
    use crate::state::CoreState;
    use crate::stdlib::get_stdlib_metamodel;
    use mercurio_symbol_index::SymbolIndexStore;
    use mercurio_sysml_semantics::semantic_contract::{SemanticFeatureView, SemanticValueView};
    use std::fs;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn compile_for_index(state: &CoreState, project_root: &Path) {
        let _ = compile_workspace_sync(
            state,
            project_root.to_string_lossy().to_string(),
            1,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile workspace");
    }

    #[test]
    fn project_model_is_built_from_symbol_index() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_project_model_db_{stamp}"));
        let project_dir = root.join("project");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            project_dir.join("main.sysml"),
            "package P { action def DoThing; }\n",
        )
        .expect("write model file");
        fs::write(
            project_dir.join(".project"),
            "{\"name\":\"pm-db\",\"use_default_library\":true,\"src\":[\"*.sysml\"]}",
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        compile_for_index(&state, &project_dir);
        let view = get_project_model(&state, project_dir.to_string_lossy().to_string())
            .expect("get project model");
        assert!(view.element_count > 0);
        assert!(view.expressions.is_empty());
        assert!(view
            .diagnostics
            .iter()
            .any(|line| line.contains("persisted symbol index")));
        assert!(view
            .elements
            .iter()
            .any(|element| element.qualified_name == "P"));

        let attrs = get_project_element_attributes(
            &state,
            project_dir.to_string_lossy().to_string(),
            "P".to_string(),
            Some("Package".to_string()),
        )
        .expect("get element attrs");
        assert_eq!(attrs.element_qualified_name, "P");
        assert!(!attrs.explicit_attributes.is_empty());
        assert!(attrs.expressions.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn project_model_missing_symbol_reports_index_message() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_project_model_db_miss_{stamp}"));
        let project_dir = root.join("project");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(project_dir.join("main.sysml"), "package P {}\n").expect("write model file");
        fs::write(
            project_dir.join(".project"),
            "{\"name\":\"pm-db\",\"use_default_library\":true,\"src\":[\"*.sysml\"]}",
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        compile_for_index(&state, &project_dir);
        let attrs = get_project_element_attributes(
            &state,
            project_dir.to_string_lossy().to_string(),
            "Missing::Symbol".to_string(),
            None,
        )
        .expect("get missing element attrs");
        assert!(attrs
            .diagnostics
            .iter()
            .any(|line| line.contains("project symbol index")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn db_model_maps_package_to_kerml_package_with_filter_condition() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_project_model_pkg_meta_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");

        let library_source = r#"
standard library package KerML {
  package Kernel {
    metaclass Namespace specializes Element {
      var feature ownedMember : Element[0..*] ordered;
    }
    metaclass Package specializes Namespace {
      var feature filterCondition : Expression[0..*] ordered;
    }
  }
}
"#;
        fs::write(library_dir.join("KerML.kerml"), library_source).expect("write library file");
        fs::write(project_dir.join("main.sysml"), "package P {}\n").expect("write model file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"pm-db\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        compile_for_index(&state, &project_dir);
        let attrs = get_project_element_attributes(
            &state,
            project_dir.to_string_lossy().to_string(),
            "P".to_string(),
            Some("Package".to_string()),
        )
        .expect("project element attributes");
        assert!(!attrs.direct_metatype_attributes.is_empty());
        assert!(attrs
            .direct_metatype_attributes
            .iter()
            .any(|attr| attr.name == "filterCondition"));
        assert!(!attrs.inherited_metatype_attributes.is_empty());

        let mapped = {
            let store = state.symbol_index.lock().expect("symbol index lock");
            store.symbol_mapping(
                &project_dir.to_string_lossy(),
                "P",
                Some(&project_dir.join("main.sysml").to_string_lossy()),
            )
        }
        .expect("symbol mapping");
        let mapped_qname = mapped
            .resolved_metatype_qname
            .clone()
            .or(attrs.metatype_qname.clone())
            .unwrap_or_else(|| "KerML::Kernel::Package".to_string());

        let metamodel = get_stdlib_metamodel(&state, project_dir.to_string_lossy().to_string())
            .expect("stdlib metamodel");
        let package_candidates = metamodel
            .types
            .iter()
            .filter(|t| t.name == "Package" || t.qualified_name.ends_with("::Package"))
            .map(|t| format!("{} attrs={}", t.qualified_name, t.attributes.len()))
            .collect::<Vec<_>>();
        println!("Package candidates: {:?}", package_candidates);
        let package_type = metamodel
            .types
            .iter()
            .find(|t| t.qualified_name == mapped_qname)
            .or_else(|| {
                let tail = mapped_qname
                    .rsplit("::")
                    .next()
                    .unwrap_or(mapped_qname.as_str());
                let mut candidates = metamodel
                    .types
                    .iter()
                    .filter(|t| t.qualified_name.ends_with(&format!("::{tail}")))
                    .collect::<Vec<_>>();
                candidates.sort_by(|a, b| {
                    let a_has_filter = a
                        .attributes
                        .iter()
                        .any(|attr| attr.name == "filterCondition");
                    let b_has_filter = b
                        .attributes
                        .iter()
                        .any(|attr| attr.name == "filterCondition");
                    b_has_filter
                        .cmp(&a_has_filter)
                        .then(b.qualified_name.len().cmp(&a.qualified_name.len()))
                });
                candidates.into_iter().next()
            })
            .expect("mapped package metatype exists");

        assert_eq!(package_type.name, "Package");
        let package_attrs = package_type
            .attributes
            .iter()
            .map(|a| a.name.clone())
            .collect::<Vec<_>>();
        println!(
            "Package metatype attributes (db-backed path): {:?}",
            package_attrs
        );
        assert!(package_type
            .attributes
            .iter()
            .any(|a| a.name == "filterCondition"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn db_model_package_includes_namespace_inherited_attribute_set() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("mercurio_project_model_pkg_inherited_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");

        let library_source = r#"
standard library package KerML {
  package Kernel {
    metaclass Element {}
    metaclass Membership specializes Element {}
    metaclass Import specializes Element {}
    metaclass Expression specializes Element {}

    metaclass Namespace specializes Element {
      derived abstract var feature membership : Membership[0..*] ordered;
      derived composite var feature ownedImport : Import[0..*] ordered subsets ownedRelationship;
      derived var feature 'member' : Element[0..*] ordered;
      derived var feature ownedMember : Element[0..*] ordered subsets 'member';
      derived composite var feature ownedMembership : Membership[0..*] ordered subsets membership, ownedRelationship;
      derived var feature importedMembership : Membership[0..*] ordered subsets membership;
    }

    metaclass Package specializes Namespace {
      derived var feature filterCondition : Expression[0..*] ordered subsets ownedMember;
    }
  }
}
"#;
        fs::write(library_dir.join("KerML.kerml"), library_source).expect("write library file");
        fs::write(project_dir.join("main.sysml"), "package P {}\n").expect("write model file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"pm-db\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        compile_for_index(&state, &project_dir);
        let _ = get_project_element_attributes(
            &state,
            project_dir.to_string_lossy().to_string(),
            "P".to_string(),
            Some("Package".to_string()),
        )
        .expect("project element attributes");

        let metamodel = get_stdlib_metamodel(&state, project_dir.to_string_lossy().to_string())
            .expect("stdlib metamodel");
        let package_type = metamodel
            .types
            .iter()
            .find(|t| t.qualified_name == "KerML::Kernel::Package")
            .or_else(|| metamodel.types.iter().find(|t| t.name == "Package"))
            .expect("package metatype");
        let attr_names = package_type
            .attributes
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>();

        for expected in [
            "membership",
            "ownedImport",
            "member",
            "ownedMember",
            "ownedMembership",
            "importedMembership",
            "filterCondition",
        ] {
            assert!(
                attr_names.iter().any(|name| *name == expected),
                "expected attribute '{expected}' in Package attrs {:?}",
                attr_names
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn db_model_package_includes_element_namespace_and_package_attributes() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("mercurio_project_model_pkg_full_chain_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");

        let library_source = r#"
standard library package KerML {
  package Kernel {
    metaclass Relationship specializes Element {}
    metaclass OwningMembership specializes Relationship {}
    metaclass Documentation specializes Element {}
    metaclass Annotation specializes Relationship {}
    metaclass TextualRepresentation specializes Element {}
    metaclass Import specializes Element {}
    metaclass Membership specializes Element {}
    metaclass Expression specializes Element {}

    abstract metaclass Element {
      var feature elementId : String[1..1];
      var feature aliasIds : String[0..*] ordered;
      var feature declaredShortName : String[0..1];
      var feature declaredName : String[0..1];
      var feature isImpliedIncluded : Boolean[1..1];
      derived var feature shortName : String[0..1];
      derived var feature name : String[0..1];
      derived var feature qualifiedName : String[0..1];
      derived var feature isLibraryElement : Boolean[1..1];
      var feature owningRelationship : Relationship[0..1];
      composite var feature ownedRelationship : Relationship[0..*] ordered;
      derived var feature owningMembership : OwningMembership[0..1] subsets owningRelationship;
      derived var feature owningNamespace : Namespace[0..1];
      derived var feature owner : Element[0..1];
      derived var feature ownedElement : Element[0..*] ordered;
      derived var feature documentation : Documentation[0..*] ordered subsets ownedElement;
      derived composite var feature ownedAnnotation : Annotation[0..*] ordered subsets ownedRelationship;
      derived var feature textualRepresentation : TextualRepresentation[0..*] ordered subsets ownedElement;
    }

    metaclass Namespace specializes Element {
      derived abstract var feature membership : Membership[0..*] ordered;
      derived composite var feature ownedImport : Import[0..*] ordered subsets ownedRelationship;
      derived var feature 'member' : Element[0..*] ordered;
      derived var feature ownedMember : Element[0..*] ordered subsets 'member';
      derived composite var feature ownedMembership : Membership[0..*] ordered subsets membership, ownedRelationship;
      derived var feature importedMembership : Membership[0..*] ordered subsets membership;
    }

    metaclass Package specializes Namespace {
      derived var feature filterCondition : Expression[0..*] ordered subsets ownedMember;
    }
  }
}
"#;
        fs::write(library_dir.join("KerML.kerml"), library_source).expect("write library file");
        fs::write(project_dir.join("main.sysml"), "package P {}\n").expect("write model file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"pm-db\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        compile_for_index(&state, &project_dir);
        let _ = get_project_element_attributes(
            &state,
            project_dir.to_string_lossy().to_string(),
            "P".to_string(),
            Some("Package".to_string()),
        )
        .expect("project element attributes");

        let metamodel = get_stdlib_metamodel(&state, project_dir.to_string_lossy().to_string())
            .expect("stdlib metamodel");
        let package_type = metamodel
            .types
            .iter()
            .find(|t| t.qualified_name == "KerML::Kernel::Package")
            .or_else(|| metamodel.types.iter().find(|t| t.name == "Package"))
            .expect("package metatype");
        let attr_names = package_type
            .attributes
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>();

        for expected in [
            "elementId",
            "aliasIds",
            "declaredShortName",
            "declaredName",
            "isImpliedIncluded",
            "shortName",
            "name",
            "qualifiedName",
            "isLibraryElement",
            "owningRelationship",
            "ownedRelationship",
            "owningMembership",
            "owningNamespace",
            "owner",
            "ownedElement",
            "documentation",
            "ownedAnnotation",
            "textualRepresentation",
            "membership",
            "ownedImport",
            "member",
            "ownedMember",
            "ownedMembership",
            "importedMembership",
            "filterCondition",
        ] {
            assert!(
                attr_names.iter().any(|name| *name == expected),
                "expected attribute '{expected}' in Package attrs {:?}",
                attr_names
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stdlib_property_sections_use_library_scope_projection_cache() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_stdlib_property_sections_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");

        let library_source = r#"
standard library package KerML {
  package Kernel {
    metaclass Element {}
    metaclass Expression specializes Element {}
    metaclass Package specializes Element {
      derived var feature filterCondition : Expression[0..*];
    }
  }
}
"#;
        let library_file = library_dir.join("KerML.kerml");
        fs::write(&library_file, library_source).expect("write library file");
        fs::write(project_dir.join("main.sysml"), "package Demo {}\n").expect("write model file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"pm-db\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        compile_for_index(&state, &project_dir);

        let sections = get_project_element_property_sections(
            &state,
            project_dir.to_string_lossy().to_string(),
            "KerML::Kernel::Package".to_string(),
            Some(library_file.to_string_lossy().to_string()),
            Some("MetaclassDef".to_string()),
            Some("library".to_string()),
        )
        .expect("stdlib property sections");

        assert!(sections.metatype_qname.is_some());
        assert!(
            sections
                .diagnostics
                .iter()
                .all(|line| !line.contains("No semantic row")),
            "unexpected diagnostics: {:?}",
            sections.diagnostics
        );
        assert!(
            sections
                .sections
                .iter()
                .flat_map(|section| section.rows.iter())
                .all(|row| row.label != "semantic.status"),
            "expected cached stdlib projection rows, got {:?}",
            sections.sections
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn metatype_reconciled_sections_dedupe_duplicate_direct_and_inherited_rows() {
        let projection = IndexedSemanticProjectionElementView {
            name: "R".to_string(),
            qualified_name: "ViewTest::R".to_string(),
            file_path: "main.sysml".to_string(),
            metatype_qname: Some("sysml::PartUsage".to_string()),
            features: vec![SemanticFeatureView {
                name: "name".to_string(),
                feature_kind: "attribute".to_string(),
                many: false,
                containment: false,
                declared_type_qname: Some("sysml::String".to_string()),
                metamodel_feature_qname: Some("sysml::Element::name".to_string()),
                value: SemanticValueView::Text {
                    value: "R".to_string(),
                },
                diagnostics: Vec::new(),
            }],
        };
        let attrs = ProjectElementAttributesView {
            element_qualified_name: "ViewTest::R".to_string(),
            metatype_qname: Some("sysml::PartUsage".to_string()),
            explicit_attributes: Vec::new(),
            inherited_attributes: Vec::new(),
            direct_metatype_attributes: vec![ProjectElementInheritedAttributeView {
                name: "name".to_string(),
                qualified_name: "sysml::Element::name".to_string(),
                declared_on: "sysml::Element".to_string(),
                declared_type: Some("String".to_string()),
                multiplicity: Some("0..1".to_string()),
                direction: None,
                documentation: None,
                cst_value: None,
            }],
            inherited_metatype_attributes: vec![ProjectElementInheritedAttributeView {
                name: "name".to_string(),
                qualified_name: "KerML::Kernel::Element::name".to_string(),
                declared_on: "KerML::Kernel::Element".to_string(),
                declared_type: Some("String".to_string()),
                multiplicity: Some("0..1".to_string()),
                direction: None,
                documentation: None,
                cst_value: None,
            }],
            expressions: Vec::new(),
            diagnostics: Vec::new(),
        };

        let sections = build_metatype_reconciled_sections(
            &projection,
            &attrs,
            "ViewTest::R",
            &attrs.direct_metatype_attributes,
            &attrs.inherited_metatype_attributes,
            &attrs.expressions,
        );

        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].label, "Metatype Attributes");
        assert_eq!(sections[0].rows.len(), 1);
        assert_eq!(sections[0].rows[0].label, "name : String[0..1]");
        assert_eq!(sections[0].rows[0].value, "R");
    }
}
