use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use mercurio_model as walk;
use syster::hir::SymbolKind;
use syster::parser::ast::{Comment, Name};
use syster::parser::{AstNode, SyntaxKind, SyntaxNode};
use syster::syntax::SyntaxFile;

use crate::{
    resolve_package_metatype, resolve_project_metatype, resolve_type_ref, span_to_line_cols,
};

#[derive(Serialize, Deserialize, Clone)]
pub struct SemanticPredicate {
    pub name: String,
    pub equals: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SemanticQuery {
    pub metatype: Option<String>,
    pub metatype_is_a: Option<String>,
    pub predicates: Vec<SemanticPredicate>,
}

#[derive(Serialize, Clone)]
pub struct SemanticElementView {
    pub name: String,
    pub qualified_name: String,
    pub metatype_qname: Option<String>,
    pub file_path: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub attributes: HashMap<String, String>,
}

pub struct SemanticIndex {
    elements: Vec<SemanticElementView>,
    metamodel: MetamodelGraph,
}

pub struct SemanticIndexInput<'a> {
    pub files: &'a HashMap<PathBuf, SyntaxFile>,
    pub project_db: &'a walk::Db,
    pub project_ws: walk::WorkspaceFiles,
    pub project_index: &'a walk::WorkspaceIndex,
    pub stdlib_index: &'a walk::WorkspaceIndex,
    pub project_path_by_file: &'a HashMap<walk::FileId, String>,
}

pub fn build_semantic_index(input: SemanticIndexInput<'_>) -> SemanticIndex {
    let mut elements = Vec::new();
    let metamodel = MetamodelGraph::new(input.stdlib_index);
    let ref_to_qname = build_ref_to_qname(input.stdlib_index);

    let mut files_by_path: HashMap<String, &SyntaxFile> = HashMap::new();
    for (path, syntax) in input.files {
        files_by_path.insert(path.to_string_lossy().to_string(), syntax);
    }

    let files = input.project_ws.files(input.project_db);
    let paths = input.project_ws.paths(input.project_db);
    for (file_text, file_path) in files.iter().copied().zip(paths.iter().copied()) {
        let file_id = file_text.file(input.project_db);
        let path_text = file_path.path(input.project_db);
        let Some(syntax) = files_by_path.get(path_text.as_str()) else {
            continue;
        };
        let file_index = walk::file_index(input.project_db, file_text, file_path);
        let file_text_content = syntax.source_text();
        let file_semantic = FileSemanticIndex::new(syntax);

        let mut type_info_by_element: HashMap<walk::ElementId, walk::TypeInfo> = HashMap::new();
        for ty in &file_index.types {
            type_info_by_element.insert(ty.element, ty.clone());
        }

        for element in &file_index.elements {
            let metatype_qname = resolve_element_metatype_qname(
                input.stdlib_index,
                &ref_to_qname,
                &type_info_by_element,
                element,
            );

            let mut attributes = HashMap::new();
            attributes.insert("name".to_string(), element.name.clone());
            attributes.insert("qualified_name".to_string(), element.qualified_name.clone());

            for rule in IMPLIED_RULES {
                let Some(qname) = metatype_qname.as_deref() else {
                    continue;
                };
                if !metamodel.is_subtype_of(qname, rule.base_metatype) {
                    continue;
                }
                if let Some(value) = (rule.extractor)(&file_semantic, element) {
                    attributes.insert(rule.attribute.to_string(), value);
                }
            }
            if metatype_qname
                .as_deref()
                .map(|qname| metamodel.is_subtype_of(qname, "Object"))
                .unwrap_or(false)
            {
                let sub_objects = collect_contained_object_qnames(
                    input.project_db,
                    input.project_ws,
                    input.stdlib_index,
                    &ref_to_qname,
                    &metamodel,
                    &type_info_by_element,
                    element,
                );
                if !sub_objects.is_empty() {
                    attributes.insert("subObjects".to_string(), sub_objects.join(", "));
                }
            }

            let (start_line, start_col, end_line, end_col) = span_to_line_cols(
                Some(&file_text_content),
                element.span,
            );

            elements.push(SemanticElementView {
                name: element.name.clone(),
                qualified_name: element.qualified_name.clone(),
                metatype_qname,
                file_path: input
                    .project_path_by_file
                    .get(&file_id)
                    .cloned()
                    .unwrap_or_else(|| path_text.clone()),
                start_line,
                start_col,
                end_line,
                end_col,
                attributes,
            });
        }
    }

    SemanticIndex { elements, metamodel }
}

