use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::command;

use mercurio_core::{
    compile_project_delta_sync_with_options as core_compile_project_delta_sync_with_options,
    evaluate_project_expression as core_evaluate_project_expression,
    get_project_element_attributes as core_get_project_element_attributes,
    get_project_element_property_sections as core_get_project_element_property_sections,
    get_project_expression_records as core_get_project_expression_records,
    get_project_expressions_view as core_get_project_expressions_view,
    get_project_model as core_get_project_model, get_stdlib_metamodel as core_get_stdlib_metamodel,
    get_workspace_startup_snapshot as core_get_workspace_startup_snapshot,
    get_workspace_symbol_snapshot as core_get_workspace_symbol_snapshot,
    get_workspace_tree_snapshot as core_get_workspace_tree_snapshot,
    load_library_symbols_sync as core_load_library_symbols_sync,
    query_library_symbols as core_query_library_symbols,
    query_project_semantic_projection_by_qualified_name as core_query_project_semantic_projection_by_qualified_name,
    query_project_symbols as core_query_project_symbols,
    query_project_symbols_for_files as core_query_project_symbols_for_files,
    query_semantic as core_query_semantic, query_semantic_symbols as core_query_semantic_symbols,
    resolve_under_root, CoreState, SemanticQuery,
};

use crate::{list_stdlib_versions_from_root, save_app_settings, AppState};

#[derive(Deserialize)]
pub struct ToolCallPayload {
    pub tool: String,
    pub args: Value,
}

#[derive(Serialize)]
pub struct ToolCallResult {
    pub ok: bool,
    pub result: Option<Value>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub read_only: bool,
}

#[derive(Serialize)]
struct ExpressionEvaluationResult {
    expression: String,
    result: String,
}

#[derive(Serialize)]
struct ExpressionsToolView {
    records: Value,
    diagnostics: Vec<String>,
    evaluation: Option<ExpressionEvaluationResult>,
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_lowercase();
            if matches!(
                name.as_str(),
                ".git" | "node_modules" | "target" | "dist" | "build"
            ) {
                continue;
            }
            collect_files(root, &path, out)?;
            continue;
        }
        if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_path_buf());
        }
    }
    Ok(())
}

fn arg_string(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Missing or invalid '{key}'"))
}

fn arg_optional_string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn arg_bool(args: &Value, key: &str, default: bool) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

fn arg_string_list(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|entry| entry.as_str())
                .map(|entry| entry.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn arg_usize(args: &Value, key: &str, default: usize) -> usize {
    args.get(key)
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(default)
}

fn root_from_args(args: &Value) -> Result<PathBuf, String> {
    Ok(PathBuf::from(arg_string(args, "root")?))
}

fn read_file_under_root(root: &Path, rel_path: &str) -> Result<String, String> {
    let resolved = resolve_under_root(root, Path::new(rel_path))?;
    fs::read_to_string(&resolved).map_err(|e| e.to_string())
}

fn list_dir_under_root(root: &Path, rel_path: &str) -> Result<Value, String> {
    let resolved = resolve_under_root(root, Path::new(rel_path))?;
    let mut dirs = Vec::<String>::new();
    let mut files = Vec::<String>::new();
    for entry in fs::read_dir(&resolved).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.path().is_dir() {
            dirs.push(name);
        } else {
            files.push(name);
        }
    }
    dirs.sort();
    files.sort();
    Ok(json!({
        "path": resolved.to_string_lossy().to_string(),
        "dirs": dirs,
        "files": files
    }))
}

