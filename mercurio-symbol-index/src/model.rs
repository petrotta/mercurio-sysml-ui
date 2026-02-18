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
    pub kind: String,
    pub metatype_qname: Option<String>,
    pub file_path: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub doc_text: Option<String>,
}
