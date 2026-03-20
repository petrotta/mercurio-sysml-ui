use mercurio_symbol_index::{SymbolIndexStore, SymbolRecord};
use mercurio_sysml_core::parser::Parser;
use mercurio_sysml_pkg::compile_support::{
    build_canonical_symbol_rows_by_file, build_compile_workspace_files,
    build_stdlib_snapshot_with_progress as build_stdlib_snapshot_rows_with_progress,
    build_workspace_semantic_elements_with_selection, build_workspace_semantic_projection_views,
    collect_stdlib_files, filter_out_library_files, group_prepared_symbols_by_file,
    is_library_symbol_path, load_stdlib_snapshot_with_cache,
    map_semantic_element_to_projected_symbol,
    normalized_compare_key as normalized_compare_key_shared, prepare_symbols_for_index,
    select_workspace_files, stdlib_signature_key, workspace_semantic_cache_key, PreparedScope,
    ProjectedPropertyValue, ProjectedSemanticSymbol, RawIndexSymbol, StdlibSymbolRow,
    WorkspaceFileSelectionScope, WorkspaceSemanticInput, WorkspaceSemanticSelection,
};
use mercurio_sysml_pkg::project_ingest::ingest_project_texts;
use mercurio_sysml_pkg::semantic_projection::{
    collect_unresolved_from_project_diagnostics, load_project_sources_for_ingest, SymbolSpan,
    UnresolvedRef,
};
use mercurio_sysml_pkg::workspace_file::WorkspaceFileScope;
use mercurio_sysml_semantics::stdlib::MetatypeIndex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Instant, SystemTime};

use crate::project::load_project_config;
use crate::project_root_key::{canonical_project_root, normalize_display_path};
use crate::state::{StdlibCache, StdlibSymbol, WorkspaceSnapshotCacheEntry};
use crate::stdlib::{
    persist_stdlib_index_cache, resolve_stdlib_path, seed_stdlib_index_from_cache_for_project,
};
use crate::symbol_index::{query_project_symbols, refresh_project_semantic_lookup};
use crate::workspace::{collect_model_files, collect_project_files};
use crate::workspace_ir_cache::schedule_workspace_ir_cache_persist;
use crate::CoreState;

#[cfg(test)]
use mercurio_sysml_semantics::semantic_contract::SemanticElementView;
use mercurio_sysml_semantics::semantic_contract::{
    SemanticElementProjectionView, SemanticFeatureView, SemanticValueView,
};

pub use crate::state::{CompileDiagnosticView, CompileFileResult};