fn search_text_under_root(root: &Path, query: &str, limit: usize) -> Result<Value, String> {
    let mut files = Vec::<PathBuf>::new();
    collect_files(root, root, &mut files)?;
    let mut hits = Vec::<Value>::new();
    for rel in files {
        if hits.len() >= limit {
            break;
        }
        let full = root.join(&rel);
        let content = match fs::read_to_string(&full) {
            Ok(content) => content,
            Err(_) => continue,
        };
        for (line_no, line) in content.lines().enumerate() {
            if line.contains(query) {
                hits.push(json!({
                    "path": rel.to_string_lossy().to_string(),
                    "line": line_no + 1,
                    "text": line,
                }));
                if hits.len() >= limit {
                    break;
                }
            }
        }
    }
    Ok(Value::Array(hits))
}

fn write_file_under_root(
    root: &Path,
    rel_path: &str,
    content: &str,
    create_dirs: bool,
) -> Result<Value, String> {
    let resolved = resolve_under_root(root, Path::new(rel_path))?;
    if let Some(parent) = resolved.parent() {
        if create_dirs {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        } else if !parent.exists() {
            return Err("Parent directory does not exist".to_string());
        }
    }
    fs::write(&resolved, content).map_err(|e| e.to_string())?;
    Ok(json!({
        "path": resolved.to_string_lossy().to_string(),
        "bytes": content.len()
    }))
}

fn apply_patch_under_root(
    root: &Path,
    rel_path: &str,
    find: &str,
    replace: &str,
    replace_all: bool,
    apply: bool,
) -> Result<Value, String> {
    if find.is_empty() {
        return Err("'find' must not be empty".to_string());
    }
    let resolved = resolve_under_root(root, Path::new(rel_path))?;
    let original = fs::read_to_string(&resolved).map_err(|e| e.to_string())?;
    let matches = original.matches(find).count();
    if matches == 0 {
        return Err("No matches found for patch".to_string());
    }
    let updated = if replace_all {
        original.replace(find, replace)
    } else {
        original.replacen(find, replace, 1)
    };
    if apply {
        fs::write(&resolved, &updated).map_err(|e| e.to_string())?;
    }
    Ok(json!({
        "path": resolved.to_string_lossy().to_string(),
        "apply": apply,
        "matches": matches,
        "replacements": if replace_all { matches } else { 1 },
        "before_bytes": original.len(),
        "after_bytes": updated.len()
    }))
}

fn canonical_tool_name(tool: &str) -> String {
    let normalized = tool.trim().to_ascii_lowercase();
    match normalized.as_str() {
        // Legacy FS actions
        "read_file" | "read_file@v1" | "fs.read_file" => "fs.read_file@v1".to_string(),
        "list_dir" | "list_dir@v1" | "fs.list_dir" => "fs.list_dir@v1".to_string(),
        "search_text" | "search_text@v1" | "fs.search_text" => "fs.search_text@v1".to_string(),
        "write_file" | "write_file@v1" | "fs.write_file" => "fs.write_file@v1".to_string(),
        "apply_patch" | "apply_patch@v1" | "fs.apply_patch" => "fs.apply_patch@v1".to_string(),

        // Core aliases (unversioned)
        "query_semantic" | "core.query_semantic" => "core.query_semantic@v1".to_string(),
        "query_semantic_symbols" | "core.query_semantic_symbols" => {
            "core.query_semantic_symbols@v1".to_string()
        }
        "query_project_symbols" | "core.query_project_symbols" => {
            "core.query_project_symbols@v1".to_string()
        }
        "query_project_symbols_for_files" | "core.query_project_symbols_for_files" => {
            "core.query_project_symbols_for_files@v1".to_string()
        }
        "query_library_symbols" | "core.query_library_symbols" => {
            "core.query_library_symbols@v1".to_string()
        }
        "load_library_symbols" | "core.load_library_symbols" => {
            "core.load_library_symbols@v1".to_string()
        }
        "get_workspace_symbol_snapshot" | "core.get_workspace_symbol_snapshot" => {
            "core.get_workspace_symbol_snapshot@v1".to_string()
        }
        "get_workspace_startup_snapshot" | "core.get_workspace_startup_snapshot" => {
            "core.get_workspace_startup_snapshot@v1".to_string()
        }
        "get_workspace_tree_snapshot" | "core.get_workspace_tree_snapshot" => {
            "core.get_workspace_tree_snapshot@v1".to_string()
        }
        "compile_project" | "workspace.compile_project" => {
            "workspace.compile_project@v1".to_string()
        }
        "compile_file" | "workspace.compile_file" => {
            "workspace.compile_file@v1".to_string()
        }
        "query_semantic_element" | "core.query_semantic_element" => {
            "core.query_semantic_element@v2".to_string()
        }
        "get_project_model" | "core.get_project_model" => "core.get_project_model@v1".to_string(),
        "get_project_element_attributes" | "core.get_project_element_attributes" => {
            "core.get_project_element_attributes@v1".to_string()
        }
        "get_project_element_property_sections" | "core.get_project_element_property_sections" => {
            "core.get_project_element_property_sections@v1".to_string()
        }
        "get_project_expressions" | "core.get_project_expressions" => {
            "core.get_project_expressions@v1".to_string()
        }
        "get_expressions_view" | "core.get_expressions_view" => {
            "core.get_expressions_view@v1".to_string()
        }
        "get_stdlib_metamodel" | "core.get_stdlib_metamodel" => {
            "core.get_stdlib_metamodel@v1".to_string()
        }
        "evaluate_expression" | "core.evaluate_expression" => {
            "core.evaluate_expression@v1".to_string()
        }

        // Stdlib aliases (unversioned)
        "stdlib.list_versions" => "stdlib.list_versions@v1".to_string(),
        "stdlib.get_default" => "stdlib.get_default@v1".to_string(),
        "stdlib.set_default" => "stdlib.set_default@v1".to_string(),

        _ => tool.trim().to_string(),
    }
}

