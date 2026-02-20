use mercurio_sysml_core::parser::Parser;
use mercurio_sysml_pkg::parse_tree_for_content;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct DiagramFile {
    #[serde(default = "default_diagram_version")]
    pub version: u32,
    #[serde(default)]
    pub nodes: Vec<DiagramNode>,
    #[serde(default)]
    pub offsets: HashMap<String, DiagramOffset>,
    #[serde(default)]
    pub sizes: HashMap<String, DiagramSize>,
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

#[derive(Serialize, Clone)]
pub struct ParseErrorView {
    pub message: String,
    pub line: usize,
    pub column: usize,
    pub kind: String,
}

#[derive(Serialize, Clone)]
pub struct ParseErrorsPayload {
    pub path: String,
    pub errors: Vec<ParseErrorView>,
}

#[derive(Serialize, Clone)]
pub struct ParseTreeNodeView {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub label: String,
    pub start_offset: usize,
    pub end_offset: usize,
    pub start_line: usize,
    pub start_col: usize,
    pub end_line: usize,
    pub end_col: usize,
    pub depth: usize,
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
    if !path.exists() {
        return Err("File does not exist".to_string());
    }
    if !is_model_file(path) {
        return Ok(ParseErrorsPayload {
            path: path.to_string_lossy().to_string(),
            errors: Vec::new(),
        });
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    get_parse_errors_for_content(path, &content)
}

pub fn get_parse_errors_for_content(
    path: &Path,
    content: &str,
) -> Result<ParseErrorsPayload, String> {
    if !is_model_file(path) {
        return Ok(ParseErrorsPayload {
            path: path.to_string_lossy().to_string(),
            errors: Vec::new(),
        });
    }
    let mut parser = Parser::new(content);
    let _ = parser.parse_root();
    let errors = parser
        .errors()
        .iter()
        .map(|err| {
            let (line, col) = offset_to_line_col(content, err.span.start as usize);
            ParseErrorView {
                message: err.message.clone(),
                line,
                column: col,
                kind: "parse".to_string(),
            }
        })
        .collect::<Vec<_>>();
    Ok(ParseErrorsPayload {
        path: path.to_string_lossy().to_string(),
        errors,
    })
}

pub fn get_ast_for_path(path: &Path) -> Result<String, String> {
    if !path.exists() {
        return Err("File does not exist".to_string());
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    get_ast_for_content(path, &content)
}

pub fn get_ast_for_content(path: &Path, content: &str) -> Result<String, String> {
    if !is_model_file(path) {
        return Err("AST is only available for .sysml or .kerml files".to_string());
    }
    let mut parser = Parser::new(content);
    let root = parser.parse_root();
    let mut out = String::new();
    out.push_str("AST (full debug):\n");
    out.push_str(&format!("{:#?}", root));
    if !parser.errors().is_empty() {
        out.push_str("\n\nErrors:\n");
        for err in parser.errors() {
            let (line, col) = offset_to_line_col(content, err.span.start as usize);
            out.push_str(&format!("- {} (line {}, col {})\n", err.message, line, col));
        }
    }
    Ok(out)
}

pub fn get_parse_tree_for_content(path: &Path, content: &str) -> Result<Vec<ParseTreeNodeView>, String> {
    if !is_model_file(path) {
        return Err("Parse tree is only available for .sysml or .kerml files".to_string());
    }
    let nodes = parse_tree_for_content(content);
    Ok(nodes
        .into_iter()
        .map(|node| ParseTreeNodeView {
            id: node.id,
            parent_id: node.parent_id,
            kind: node.kind,
            label: node.label,
            start_offset: node.start_offset,
            end_offset: node.end_offset,
            start_line: node.start_line,
            start_col: node.start_col,
            end_line: node.end_line,
            end_col: node.end_col,
            depth: node.depth,
        })
        .collect())
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

pub(crate) fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new("\\")),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(segment) => normalized.push(segment),
        }
    }
    normalized
}

pub(crate) fn resolve_under_root(root: &Path, target: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let joined = if target.is_absolute() {
        target.to_path_buf()
    } else {
        root.join(target)
    };
    let normalized = normalize_path(&joined);
    if !normalized.starts_with(&root) {
        let root_str = root.to_string_lossy();
        let path_str = normalized.to_string_lossy();
        let strip = |value: &str| {
            let value = value.replace('/', "\\").to_lowercase();
            value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
        };
        let root_cmp = strip(&root_str);
        let path_cmp = strip(&path_str);
        if !path_cmp.starts_with(&root_cmp) {
            return Err("Path is outside the project root".to_string());
        }
    }
    Ok(normalized)
}

pub(crate) fn is_model_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_lowercase().as_str(), "sysml" | "kerml"))
        .unwrap_or(false)
}

fn default_diagram_version() -> u32 {
    1
}

fn normalize_diagram(diagram: &mut DiagramFile) {
    if diagram.version == 0 {
        diagram.version = 1;
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
