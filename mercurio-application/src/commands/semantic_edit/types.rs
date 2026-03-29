use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticEditFieldType {
    Text,
    Textarea,
    Checkbox,
    #[allow(dead_code)]
    Select,
    Readonly,
}

#[derive(Debug, Clone, Serialize)]
pub struct SemanticEditFieldOptionView {
    pub value: &'static str,
    pub label: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct SemanticEditFieldView {
    pub key: &'static str,
    pub label: &'static str,
    pub field_type: SemanticEditFieldType,
    pub required: bool,
    pub placeholder: Option<&'static str>,
    pub description: Option<&'static str>,
    pub default_text: Option<&'static str>,
    pub default_bool: Option<bool>,
    pub options: &'static [SemanticEditFieldOptionView],
}

#[derive(Debug, Clone, Serialize)]
pub struct SemanticEditActionView {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub applies_to: Vec<SemanticEditAppliesToView>,
    pub fields: Vec<SemanticEditFieldView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SemanticEditAppliesToView {
    pub type_name: &'static str,
    pub include_subtypes: bool,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct SemanticEditTargetPayload {
    pub symbol_id: Option<String>,
    pub qualified_name: String,
    pub name: String,
    pub kind: String,
    pub metatype_qname: Option<String>,
    pub metatype_lineage: Option<Vec<String>>,
    pub metatype_supertypes: Option<Vec<String>>,
    pub file_path: String,
    pub parent_qualified_name: Option<String>,
    pub start_line: Option<u32>,
    pub start_col: Option<u32>,
    pub end_line: Option<u32>,
    pub end_col: Option<u32>,
    pub short_name_start_line: Option<u32>,
    pub short_name_start_col: Option<u32>,
    pub short_name_end_line: Option<u32>,
    pub short_name_end_col: Option<u32>,
    pub source_scope: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ListSemanticEditActionsPayload {
    pub target: SemanticEditTargetPayload,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PreviewSemanticEditPayload {
    pub root: String,
    pub target: SemanticEditTargetPayload,
    pub action_id: String,
    pub input: Value,
    pub current_text: String,
    pub conflict_policy: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ApplySemanticEditPayload {
    pub root: String,
    pub target: SemanticEditTargetPayload,
    pub action_id: String,
    pub input: Value,
    pub current_text: String,
    pub conflict_policy: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SemanticEditPreviewResult {
    pub action_id: String,
    pub action_label: String,
    pub changed: bool,
    pub diff: String,
    pub updated_text: String,
    pub diagnostics: Vec<String>,
    pub skipped_ops: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SemanticEditApplyResult {
    pub action_id: String,
    pub action_label: String,
    pub changed: bool,
    pub updated_text: String,
    pub diagnostics: Vec<String>,
    pub skipped_ops: usize,
    pub file_path: String,
}
