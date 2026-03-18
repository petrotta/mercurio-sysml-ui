use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub use mercurio_sysml_pkg::parser_tools::{ParseErrorView, ParseErrorsPayload, ParseTreeNodeView};

pub const DIAGRAM_SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct DiagramFile {
    #[serde(default = "default_diagram_version")]
    pub version: u32,
    #[serde(default = "default_diagram_type")]
    pub diagram_type: DiagramType,
    #[serde(default)]
    pub nodes: Vec<DiagramNode>,
    #[serde(default)]
    pub offsets: HashMap<String, DiagramOffset>,
    #[serde(default)]
    pub sizes: HashMap<String, DiagramSize>,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum DiagramType {
    #[default]
    Bdd,
    Ibd,
    Package,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct DiagramNode {
    pub qualified: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct DiagramOffset {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct DiagramSize {
    pub width: f64,
    pub height: f64,
}

pub fn read_diagram(root: &Path, path: &Path) -> Result<DiagramFile, String> {
    let target_path = resolve_under_root(root, path)?;
    if !target_path.exists() {
        return Ok(DiagramFile::default());
    }
    let raw = fs::read_to_string(&target_path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(DiagramFile::default());
    }
    let mut diagram: DiagramFile =
        serde_json::from_str(&raw).map_err(|e| format!("Invalid diagram file: {}", e))?;
    normalize_diagram(&mut diagram);
    Ok(diagram)
}

pub fn write_diagram(root: &Path, path: &Path, diagram: DiagramFile) -> Result<(), String> {
    let target_path = resolve_under_root(root, path)?;
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut normalized = diagram;
    normalize_diagram(&mut normalized);
    let payload = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
    fs::write(target_path, payload).map_err(|e| e.to_string())
}

pub fn get_parse_errors(path: &Path) -> Result<ParseErrorsPayload, String> {
    mercurio_sysml_pkg::parser_tools::get_parse_errors(path)
}

pub fn get_parse_errors_for_content(
    path: &Path,
    content: &str,
) -> Result<ParseErrorsPayload, String> {
    mercurio_sysml_pkg::parser_tools::get_parse_errors_for_content(path, content)
}

pub fn get_ast_for_path(path: &Path) -> Result<String, String> {
    mercurio_sysml_pkg::parser_tools::get_ast_for_path(path)
}

pub fn get_ast_for_content(path: &Path, content: &str) -> Result<String, String> {
    mercurio_sysml_pkg::parser_tools::get_ast_for_content(path, content)
}

pub fn get_parse_tree_for_content(
    path: &Path,
    content: &str,
) -> Result<Vec<ParseTreeNodeView>, String> {
    mercurio_sysml_pkg::parser_tools::get_parse_tree_for_content(path, content)
}

pub fn resolve_under_root(root: &Path, target: &Path) -> Result<PathBuf, String> {
    mercurio_sysml_pkg::workspace_query::resolve_under_root(root, target)
}

fn default_diagram_version() -> u32 {
    DIAGRAM_SCHEMA_VERSION
}

fn default_diagram_type() -> DiagramType {
    DiagramType::Bdd
}

fn normalize_diagram(diagram: &mut DiagramFile) {
    if diagram.version == 0 {
        diagram.version = DIAGRAM_SCHEMA_VERSION;
    }
    for node in &mut diagram.nodes {
        if node.name.trim().is_empty() {
            node.name = node
                .qualified
                .split("::")
                .filter(|segment| !segment.is_empty())
                .last()
                .unwrap_or("Node")
                .to_string();
        }
    }
}
