use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use mercurio_model as walk;
use syster::base::{LineIndex, TextSize};
use syster::parser::Direction;
use syster::syntax::normalized::Multiplicity;
use syster::syntax::SyntaxFile;

#[derive(Serialize, Clone)]
pub struct ProjectModelView {
    pub stdlib_path: Option<String>,
    pub stdlib_cache_hit: bool,
    pub project_cache_hit: bool,
    pub element_count: usize,
    pub elements: Vec<ProjectModelElementView>,
    pub diagnostics: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct ProjectModelElementView {
    pub name: String,
    pub qualified_name: String,
    pub kind: String,
    pub file_path: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub metatype_qname: Option<String>,
    pub declared_supertypes: Vec<String>,
    pub supertypes: Vec<String>,
    pub direct_specializations: Vec<String>,
    pub indirect_specializations: Vec<String>,
    pub documentation: Option<String>,
    pub attributes: Vec<ProjectModelAttributeView>,
    pub diagnostics: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct ProjectModelAttributeView {
    pub name: String,
    pub qualified_name: String,
    pub declared_type: Option<String>,
    pub multiplicity: Option<String>,
    pub direction: Option<String>,
    pub documentation: Option<String>,
    pub cst_value: Option<String>,
    pub metamodel_attribute_qname: Option<String>,
    pub diagnostics: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct ProjectElementInheritedAttributeView {
    pub name: String,
    pub qualified_name: String,
    pub declared_on: String,
    pub declared_type: Option<String>,
    pub multiplicity: Option<String>,
    pub direction: Option<String>,
    pub documentation: Option<String>,
    pub cst_value: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ProjectElementAttributesView {
    pub element_qualified_name: String,
    pub metatype_qname: Option<String>,
    pub explicit_attributes: Vec<ProjectModelAttributeView>,
    pub inherited_attributes: Vec<ProjectElementInheritedAttributeView>,
    pub diagnostics: Vec<String>,
}

pub fn resolve_project_metatype(
    stdlib_index: &walk::WorkspaceIndex,
    ty: &walk::TypeInfo,
    symbol_kind_hint: Option<&str>,
) -> (Option<walk::TypeRef>, Option<String>) {
    for super_name in &ty.declared_supertypes {
        if let Some(found) = resolve_type_ref(stdlib_index, super_name) {
            return (Some(found), None);
        }
    }
    for super_name in &ty.supertypes {
        if let Some(found) = resolve_type_ref(stdlib_index, super_name) {
            return (Some(found), None);
        }
    }
    if let Some(kind) = symbol_kind_hint {
        if let Some(found) = resolve_metatype_from_kind_hint(stdlib_index, kind) {
            return (Some(found), None);
        }
    }
    if ty.declared_supertypes.is_empty() && ty.supertypes.is_empty() {
        return (
            None,
            Some(format!(
                "Type '{}' does not declare a supertype that can bind to stdlib.",
                ty.qualified_name
            )),
        );
    }
    (
        None,
        Some(format!(
            "None of '{}' supertypes resolved to stdlib.",
            ty.qualified_name
        )),
    )
}

fn resolve_metatype_from_kind_hint(
    index: &walk::WorkspaceIndex,
    kind: &str,
) -> Option<walk::TypeRef> {
    let candidates = metatype_name_candidates(kind);
    if candidates.is_empty() {
        return None;
    }
    let mut aggregate_matches = Vec::new();
    for candidate in &candidates {
        let matches = index
            .type_by_qname
            .iter()
            .filter(|(qname, _)| {
                let tail = qname.rsplit("::").next().unwrap_or(qname);
                normalize_kind_key(tail) == *candidate
            })
            .map(|(_, tref)| *tref)
            .collect::<Vec<_>>();
        let mut seen = HashSet::new();
        let matches = matches
            .into_iter()
            .filter(|tref| seen.insert(*tref))
            .collect::<Vec<_>>();
        if matches.len() == 1 {
            return matches.into_iter().next();
        }
        if !matches.is_empty() {
            aggregate_matches.extend(matches);
        }
    }
    let mut seen = HashSet::new();
    aggregate_matches.retain(|tref| seen.insert(*tref));
    if aggregate_matches.len() == 1 {
        aggregate_matches.into_iter().next()
    } else {
        None
    }
}

fn metatype_name_candidates(kind: &str) -> Vec<String> {
    let normalized = normalize_kind_key(kind);
    if normalized.is_empty() {
        return Vec::new();
    }
    let mut out = vec![normalized.clone()];
    for suffix in ["definition", "def", "usage", "use"] {
        if normalized.ends_with(suffix) && normalized.len() > suffix.len() {
            out.push(normalized[..normalized.len() - suffix.len()].to_string());
        }
    }
    let expanded = out.clone();
    for candidate in expanded {
        if candidate.starts_with("attribute") {
            out.push("feature".to_string());
            if candidate.len() > "attribute".len() {
                out.push(format!("feature{}", &candidate["attribute".len()..]));
            }
        }
    }
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for candidate in out {
        if seen.insert(candidate.clone()) {
            deduped.push(candidate);
        }
    }
    deduped
}

fn normalize_kind_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

pub fn resolve_package_metatype(
    stdlib_index: &walk::WorkspaceIndex,
) -> (Option<walk::TypeRef>, Option<String>) {
    if let Some(found) = stdlib_index.type_by_qname.get("Package").copied() {
        return (Some(found), None);
    }
    if let Some(found) = stdlib_index
        .type_by_name
        .get("Package")
        .and_then(|list| if list.len() == 1 { list.first().copied() } else { None })
    {
        return (Some(found), None);
    }

    let matches = stdlib_index
        .type_by_qname
        .iter()
        .filter(|(qname, _)| qname.rsplit("::").next() == Some("Package"))
        .map(|(_, tref)| *tref)
        .collect::<Vec<_>>();
    if matches.len() == 1 {
        return (matches.first().copied(), None);
    }
    if matches.len() > 1 {
        return (
            None,
            Some("Package metatype resolution is ambiguous in stdlib.".to_string()),
        );
    }
    (None, Some("Package metatype was not found in stdlib.".to_string()))
}

pub fn resolve_type_ref(index: &walk::WorkspaceIndex, name: &str) -> Option<walk::TypeRef> {
    index.type_by_qname.get(name).copied().or_else(|| {
        index.type_by_name.get(name).and_then(|list| {
            if list.len() == 1 {
                list.first().copied()
            } else {
                None
            }
        })
    })
}

pub fn collect_metamodel_attributes(
    db: &walk::Db,
    ws_files: walk::WorkspaceFiles,
    index: &walk::WorkspaceIndex,
    ref_to_qname: &HashMap<walk::TypeRef, String>,
    type_info_by_qname: &HashMap<String, walk::TypeInfo>,
    base: walk::TypeRef,
) -> Vec<walk::AttrInfo> {
    let mut out = Vec::new();
    let mut seen_types: HashSet<String> = HashSet::new();
    let mut seen_attrs: HashSet<String> = HashSet::new();
    let mut stack: Vec<String> = Vec::new();
    if let Some(base_qname) = ref_to_qname.get(&base) {
        stack.push(base_qname.clone());
    }

    while let Some(current_qname) = stack.pop() {
        if !seen_types.insert(current_qname.clone()) {
            continue;
        }
        let Some(current_ref) = index.type_by_qname.get(&current_qname).copied() else {
            continue;
        };
        if let Some(attrs) = index.owned_attrs.get(&current_ref) {
            for attr_ref in attrs {
                if let Some(attr_info) = walk::attr_info(db, ws_files, *attr_ref) {
                    if seen_attrs.insert(attr_info.qualified_name.clone()) {
                        out.push(attr_info);
                    }
                }
            }
        }
        if let Some(type_info) = type_info_by_qname.get(&current_qname) {
            for super_name in &type_info.supertypes {
                if let Some(super_ref) = resolve_type_ref(index, super_name) {
                    if let Some(super_qname) = ref_to_qname.get(&super_ref) {
                        stack.push(super_qname.clone());
                    }
                }
            }
        }
    }

    out.sort_by(|a, b| a.qualified_name.cmp(&b.qualified_name));
    out
}

pub fn build_walk_workspace(
    files: &HashMap<PathBuf, SyntaxFile>,
    paths: &[PathBuf],
) -> Option<(
    walk::Db,
    walk::WorkspaceFiles,
    HashMap<walk::FileId, String>,
    HashMap<walk::FileId, String>,
)> {
    if paths.is_empty() {
        return None;
    }

    let mut db = walk::Db::default();
    let mut sorted_paths = paths.to_vec();
    sorted_paths.sort();
    sorted_paths.dedup();

    let mut file_texts = Vec::new();
    let mut file_paths = Vec::new();
    let mut text_by_id = HashMap::new();
    let mut path_by_id = HashMap::new();
    let mut next_id = 1u32;

    for path in &sorted_paths {
        let Some(syntax) = files.get(path) else {
            continue;
        };
        let file_id = walk::FileId(next_id);
        next_id += 1;
        let text = syntax.source_text();
        let path_text = path.to_string_lossy().to_string();
        text_by_id.insert(file_id, text.clone());
        path_by_id.insert(file_id, path_text.clone());
        file_texts.push(walk::FileText::new(&mut db, file_id, text));
        file_paths.push(walk::FilePath::new(&mut db, file_id, path_text));
    }

    if file_texts.is_empty() {
        return None;
    }

    let ws_files = walk::WorkspaceFiles::new(&mut db, walk::WorkspaceId(1), file_texts, file_paths);
    Some((db, ws_files, text_by_id, path_by_id))
}

pub fn span_to_line_cols(text: Option<&str>, span: walk::Span) -> (u32, u32, u32, u32) {
    let Some(text) = text else {
        return (0, 0, 0, 0);
    };
    let line_index = LineIndex::new(text);
    let start = line_index.line_col(TextSize::from(span.start));
    let end = line_index.line_col(TextSize::from(span.end));
    (start.line, start.col, end.line, end.col)
}

pub fn format_direction(direction: Direction) -> String {
    match direction {
        Direction::In => "in".to_string(),
        Direction::Out => "out".to_string(),
        Direction::InOut => "inout".to_string(),
    }
}

pub fn format_multiplicity(mult: Option<Multiplicity>) -> Option<String> {
    let mult = mult?;
    let lower = mult.lower;
    let upper = mult.upper;
    if lower.is_none() && upper.is_none() {
        return None;
    }
    if let (Some(lo), Some(hi)) = (lower, upper) {
        if lo == hi {
            return Some(format!("[{}]", lo));
        }
    }
    let lo = lower
        .map(|v| v.to_string())
        .unwrap_or_else(|| "*".to_string());
    let hi = upper
        .map(|v| v.to_string())
        .unwrap_or_else(|| "*".to_string());
    Some(format!("[{}..{}]", lo, hi))
}

pub fn type_names_match(project_type: &str, metamodel_type: &str) -> bool {
    if project_type == metamodel_type {
        return true;
    }
    let project_tail = project_type.rsplit("::").next().unwrap_or(project_type);
    let metamodel_tail = metamodel_type.rsplit("::").next().unwrap_or(metamodel_type);
    project_tail == metamodel_tail
}

pub fn extract_doc_comment(text: &str, start_offset: usize) -> Option<String> {
    let safe_start = start_offset.min(text.len());
    let before = &text[..safe_start];
    let mut lines: Vec<&str> = before.lines().collect();
    if lines.is_empty() {
        return None;
    }

    while let Some(last) = lines.last() {
        if last.trim().is_empty() {
            lines.pop();
            continue;
        }
        break;
    }
    if lines.is_empty() {
        return None;
    }

    let mut doc_lines = Vec::new();
    let mut index = lines.len();
    while index > 0 {
        let line = lines[index - 1].trim_start();
        if let Some(rest) = line.strip_prefix("///") {
            doc_lines.push(rest.trim_start().to_string());
            index -= 1;
            continue;
        }
        if let Some(rest) = line.strip_prefix("//!") {
            doc_lines.push(rest.trim_start().to_string());
            index -= 1;
            continue;
        }
        break;
    }
    if !doc_lines.is_empty() {
        doc_lines.reverse();
        return Some(doc_lines.join("\n"));
    }

    None
}