impl SemanticIndex {
    pub fn query(&self, query: &SemanticQuery) -> Vec<SemanticElementView> {
        self.elements
            .iter()
            .filter(|element| self.matches_query(element, query))
            .cloned()
            .collect()
    }

    fn matches_query(&self, element: &SemanticElementView, query: &SemanticQuery) -> bool {
        if let Some(metatype) = query.metatype.as_deref() {
            if !element
                .metatype_qname
                .as_deref()
                .map(|qname| matches_metatype(qname, metatype))
                .unwrap_or(false)
            {
                return false;
            }
        }
        if let Some(base) = query.metatype_is_a.as_deref() {
            let Some(qname) = element.metatype_qname.as_deref() else {
                return false;
            };
            if !self.metamodel.is_subtype_of(qname, base) {
                return false;
            }
        }
        for predicate in &query.predicates {
            let key = normalize_attr_key(&predicate.name);
            let expected = predicate.equals.as_str();
            let found = element.attributes.iter().find(|(name, _)| {
                normalize_attr_key(name) == key
            });
            let Some((_, value)) = found else {
                return false;
            };
            if value != expected {
                return false;
            }
        }
        true
    }
}

fn resolve_element_metatype_qname(
    stdlib_index: &walk::WorkspaceIndex,
    ref_to_qname: &HashMap<walk::TypeRef, String>,
    type_info_by_element: &HashMap<walk::ElementId, walk::TypeInfo>,
    element: &walk::ElementInfo,
) -> Option<String> {
    let metatype_ref = match element.kind {
        SymbolKind::Package => resolve_package_metatype(stdlib_index).0,
        SymbolKind::Comment => resolve_type_ref(stdlib_index, "Comment"),
        _ => {
            let kind_hint = element.kind.display().to_string();
            if let Some(ty) = type_info_by_element.get(&element.id) {
                resolve_project_metatype(stdlib_index, ty, Some(kind_hint.as_str())).0
            } else {
                resolve_type_ref_by_kind_hint(stdlib_index, kind_hint.as_str())
            }
        }
    };
    metatype_ref.and_then(|reference| ref_to_qname.get(&reference).cloned())
}

