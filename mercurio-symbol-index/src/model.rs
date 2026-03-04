use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Scope {
    Stdlib,
    Project,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SymbolRecord {
    pub id: String,
    pub project_root: String,
    pub library_key: Option<String>,
    pub scope: Scope,
    pub name: String,
    pub qualified_name: String,
    #[serde(default)]
    pub parent_qualified_name: Option<String>,
    pub kind: String,
    pub metatype_qname: Option<String>,
    pub file_path: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub doc_text: Option<String>,
    pub properties_json: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SymbolMetatypeMappingRecord {
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