fn next_tool_run_id() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
        .try_into()
        .unwrap_or(u64::MAX)
}

pub fn tool_catalog() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "core.get_workspace_startup_snapshot@v1".to_string(),
            description: "Read the current workspace startup snapshot, including trees and indexed symbols.".to_string(),
            input_schema: json!({
                "type": "object",
                "required": ["root"],
                "properties": {
                    "root": { "type": "string" },
                    "hydrate_library": { "type": "boolean" },
                    "prefer_cache": { "type": "boolean" }
                }
            }),
            read_only: true,
        },
        ToolDefinition {
            name: "core.get_workspace_symbol_snapshot@v1".to_string(),
            description: "Read the current indexed project and library symbols for a workspace.".to_string(),
            input_schema: json!({
                "type": "object",
                "required": ["root"],
                "properties": {
                    "root": { "type": "string" },
                    "hydrate_library": { "type": "boolean" }
                }
            }),
            read_only: true,
        },
        ToolDefinition {
            name: "core.query_semantic_symbols@v1".to_string(),
            description: "Query project semantic symbols projected for UI and AI consumption.".to_string(),
            input_schema: json!({
                "type": "object",
                "required": ["root"],
                "properties": {
                    "root": { "type": "string" }
                }
            }),
            read_only: true,
        },
        ToolDefinition {
            name: "core.query_semantic_element@v2".to_string(),
            description: "Load the semantic projection for a specific qualified name.".to_string(),
            input_schema: json!({
                "type": "object",
                "required": ["root", "qualified_name"],
                "properties": {
                    "root": { "type": "string" },
                    "qualified_name": { "type": "string" },
                    "file_path": { "type": "string" }
                }
            }),
            read_only: true,
        },
        ToolDefinition {
            name: "core.get_project_model@v1".to_string(),
            description: "Read the project model view and expression records.".to_string(),
            input_schema: json!({
                "type": "object",
                "required": ["root"],
                "properties": {
                    "root": { "type": "string" }
                }
            }),
            read_only: true,
        },
        ToolDefinition {
            name: "core.get_project_element_property_sections@v1".to_string(),
            description: "Read display-ready property sections for a selected project element.".to_string(),
            input_schema: json!({
                "type": "object",
                "required": ["root", "element_qualified_name"],
                "properties": {
                    "root": { "type": "string" },
                    "element_qualified_name": { "type": "string" },
                    "file_path": { "type": "string" },
                    "symbol_kind": { "type": "string" },
                    "source_scope": { "type": "string" }
                }
            }),
            read_only: true,
        },
        ToolDefinition {
            name: "workspace.compile_project@v1".to_string(),
            description: "Compile the full workspace and return diagnostics, unresolved references, and refreshed symbols.".to_string(),
            input_schema: json!({
                "type": "object",
                "required": ["root"],
                "properties": {
                    "root": { "type": "string" },
                    "allow_parse_errors": { "type": "boolean" },
                    "include_symbols": { "type": "boolean" }
                }
            }),
            read_only: false,
        },
        ToolDefinition {
            name: "workspace.compile_file@v1".to_string(),
            description: "Compile a single workspace file and return diagnostics plus refreshed semantic results.".to_string(),
            input_schema: json!({
                "type": "object",
                "required": ["root", "path"],
                "properties": {
                    "root": { "type": "string" },
                    "path": { "type": "string" },
                    "allow_parse_errors": { "type": "boolean" },
                    "include_symbols": { "type": "boolean" }
                }
            }),
            read_only: false,
        },
        ToolDefinition {
            name: "fs.read_file@v1".to_string(),
            description: "Read a file under the workspace root.".to_string(),
            input_schema: json!({
                "type": "object",
                "required": ["root", "path"],
                "properties": {
                    "root": { "type": "string" },
                    "path": { "type": "string" }
                }
            }),
            read_only: true,
        },
        ToolDefinition {
            name: "fs.list_dir@v1".to_string(),
            description: "List directories and files under a workspace path.".to_string(),
            input_schema: json!({
                "type": "object",
                "required": ["root", "path"],
                "properties": {
                    "root": { "type": "string" },
                    "path": { "type": "string" }
                }
            }),
            read_only: true,
        },
        ToolDefinition {
            name: "fs.search_text@v1".to_string(),
            description: "Search workspace text files for a substring.".to_string(),
            input_schema: json!({
                "type": "object",
                "required": ["root", "query"],
                "properties": {
                    "root": { "type": "string" },
                    "query": { "type": "string" },
                    "limit": { "type": "number" }
                }
            }),
            read_only: true,
        },
        ToolDefinition {
            name: "fs.write_file@v1".to_string(),
            description: "Write a file under the workspace root.".to_string(),
            input_schema: json!({
                "type": "object",
                "required": ["root", "path", "content"],
                "properties": {
                    "root": { "type": "string" },
                    "path": { "type": "string" },
                    "content": { "type": "string" },
                    "create_dirs": { "type": "boolean" }
                }
            }),
            read_only: false,
        },
        ToolDefinition {
            name: "fs.apply_patch@v1".to_string(),
            description: "Apply a simple string replacement patch to a file under the workspace root.".to_string(),
            input_schema: json!({
                "type": "object",
                "required": ["root", "path", "find", "replace"],
                "properties": {
                    "root": { "type": "string" },
                    "path": { "type": "string" },
                    "find": { "type": "string" },
                    "replace": { "type": "string" },
                    "replace_all": { "type": "boolean" },
                    "apply": { "type": "boolean" }
                }
            }),
            read_only: false,
        },
    ]
}