#[derive(Serialize)]
pub struct CompileResponse {
    pub ok: bool,
    pub files: Vec<CompileFileResult>,
    pub file_diagnostics: Vec<CompileFileDiagnosticsView>,
    pub parse_error_categories: Vec<ParseErrorCategoryView>,
    pub performance_warnings: Vec<String>,
    pub symbols: Vec<SymbolView>,
    pub project_symbol_count: usize,
    pub library_symbol_count: usize,
    pub unresolved: Vec<UnresolvedRefView>,
    pub library_path: Option<String>,
    pub parse_failed: bool,
    pub workspace_snapshot_hit: bool,
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
    pub workspace_snapshot_hit: bool,
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
pub struct CompileFileDiagnosticsView {
    pub path: String,
    pub diagnostics: Vec<CompileDiagnosticView>,
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
    #[serde(default = "default_include_symbols")]
    pub include_symbols: bool,
    #[serde(default)]
    pub unsaved: Vec<UnsavedFileInput>,
    #[serde(default, alias = "file", alias = "path")]
    pub target_path: Option<String>,
}

impl CompileRequest {
    pub fn into_parts(self) -> (String, u64, bool, bool, Option<PathBuf>, Vec<UnsavedFile>) {
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
            self.include_symbols,
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

fn offset_to_line_col(text: &str, offset: usize) -> (usize, usize) {
    let safe = offset.min(text.len());
    let mut line = 1usize;
    let mut col = 1usize;
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

fn summarize_parse_error_categories(files: &[CompileFileResult]) -> Vec<ParseErrorCategoryView> {
    let mut categories = HashMap::<String, usize>::new();
    for file in files {
        if file.ok {
            continue;
        }
        for diagnostic in &file.errors {
            let key = if diagnostic.kind.trim().is_empty() {
                categorize_parse_error(&diagnostic.message)
            } else {
                diagnostic.kind.trim().to_string()
            };
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

fn build_file_diagnostics(
    files: &[CompileFileResult],
    unresolved: &[UnresolvedRefView],
) -> Vec<CompileFileDiagnosticsView> {
    let mut by_path = HashMap::<String, Vec<CompileDiagnosticView>>::new();
    for file in files {
        if file.errors.is_empty() {
            continue;
        }
        by_path
            .entry(file.path.clone())
            .or_default()
            .extend(file.errors.iter().cloned());
    }
    for issue in unresolved {
        by_path
            .entry(issue.file_path.clone())
            .or_default()
            .push(CompileDiagnosticView {
                message: issue.message.clone(),
                line: usize::try_from(issue.line.max(1)).unwrap_or(1),
                column: usize::try_from(issue.column.max(1)).unwrap_or(1),
                kind: issue
                    .code
                    .as_ref()
                    .map(|value| value.trim())
                    .filter(|value| !value.is_empty())
                    .unwrap_or("semantic")
                    .to_string(),
                source: "semantic".to_string(),
            });
    }
    let mut out = by_path
        .into_iter()
        .map(|(path, mut diagnostics)| {
            diagnostics.sort_by(|left, right| {
                left.line
                    .cmp(&right.line)
                    .then(left.column.cmp(&right.column))
                    .then(left.source.cmp(&right.source))
                    .then(left.kind.cmp(&right.kind))
                    .then(left.message.cmp(&right.message))
            });
            CompileFileDiagnosticsView { path, diagnostics }
        })
        .collect::<Vec<_>>();
    out.sort_by(|left, right| left.path.cmp(&right.path));
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
    let root = canonical_project_root(&root);
    let indexed = query_project_symbols(state, root.clone(), None, None, None).unwrap_or_default();
    let (semantic_by_file_qname, semantic_by_qname) =
        semantic_attribute_lookups_for_root(state, &root);
    Ok(indexed
        .into_iter()
        .map(|symbol| {
            let file_key = normalized_compare_key(Path::new(&symbol.file_path));
            let key = format!("{file_key}|{}", symbol.qualified_name);
            let semantic_attributes = semantic_by_file_qname
                .get(&key)
                .or_else(|| semantic_by_qname.get(&symbol.qualified_name));
            let supertypes = semantic_attributes
                .map(extract_metatype_supertypes)
                .unwrap_or_default();
            let mut relationships = semantic_attributes
                .map(|attributes| {
                    classification_relationships_from_semantic_attributes(
                        attributes,
                        symbol.start_line,
                        symbol.start_col,
                        symbol.end_line,
                        symbol.end_col,
                    )
                })
                .unwrap_or_default();
            if relationships.is_empty() {
                if let Some(metatype) = symbol.metatype_qname.as_ref() {
                    let metatype = metatype.trim();
                    if !metatype.is_empty() {
                        relationships.push(RelationshipView {
                            kind: "classifiedBy".to_string(),
                            target: metatype.to_string(),
                            resolved_target: Some(metatype.to_string()),
                            start_line: symbol.start_line,
                            start_col: symbol.start_col,
                            end_line: symbol.end_line,
                            end_col: symbol.end_col,
                        });
                    }
                }
            }
            let mut properties = semantic_attributes
                .map(semantic_attributes_to_properties)
                .unwrap_or_default();
            if properties.is_empty() {
                if let Some(metatype) = symbol.metatype_qname.as_ref() {
                    let metatype = metatype.trim();
                    if !metatype.is_empty() {
                        properties.push(PropertyItemView {
                            name: "metatype_qname".to_string(),
                            label: "metatype_qname".to_string(),
                            value: PropertyValueView::Text {
                                value: metatype.to_string(),
                            },
                            hint: None,
                            group: Some("classification".to_string()),
                        });
                    }
                }
            }
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
                doc: symbol.doc_text,
                supertypes,
                relationships,
                type_refs: Vec::new(),
                is_public: true,
                properties,
            }
        })
        .collect())
}

fn semantic_attribute_lookups_for_root(
    state: &CoreState,
    root: &str,
) -> (
    HashMap<String, HashMap<String, String>>,
    HashMap<String, HashMap<String, String>>,
) {
    let mut by_file_qname = HashMap::<String, HashMap<String, String>>::new();
    let mut by_qname = HashMap::<String, HashMap<String, String>>::new();
    let root_prefix = format!("project-semantic|{}|", root);
    let Ok(cache) = state.workspace_snapshot_cache.lock() else {
        return (by_file_qname, by_qname);
    };
    for (key, entry) in cache.iter() {
        if !key.starts_with(&root_prefix) {
            continue;
        }
        let WorkspaceSnapshotCacheEntry::ProjectSemantic(elements) = entry else {
            continue;
        };
        for element in elements.iter() {
            let mut attributes = HashMap::<String, String>::new();
            for (name, value) in &element.attributes {
                let name = name.trim();
                let value = value.trim();
                if name.is_empty() || value.is_empty() {
                    continue;
                }
                attributes.insert(name.to_string(), value.to_string());
            }
            if let Some(metatype) = element.metatype_qname.as_ref() {
                let metatype = metatype.trim();
                if !metatype.is_empty() {
                    attributes
                        .entry("metatype_qname".to_string())
                        .or_insert_with(|| metatype.to_string());
                }
            }
            if attributes.is_empty() {
                continue;
            }
            let file_key = normalized_compare_key(Path::new(&element.file_path));
            let file_qname_key = format!("{file_key}|{}", element.qualified_name);
            upsert_richer_attribute_entry(&mut by_file_qname, file_qname_key, attributes.clone());
            upsert_richer_attribute_entry(
                &mut by_qname,
                element.qualified_name.clone(),
                attributes,
            );
        }
    }
    (by_file_qname, by_qname)
}

fn upsert_richer_attribute_entry(
    target: &mut HashMap<String, HashMap<String, String>>,
    key: String,
    attributes: HashMap<String, String>,
) {
    let should_replace = target
        .get(&key)
        .map(|current| attributes.len() > current.len())
        .unwrap_or(true);
    if should_replace {
        target.insert(key, attributes);
    }
}

fn parse_comma_list(raw: &str) -> Vec<String> {
    raw.trim()
        .trim_matches(|ch| ch == '[' || ch == ']')
        .split(',')
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .map(|item| item.to_string())
        .collect()
}

fn extract_metatype_supertypes(attributes: &HashMap<String, String>) -> Vec<String> {
    let mut out = attributes
        .get("metatype_supertypes")
        .or_else(|| attributes.get("mercurio::metatypeSupertypes"))
        .map(|value| parse_comma_list(value))
        .unwrap_or_default();
    if out.is_empty() {
        if let Some(lineage) = attributes
            .get("metatype_lineage")
            .or_else(|| attributes.get("mercurio::metatypeLineage"))
        {
            out = parse_comma_list(lineage).into_iter().skip(1).collect();
        }
    }
    out.dedup();
    out
}

fn classification_relationships_from_semantic_attributes(
    attributes: &HashMap<String, String>,
    start_line: u32,
    start_col: u32,
    end_line: u32,
    end_col: u32,
) -> Vec<RelationshipView> {
    let mut out = Vec::<RelationshipView>::new();
    if let Some(owner) = attributes
        .get("mercurio::owner")
        .or_else(|| attributes.get("Element::owner"))
        .or_else(|| attributes.get("emf::owner"))
    {
        let owner = owner.trim();
        if !owner.is_empty() {
            out.push(RelationshipView {
                kind: "owningNamespace".to_string(),
                target: owner.to_string(),
                resolved_target: Some(owner.to_string()),
                start_line,
                start_col,
                end_line,
                end_col,
            });
        }
    }
    if let Some(metatype) = attributes
        .get("metatype_qname")
        .or_else(|| attributes.get("mercurio::metatype"))
        .or_else(|| attributes.get("Element::metatype"))
    {
        let metatype = metatype.trim();
        if !metatype.is_empty() {
            out.push(RelationshipView {
                kind: "classifiedBy".to_string(),
                target: metatype.to_string(),
                resolved_target: Some(metatype.to_string()),
                start_line,
                start_col,
                end_line,
                end_col,
            });
        }
    }
    for supertype in extract_metatype_supertypes(attributes) {
        out.push(RelationshipView {
            kind: "metatypeSupertype".to_string(),
            target: supertype.clone(),
            resolved_target: Some(supertype),
            start_line,
            start_col,
            end_line,
            end_col,
        });
    }
    out
}

fn semantic_attributes_to_properties(
    attributes: &HashMap<String, String>,
) -> Vec<PropertyItemView> {
    let mut keys = attributes.keys().cloned().collect::<Vec<_>>();
    keys.sort();
    let mut properties = Vec::<PropertyItemView>::new();
    for key in keys {
        let Some(raw) = attributes.get(&key) else {
            continue;
        };
        let value = raw.trim();
        if value.is_empty() {
            continue;
        }
        let is_list = matches!(
            key.as_str(),
            "metatype_lineage"
                | "mercurio::metatypeLineage"
                | "metatype_supertypes"
                | "mercurio::metatypeSupertypes"
                | "mercurio::ownedElements"
                | "Element::ownedElement"
                | "emf::ownedElements"
                | "base_metatypes"
                | "attribute_type_metatypes"
                | "relationship_endpoint_metatypes"
                | "behavior_relation_metatypes"
        ) || (value.starts_with('[') && value.ends_with(']'));
        let property_value = if is_list {
            PropertyValueView::List {
                items: parse_comma_list(value),
            }
        } else if value.eq_ignore_ascii_case("true") {
            PropertyValueView::Bool { value: true }
        } else if value.eq_ignore_ascii_case("false") {
            PropertyValueView::Bool { value: false }
        } else if let Ok(number) = value.parse::<u64>() {
            PropertyValueView::Number { value: number }
        } else {
            PropertyValueView::Text {
                value: value.to_string(),
            }
        };
        properties.push(PropertyItemView {
            name: key.clone(),
            label: key,
            value: property_value,
            hint: None,
            group: None,
        });
    }
    properties
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
    compile_project_delta_sync_with_options(
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

pub fn compile_project_delta_sync_with_options<F: Fn(CompileProgressPayload)>(
    state: &CoreState,
    root: String,
    run_id: u64,
    allow_parse_errors: bool,
    target_path: Option<PathBuf>,
    unsaved: Vec<UnsavedFile>,
    include_symbols: bool,
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
        include_symbols,
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
    include_symbols: bool,
    emit_progress: F,
) -> Result<CompileResponse, String> {
    let raw_root = root.trim().to_string();
    let root = canonical_project_root(&root);
    let compile_start = Instant::now();
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }
    let compile_target = target_path
        .as_ref()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "<project>".to_string());
    let _background_job = state.try_start_background_job(
        "compile",
        Some(format!(
            "run_id={} target={} include_symbols={}",
            run_id, compile_target, include_symbols
        )),
        Some(run_id),
    );

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
    files = filter_out_library_files(files, stdlib_path_for_log.as_deref());
    if files.is_empty() {
        let mut fallback = Vec::new();
        collect_model_files(&root_path, &mut fallback)?;
        files = filter_out_library_files(fallback, stdlib_path_for_log.as_deref());
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
    emit_progress(
        "parsing",
        Some(format!("queued {} project files", files.len())),
        None,
        Some(files.len()),
    );

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
                .map(|error| {
                    let message = error.message.clone();
                    let (line, column) = offset_to_line_col(&content, error.span.start as usize);
                    CompileDiagnosticView {
                        kind: categorize_parse_error(&message),
                        message,
                        line,
                        column,
                        source: "parse".to_string(),
                    }
                })
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
        let file_diagnostics = build_file_diagnostics(&file_results, &[]);
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
            file_diagnostics,
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
            workspace_snapshot_hit: false,
            parsed_files,
            parse_duration_ms,
            analysis_duration_ms,
            stdlib_duration_ms,
            stdlib_file_count: 0,
            total_duration_ms,
        });
    }

    let use_stdlib_snapshot = true;
    let (
        stdlib_entries,
        stdlib_files,
        stdlib_metatype_index,
        workspace_snapshot_hit,
        stdlib_signature,
        stdlib_duration_ms,
    ) = if use_stdlib_snapshot {
        emit_progress(
            "stdlib",
            Some("loading stdlib snapshot".to_string()),
            None,
            None,
        );
        let stdlib_start = Instant::now();
        let mut in_flight_stdlib_file: Option<(usize, usize, PathBuf, Instant)> = None;
        let (
            stdlib_entries,
            stdlib_metatype_index,
            _stdlib_snapshot_symbols,
            workspace_snapshot_hit,
            stdlib_signature,
        ) = load_stdlib_snapshot(
            state,
            stdlib_path_for_log.as_deref(),
            |index, total, path| {
                if total == 0 {
                    return;
                }
                if let Some((prev_index, prev_total, prev_path, started_at)) =
                    in_flight_stdlib_file.take()
                {
                    emit_progress(
                        "stdlib",
                        Some(format!(
                            "parsed stdlib {}/{} in {} ms: {}",
                            prev_index,
                            prev_total,
                            started_at.elapsed().as_millis(),
                            prev_path.to_string_lossy()
                        )),
                        Some(prev_index),
                        Some(prev_total),
                    );
                }
                in_flight_stdlib_file = Some((index, total, path.to_path_buf(), Instant::now()));
                emit_progress(
                    "stdlib",
                    Some(format!(
                        "parsing stdlib {}/{}: {}",
                        index,
                        total,
                        path.to_string_lossy()
                    )),
                    Some(index),
                    Some(total),
                );
            },
        )?;
        if let Some((index, total, path, started_at)) = in_flight_stdlib_file.take() {
            emit_progress(
                "stdlib",
                Some(format!(
                    "parsed stdlib {}/{} in {} ms: {}",
                    index,
                    total,
                    started_at.elapsed().as_millis(),
                    path.to_string_lossy()
                )),
                Some(index),
                Some(total),
            );
        }
        let files = stdlib_entries
            .iter()
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();
        let stdlib_duration_ms = stdlib_start.elapsed().as_millis();
        emit_progress(
            "stdlib",
            Some(format!(
                "loaded {} stdlib files (snapshot_hit={})",
                files.len(),
                workspace_snapshot_hit
            )),
            Some(files.len()),
            Some(files.len()),
        );
        (
            stdlib_entries,
            files,
            stdlib_metatype_index,
            workspace_snapshot_hit,
            stdlib_signature,
            stdlib_duration_ms,
        )
    } else {
        emit_progress(
            "stdlib",
            Some("skipped stdlib snapshot (fast project mode)".to_string()),
            Some(0),
            Some(0),
        );
        (
            Vec::new(),
            Vec::new(),
            Arc::new(MetatypeIndex::default()),
            false,
            String::new(),
            0,
        )
    };

    let analysis_start = Instant::now();
    check_cancel()?;
    emit_progress(
        "analysis",
        Some("starting semantic analysis".to_string()),
        None,
        None,
    );

    let workspace_files = build_compile_workspace_files(&files, &stdlib_files);
    let project_symbol_files = select_workspace_files(
        &workspace_files,
        WorkspaceFileSelectionScope::Project,
        target_path.as_deref(),
    );
    let mut symbol_spans = build_symbol_span_seed_from_index(state, &root, &project_symbol_files);
    let unresolved_files = if include_library_symbols {
        files.clone()
    } else {
        project_symbol_files.clone()
    };
    emit_progress(
        "analysis",
        Some(format!(
            "collecting unresolved references ({} files)",
            unresolved_files.len()
        )),
        Some(0),
        Some(unresolved_files.len()),
    );
    let unresolved = if unresolved_files.is_empty() {
        Vec::new()
    } else {
        check_cancel()?;
        let project_sources = load_project_sources_for_ingest(&unresolved_files, &unsaved_map)?;
        match ingest_project_texts(project_sources.clone()) {
            Ok(ingest) => {
                collect_unresolved_from_project_diagnostics(ingest.diagnostics, &project_sources)
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
                    .collect()
            }
            Err(_) => Vec::new(),
        }
    };
    emit_progress(
        "analysis",
        Some(format!(
            "unresolved references collected: {}",
            unresolved.len()
        )),
        Some(unresolved.len()),
        Some(unresolved.len()),
    );

    let mut symbols = Vec::new();
    let mut raw_index_symbols = Vec::<RawIndexSymbol>::new();
    let mut seen = HashSet::new();

    let mut project_symbol_count = 0usize;
    let mut library_symbol_count = 0usize;
    let project_semantic_inputs =
        load_project_sources_for_ingest(&project_symbol_files, &unsaved_map)?
            .into_iter()
            .map(|(path, source)| WorkspaceSemanticInput {
                path,
                source,
                scope: WorkspaceFileScope::Project,
            })
            .collect::<Vec<_>>();
    let project_sources_by_file = project_semantic_inputs
        .iter()
        .map(|input| (normalized_compare_key(&input.path), input.source.clone()))
        .collect::<HashMap<_, _>>();
    let semantic_pipeline = "project-semantic-v3";
    let semantic_cache_key = workspace_semantic_cache_key(
        &root,
        &project_semantic_inputs,
        &stdlib_signature,
        semantic_pipeline,
    );
    let semantic_projection_pipeline = "project-semantic-projection-v1";
    let semantic_projection_cache_key = workspace_semantic_cache_key(
        &root,
        &project_semantic_inputs,
        "",
        semantic_projection_pipeline,
    );
    let semantic_elements = if let Ok(cache) = state.workspace_snapshot_cache.lock() {
        cache
            .get(&semantic_cache_key)
            .and_then(|entry| match entry {
                WorkspaceSnapshotCacheEntry::ProjectSemantic(elements) => Some(elements.clone()),
                WorkspaceSnapshotCacheEntry::Stdlib(_)
                | WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(_) => None,
            })
    } else {
        None
    };
    let semantic_projection = if let Ok(cache) = state.workspace_snapshot_cache.lock() {
        cache
            .get(&semantic_projection_cache_key)
            .and_then(|entry| match entry {
                WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(elements) => {
                    Some(elements.clone())
                }
                WorkspaceSnapshotCacheEntry::Stdlib(_)
                | WorkspaceSnapshotCacheEntry::ProjectSemantic(_) => None,
            })
    } else {
        None
    };
    let mut semantic_cache_needs_store = false;
    let semantic_elements = if let Some(cached) = semantic_elements {
        emit_progress(
            "analysis",
            Some(format!("semantic cache hit ({} elements)", cached.len())),
            Some(cached.len()),
            Some(cached.len()),
        );
        cached
    } else {
        semantic_cache_needs_store = true;
        emit_progress(
            "analysis",
            Some(format!(
                "building semantic elements ({} files)",
                project_semantic_inputs.len()
            )),
            Some(0),
            Some(project_semantic_inputs.len()),
        );
        let computed = Arc::new(build_workspace_semantic_elements_with_selection(
            &project_semantic_inputs,
            stdlib_metatype_index.as_ref(),
            stdlib_files.len(),
            WorkspaceSemanticSelection::ProjectOnly,
        ));
        computed
    };
    let mut semantic_projection_needs_store = false;
    let semantic_projection = if let Some(cached) = semantic_projection {
        cached
    } else {
        let projection_inputs = project_semantic_inputs
            .iter()
            .filter_map(|input| {
                let mut parser = Parser::new(&input.source);
                let _ = parser.parse_root();
                if !parser.errors().is_empty() {
                    return None;
                }
                Some(WorkspaceSemanticInput {
                    path: input.path.clone(),
                    source: input.source.clone(),
                    scope: input.scope.clone(),
                })
            })
            .collect::<Vec<_>>();
        emit_progress(
            "analysis",
            Some(format!(
                "warming semantic projection cache ({} files)",
                projection_inputs.len()
            )),
            Some(0),
            Some(projection_inputs.len()),
        );
        if projection_inputs.is_empty() {
            Arc::new(Vec::new())
        } else {
            match build_workspace_semantic_projection_views(&projection_inputs) {
                Ok(projection) => {
                    semantic_projection_needs_store = true;
                    Arc::new(projection)
                }
                Err(error) => {
                    emit_progress(
                        "analysis",
                        Some(format!("semantic projection cache warm failed: {}", error)),
                        None,
                        None,
                    );
                    eprintln!("[compile] semantic projection cache warm failed: {}", error);
                    Arc::new(Vec::new())
                }
            }
        }
    };
    let display_root_path = PathBuf::from(if raw_root.is_empty() {
        &root
    } else {
        &raw_root
    });
    let semantic_elements = Arc::new(
        semantic_elements
            .iter()
            .cloned()
            .map(|element| normalize_semantic_element_file_path(&display_root_path, element))
            .collect::<Vec<_>>(),
    );
    let semantic_projection = Arc::new(
        semantic_projection
            .iter()
            .cloned()
            .map(|element| normalize_semantic_projection_file_path(&display_root_path, element))
            .collect::<Vec<_>>(),
    );
    let selected_project_semantic_file_keys = project_symbol_files
        .iter()
        .map(|path| normalized_compare_key(path))
        .collect::<HashSet<_>>();
    if semantic_cache_needs_store || semantic_projection_needs_store {
        if let Ok(mut cache) = state.workspace_snapshot_cache.lock() {
            if target_path.is_none() {
                clear_project_semantic_cache_for_root(&mut cache, &root);
            } else {
                retain_project_semantic_cache_for_files(
                    &mut cache,
                    &root,
                    &selected_project_semantic_file_keys,
                );
            }
            let mut semantic_cache_keys = vec![semantic_cache_key.clone()];
            let mut semantic_projection_cache_keys = vec![semantic_projection_cache_key.clone()];
            if !raw_root.is_empty() && raw_root != root {
                semantic_cache_keys.push(workspace_semantic_cache_key(
                    &raw_root,
                    &project_semantic_inputs,
                    &stdlib_signature,
                    semantic_pipeline,
                ));
                semantic_projection_cache_keys.push(workspace_semantic_cache_key(
                    &raw_root,
                    &project_semantic_inputs,
                    "",
                    semantic_projection_pipeline,
                ));
            }
            for key in semantic_cache_keys {
                cache.insert(
                    key,
                    WorkspaceSnapshotCacheEntry::ProjectSemantic(semantic_elements.clone()),
                );
            }
            for key in semantic_projection_cache_keys {
                cache.insert(
                    key,
                    WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(
                        semantic_projection.clone(),
                    ),
                );
            }
        }
    }
    let _ = refresh_project_semantic_lookup_from_cache(state, &root)
        .or_else(|_| {
            refresh_project_semantic_lookup(
                state,
                &root,
                semantic_elements.as_ref(),
                semantic_projection.as_ref(),
            )
        });
    let semantic_total = semantic_elements.len();
    emit_progress(
        "analysis",
        Some(format!(
            "projecting semantic symbols ({} elements)",
            semantic_total
        )),
        Some(0),
        Some(semantic_total),
    );
    for (semantic_index, element) in semantic_elements.iter().cloned().enumerate() {
        if semantic_index % 500 == 0 {
            check_cancel()?;
            emit_progress(
                "analysis",
                Some(format!(
                    "projecting semantic symbols {}/{}",
                    semantic_index + 1,
                    semantic_total
                )),
                Some(semantic_index + 1),
                Some(semantic_total),
            );
        }
        let mut projected =
            map_semantic_element_to_projected_symbol(element.clone(), &symbol_spans);
        repair_projected_symbol_span_from_source(
            &mut projected,
            &element,
            &project_sources_by_file,
            &symbol_spans,
        );
        remember_projected_symbol_span(&mut symbol_spans, &projected);
        let key = format!(
            "{}|{}|{}",
            projected.file_path, projected.qualified_name, projected.name
        );
        if seen.insert(key) {
            raw_index_symbols.push(map_projected_semantic_symbol_to_raw_index(&projected));
            if include_symbols {
                symbols.push(map_projected_semantic_symbol(projected));
            }
            project_symbol_count += 1;
        }
    }
    emit_progress(
        "analysis",
        Some(format!(
            "project symbols projected: {}",
            project_symbol_count
        )),
        Some(project_symbol_count),
        Some(project_symbol_count),
    );
    if include_library_symbols {
        let library_semantic_inputs = stdlib_entries
            .iter()
            .map(|(path, source)| WorkspaceSemanticInput {
                path: path.clone(),
                source: source.clone(),
                scope: WorkspaceFileScope::Library,
            })
            .collect::<Vec<_>>();
        emit_progress(
            "analysis",
            Some(format!(
                "building library semantic elements ({} files)",
                library_semantic_inputs.len()
            )),
            Some(0),
            Some(library_semantic_inputs.len()),
        );
        let empty_library_spans = HashMap::<String, SymbolSpan>::new();
        let library_semantic_elements = build_workspace_semantic_elements_with_selection(
            &library_semantic_inputs,
            stdlib_metatype_index.as_ref(),
            stdlib_files.len(),
            WorkspaceSemanticSelection::LibraryOnly,
        );
        let mut library_projection_views = Vec::<SemanticElementProjectionView>::new();
        let library_total = library_semantic_elements.len();
        emit_progress(
            "analysis",
            Some(format!(
                "projecting library semantic symbols ({} elements)",
                library_total
            )),
            Some(0),
            Some(library_total),
        );
        for (library_index, element) in library_semantic_elements.into_iter().enumerate() {
            if library_index % 500 == 0 {
                check_cancel()?;
                emit_progress(
                    "analysis",
                    Some(format!(
                        "projecting library semantic symbols {}/{}",
                        library_index + 1,
                        library_total
                    )),
                    Some(library_index + 1),
                    Some(library_total),
                );
            }
            let projected = map_semantic_element_to_projected_symbol(element, &empty_library_spans);
            library_projection_views.push(stdlib_projection_view_from_projected_symbol(&projected));
            let key = format!(
                "{}|{}|{}",
                projected.file_path, projected.qualified_name, projected.name
            );
            if seen.insert(key) {
                raw_index_symbols.push(map_projected_semantic_symbol_to_raw_index(&projected));
                if include_symbols {
                    symbols.push(map_projected_semantic_symbol(projected));
                }
                library_symbol_count += 1;
            }
        }
        store_stdlib_semantic_projection_cache(
            state,
            stdlib_path_for_log.as_deref(),
            library_projection_views,
        );
    }
    if include_symbols {
        augment_owned_relationships(&mut symbols);
    }

    let mut symbol_counts = HashMap::<String, usize>::new();
    if include_symbols {
        for symbol in &symbols {
            *symbol_counts.entry(symbol.file_path.clone()).or_insert(0) += 1;
        }
    } else {
        for symbol in &raw_index_symbols {
            *symbol_counts.entry(symbol.file_path.clone()).or_insert(0) += 1;
        }
    }
    for file in &mut file_results {
        file.symbol_count = symbol_counts.get(&file.path).copied().unwrap_or(0);
    }

    let analysis_duration_ms = analysis_start.elapsed().as_millis();

    let parse_duration_ms = parse_start.elapsed().as_millis();
    let total_duration_ms = compile_start.elapsed().as_millis();
    let file_diagnostics = build_file_diagnostics(&file_results, &unresolved);
    let parse_error_categories = summarize_parse_error_categories(&file_results);
    let performance_warnings = performance_warnings(
        parse_duration_ms,
        analysis_duration_ms,
        stdlib_duration_ms,
        total_duration_ms,
    );
    let response_symbols = if include_symbols { symbols } else { Vec::new() };
    let response = CompileResponse {
        ok: file_results.iter().all(|f| f.ok),
        files: file_results,
        file_diagnostics,
        parse_error_categories,
        performance_warnings,
        symbols: response_symbols,
        project_symbol_count,
        library_symbol_count,
        unresolved,
        library_path: stdlib_path_for_log
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        parse_failed: false,
        workspace_snapshot_hit,
        parsed_files,
        parse_duration_ms,
        analysis_duration_ms,
        stdlib_duration_ms,
        stdlib_file_count: stdlib_files.len(),
        total_duration_ms,
    };
    if include_symbols {
        emit_progress(
            "indexing",
            Some(format!("indexing {} symbols", response.symbols.len())),
            Some(response.symbols.len()),
            Some(response.symbols.len()),
        );
        let _ = index_symbols_for_project(
            state,
            &root,
            stdlib_path_for_log.as_deref(),
            &response.symbols,
            true,
            false,
        );
    } else {
        emit_progress(
            "indexing",
            Some(format!("indexing {} raw symbols", raw_index_symbols.len())),
            Some(raw_index_symbols.len()),
            Some(raw_index_symbols.len()),
        );
        let _ = index_raw_symbols_for_project(
            state,
            &root,
            stdlib_path_for_log.as_deref(),
            raw_index_symbols,
            true,
            false,
        );
    }
    let persist_signature = if stdlib_signature.is_empty() {
        None
    } else {
        Some(stdlib_signature.as_str())
    };
    schedule_workspace_ir_cache_persist(
        state.clone(),
        root.clone(),
        persist_signature.map(|value| value.to_string()),
    );
    emit_progress("complete", Some("compile done".to_string()), None, None);
    Ok(response)
}

pub fn load_library_symbols_sync(
    state: &CoreState,
    root: String,
    target_path: Option<PathBuf>,
    include_symbols: bool,
) -> Result<LibrarySymbolsResponse, String> {
    let root = canonical_project_root(&root);
    let start = Instant::now();
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }
    let load_target = target_path
        .as_ref()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "<all-library-files>".to_string());
    let _background_job = state.try_start_background_job(
        "library-load",
        Some(format!(
            "target={} include_symbols={}",
            load_target, include_symbols
        )),
        None,
    );

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
    let stdlib_file_count = stdlib_files.len();
    let library_path_text = stdlib_path_for_log
        .as_ref()
        .map(|path| path.to_string_lossy().to_string());
    let library_key = stdlib_path_for_log
        .as_ref()
        .map(|path| normalized_compare_key(path));
    if !stdlib_signature.is_empty() {
        let _ = seed_stdlib_index_from_cache_for_project(
            state,
            &root,
            stdlib_path_for_log.as_deref(),
            &stdlib_signature,
        )?;
    }
    let index_fresh =
        if let (Some(key), false) = (library_key.as_ref(), stdlib_signature.is_empty()) {
            let store = state
                .symbol_index
                .lock()
                .map_err(|_| "Symbol index lock poisoned".to_string())?;
            store.is_stdlib_index_fresh(&root, key, &stdlib_signature)
        } else {
            false
        };

    let mut workspace_snapshot_hit = index_fresh;
    let symbols = if !include_symbols {
        Vec::new()
    } else if index_fresh {
        let target_file = target_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string());
        let indexed = {
            let store = state
                .symbol_index
                .lock()
                .map_err(|_| "Symbol index lock poisoned".to_string())?;
            store.library_symbols(&root, target_file.as_deref())
        };
        indexed
            .iter()
            .map(map_index_symbol_record_to_symbol_view)
            .collect::<Vec<_>>()
    } else {
        let trace_stdlib = std::env::var("MERCURIO_STDLIB_TRACE")
            .ok()
            .map(|value| {
                let normalized = value.trim().to_ascii_lowercase();
                matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
            })
            .unwrap_or(false);
        let mut in_flight_stdlib_file: Option<(usize, usize, PathBuf, Instant)> = None;
        let (
            stdlib_entries,
            _stdlib_metatype_index,
            _stdlib_snapshot_symbols,
            snapshot_hit,
            _snapshot_signature,
        ) = load_stdlib_snapshot(
            state,
            stdlib_path_for_log.as_deref(),
            |index, total, path| {
                if !trace_stdlib || total == 0 {
                    return;
                }
                if let Some((prev_index, prev_total, prev_path, started_at)) =
                    in_flight_stdlib_file.take()
                {
                    eprintln!(
                        "[stdlib-load] parsed {}/{} in {} ms: {}",
                        prev_index,
                        prev_total,
                        started_at.elapsed().as_millis(),
                        prev_path.to_string_lossy()
                    );
                }
                in_flight_stdlib_file = Some((index, total, path.to_path_buf(), Instant::now()));
                eprintln!(
                    "[stdlib-load] parsing {}/{}: {}",
                    index,
                    total,
                    path.to_string_lossy()
                );
            },
        )?;
        if trace_stdlib {
            if let Some((index, total, path, started_at)) = in_flight_stdlib_file.take() {
                eprintln!(
                    "[stdlib-load] parsed {}/{} in {} ms: {}",
                    index,
                    total,
                    started_at.elapsed().as_millis(),
                    path.to_string_lossy()
                );
            }
        }
        workspace_snapshot_hit = snapshot_hit;
        let stdlib_entry_files = stdlib_entries
            .iter()
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();
        let selected_files = select_workspace_files(
            &build_compile_workspace_files(&[], &stdlib_entry_files),
            WorkspaceFileSelectionScope::Library,
            target_path.as_deref(),
        );
        let selected = selected_files
            .iter()
            .map(|path| normalized_compare_key(path))
            .collect::<HashSet<_>>();
        let selected_entries = stdlib_entries
            .iter()
            .filter(|(path, _)| {
                target_path.is_none() || selected.contains(&normalized_compare_key(path))
            })
            .map(|(path, source)| (path.clone(), source.clone()))
            .collect::<Vec<_>>();
        let library_semantic_inputs = selected_entries
            .iter()
            .map(|(path, source)| WorkspaceSemanticInput {
                path: path.clone(),
                source: source.clone(),
                scope: WorkspaceFileScope::Library,
            })
            .collect::<Vec<_>>();
        let empty_library_spans = HashMap::<String, SymbolSpan>::new();
        let projected_library_symbols = build_workspace_semantic_elements_with_selection(
            &library_semantic_inputs,
            _stdlib_metatype_index.as_ref(),
            stdlib_entry_files.len(),
            WorkspaceSemanticSelection::LibraryOnly,
        )
        .into_iter()
        .map(|element| map_semantic_element_to_projected_symbol(element, &empty_library_spans))
        .collect::<Vec<_>>();
        store_stdlib_semantic_projection_cache(
            state,
            stdlib_path_for_log.as_deref(),
            projected_library_symbols
                .iter()
                .map(stdlib_projection_view_from_projected_symbol)
                .collect::<Vec<_>>(),
        );
        let mut resolved = Vec::<SymbolView>::new();
        let mut raw_for_index = Vec::<RawIndexSymbol>::new();
        for projected in projected_library_symbols {
            raw_for_index.push(map_projected_semantic_symbol_to_raw_index(&projected));
            resolved.push(map_projected_semantic_symbol(projected));
        }

        let _ = index_raw_symbols_for_project(
            state,
            &root,
            stdlib_path_for_log.as_deref(),
            raw_for_index,
            true,
            false,
        );
        if let Some(key) = library_key.as_ref() {
            if let Ok(mut store) = state.symbol_index.lock() {
                if !stdlib_signature.is_empty() {
                    store.mark_stdlib_indexed(&root, key, &stdlib_signature);
                }
            }
        }
        let _ = persist_stdlib_index_cache(
            state,
            &root,
            stdlib_path_for_log.as_deref(),
            &stdlib_signature,
        );
        resolved
    };
    let stdlib_duration_ms = stdlib_start.elapsed().as_millis();

