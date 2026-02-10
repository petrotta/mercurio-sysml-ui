use salsa;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use syster::base::{LineCol, LineIndex, TextSize};
use syster::hir::{extract_symbols_unified, HirSymbol, SymbolKind, RefKind, TypeRefKind};
use syster::parser::Direction;
use syster::syntax::{SyntaxFile};
use syster::syntax::normalized::Multiplicity;
use syster::syntax::file::FileExtension;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FileId(pub u32);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WorkspaceId(pub u32);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ElementId(pub u32);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Span {
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplaceSpan {
    pub file: FileId,
    pub span: Span,
    pub replacement: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ElementRef {
    pub file: FileId,
    pub id: ElementId,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TypeRef {
    pub element: ElementRef,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AttrRef {
    pub element: ElementRef,
}

impl ElementRef {
    pub fn info(self, db: &dyn salsa::Database, ws_files: WorkspaceFiles) -> Option<ElementInfo> {
        element_info(db, ws_files, self)
    }

    pub fn parent(self, db: &dyn salsa::Database, ws_files: WorkspaceFiles) -> Option<ElementRef> {
        element_parent(db, ws_files, self)
    }

    pub fn children(self, db: &dyn salsa::Database, ws_files: WorkspaceFiles) -> Vec<ElementRef> {
        element_children(db, ws_files, self)
    }
}

impl TypeRef {
    pub fn info(self, db: &dyn salsa::Database, ws_files: WorkspaceFiles) -> Option<TypeInfo> {
        type_info(db, ws_files, self)
    }

    pub fn supertypes(self, db: &dyn salsa::Database, ws_files: WorkspaceFiles) -> Vec<TypeRef> {
        type_supertypes(db, ws_files, self)
    }

    pub fn subtypes(self, db: &dyn salsa::Database, ws_files: WorkspaceFiles) -> Vec<TypeRef> {
        type_subtypes(db, ws_files, self)
    }

    pub fn owned_attributes(self, db: &dyn salsa::Database, ws_files: WorkspaceFiles) -> Arc<Vec<AttrRef>> {
        owned_attributes(db, ws_files, self)
    }

    pub fn all_attributes(self, db: &dyn salsa::Database, ws_files: WorkspaceFiles) -> Arc<Vec<AttrRef>> {
        all_attributes(db, ws_files, self)
    }
}

impl AttrRef {
    pub fn info(self, db: &dyn salsa::Database, ws_files: WorkspaceFiles) -> Option<AttrInfo> {
        attr_info(db, ws_files, self)
    }
}

#[salsa::input]
pub struct FileText {
    pub file: FileId,
    #[return_ref]
    pub text: String,
}

#[salsa::input]
pub struct FilePath {
    pub file: FileId,
    #[return_ref]
    pub path: String,
}

#[salsa::input]
pub struct WorkspaceFiles {
    pub ws: WorkspaceId,
    #[return_ref]
    pub files: Vec<FileText>,
    #[return_ref]
    pub paths: Vec<FilePath>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Parsed {
    pub symbols: Vec<SymbolStub>,
    pub diagnostics: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SymbolStub {
    pub name: String,
    pub qualified_name: String,
    pub kind: SymbolKind,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub supertypes: Vec<String>,
    pub declared_type: Option<String>,
    pub is_public: bool,
    pub is_abstract: bool,
    pub is_variation: bool,
    pub is_readonly: bool,
    pub is_derived: bool,
    pub is_parallel: bool,
    pub direction: Option<Direction>,
    pub multiplicity: Option<Multiplicity>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ElementInfo {
    pub id: ElementId,
    pub file: FileId,
    pub name: String,
    pub qualified_name: String,
    pub kind: SymbolKind,
    pub span: Span,
    pub name_span: Span,
    pub parent: Option<ElementId>,
    pub declared_type: Option<String>,
    pub is_public: bool,
    pub is_abstract: bool,
    pub is_variation: bool,
    pub is_readonly: bool,
    pub is_derived: bool,
    pub is_parallel: bool,
    pub direction: Option<Direction>,
    pub multiplicity: Option<Multiplicity>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TypeInfo {
    pub element: ElementId,
    pub name: String,
    pub qualified_name: String,
    pub supertypes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttrInfo {
    pub element: ElementId,
    pub name: String,
    pub qualified_name: String,
    pub declared_type: Option<String>,
    pub is_public: bool,
    pub is_abstract: bool,
    pub is_variation: bool,
    pub is_readonly: bool,
    pub is_derived: bool,
    pub is_parallel: bool,
    pub direction: Option<Direction>,
    pub multiplicity: Option<Multiplicity>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileIndex {
    pub elements: Vec<ElementInfo>,
    pub children: Vec<Vec<ElementId>>, // index by ElementId
    pub types: Vec<TypeInfo>,
    pub attrs: Vec<AttrInfo>,
    pub owned_attrs: HashMap<ElementId, Vec<ElementId>>, // type element -> attr element
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceIndex {
    pub types: Vec<TypeInfo>,
    pub attrs: Vec<AttrInfo>,
    pub type_by_qname: HashMap<String, TypeRef>,
    pub type_by_name: HashMap<String, Vec<TypeRef>>,
    pub subtypes: HashMap<TypeRef, Vec<TypeRef>>,
    pub owned_attrs: HashMap<TypeRef, Vec<AttrRef>>,
}

#[salsa::db]
#[derive(Default, Clone)]
pub struct Db {
    storage: salsa::Storage<Self>,
}

#[salsa::db]
impl salsa::Database for Db {
    fn salsa_event(&self, _event: &dyn Fn() -> salsa::Event) {}
}

#[salsa::tracked]
pub fn parse_file(db: &dyn salsa::Database, file_text: FileText, file_path: FilePath) -> Parsed {
    let text = file_text.text(db);
    let path = file_path.path(db);
    let ext = if path.to_lowercase().ends_with(".kerml") {
        FileExtension::KerML
    } else {
        FileExtension::SysML
    };
    let syntax_file = SyntaxFile::new(text, ext);
    let symbols = extract_symbols_unified(syster::base::FileId::new(file_text.file(db).0), &syntax_file)
        .into_iter()
        .map(symbol_to_stub)
        .collect();
    Parsed {
        symbols,
        diagnostics: Vec::new(),
    }
}

#[salsa::tracked]
pub fn file_index(db: &dyn salsa::Database, file_text: FileText, file_path: FilePath) -> Arc<FileIndex> {
    let parsed = parse_file(db, file_text, file_path);
    let text = file_text.text(db);
    let line_index = LineIndex::new(text);
    let mut elements: Vec<ElementInfo> = Vec::new();
    let mut qname_to_id: HashMap<String, ElementId> = HashMap::new();

    for symbol in parsed.symbols.iter() {
        let id = ElementId(elements.len() as u32);
        let span = span_from_symbol(symbol, &line_index);
        let name_span = find_name_span(text, &span, symbol.name.as_ref());
        let qualified_name = symbol.qualified_name.to_string();
        let info = ElementInfo {
            id,
            file: file_text.file(db),
            name: symbol.name.to_string(),
            qualified_name: qualified_name.clone(),
            kind: symbol.kind,
            span,
            name_span,
            parent: None,
            declared_type: symbol.declared_type.clone(),
            is_public: symbol.is_public,
            is_abstract: symbol.is_abstract,
            is_variation: symbol.is_variation,
            is_readonly: symbol.is_readonly,
            is_derived: symbol.is_derived,
            is_parallel: symbol.is_parallel,
            direction: symbol.direction,
            multiplicity: symbol.multiplicity,
        };
        qname_to_id.insert(qualified_name, id);
        elements.push(info);
    }

    for element in elements.iter_mut() {
        if let Some(parent_qname) = parent_scope(&element.qualified_name) {
            if let Some(parent_id) = qname_to_id.get(parent_qname) {
                element.parent = Some(*parent_id);
            }
        }
    }

    let mut children: Vec<Vec<ElementId>> = vec![Vec::new(); elements.len()];
    for element in &elements {
        if let Some(parent) = element.parent {
            if let Some(bucket) = children.get_mut(parent.0 as usize) {
                bucket.push(element.id);
            }
        }
    }

    let mut types = Vec::new();
    let mut attrs = Vec::new();
    let mut owned_attrs: HashMap<ElementId, Vec<ElementId>> = HashMap::new();

    for element in &elements {
        if is_type_kind(element.kind) {
            if let Some(symbol) = parsed.symbols.get(element.id.0 as usize) {
                types.push(TypeInfo {
                    element: element.id,
                    name: element.name.clone(),
                    qualified_name: element.qualified_name.clone(),
                    supertypes: symbol.supertypes.clone(),
                });
            }
        }
        if is_attribute_kind(element.kind) {
            let symbol = parsed.symbols.get(element.id.0 as usize);
            attrs.push(AttrInfo {
                element: element.id,
                name: element.name.clone(),
                qualified_name: element.qualified_name.clone(),
                declared_type: symbol.and_then(|item| item.declared_type.clone()),
                is_public: symbol.map(|item| item.is_public).unwrap_or(false),
                is_abstract: symbol.map(|item| item.is_abstract).unwrap_or(false),
                is_variation: symbol.map(|item| item.is_variation).unwrap_or(false),
                is_readonly: symbol.map(|item| item.is_readonly).unwrap_or(false),
                is_derived: symbol.map(|item| item.is_derived).unwrap_or(false),
                is_parallel: symbol.map(|item| item.is_parallel).unwrap_or(false),
                direction: symbol.and_then(|item| item.direction),
                multiplicity: symbol.and_then(|item| item.multiplicity),
            });
        }
    }

    for attr in &attrs {
        if let Some(element) = elements.get(attr.element.0 as usize) {
            if let Some(parent) = element.parent {
                owned_attrs.entry(parent).or_default().push(attr.element);
            }
        }
    }

    Arc::new(FileIndex {
        elements,
        children,
        types,
        attrs,
        owned_attrs,
    })
}

#[salsa::tracked]
pub fn workspace_index(db: &dyn salsa::Database, ws_files: WorkspaceFiles) -> Arc<WorkspaceIndex> {
    let mut types: Vec<TypeInfo> = Vec::new();
    let mut attrs: Vec<AttrInfo> = Vec::new();
    let mut type_by_qname: HashMap<String, TypeRef> = HashMap::new();
    let mut type_by_name: HashMap<String, Vec<TypeRef>> = HashMap::new();
    let mut owned_attrs: HashMap<TypeRef, Vec<AttrRef>> = HashMap::new();
    let files = ws_files.files(db);
    let paths = ws_files.paths(db);
    for (file_text, file_path) in files.iter().copied().zip(paths.iter().copied()) {
        let file = file_text.file(db);
        let index = file_index(db, file_text, file_path);
        for ty in &index.types {
            let tref = TypeRef {
                element: ElementRef { file, id: ty.element },
            };
            type_by_qname.insert(ty.qualified_name.clone(), tref);
            type_by_name.entry(ty.name.clone()).or_default().push(tref);
            types.push(ty.clone());
        }
        for attr in &index.attrs {
            attrs.push(attr.clone());
            if let Some(parent) = index
                .elements
                .get(attr.element.0 as usize)
                .and_then(|el| el.parent)
            {
                let owner = TypeRef {
                    element: ElementRef { file, id: parent },
                };
                owned_attrs.entry(owner).or_default().push(AttrRef {
                    element: ElementRef { file, id: attr.element },
                });
            }
        }
    }

    let mut subtypes: HashMap<TypeRef, Vec<TypeRef>> = HashMap::new();
    for ty in &types {
        let this = type_by_qname.get(&ty.qualified_name).copied();
        let Some(this_ref) = this else { continue };
        for super_name in &ty.supertypes {
            let resolved = type_by_qname
                .get(super_name)
                .copied()
                .or_else(|| {
                    type_by_name.get(super_name).and_then(|list| {
                        if list.len() == 1 { list.first().copied() } else { None }
                    })
                });
            if let Some(super_ref) = resolved {
                subtypes.entry(super_ref).or_default().push(this_ref);
            }
        }
    }

    Arc::new(WorkspaceIndex {
        types,
        attrs,
        type_by_qname,
        type_by_name,
        subtypes,
        owned_attrs,
    })
}

#[salsa::tracked]
pub fn derived_types(db: &dyn salsa::Database, ws_files: WorkspaceFiles, base: TypeRef) -> Arc<Vec<TypeRef>> {
    let index = workspace_index(db, ws_files);
    let mut out = Vec::new();
    let mut stack = Vec::new();
    let mut seen: HashSet<TypeRef> = HashSet::new();
    stack.push(base);
    while let Some(current) = stack.pop() {
        if !seen.insert(current) {
            continue;
        }
        if let Some(children) = index.subtypes.get(&current) {
            for &child in children {
                out.push(child);
                stack.push(child);
            }
        }
    }
    sort_types(db, ws_files, &mut out);
    Arc::new(out)
}

#[salsa::tracked]
pub fn owned_attributes(db: &dyn salsa::Database, ws_files: WorkspaceFiles, ty: TypeRef) -> Arc<Vec<AttrRef>> {
    let index = workspace_index(db, ws_files);
    let attrs = index.owned_attrs.get(&ty).cloned().unwrap_or_default();
    let mut out = attrs;
    sort_attrs(db, ws_files, &mut out);
    Arc::new(out)
}

#[salsa::tracked]
pub fn all_attributes(db: &dyn salsa::Database, ws_files: WorkspaceFiles, ty: TypeRef) -> Arc<Vec<AttrRef>> {
    let index = workspace_index(db, ws_files);
    let mut out = Vec::new();
    let mut visited: HashSet<TypeRef> = HashSet::new();
    let mut stack = vec![ty];
    while let Some(current) = stack.pop() {
        if !visited.insert(current) {
            continue;
        }
        if let Some(attrs) = index.owned_attrs.get(&current) {
            out.extend(attrs.iter().copied());
        }
        for (super_ref, subs) in &index.subtypes {
            if subs.contains(&current) {
                stack.push(*super_ref);
            }
        }
    }
    sort_attrs(db, ws_files, &mut out);
    Arc::new(out)
}

pub fn element_info(db: &dyn salsa::Database, ws_files: WorkspaceFiles, element: ElementRef) -> Option<ElementInfo> {
    let (file_text, file_path) = find_file_inputs(db, ws_files, element.file)?;
    let file_index = file_index(db, file_text, file_path);
    file_index.elements.get(element.id.0 as usize).cloned()
}

pub fn element_parent(db: &dyn salsa::Database, ws_files: WorkspaceFiles, element: ElementRef) -> Option<ElementRef> {
    let info = element_info(db, ws_files, element)?;
    info.parent.map(|parent| ElementRef {
        file: element.file,
        id: parent,
    })
}

pub fn element_children(db: &dyn salsa::Database, ws_files: WorkspaceFiles, element: ElementRef) -> Vec<ElementRef> {
    let (file_text, file_path) = match find_file_inputs(db, ws_files, element.file) {
        Some(inputs) => inputs,
        None => return Vec::new(),
    };
    let file_index = file_index(db, file_text, file_path);
    match file_index.children.get(element.id.0 as usize) {
        Some(children) => children
            .iter()
            .copied()
            .map(|id| ElementRef { file: element.file, id })
            .collect(),
        None => Vec::new(),
    }
}

pub fn type_info(db: &dyn salsa::Database, ws_files: WorkspaceFiles, ty: TypeRef) -> Option<TypeInfo> {
    let element = element_info(db, ws_files, ty.element)?;
    let index = workspace_index(db, ws_files);
    index
        .types
        .iter()
        .find(|info| info.element == element.id && info.qualified_name == element.qualified_name)
        .cloned()
}

pub fn attr_info(db: &dyn salsa::Database, ws_files: WorkspaceFiles, attr: AttrRef) -> Option<AttrInfo> {
    let element = element_info(db, ws_files, attr.element)?;
    let index = workspace_index(db, ws_files);
    index
        .attrs
        .iter()
        .find(|info| info.element == element.id && info.qualified_name == element.qualified_name)
        .cloned()
}

pub fn type_supertypes(db: &dyn salsa::Database, ws_files: WorkspaceFiles, ty: TypeRef) -> Vec<TypeRef> {
    let Some(info) = type_info(db, ws_files, ty) else { return Vec::new() };
    let index = workspace_index(db, ws_files);
    info.supertypes
        .iter()
        .filter_map(|name| resolve_type(&index, name))
        .collect()
}

pub fn type_subtypes(db: &dyn salsa::Database, ws_files: WorkspaceFiles, ty: TypeRef) -> Vec<TypeRef> {
    let index = workspace_index(db, ws_files);
    let mut out = index.subtypes.get(&ty).cloned().unwrap_or_default();
    sort_types(db, ws_files, &mut out);
    out
}

pub fn rename_element_patch(_text: &str, element: &ElementInfo, new_name: &str) -> ReplaceSpan {
    ReplaceSpan {
        file: element.file,
        span: element.name_span,
        replacement: new_name.to_string(),
    }
}

pub fn delete_attribute_patch(_text: &str, element: &ElementInfo) -> ReplaceSpan {
    ReplaceSpan {
        file: element.file,
        span: element.span,
        replacement: "".to_string(),
    }
}

pub fn add_attribute_patch(text: &str, element: &ElementInfo, attribute_text: &str) -> Option<ReplaceSpan> {
    let span = element.span;
    let start = span.start as usize;
    let end = span.end as usize;
    if start >= end || end > text.len() {
        return None;
    }
    let slice = &text[start..end];
    if let Some(insert_offset) = find_insert_before_closing_brace(slice) {
        let absolute = start + insert_offset;
        let indent = guess_indent(text, absolute);
        return Some(ReplaceSpan {
            file: element.file,
            span: Span { start: absolute as u32, end: absolute as u32 },
            replacement: format!("\n{}{}", indent, attribute_text.trim()),
        });
    }
    None
}

pub fn apply_patch(text: &str, patch: &ReplaceSpan) -> String {
    let start = patch.span.start as usize;
    let end = patch.span.end as usize;
    let mut out = String::with_capacity(text.len() + patch.replacement.len());
    out.push_str(&text[..start]);
    out.push_str(&patch.replacement);
    out.push_str(&text[end..]);
    out
}

fn span_from_symbol(symbol: &SymbolStub, line_index: &LineIndex) -> Span {
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

fn symbol_to_stub(symbol: HirSymbol) -> SymbolStub {
    let declared_type = declared_type_from_symbol(&symbol);
    SymbolStub {
        name: symbol.name.as_ref().to_string(),
        qualified_name: symbol.qualified_name.as_ref().to_string(),
        kind: symbol.kind,
        start_line: symbol.start_line,
        start_col: symbol.start_col,
        end_line: symbol.end_line,
        end_col: symbol.end_col,
        supertypes: symbol.supertypes.into_iter().map(|s| s.to_string()).collect(),
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

fn find_name_span(text: &str, span: &Span, name: &str) -> Span {
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

fn parent_scope(qualified: &str) -> Option<&str> {
    if let Some((parent, _)) = qualified.rsplit_once("::") {
        if parent.is_empty() { None } else { Some(parent) }
    } else {
        None
    }
}

fn is_type_kind(kind: SymbolKind) -> bool {
    matches!(
        kind,
        SymbolKind::PartDef
            | SymbolKind::ItemDef
            | SymbolKind::ActionDef
            | SymbolKind::PortDef
            | SymbolKind::AttributeDef
            | SymbolKind::ConnectionDef
            | SymbolKind::InterfaceDef
            | SymbolKind::AllocationDef
            | SymbolKind::RequirementDef
            | SymbolKind::ConstraintDef
            | SymbolKind::StateDef
            | SymbolKind::CalculationDef
            | SymbolKind::UseCaseDef
            | SymbolKind::AnalysisCaseDef
            | SymbolKind::ConcernDef
            | SymbolKind::ViewDef
            | SymbolKind::ViewpointDef
            | SymbolKind::RenderingDef
    )
}

fn is_attribute_kind(kind: SymbolKind) -> bool {
    matches!(kind, SymbolKind::AttributeDef | SymbolKind::AttributeUsage)
}

fn find_insert_before_closing_brace(text: &str) -> Option<usize> {
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

fn resolve_type(index: &WorkspaceIndex, name: &str) -> Option<TypeRef> {
    index
        .type_by_qname
        .get(name)
        .copied()
        .or_else(|| {
            index.type_by_name.get(name).and_then(|list| {
                if list.len() == 1 { list.first().copied() } else { None }
            })
        })
}

fn find_file_inputs(
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

fn type_sort_key(db: &dyn salsa::Database, ws_files: WorkspaceFiles, ty: TypeRef) -> (String, u32, u32) {
    let info = type_info(db, ws_files, ty);
    match info {
        Some(info) => (info.qualified_name, ty.element.file.0, ty.element.id.0),
        None => ("".to_string(), ty.element.file.0, ty.element.id.0),
    }
}

fn sort_types(db: &dyn salsa::Database, ws_files: WorkspaceFiles, types: &mut Vec<TypeRef>) {
    types.sort_by(|a, b| type_sort_key(db, ws_files, *a).cmp(&type_sort_key(db, ws_files, *b)));
}

fn attr_sort_key(db: &dyn salsa::Database, ws_files: WorkspaceFiles, attr: AttrRef) -> (String, u32, u32) {
    let info = attr_info(db, ws_files, attr);
    match info {
        Some(info) => (info.qualified_name, attr.element.file.0, attr.element.id.0),
        None => ("".to_string(), attr.element.file.0, attr.element.id.0),
    }
}

fn sort_attrs(db: &dyn salsa::Database, ws_files: WorkspaceFiles, attrs: &mut Vec<AttrRef>) {
    attrs.sort_by(|a, b| attr_sort_key(db, ws_files, *a).cmp(&attr_sort_key(db, ws_files, *b)));
}

fn guess_indent(text: &str, insert_at: usize) -> String {
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