pub async fn execute_tool(core: CoreState, tool: &str, args: Value) -> Result<Value, String> {
    let tool = canonical_tool_name(tool);
    let _background_job = core.try_start_background_job("tool", Some(tool.clone()), None);
    match tool.as_str() {
        "fs.read_file@v1" => {
            let root = root_from_args(&args)?;
            let path = arg_string(&args, "path")?;
            Ok(json!({ "content": read_file_under_root(&root, &path)? }))
        }
        "fs.list_dir@v1" => {
            let root = root_from_args(&args)?;
            let path = arg_string(&args, "path")?;
            list_dir_under_root(&root, &path)
        }
        "fs.search_text@v1" => {
            let root = root_from_args(&args)?;
            let query = arg_string(&args, "query")?;
            let limit = arg_usize(&args, "limit", 20).clamp(1, 200);
            Ok(json!({ "hits": search_text_under_root(&root, &query, limit)? }))
        }
        "fs.write_file@v1" => {
            let root = root_from_args(&args)?;
            let path = arg_string(&args, "path")?;
            let content = arg_string(&args, "content")?;
            let create_dirs = arg_bool(&args, "create_dirs", true);
            write_file_under_root(&root, &path, &content, create_dirs)
        }
        "fs.apply_patch@v1" => {
            let root = root_from_args(&args)?;
            let path = arg_string(&args, "path")?;
            let find = arg_string(&args, "find")?;
            let replace = arg_string(&args, "replace")?;
            let replace_all = arg_bool(&args, "replace_all", false);
            let apply = arg_bool(&args, "apply", false);
            apply_patch_under_root(&root, &path, &find, &replace, replace_all, apply)
        }
        "core.query_semantic@v1" => {
            let root = arg_string(&args, "root")?;
            let query_value = args
                .get("query")
                .cloned()
                .ok_or_else(|| "Missing or invalid 'query'".to_string())?;
            let query: SemanticQuery =
                serde_json::from_value(query_value).map_err(|e| format!("Invalid query: {e}"))?;
            tauri::async_runtime::spawn_blocking(move || core_query_semantic(&core, root, query))
                .await
                .map_err(|e| e.to_string())?
                .and_then(|rows| serde_json::to_value(rows).map_err(|e| e.to_string()))
        }
        "core.query_semantic_symbols@v1" => {
            let root = arg_string(&args, "root")?;
            tauri::async_runtime::spawn_blocking(move || core_query_semantic_symbols(&core, root))
                .await
                .map_err(|e| e.to_string())?
                .and_then(|rows| serde_json::to_value(rows).map_err(|e| e.to_string()))
        }
        "core.query_project_symbols@v1" => {
            let root = arg_string(&args, "root")?;
            let file_path = arg_optional_string(&args, "file_path");
            let offset = args
                .get("offset")
                .and_then(|value| value.as_u64())
                .and_then(|value| usize::try_from(value).ok());
            let limit = args
                .get("limit")
                .and_then(|value| value.as_u64())
                .and_then(|value| usize::try_from(value).ok());
            tauri::async_runtime::spawn_blocking(move || {
                core_query_project_symbols(&core, root, file_path, offset, limit)
            })
            .await
            .map_err(|e| e.to_string())?
            .and_then(|rows| serde_json::to_value(rows).map_err(|e| e.to_string()))
        }
        "core.query_project_symbols_for_files@v1" => {
            let root = arg_string(&args, "root")?;
            let file_paths = arg_string_list(&args, "file_paths");
            let offset = args
                .get("offset")
                .and_then(|value| value.as_u64())
                .and_then(|value| usize::try_from(value).ok());
            let limit = args
                .get("limit")
                .and_then(|value| value.as_u64())
                .and_then(|value| usize::try_from(value).ok());
            tauri::async_runtime::spawn_blocking(move || {
                core_query_project_symbols_for_files(&core, root, file_paths, offset, limit)
            })
            .await
            .map_err(|e| e.to_string())?
            .and_then(|rows| serde_json::to_value(rows).map_err(|e| e.to_string()))
        }
        "core.query_library_symbols@v1" => {
            let root = arg_string(&args, "root")?;
            let file_path = arg_optional_string(&args, "file_path");
            let offset = args
                .get("offset")
                .and_then(|value| value.as_u64())
                .and_then(|value| usize::try_from(value).ok());
            let limit = args
                .get("limit")
                .and_then(|value| value.as_u64())
                .and_then(|value| usize::try_from(value).ok());
            tauri::async_runtime::spawn_blocking(move || {
                core_query_library_symbols(&core, root, file_path, offset, limit)
            })
            .await
            .map_err(|e| e.to_string())?
            .and_then(|rows| serde_json::to_value(rows).map_err(|e| e.to_string()))
        }
        "core.load_library_symbols@v1" => {
            let root = arg_string(&args, "root")?;
            let file_path = arg_optional_string(&args, "file_path").map(PathBuf::from);
            let include_symbols = arg_bool(&args, "include_symbols", true);
            tauri::async_runtime::spawn_blocking(move || {
                core_load_library_symbols_sync(&core, root, file_path, include_symbols)
            })
            .await
            .map_err(|e| e.to_string())?
            .and_then(|rows| serde_json::to_value(rows).map_err(|e| e.to_string()))
        }
        "core.get_workspace_symbol_snapshot@v1" => {
            let root = arg_string(&args, "root")?;
            let hydrate_library = arg_bool(&args, "hydrate_library", true);
            tauri::async_runtime::spawn_blocking(move || {
                core_get_workspace_symbol_snapshot(&core, root, hydrate_library)
            })
            .await
            .map_err(|e| e.to_string())?
            .and_then(|view| serde_json::to_value(view).map_err(|e| e.to_string()))
        }
        "core.get_workspace_startup_snapshot@v1" => {
            let root = arg_string(&args, "root")?;
            let hydrate_library = arg_bool(&args, "hydrate_library", true);
            let prefer_cache = arg_bool(&args, "prefer_cache", true);
            tauri::async_runtime::spawn_blocking(move || {
                core_get_workspace_startup_snapshot(&core, root, hydrate_library, prefer_cache)
            })
            .await
            .map_err(|e| e.to_string())?
            .and_then(|view| serde_json::to_value(view).map_err(|e| e.to_string()))
        }
        "core.get_workspace_tree_snapshot@v1" => {
            let root = arg_string(&args, "root")?;
            tauri::async_runtime::spawn_blocking(move || {
                core_get_workspace_tree_snapshot(&core, root)
            })
            .await
            .map_err(|e| e.to_string())?
            .and_then(|view| serde_json::to_value(view).map_err(|e| e.to_string()))
        }
        "workspace.compile_project@v1" => {
            let root = arg_string(&args, "root")?;
            let allow_parse_errors = arg_bool(&args, "allow_parse_errors", true);
            let include_symbols = arg_bool(&args, "include_symbols", true);
            let run_id = next_tool_run_id();
            tauri::async_runtime::spawn_blocking(move || {
                core_compile_project_delta_sync_with_options(
                    &core,
                    root,
                    run_id,
                    allow_parse_errors,
                    None,
                    Vec::new(),
                    include_symbols,
                    |_| {},
                )
            })
            .await
            .map_err(|e| e.to_string())?
            .and_then(|response| serde_json::to_value(response).map_err(|e| e.to_string()))
        }
        "workspace.compile_file@v1" => {
            let root = arg_string(&args, "root")?;
            let path = arg_string(&args, "path")?;
            let allow_parse_errors = arg_bool(&args, "allow_parse_errors", true);
            let include_symbols = arg_bool(&args, "include_symbols", true);
            let run_id = next_tool_run_id();
            tauri::async_runtime::spawn_blocking(move || {
                core_compile_project_delta_sync_with_options(
                    &core,
                    root,
                    run_id,
                    allow_parse_errors,
                    Some(PathBuf::from(path)),
                    Vec::new(),
                    include_symbols,
                    |_| {},
                )
            })
            .await
            .map_err(|e| e.to_string())?
            .and_then(|response| serde_json::to_value(response).map_err(|e| e.to_string()))
        }
        "core.query_semantic_element@v2" => {
            let root = arg_string(&args, "root")?;
            let qualified_name = arg_string(&args, "qualified_name")?;
            let file_path = arg_optional_string(&args, "file_path");
            tauri::async_runtime::spawn_blocking(move || {
                core_query_project_semantic_projection_by_qualified_name(
                    &core,
                    root,
                    qualified_name,
                    file_path,
                )
            })
            .await
            .map_err(|e| e.to_string())?
            .and_then(|row| serde_json::to_value(row).map_err(|e| e.to_string()))
        }
        "core.get_project_model@v1" => {
            let root = arg_string(&args, "root")?;
            tauri::async_runtime::spawn_blocking(move || {
                let model = core_get_project_model(&core, root.clone())?;
                let expressions = core_get_project_expression_records(&core, root)?;
                Ok::<_, String>((model, expressions))
            })
            .await
            .map_err(|e| e.to_string())?
            .and_then(|(model, expressions)| {
                let mut value = serde_json::to_value(model).map_err(|e| e.to_string())?;
                if let Value::Object(ref mut obj) = value {
                    obj.insert(
                        "expression_records".to_string(),
                        serde_json::to_value(expressions.records).map_err(|e| e.to_string())?,
                    );
                    if !expressions.diagnostics.is_empty() {
                        obj.insert(
                            "expression_records_error".to_string(),
                            Value::String(expressions.diagnostics.join("\n")),
                        );
                    }
                }
                Ok(value)
            })
        }
        "core.get_project_expressions@v1" => {
            let root = arg_string(&args, "root")?;
            let file_path = arg_optional_string(&args, "file_path");
            let qualified_name = arg_optional_string(&args, "qualified_name");
            let xtext_export_path = arg_optional_string(&args, "xtext_export_path");
            tauri::async_runtime::spawn_blocking(move || {
                core_get_project_expressions_view(
                    root,
                    file_path,
                    qualified_name,
                    xtext_export_path,
                )
            })
            .await
            .map_err(|e| e.to_string())?
            .and_then(|view| serde_json::to_value(view).map_err(|e| e.to_string()))
        }
        "core.get_expressions_view@v1" => {
            let root = arg_string(&args, "root")?;
            let expression = arg_optional_string(&args, "expression")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let file_path = arg_optional_string(&args, "file_path");
            let qualified_name = arg_optional_string(&args, "qualified_name");
            let _xtext_export_path = arg_optional_string(&args, "xtext_export_path");
            tauri::async_runtime::spawn_blocking(move || {
                let mut view = core_get_project_expression_records(&core, root.clone())?;
                if let Some(file_path) = file_path.as_deref() {
                    let needle = file_path.trim();
                    if !needle.is_empty() {
                        view.records.retain(|record| record.file_path.trim() == needle);
                    }
                }
                if let Some(qualified_name) = qualified_name.as_deref() {
                    let needle = qualified_name.trim();
                    if !needle.is_empty() {
                        view.records.retain(|record| {
                            record.qualified_name.trim() == needle
                                || record.owner_qualified_name.trim() == needle
                        });
                    }
                }
                let evaluation = if let Some(expression) = expression {
                    Some(ExpressionEvaluationResult {
                        result: core_evaluate_project_expression(root, expression.clone())?,
                        expression,
                    })
                } else {
                    None
                };
                serde_json::to_value(ExpressionsToolView {
                    records: serde_json::to_value(view.records).map_err(|e| e.to_string())?,
                    diagnostics: view.diagnostics,
                    evaluation,
                })
                .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "core.get_project_element_attributes@v1" => {
            let root = arg_string(&args, "root")?;
            let element_qualified_name = arg_string(&args, "element_qualified_name")?;
            let symbol_kind = arg_optional_string(&args, "symbol_kind");
            tauri::async_runtime::spawn_blocking(move || {
                core_get_project_element_attributes(
                    &core,
                    root,
                    element_qualified_name,
                    symbol_kind,
                )
            })
            .await
            .map_err(|e| e.to_string())?
            .and_then(|attrs| serde_json::to_value(attrs).map_err(|e| e.to_string()))
        }
        "core.get_project_element_property_sections@v1" => {
            let root = arg_string(&args, "root")?;
            let element_qualified_name = arg_string(&args, "element_qualified_name")?;
            let file_path = arg_optional_string(&args, "file_path");
            let symbol_kind = arg_optional_string(&args, "symbol_kind");
            let source_scope = arg_optional_string(&args, "source_scope");
            tauri::async_runtime::spawn_blocking(move || {
                core_get_project_element_property_sections(
                    &core,
                    root,
                    element_qualified_name,
                    file_path,
                    symbol_kind,
                    source_scope,
                )
            })
            .await
            .map_err(|e| e.to_string())?
            .and_then(|view| serde_json::to_value(view).map_err(|e| e.to_string()))
        }
        "core.get_stdlib_metamodel@v1" => {
            let root = arg_string(&args, "root")?;
            tauri::async_runtime::spawn_blocking(move || core_get_stdlib_metamodel(&core, root))
                .await
                .map_err(|e| e.to_string())?
                .and_then(|model| serde_json::to_value(model).map_err(|e| e.to_string()))
        }
        "core.evaluate_expression@v1" => {
            let root = arg_string(&args, "root")?;
            let expression = arg_string(&args, "expression")?;
            tauri::async_runtime::spawn_blocking(move || {
                let result = core_evaluate_project_expression(root, expression.clone())?;
                serde_json::to_value(ExpressionEvaluationResult { expression, result })
                    .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())?
        }
        _ => Err(format!("Unknown tool '{}'", tool)),
    }
}

#[command]
pub fn list_tools() -> Vec<ToolDefinition> {
    tool_catalog()
}

#[command]
pub async fn call_tool(
    state: tauri::State<'_, AppState>,
    payload: ToolCallPayload,
) -> Result<ToolCallResult, String> {
    let tool_name = canonical_tool_name(&payload.tool);
    let stdlib_result: Option<Result<Value, String>> = match tool_name.as_str() {
        "stdlib.list_versions@v1" => Some(
            list_stdlib_versions_from_root(&state.core.stdlib_root)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        ),
        "stdlib.get_default@v1" => Some(
            state
                .core
                .settings
                .lock()
                .map_err(|_| "Settings lock poisoned".to_string())
                .map(|settings| settings.default_stdlib.clone())
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        ),
        "stdlib.set_default@v1" => {
            let requested = payload
                .args
                .get("stdlib")
                .and_then(|value| value.as_str())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let installed = list_stdlib_versions_from_root(&state.core.stdlib_root);
            let save_result = installed.and_then(|installed| {
                if let Some(id) = requested.as_ref() {
                    if !installed.iter().any(|installed_id| installed_id == id) {
                        return Err(format!("Stdlib version not installed: {id}"));
                    }
                }
                let mut settings = state
                    .core
                    .settings
                    .lock()
                    .map_err(|_| "Settings lock poisoned".to_string())?;
                settings.default_stdlib = requested;
                save_app_settings(&state.settings_path, &settings)?;
                Ok(settings.default_stdlib.clone())
            });
            Some(save_result.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())))
        }
        _ => None,
    };
    if let Some(result) = stdlib_result {
        return match result {
            Ok(value) => Ok(ToolCallResult {
                ok: true,
                result: Some(value),
                error: None,
            }),
            Err(error) => Ok(ToolCallResult {
                ok: false,
                result: None,
                error: Some(error),
            }),
        };
    }

    let core = state.core.clone();
    match execute_tool(core, &tool_name, payload.args).await {
        Ok(result) => Ok(ToolCallResult {
            ok: true,
            result: Some(result),
            error: None,
        }),
        Err(error) => Ok(ToolCallResult {
            ok: false,
            result: None,
            error: Some(error),
        }),
    }
}
