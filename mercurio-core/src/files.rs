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

pub fn get_parse_errors_for_content(path: &Path, content: &str) -> Result<ParseErrorsPayload, String> {
    if !is_model_file(path) {
        return Ok(ParseErrorsPayload {
            path: path.to_string_lossy().to_string(),
            errors: Vec::new(),
        });
    }
    let parse = syster::syntax::parser::parse_with_result(content, path);
    let errors = parse
        .errors
        .iter()
        .map(|err| ParseErrorView {
            message: err.message.clone(),
            line: err.position.line,
            column: err.position.column,
            kind: "parse".to_string(),
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
    let parse = syster::syntax::parser::parse_with_result(content, path);
    if let Some(syntax) = parse.content {
        let mut out = String::new();
        out.push_str("AST (full debug):\n");
        let root = syntax.parse().syntax();
        out.push_str(&format!("{:#?}", root));
        if !parse.errors.is_empty() {
            out.push_str("\n\nErrors:\n");
            for err in parse.errors.iter() {
                out.push_str(&format!(
                    "- {} (line {}, col {})\n",
                    err.message, err.position.line, err.position.column
                ));
            }
        }
        return Ok(out);
    }
    let mut error_lines = Vec::new();
    for err in parse.errors.iter() {
        error_lines.push(format!(
            "{} (line {}, col {})",
            err.message, err.position.line, err.position.column
        ));
    }
    if error_lines.is_empty() {
        Err("Parse failed with no error details".to_string())
    } else {
        Err(format!("Parse failed:\n{}", error_lines.join("\n")))
    }
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

pub(crate) fn is_path_under_root(root: &Path, path: &str) -> bool {
    let root_norm = root.canonicalize().ok();
    let path_norm = PathBuf::from(path).canonicalize().ok();
    if let (Some(root_norm), Some(path_norm)) = (root_norm, path_norm) {
        return path_norm.starts_with(&root_norm);
    }
    let root_str = root.to_string_lossy().to_lowercase();
    let path_str = path.to_lowercase();
    if root_str.is_empty() || path_str.is_empty() {
        return false;
    }
    path_str.starts_with(&root_str)
}

pub(crate) fn is_import_extension(ext: &str) -> bool {
    matches!(
        ext.to_lowercase().as_str(),
        "xmi" | "sysmlx" | "kermlx" | "kpar" | "jsonld" | "json"
    )
}

pub(crate) fn is_model_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_lowercase().as_str(), "sysml" | "kerml"))
        .unwrap_or(false)
}

pub(crate) fn is_import_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| is_import_extension(ext))
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
