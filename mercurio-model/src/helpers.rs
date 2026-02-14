use syster::base::{LineCol, LineIndex, TextSize};
use syster::hir::{HirSymbol, RefKind, SymbolKind, TypeRefKind};

use crate::{
    attr_info, AttrRef, FileId, FilePath, FileText, Span, SymbolStub, TypeRef, WorkspaceFiles,
    WorkspaceIndex,
};

pub(crate) fn span_from_symbol(symbol: &SymbolStub, line_index: &LineIndex) -> Span {
    let start = line_index
        .offset(LineCol::new(symbol.start_line, symbol.start_col))
        .unwrap_or(TextSize::from(0));
    let end = line_index
        .offset(LineCol::new(symbol.end_line, symbol.end_col))
        .unwrap_or(start);
    Span {
        start: start.into(),
        end: end.into(),
    }
}

pub(crate) fn symbol_to_stub(symbol: HirSymbol) -> SymbolStub {
    let declared_type = declared_type_from_symbol(&symbol);
    let declared_supertypes = declared_supertypes_from_symbol(&symbol);
    SymbolStub {
        name: symbol.name.as_ref().to_string(),
        qualified_name: symbol.qualified_name.as_ref().to_string(),
        kind: symbol.kind,
        start_line: symbol.start_line,
        start_col: symbol.start_col,
        end_line: symbol.end_line,
        end_col: symbol.end_col,
        declared_supertypes,
        supertypes: symbol
            .supertypes
            .into_iter()
            .map(|s| s.to_string())
            .collect(),
        declared_type,
        is_public: symbol.is_public,
        is_abstract: symbol.is_abstract,
        is_variation: symbol.is_variation,
        is_readonly: symbol.is_readonly,
        is_derived: symbol.is_derived,
        is_parallel: symbol.is_parallel,
        direction: symbol.direction,
        multiplicity: symbol.multiplicity,
    }
}

fn declared_supertypes_from_symbol(symbol: &HirSymbol) -> Vec<String> {
    let mut out: Vec<String> = symbol
        .type_refs
        .iter()
        .flat_map(|type_ref| type_ref.as_refs().into_iter())
        .filter(|reference| reference.kind == RefKind::Specializes)
        .map(|reference| reference.effective_target().as_ref().to_string())
        .collect();
    out.sort();
    out.dedup();
    out
}

fn declared_type_from_symbol(symbol: &HirSymbol) -> Option<String> {
    let typed = symbol
        .type_refs
        .iter()
        .find_map(|type_ref| pick_type_ref(type_ref, RefKind::TypedBy));
    if typed.is_some() {
        return typed;
    }
    symbol
        .type_refs
        .iter()
        .find_map(|type_ref| pick_type_ref(type_ref, RefKind::Specializes))
}

fn pick_type_ref(type_ref: &TypeRefKind, kind: RefKind) -> Option<String> {
    type_ref
        .as_refs()
        .into_iter()
        .find(|reference| reference.kind == kind)
        .map(|reference| reference.effective_target().as_ref().to_string())
}

pub(crate) fn find_name_span(text: &str, span: &Span, name: &str) -> Span {
    let start = span.start as usize;
    let end = span.end as usize;
    if start >= end || end > text.len() {
        return *span;
    }
    let slice = &text[start..end];
    if let Some(rel) = slice.find(name) {
        let abs = start + rel;
        return Span {
            start: abs as u32,
            end: (abs + name.len()) as u32,
        };
    }
    *span
}

pub(crate) fn parent_scope(qualified: &str) -> Option<&str> {
    if let Some((parent, _)) = qualified.rsplit_once("::") {
        if parent.is_empty() {
            None
        } else {
            Some(parent)
        }
    } else {
        None
    }
}