    let response = LibrarySymbolsResponse {
        ok: true,
        symbols,
        library_files,
        library_path: library_path_text,
        workspace_snapshot_hit,
        stdlib_duration_ms,
        stdlib_file_count,
        total_duration_ms: start.elapsed().as_millis(),
    };
    let persist_signature = if stdlib_signature.is_empty() {
        None
    } else {
        Some(stdlib_signature.as_str())
    };
    schedule_workspace_ir_cache_persist(
        state.clone(),
        root.clone(),
        persist_signature.map(|value| value.to_string()),
    );
    if !stdlib_signature.is_empty() {
        let _ = persist_stdlib_index_cache(state, &root, stdlib_path_for_log.as_deref(), &stdlib_signature);
    }
    Ok(response)
}

fn load_stdlib_snapshot<F>(
    state: &CoreState,
    stdlib_path: Option<&Path>,
    mut on_progress: F,
) -> Result<
    (
        Vec<(PathBuf, String)>,
        Arc<MetatypeIndex>,
        Arc<Vec<StdlibSymbol>>,
        bool,
        String,
    ),
    String,
>
where
    F: FnMut(usize, usize, &Path),
{
    let mut stdlib_cache = {
        let cache = state
            .workspace_snapshot_cache
            .lock()
            .map_err(|_| "Workspace snapshot cache lock poisoned".to_string())?;
        cache
            .iter()
            .filter_map(|(key, entry)| match entry {
                WorkspaceSnapshotCacheEntry::Stdlib(value) => Some((key.clone(), value.clone())),
                WorkspaceSnapshotCacheEntry::ProjectSemantic(_)
                | WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(_) => None,
            })
            .collect::<HashMap<String, StdlibCache>>()
    };
    let result = load_stdlib_snapshot_with_cache(stdlib_path, &mut stdlib_cache, |entries| {
        build_stdlib_snapshot_with_progress(entries, |index, total, path| {
            on_progress(index, total, path);
        })
    })?;
    let mut cache = state
        .workspace_snapshot_cache
        .lock()
        .map_err(|_| "Workspace snapshot cache lock poisoned".to_string())?;
    cache.retain(|_, entry| !matches!(entry, WorkspaceSnapshotCacheEntry::Stdlib(_)));
    for (key, value) in stdlib_cache {
        cache.insert(key, WorkspaceSnapshotCacheEntry::Stdlib(value));
    }
    Ok(result)
}

fn build_stdlib_snapshot_with_progress<F>(
    entries: &[(PathBuf, String)],
    on_progress: F,
) -> (MetatypeIndex, Vec<StdlibSymbol>)
where
    F: FnMut(usize, usize, &Path),
{
    let (index, symbols) = build_stdlib_snapshot_rows_with_progress(entries, on_progress);
    (
        index,
        symbols.into_iter().map(map_stdlib_symbol_row).collect(),
    )
}

#[cfg(test)]
fn build_stdlib_snapshot(entries: &[(PathBuf, String)]) -> (MetatypeIndex, Vec<StdlibSymbol>) {
    build_stdlib_snapshot_with_progress(entries, |_index, _total, _path| {})
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

fn clear_project_semantic_cache_for_root(
    cache: &mut HashMap<String, WorkspaceSnapshotCacheEntry>,
    project_root: &str,
) {
    let canonical_root = canonical_project_root(project_root);
    let to_remove = cache
        .iter()
        .filter_map(|(key, entry)| match entry {
            WorkspaceSnapshotCacheEntry::ProjectSemantic(_)
            | WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(_)
                if project_semantic_cache_key_matches_root(key, &canonical_root) =>
            {
                Some(key.clone())
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    for key in to_remove {
        cache.remove(&key);
    }
}

fn collect_project_semantic_cache_for_root(
    cache: &HashMap<String, WorkspaceSnapshotCacheEntry>,
    project_root: &str,
) -> (
    Vec<mercurio_sysml_semantics::semantic_contract::SemanticElementView>,
    Vec<mercurio_sysml_semantics::semantic_contract::SemanticElementProjectionView>,
) {
    let canonical_root = canonical_project_root(project_root);
    let mut semantic_elements = Vec::new();
    let mut semantic_projections = Vec::new();
    for (key, entry) in cache.iter() {
        if !project_semantic_cache_key_matches_root(key, &canonical_root) {
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
    (semantic_elements, semantic_projections)
}

fn retain_project_semantic_cache_for_files(
    cache: &mut HashMap<String, WorkspaceSnapshotCacheEntry>,
    project_root: &str,
    selected_file_keys: &HashSet<String>,
) {
    if selected_file_keys.is_empty() {
        return;
    }
    let canonical_root = canonical_project_root(project_root);
    let target_keys = cache
        .iter()
        .filter_map(|(key, entry)| match entry {
            WorkspaceSnapshotCacheEntry::ProjectSemantic(_)
            | WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(_)
                if project_semantic_cache_key_matches_root(key, &canonical_root) =>
            {
                Some(key.clone())
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    for key in target_keys {
        let replacement = cache.get(&key).and_then(|entry| match entry {
            WorkspaceSnapshotCacheEntry::ProjectSemantic(elements) => {
                let filtered = elements
                    .iter()
                    .filter(|element| {
                        !selected_file_keys
                            .contains(&normalized_compare_key(Path::new(&element.file_path)))
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                if filtered.is_empty() {
                    None
                } else {
                    Some(WorkspaceSnapshotCacheEntry::ProjectSemantic(Arc::new(filtered)))
                }
            }
            WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(elements) => {
                let filtered = elements
                    .iter()
                    .filter(|element| {
                        !selected_file_keys
                            .contains(&normalized_compare_key(Path::new(&element.file_path)))
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                if filtered.is_empty() {
                    None
                } else {
                    Some(WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(Arc::new(
                        filtered,
                    )))
                }
            }
            WorkspaceSnapshotCacheEntry::Stdlib(_) => None,
        });
        if let Some(entry) = replacement {
            cache.insert(key, entry);
        } else {
            cache.remove(&key);
        }
    }
}

fn refresh_project_semantic_lookup_from_cache(
    state: &CoreState,
    project_root: &str,
) -> Result<(), String> {
    let (semantic_elements, semantic_projections) = {
        let cache = state
            .workspace_snapshot_cache
            .lock()
            .map_err(|_| "Workspace snapshot cache lock poisoned".to_string())?;
        collect_project_semantic_cache_for_root(&cache, project_root)
    };
    refresh_project_semantic_lookup(
        state,
        project_root,
        semantic_elements.as_slice(),
        semantic_projections.as_slice(),
    )
}

fn stdlib_semantic_projection_cache_key(stdlib_path: &Path) -> String {
    format!(
        "stdlib-semantic-projection|{}",
        normalized_compare_key(stdlib_path)
    )
}

fn store_stdlib_semantic_projection_cache(
    state: &CoreState,
    stdlib_path: Option<&Path>,
    projection: Vec<SemanticElementProjectionView>,
) {
    let Some(stdlib_path) = stdlib_path else {
        return;
    };
    if projection.is_empty() {
        return;
    }
    if let Ok(mut cache) = state.workspace_snapshot_cache.lock() {
        cache.insert(
            stdlib_semantic_projection_cache_key(stdlib_path),
            WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(Arc::new(projection)),
        );
    }
}

fn stdlib_projection_view_from_projected_symbol(
    symbol: &ProjectedSemanticSymbol,
) -> SemanticElementProjectionView {
    SemanticElementProjectionView {
        name: symbol.name.clone(),
        qualified_name: symbol.qualified_name.clone(),
        file_path: symbol.file_path.clone(),
        metatype_qname: projected_symbol_metatype_qname(symbol),
        features: symbol
            .properties
            .iter()
            .map(|property| SemanticFeatureView {
                name: property.name.clone(),
                feature_kind: "attribute".to_string(),
                many: matches!(property.value, ProjectedPropertyValue::List { .. }),
                containment: false,
                declared_type_qname: None,
                metamodel_feature_qname: None,
                value: semantic_value_from_projected_property_value(&property.value),
                diagnostics: Vec::new(),
            })
            .collect(),
    }
}

fn semantic_value_from_projected_property_value(
    value: &ProjectedPropertyValue,
) -> SemanticValueView {
    match value {
        ProjectedPropertyValue::Text { value } => SemanticValueView::Text {
            value: value.clone(),
        },
        ProjectedPropertyValue::List { items } => SemanticValueView::List {
            items: items
                .iter()
                .map(|item| SemanticValueView::Text {
                    value: item.clone(),
                })
                .collect(),
        },
        ProjectedPropertyValue::Bool { value } => SemanticValueView::Bool { value: *value },
        ProjectedPropertyValue::Number { value } => SemanticValueView::U64 { value: *value },
    }
}

fn project_semantic_cache_key_matches_root(key: &str, canonical_root: &str) -> bool {
    let Some(rest) = key.strip_prefix("project-semantic|") else {
        return false;
    };
    let Some((candidate_root, _)) = rest.split_once('|') else {
        return false;
    };
    canonical_project_root(candidate_root) == canonical_root
}

fn normalize_semantic_element_file_path(
    project_root: &Path,
    mut element: mercurio_sysml_semantics::semantic_contract::SemanticElementView,
) -> mercurio_sysml_semantics::semantic_contract::SemanticElementView {
    element.file_path = normalize_workspace_file_path(project_root, &element.file_path);
    element
}

fn normalize_semantic_projection_file_path(
    project_root: &Path,
    mut element: mercurio_sysml_semantics::semantic_contract::SemanticElementProjectionView,
) -> mercurio_sysml_semantics::semantic_contract::SemanticElementProjectionView {
    element.file_path = normalize_workspace_file_path(project_root, &element.file_path);
    element
}

fn normalize_workspace_file_path(project_root: &Path, file_path: &str) -> String {
    let path = PathBuf::from(file_path);
    if path.is_absolute() {
        let canonical_root = project_root
            .canonicalize()
            .unwrap_or_else(|_| project_root.to_path_buf());
        let canonical_path = path.canonicalize().unwrap_or(path.clone());
        if let Ok(relative) = canonical_path.strip_prefix(&canonical_root) {
            return normalize_display_path(&project_root.join(relative).to_string_lossy());
        }
        return normalize_display_path(file_path);
    }
    normalize_display_path(&project_root.join(path).to_string_lossy())
}

fn build_symbol_span_seed_from_index(
    state: &CoreState,
    project_root: &str,
    files: &[PathBuf],
) -> HashMap<String, SymbolSpan> {
    if files.is_empty() {
        return HashMap::new();
    }
    let Ok(store) = state.symbol_index.lock() else {
        return HashMap::new();
    };
    let mut out = HashMap::new();
    for file in files {
        let file_path = file.to_string_lossy().to_string();
        for symbol in store.project_symbols(project_root, Some(&file_path)) {
            out.insert(
                symbol_key(&symbol.file_path, &symbol.qualified_name),
                SymbolSpan {
                    start_line: symbol.start_line,
                    start_col: symbol.start_col,
                    end_line: symbol.end_line,
                    end_col: symbol.end_col,
                },
            );
        }
    }
    out
}

fn remember_projected_symbol_span(
    symbol_spans: &mut HashMap<String, SymbolSpan>,
    symbol: &ProjectedSemanticSymbol,
) {
    if symbol.start_line == 0 || symbol.start_col == 0 {
        return;
    }
    symbol_spans
        .entry(symbol_key(&symbol.file_path, &symbol.qualified_name))
        .or_insert(SymbolSpan {
            start_line: symbol.start_line,
            start_col: symbol.start_col,
            end_line: symbol.end_line.max(symbol.start_line),
            end_col: symbol.end_col.max(symbol.start_col),
        });
}

fn repair_projected_symbol_span_from_source(
    projected: &mut ProjectedSemanticSymbol,
    element: &mercurio_sysml_semantics::semantic_contract::SemanticElementView,
    sources_by_file: &HashMap<String, String>,
    symbol_spans: &HashMap<String, SymbolSpan>,
) {
    if projected.start_line > 0 && projected.start_col > 0 {
        return;
    }
    if !projected.kind.eq_ignore_ascii_case("OwnedEnd") {
        return;
    }
    let name = projected.name.trim();
    if name.is_empty() {
        return;
    }
    let file_key = normalized_compare_key(Path::new(&projected.file_path));
    let Some(source) = sources_by_file.get(&file_key) else {
        return;
    };
    let owner_qname = element
        .attributes
        .get("mercurio::owner")
        .or_else(|| element.attributes.get("element::owner"))
        .or_else(|| element.attributes.get("emf::owner"))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let owner_span = owner_qname.and_then(|qname| {
        symbol_spans
            .get(&symbol_key(&projected.file_path, qname))
            .copied()
    });
    if let Some(span) = find_owned_end_span_in_source(source, name, owner_span) {
        projected.start_line = span.start_line;
        projected.start_col = span.start_col;
        projected.end_line = span.end_line;
        projected.end_col = span.end_col;
    }
}

fn find_owned_end_span_in_source(
    source: &str,
    name: &str,
    owner_span: Option<SymbolSpan>,
) -> Option<SymbolSpan> {
    let line_ranges = owner_span
        .map(|span| vec![(span.start_line, span.end_line.max(span.start_line))])
        .unwrap_or_else(|| vec![(1, source.lines().count().max(1) as u32)]);
    for (start_line, end_line) in line_ranges {
        for (index, line) in source.lines().enumerate() {
            let line_number = index as u32 + 1;
            if line_number < start_line || line_number > end_line {
                continue;
            }
            let Some(end_offset) = find_word_after(line, "end", 0) else {
                continue;
            };
            let Some(name_offset) = find_word_after(line, name, end_offset + 3) else {
                continue;
            };
            let start_col = line[..name_offset].chars().count() as u32 + 1;
            let end_col = start_col + name.chars().count() as u32;
            return Some(SymbolSpan {
                start_line: line_number,
                start_col,
                end_line: line_number,
                end_col,
            });
        }
    }
    None
}

fn find_word_after(line: &str, needle: &str, min_offset: usize) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    let mut search_from = min_offset.min(line.len());
    while let Some(relative) = line[search_from..].find(needle) {
        let absolute = search_from + relative;
        let before = if absolute == 0 {
            None
        } else {
            line[..absolute].chars().next_back()
        };
        let after = line[absolute + needle.len()..].chars().next();
        let is_word_start = before.map(is_identifier_char).unwrap_or(false);
        let is_word_end = after.map(is_identifier_char).unwrap_or(false);
        if !is_word_start && !is_word_end {
            return Some(absolute);
        }
        search_from = absolute + needle.len();
    }
    None
}

fn is_identifier_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
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
        qname_to_index
            .entry(symbol.qualified_name.clone())
            .or_insert(idx);
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
        for rel in parent
            .relationships
            .iter()
            .filter(|rel| rel.kind == "ownedMember")
        {
            let Some(is_attribute) = is_attribute_by_qname.get(&rel.target) else {
                continue;
            };
            if *is_attribute && !owned_attributes.iter().any(|target| target == &rel.target) {
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

fn map_index_symbol_record_to_symbol_view(symbol: &SymbolRecord) -> SymbolView {
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
        doc: symbol.doc_text.clone(),
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

fn projected_symbol_metatype_qname(symbol: &ProjectedSemanticSymbol) -> Option<String> {
    symbol.properties.iter().find_map(|item| {
        if item.name != "metatype_qname" {
            return None;
        }
        match &item.value {
            ProjectedPropertyValue::Text { value } if !value.trim().is_empty() => {
                Some(value.clone())
            }
            _ => None,
        }
    })
}

fn map_projected_semantic_symbol_to_raw_index(symbol: &ProjectedSemanticSymbol) -> RawIndexSymbol {
    RawIndexSymbol {
        file_path: symbol.file_path.clone(),
        name: symbol.name.clone(),
        qualified_name: symbol.qualified_name.clone(),
        parent_qualified_name: projected_symbol_parent_qualified_name(symbol),
        kind: symbol.kind.clone(),
        metatype_qname: projected_symbol_metatype_qname(symbol),
        start_line: symbol.start_line,
        start_col: symbol.start_col,
        end_line: symbol.end_line,
        end_col: symbol.end_col,
        doc_text: symbol.doc.clone(),
        properties_json: None,
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

fn parent_qualified_name_from_qname(qualified_name: &str) -> Option<String> {
    let value = qualified_name.trim();
    if value.is_empty() {
        return None;
    }
    let index = value.rfind("::")?;
    if index == 0 {
        return None;
    }
    Some(value[..index].to_string())
}

fn projected_symbol_parent_qualified_name(symbol: &ProjectedSemanticSymbol) -> Option<String> {
    for relationship in &symbol.relationships {
        if relationship.kind.eq_ignore_ascii_case("owningNamespace") {
            let target = relationship.target.trim();
            if !target.is_empty() {
                return Some(target.to_string());
            }
        }
    }
    for property in &symbol.properties {
        let key = property.name.as_str();
        let is_owner_property = matches!(
            key,
            "mercurio::owner" | "element::owner" | "emf::owner" | "owner"
        );
        if !is_owner_property {
            continue;
        }
        match &property.value {
            ProjectedPropertyValue::Text { value } => {
                let value = value.trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
            ProjectedPropertyValue::List { items } => {
                if let Some(value) = items.iter().find_map(|item| {
                    let trimmed = item.trim();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(trimmed.to_string())
                    }
                }) {
                    return Some(value);
                }
            }
            _ => {}
        }
    }
    parent_qualified_name_from_qname(&symbol.qualified_name)
}

fn symbol_parent_qualified_name(symbol: &SymbolView) -> Option<String> {
    for relationship in &symbol.relationships {
        if relationship.kind.eq_ignore_ascii_case("owningNamespace") {
            let target = relationship.target.trim();
            if !target.is_empty() {
                return Some(target.to_string());
            }
        }
    }
    for property in &symbol.properties {
        let key = property.name.as_str();
        let is_owner_property = matches!(
            key,
            "mercurio::owner" | "element::owner" | "emf::owner" | "owner"
        );
        if !is_owner_property {
            continue;
        }
        match &property.value {
            PropertyValueView::Text { value } => {
                let value = value.trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
            PropertyValueView::List { items } => {
                if let Some(value) = items.iter().find_map(|item| {
                    let trimmed = item.trim();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(trimmed.to_string())
                    }
                }) {
                    return Some(value);
                }
            }
            _ => {}
        }
    }
    parent_qualified_name_from_qname(&symbol.qualified_name)
}

fn index_symbols_for_project(
    state: &CoreState,
    project_root: &str,
    library_path: Option<&Path>,
    symbols: &[SymbolView],
    rebuild_mappings: bool,
    non_blocking_lock: bool,
) -> Result<(), String> {
    let raw = symbols
        .iter()
        .map(|symbol| RawIndexSymbol {
            file_path: symbol.file_path.clone(),
            name: symbol.name.clone(),
            qualified_name: symbol.qualified_name.clone(),
            parent_qualified_name: symbol_parent_qualified_name(symbol),
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
    index_raw_symbols_for_project(
        state,
        project_root,
        library_path,
        raw,
        rebuild_mappings,
        non_blocking_lock,
    )
}

fn index_raw_symbols_for_project(
    state: &CoreState,
    project_root: &str,
    library_path: Option<&Path>,
    raw: Vec<RawIndexSymbol>,
    rebuild_mappings: bool,
    non_blocking_lock: bool,
) -> Result<(), String> {
    let library_key = library_path.map(|path| normalized_compare_key(path));
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
                parent_qualified_name: row.parent_qualified_name,
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
    use crate::settings::AppSettings;
    use crate::symbol_index::query_project_symbols;
    use mercurio_sysml_pkg::compile_support::canonical_symbol_id as canonical_symbol_id_shared;
    use mercurio_sysml_pkg::semantic_projection::build_symbol_span_index;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn map_semantic_element_to_symbol(
        element: SemanticElementView,
        symbol_spans: &HashMap<String, SymbolSpan>,
    ) -> SymbolView {
        let projected = map_semantic_element_to_projected_symbol(element, symbol_spans);
        map_projected_semantic_symbol(projected)
    }

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
        assert!(symbols.iter().any(|symbol| symbol.kind == "Documentation"
            && symbol.qualified_name.starts_with("KerML::doc@")));
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
            .any(|symbol| symbol.name == "AnnotatingElement"
                && symbol
                    .qualified_name
                    .ends_with("KerML::Root::AnnotatingElement")));

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
            symbol
                .qualified_name
                .ends_with("KerML::Root::AnnotatingElement")
        }));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn compile_workspace_warms_semantic_projection_cache() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_projection_cache_{stamp}"));
        let project_dir = root.join("project");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            project_dir.join("main.sysml"),
            "package P { action def DoThing; }\n",
        )
        .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            "{\"name\":\"projection-cache\",\"src\":[\"*.sysml\"]}",
        )
        .expect("write project descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let project_root = project_dir.to_string_lossy().to_string();
        let response = compile_workspace_sync(
            &state,
            project_root.clone(),
            1,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile response");

        assert!(response.ok);

        let cache = state
            .workspace_snapshot_cache
            .lock()
            .expect("workspace cache lock");
        let root_prefix = format!("project-semantic|{}|", project_root);
        let projection_entry = cache.iter().find_map(|(key, entry)| match entry {
            WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(elements)
                if key.starts_with(&root_prefix) =>
            {
                Some(elements.clone())
            }
            _ => None,
        });
        let projection_entry = projection_entry.expect("projection cache entry");
        let main_file = project_dir.join("main.sysml").to_string_lossy().to_string();
        assert!(!projection_entry.is_empty());
        assert!(projection_entry
            .iter()
            .any(|element| element.file_path == main_file));

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
        assert!(!first.workspace_snapshot_hit);

        let second = load_library_symbols_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            None,
            true,
        )
        .expect("second load");
        assert!(second.workspace_snapshot_hit);

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
        assert!(!third.workspace_snapshot_hit);
        assert!(third.symbols.iter().any(|symbol| symbol.name == "B"));

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
        fs::write(
            project_dir.join("main.sysml"),
            "package P { part def A; }\n",
        )
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
        assert!(response.symbols.iter().all(|symbol| !symbol
            .qualified_name
            .contains("KerML::Root::AnnotatingElement")));

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
        assert!(symbols.iter().any(
            |symbol| symbol.kind == "Import" && symbol.qualified_name.contains("ScalarValues")
        ));
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
        assert!(response.symbols.iter().any(
            |symbol| symbol.kind == "Import" && symbol.qualified_name.contains("ScalarValues")
        ));

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
        fs::write(
            project_dir.join("main.sysml"),
            "package P { part def A; }\n",
        )
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
        assert!(response.symbols.iter().any(
            |symbol| symbol.kind == "Import" && symbol.qualified_name.contains("ScalarValues")
        ));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn compile_workspace_includes_project_import_symbols_via_semantic_pipeline() {
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

        assert!(response.symbols.iter().any(|symbol| {
            symbol.kind == "Import"
                && symbol.file_path.ends_with("main.sysml")
                && symbol.qualified_name.contains("ScalarValues")
        }));

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
    fn compile_project_delta_without_symbols_still_seeds_index() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_delta_no_symbols_{stamp}"));
        let project_dir = root.join("project");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            project_dir.join("main.sysml"),
            "package P { part def A; }\n",
        )
        .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            "{\"name\":\"delta-no-symbols\",\"src\":[\"*.sysml\"]}",
        )
        .expect("write project descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let project_root = project_dir.to_string_lossy().to_string();
        let response = compile_project_delta_sync_with_options(
            &state,
            project_root.clone(),
            501,
            true,
            None,
            Vec::new(),
            false,
            |_| {},
        )
        .expect("delta compile");
        assert!(response.ok);
        assert_eq!(response.symbols.len(), 0);
        assert!(response.project_symbol_count > 0);
        assert_eq!(response.library_symbol_count, 0);

        let indexed = query_project_symbols(&state, project_root, None, Some(0), Some(10_000))
            .expect("query project symbols");
        assert!(!indexed.is_empty());
        assert!(indexed.iter().any(|symbol| symbol.qualified_name == "P"));

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
                let expected = vec!["Demo::ScenarioState::speed".to_string()];
                assert_eq!(items.as_slice(), expected.as_slice());
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
    fn repair_projected_symbol_span_falls_back_to_owned_end_source_line() {
        let source = "\
package ConnectionTest {
  abstract connection def C {
    part p;
    end end1;
    end end2;
    end end3;
  }
}
";
        let mut attrs = HashMap::new();
        attrs.insert("emf::owner".to_string(), "ConnectionTest::C".to_string());
        let element = SemanticElementView {
            name: "end3".to_string(),
            qualified_name: "ConnectionTest::C::end3".to_string(),
            metatype_qname: Some("sysml::Feature".to_string()),
            file_path: "ConnectionTest.sysml".to_string(),
            attributes: attrs,
        };
        let mut projected = ProjectedSemanticSymbol {
            file_path: "ConnectionTest.sysml".to_string(),
            name: "end3".to_string(),
            qualified_name: "ConnectionTest::C::end3".to_string(),
            kind: "OwnedEnd".to_string(),
            start_line: 0,
            start_col: 0,
            end_line: 0,
            end_col: 0,
            doc: None,
            supertypes: Vec::new(),
            relationships: Vec::new(),
            is_public: true,
            properties: Vec::new(),
        };
        let mut symbol_spans = HashMap::new();
        symbol_spans.insert(
            symbol_key("ConnectionTest.sysml", "ConnectionTest::C"),
            SymbolSpan {
                start_line: 2,
                start_col: 3,
                end_line: 7,
                end_col: 4,
            },
        );
        let sources_by_file = HashMap::from([(
            normalized_compare_key(Path::new("ConnectionTest.sysml")),
            source.to_string(),
        )]);

        repair_projected_symbol_span_from_source(
            &mut projected,
            &element,
            &sources_by_file,
            &symbol_spans,
        );

        assert_eq!(projected.start_line, 6);
        assert_eq!(projected.start_col, 9);
        assert_eq!(projected.end_line, 6);
        assert_eq!(projected.end_col, 13);
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
        let a1 =
            load_library_symbols_sync(&state, project_a.to_string_lossy().to_string(), None, true)
                .expect("load a1");
        assert!(!a1.workspace_snapshot_hit);

        let b1 =
            load_library_symbols_sync(&state, project_b.to_string_lossy().to_string(), None, true)
                .expect("load b1");
        assert!(!b1.workspace_snapshot_hit);

        state
            .clear_in_memory_caches_for_tests()
            .expect("clear runtime caches");

        let a2 =
            load_library_symbols_sync(&state, project_a.to_string_lossy().to_string(), None, true)
                .expect("load a2");
        assert!(a2.workspace_snapshot_hit);

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
        fs::write(
            project_dir.join("main.sysml"),
            "package P {\n  part def A\n}\n",
        )
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
        assert!(!response.file_diagnostics.is_empty());
        let file_errors = response
            .files
            .iter()
            .flat_map(|file| file.errors.iter())
            .collect::<Vec<_>>();
        assert!(!file_errors.is_empty());
        assert!(file_errors.iter().all(|error| error.line >= 1));
        assert!(file_errors.iter().all(|error| error.column >= 1));
        assert!(file_errors
            .iter()
            .all(|error| !error.kind.trim().is_empty()));
        assert!(file_errors.iter().all(|error| error.source == "parse"));
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
            .file_diagnostics
            .iter()
            .flat_map(|entry| entry.diagnostics.iter())
            .any(|diagnostic| diagnostic.source == "semantic"));
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
        assert!(warnings
            .iter()
            .any(|w| w.contains("analysis stage exceeded")));
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

        let semantic =
            query_semantic_symbols(&state, project_root).expect("query semantic symbols");
        assert!(!semantic.is_empty());
        assert!(semantic
            .iter()
            .any(|symbol| symbol.qualified_name == "Demo"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn query_semantic_symbols_exposes_backend_classification_lineage() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_semantic_lineage_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            library_dir.join("Parts.sysml"),
            "package Parts {\n  abstract item def Item {}\n  abstract part def Part :> Item {}\n}\n",
        )
        .expect("write stdlib parts");
        fs::write(
            project_dir.join("main.sysml"),
            "package PartTest {\n  public part def A {}\n}\n",
        )
        .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"semantic-lineage\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let project_root = project_dir.to_string_lossy().to_string();
        let _ = compile_project_delta_sync(
            &state,
            project_root.clone(),
            17,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile response");

        let semantic =
            query_semantic_symbols(&state, project_root).expect("query semantic symbols");
        let a = semantic
            .iter()
            .find(|symbol| symbol.qualified_name == "PartTest::A")
            .expect("PartTest::A symbol");
        assert!(a
            .relationships
            .iter()
            .any(|rel| rel.kind == "classifiedBy" && rel.target == "Parts::Part"));
        assert!(a
            .relationships
            .iter()
            .any(|rel| rel.kind == "metatypeSupertype" && rel.target == "Parts::Item"));
        assert!(a.supertypes.iter().any(|ty| ty == "Parts::Item"));
        assert!(a.properties.iter().any(|prop| {
            prop.name == "metatype_source"
                && matches!(
                    prop.value,
                    PropertyValueView::Text { ref value } if value == "inferred-kind"
                )
        }));
        assert!(a.properties.iter().any(|prop| {
            prop.name == "metatype_lineage"
                && matches!(
                    prop.value,
                    PropertyValueView::List { ref items }
                        if items.iter().any(|item| item == "Parts::Part")
                            && items.iter().any(|item| item == "Parts::Item")
                )
        }));

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