fn resolve_type_ref_by_kind_hint(
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

fn collect_contained_object_qnames(
    db: &walk::Db,
    ws_files: walk::WorkspaceFiles,
    stdlib_index: &walk::WorkspaceIndex,
    ref_to_qname: &HashMap<walk::TypeRef, String>,
    metamodel: &MetamodelGraph,
    type_info_by_element: &HashMap<walk::ElementId, walk::TypeInfo>,
    element: &walk::ElementInfo,
) -> Vec<String> {
    let root_ref = walk::ElementRef {
        file: element.file,
        id: element.id,
    };
    let mut stack = walk::element_children(db, ws_files, root_ref);
    let mut visited: HashSet<(u32, u32)> = HashSet::new();
    let mut out = Vec::new();
    while let Some(child_ref) = stack.pop() {
        let visit_key = (child_ref.file.0, child_ref.id.0);
        if !visited.insert(visit_key) {
            continue;
        }
        let nested = walk::element_children(db, ws_files, child_ref);
        stack.extend(nested);
        let Some(child) = walk::element_info(db, ws_files, child_ref) else {
            continue;
        };
        let Some(child_metatype_qname) = resolve_element_metatype_qname(
            stdlib_index,
            ref_to_qname,
            type_info_by_element,
            &child,
        ) else {
            continue;
        };
        if !metamodel.is_subtype_of(&child_metatype_qname, "Object") {
            continue;
        }
        if !child.qualified_name.is_empty() {
            out.push(child.qualified_name);
        } else if !child.name.is_empty() {
            out.push(child.name);
        }
    }
    out.sort();
    out.dedup();
    out
}

struct MetamodelGraph {
    supertypes: HashMap<String, Vec<String>>,
}

impl MetamodelGraph {
    fn new(index: &walk::WorkspaceIndex) -> Self {
        let mut supertypes = HashMap::new();
        for ty in &index.types {
            supertypes.insert(ty.qualified_name.clone(), ty.supertypes.clone());
        }
        Self { supertypes }
    }

    fn is_subtype_of(&self, qname: &str, target: &str) -> bool {
        if matches_metatype(qname, target) {
            return true;
        }
        let mut stack = vec![qname.to_string()];
        let mut seen = HashMap::new();
        while let Some(current) = stack.pop() {
            if seen.insert(current.clone(), true).is_some() {
                continue;
            }
            if matches_metatype(&current, target) {
                return true;
            }
            if let Some(supers) = self.supertypes.get(&current) {
                for super_name in supers {
                    stack.push(super_name.clone());
                }
            }
        }
        false
    }
}

struct FileSemanticIndex {
    short_name_by_start: HashMap<u32, String>,
    comment_body_by_start: HashMap<u32, String>,
}

struct ImpliedRule {
    base_metatype: &'static str,
    attribute: &'static str,
    extractor: fn(&FileSemanticIndex, &walk::ElementInfo) -> Option<String>,
}

const IMPLIED_RULES: &[ImpliedRule] = &[
    // Element (and subtypes) imply a short name via the AST/HIR identification.
    ImpliedRule {
        base_metatype: "Element",
        attribute: "short_name",
        extractor: FileSemanticIndex::short_name_for,
    },
    // Comment (and subtypes) imply a body via the block comment payload.
    ImpliedRule {
        base_metatype: "Comment",
        attribute: "body",
        extractor: FileSemanticIndex::comment_body_for,
    },
];

impl FileSemanticIndex {
    fn new(syntax: &SyntaxFile) -> Self {
        let mut short_name_by_start = HashMap::new();
        let mut comment_body_by_start = HashMap::new();
        let root = syntax.parse().syntax();

        for name in root.descendants().filter_map(Name::cast) {
            if let Some(short) = name.short_name().and_then(|sn| sn.text()) {
                if let Some(start) = name_token_start(&name) {
                    short_name_by_start.insert(start, short);
                }
            }
        }

        for comment in root.descendants().filter_map(Comment::cast) {
            if let Some(start) = node_start(&comment.syntax()) {
                if let Some(body) = comment_body_from_node(&comment) {
                    comment_body_by_start.insert(start, body);
                }
            }
        }

        Self {
            short_name_by_start,
            comment_body_by_start,
        }
    }

    fn short_name_for(&self, element: &walk::ElementInfo) -> Option<String> {
        self.short_name_by_start
            .get(&element.name_span.start)
            .cloned()
    }

    fn comment_body_for(&self, element: &walk::ElementInfo) -> Option<String> {
        self.comment_body_by_start
            .get(&element.span.start)
            .cloned()
    }
}

fn build_ref_to_qname(index: &walk::WorkspaceIndex) -> HashMap<walk::TypeRef, String> {
    let mut ref_to_qname = HashMap::new();
    for (qname, tref) in &index.type_by_qname {
        ref_to_qname.insert(*tref, qname.clone());
    }
    ref_to_qname
}

fn matches_metatype(metatype_qname: &str, query: &str) -> bool {
    if metatype_qname == query {
        return true;
    }
    metatype_qname
        .rsplit("::")
        .next()
        .map(|tail| tail == query)
        .unwrap_or(false)
}

fn normalize_attr_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

fn name_token_start(name: &Name) -> Option<u32> {
    for child in name.syntax().children_with_tokens() {
        let Some(token) = child.into_token() else {
            continue;
        };
        if is_name_token_kind(token.kind()) {
            return Some(u32::from(token.text_range().start()));
        }
    }
    None
}

fn is_name_token_kind(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::IDENT
            | SyntaxKind::START_KW
            | SyntaxKind::END_KW
            | SyntaxKind::DONE_KW
            | SyntaxKind::THIS_KW
            | SyntaxKind::MEMBER_KW
            | SyntaxKind::FRAME_KW
    )
}

fn node_start(node: &SyntaxNode) -> Option<u32> {
    Some(u32::from(node.text_range().start()))
}

fn comment_body_from_node(comment: &Comment) -> Option<String> {
    let token = comment
        .syntax()
        .descendants_with_tokens()
        .filter_map(|child| child.into_token())
        .find(|token| token.kind() == SyntaxKind::BLOCK_COMMENT)?;
    Some(strip_block_comment(token.text()))
}

fn strip_block_comment(text: &str) -> String {
    let trimmed = text.trim();
    let without_open = trimmed.strip_prefix("/*").unwrap_or(trimmed);
    let without_close = without_open.strip_suffix("*/").unwrap_or(without_open);
    without_close.trim().to_string()
}