pub(crate) fn is_type_kind(kind: SymbolKind) -> bool {
    matches!(
        kind,
        SymbolKind::Package
            | SymbolKind::PartDefinition
            | SymbolKind::ItemDefinition
            | SymbolKind::ActionDefinition
            | SymbolKind::PortDefinition
            | SymbolKind::AttributeDefinition
            | SymbolKind::ConnectionDefinition
            | SymbolKind::InterfaceDefinition
            | SymbolKind::AllocationDefinition
            | SymbolKind::RequirementDefinition
            | SymbolKind::ConstraintDefinition
            | SymbolKind::StateDefinition
            | SymbolKind::CalculationDefinition
            | SymbolKind::UseCaseDefinition
            | SymbolKind::AnalysisCaseDefinition
            | SymbolKind::ConcernDefinition
            | SymbolKind::ViewDefinition
            | SymbolKind::ViewpointDefinition
            | SymbolKind::RenderingDefinition
            | SymbolKind::EnumerationDefinition
            | SymbolKind::MetadataDefinition
            | SymbolKind::Interaction
            | SymbolKind::DataType
            | SymbolKind::Class
            | SymbolKind::Structure
            | SymbolKind::Behavior
            | SymbolKind::Function
            | SymbolKind::Association
    )
}

pub(crate) fn is_attribute_kind(kind: SymbolKind) -> bool {
    matches!(
        kind,
        SymbolKind::AttributeDefinition | SymbolKind::AttributeUsage
    )
}

pub(crate) fn find_insert_before_closing_brace(text: &str) -> Option<usize> {
    let mut depth = 0i32;
    let mut last_close = None;
    for (idx, ch) in text.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    last_close = Some(idx);
                }
            }
            _ => {}
        }
    }
    last_close
}

pub(crate) fn resolve_type(index: &WorkspaceIndex, name: &str) -> Option<TypeRef> {
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

pub(crate) fn find_file_inputs(
    db: &dyn salsa::Database,
    ws_files: WorkspaceFiles,
    file_id: FileId,
) -> Option<(FileText, FilePath)> {
    let files = ws_files.files(db);
    let paths = ws_files.paths(db);
    for (file_text, file_path) in files.iter().copied().zip(paths.iter().copied()) {
        if file_text.file(db) == file_id {
            return Some((file_text, file_path));
        }
    }
    None
}

fn type_sort_key(
    db: &dyn salsa::Database,
    ws_files: WorkspaceFiles,
    ty: TypeRef,
) -> (String, u32, u32) {
    let info = crate::type_info(db, ws_files, ty);
    match info {
        Some(info) => (info.qualified_name, ty.element.file.0, ty.element.id.0),
        None => ("".to_string(), ty.element.file.0, ty.element.id.0),
    }
}

pub(crate) fn sort_types(
    db: &dyn salsa::Database,
    ws_files: WorkspaceFiles,
    types: &mut Vec<TypeRef>,
) {
    types.sort_by(|a, b| type_sort_key(db, ws_files, *a).cmp(&type_sort_key(db, ws_files, *b)));
}

fn attr_sort_key(
    db: &dyn salsa::Database,
    ws_files: WorkspaceFiles,
    attr: AttrRef,
) -> (String, u32, u32) {
    let info = attr_info(db, ws_files, attr);
    match info {
        Some(info) => (info.qualified_name, attr.element.file.0, attr.element.id.0),
        None => ("".to_string(), attr.element.file.0, attr.element.id.0),
    }
}

pub(crate) fn sort_attrs(
    db: &dyn salsa::Database,
    ws_files: WorkspaceFiles,
    attrs: &mut Vec<AttrRef>,
) {
    attrs.sort_by(|a, b| attr_sort_key(db, ws_files, *a).cmp(&attr_sort_key(db, ws_files, *b)));
}

pub(crate) fn guess_indent(text: &str, insert_at: usize) -> String {
    let mut indent = String::new();
    let line_start = text[..insert_at].rfind('\n').map(|i| i + 1).unwrap_or(0);
    for ch in text[line_start..insert_at].chars() {
        if ch == ' ' || ch == '\t' {
            indent.push(ch);
        } else {
            break;
        }
    }
    if indent.is_empty() {
        "  ".to_string()
    } else {
        indent
    }
}
