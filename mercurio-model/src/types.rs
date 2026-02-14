use salsa;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use syster::hir::SymbolKind;
use syster::parser::Direction;
use syster::syntax::normalized::Multiplicity;

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
    pub fn info(
        self,
        db: &dyn salsa::Database,
        ws_files: crate::WorkspaceFiles,
    ) -> Option<ElementInfo> {
        crate::element_info(db, ws_files, self)
    }

    pub fn parent(
        self,
        db: &dyn salsa::Database,
        ws_files: crate::WorkspaceFiles,
    ) -> Option<ElementRef> {
        crate::element_parent(db, ws_files, self)
    }

    pub fn children(
        self,
        db: &dyn salsa::Database,
        ws_files: crate::WorkspaceFiles,
    ) -> Vec<ElementRef> {
        crate::element_children(db, ws_files, self)
    }
}

impl TypeRef {
    pub fn info(
        self,
        db: &dyn salsa::Database,
        ws_files: crate::WorkspaceFiles,
    ) -> Option<TypeInfo> {
        crate::type_info(db, ws_files, self)
    }

    pub fn supertypes(
        self,
        db: &dyn salsa::Database,
        ws_files: crate::WorkspaceFiles,
    ) -> Vec<TypeRef> {
        crate::type_supertypes(db, ws_files, self)
    }

    pub fn subtypes(
        self,
        db: &dyn salsa::Database,
        ws_files: crate::WorkspaceFiles,
    ) -> Vec<TypeRef> {
        crate::type_subtypes(db, ws_files, self)
    }

    pub fn owned_attributes(
        self,
        db: &dyn salsa::Database,
        ws_files: crate::WorkspaceFiles,
    ) -> Arc<Vec<AttrRef>> {
        crate::owned_attributes(db, ws_files, self)
    }

    pub fn all_attributes(
        self,
        db: &dyn salsa::Database,
        ws_files: crate::WorkspaceFiles,
    ) -> Arc<Vec<AttrRef>> {
        crate::all_attributes(db, ws_files, self)
    }
}

impl AttrRef {
    pub fn info(
        self,
        db: &dyn salsa::Database,
        ws_files: crate::WorkspaceFiles,
    ) -> Option<AttrInfo> {
        crate::attr_info(db, ws_files, self)
    }
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
    pub declared_supertypes: Vec<String>,
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
    pub declared_supertypes: Vec<String>,
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
    pub children: Vec<Vec<ElementId>>,
    pub types: Vec<TypeInfo>,
    pub attrs: Vec<AttrInfo>,
    pub owned_attrs: HashMap<ElementId, Vec<ElementId>>,
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
