//! AI provider commands.
//!
//! Intent: keep provider-specific request shaping in one place behind a stable Tauri command API.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::command;
use mercurio_core::resolve_under_root;

use crate::agent::{AgentFinal, parse_agent_final};
use crate::commands::tools::{execute_tool, tool_catalog};
use crate::AppState;

#[derive(Deserialize)]
pub struct AiEndpointPayload {
    url: String,
    r#type: String,
    provider: Option<String>,
    model: Option<String>,
    token: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct AiMessagePayload {
    role: String,
    content: String,
}

#[derive(Deserialize)]
pub struct AiAgentPayload {
    url: String,
    provider: Option<String>,
    model: Option<String>,
    token: Option<String>,
    messages: Vec<AiMessagePayload>,
    max_tokens: Option<u32>,
    root: Option<String>,
    enable_tools: Option<bool>,
}

#[derive(Serialize)]
pub struct AiAgentStep {
    kind: String,
    detail: String,
}

#[derive(Serialize)]
pub struct AiAgentResponse {
    message: String,
    steps: Vec<AiAgentStep>,
    final_response: Option<AgentFinal>,
    final_error: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AiProvider {
    OpenAi,
    Anthropic,
}

impl AiProvider {
    fn from_input(value: Option<&str>) -> Self {
        match value.unwrap_or("openai").trim().to_lowercase().as_str() {
            "anthropic" => Self::Anthropic,
            _ => Self::OpenAi,
        }
    }
}

trait ProviderAdapter: Sync {
    fn chat_url(&self, base: &str) -> String;
    fn test_url(&self, base: &str, endpoint_type: &str) -> Result<String, String>;
    fn test_body(&self, endpoint_type: &str, model: Option<&str>) -> serde_json::Value;
    fn chat_body(
        &self,
        model: Option<&str>,
        messages: &[AiMessagePayload],
        max_tokens: u32,
    ) -> serde_json::Value;
    fn apply_auth(&self, request: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder;
    fn extract_text(&self, value: &serde_json::Value) -> String;
}

struct OpenAiAdapter;
struct AnthropicAdapter;

fn normalize_openai_url(base: &str, suffix: &str) -> String {
    if base.contains(suffix) {
        return base.to_string();
    }
    let trimmed = base.trim_end_matches('/');
    if trimmed.ends_with("/v1") {
        format!("{}{}", trimmed, suffix)
    } else {
        format!("{}/v1{}", trimmed, suffix)
    }
}

fn normalize_anthropic_url(base: &str, suffix: &str) -> String {
    if base.contains(suffix) {
        return base.to_string();
    }
    let trimmed = base.trim_end_matches('/');
    format!("{}{}", trimmed, suffix)
}

impl ProviderAdapter for OpenAiAdapter {
    fn chat_url(&self, base: &str) -> String {
        normalize_openai_url(base, "/chat/completions")
    }

    fn test_url(&self, base: &str, endpoint_type: &str) -> Result<String, String> {
        if endpoint_type == "embeddings" {
            Ok(normalize_openai_url(base, "/embeddings"))
        } else {
            Ok(self.chat_url(base))
        }
    }

    fn test_body(&self, endpoint_type: &str, model: Option<&str>) -> serde_json::Value {
        if endpoint_type == "embeddings" {
            serde_json::json!({
                "model": model.unwrap_or("text-embedding-3-small"),
                "input": "ping",
            })
        } else {
            serde_json::json!({
                "model": model.unwrap_or("gpt-4o-mini"),
                "messages": [{ "role": "user", "content": "ping" }],
                "max_completion_tokens": 1,
            })
        }
    }

    fn chat_body(
        &self,
        model: Option<&str>,
        messages: &[AiMessagePayload],
        max_tokens: u32,
    ) -> serde_json::Value {
        serde_json::json!({
            "model": model.unwrap_or("gpt-4o-mini"),
            "messages": messages,
            "max_completion_tokens": max_tokens,
        })
    }

    fn apply_auth(&self, request: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
        if let Some(token) = token {
            if !token.trim().is_empty() {
                return request.header("Authorization", format!("Bearer {}", token));
            }
        }
        request
    }

    fn extract_text(&self, value: &serde_json::Value) -> String {
        value
            .get("choices")
            .and_then(|choices| choices.get(0))
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content"))
            .and_then(|content| content.as_str())
            .or_else(|| {
                value
                    .get("choices")
                    .and_then(|choices| choices.get(0))
                    .and_then(|choice| choice.get("text"))
                    .and_then(|text| text.as_str())
            })
            .or_else(|| value.get("message").and_then(|message| message.as_str()))
            .unwrap_or("")
            .to_string()
    }
}

impl ProviderAdapter for AnthropicAdapter {
    fn chat_url(&self, base: &str) -> String {
        normalize_anthropic_url(base, "/v1/messages")
    }

    fn test_url(&self, base: &str, endpoint_type: &str) -> Result<String, String> {
        if endpoint_type == "embeddings" {
            return Err("Embeddings are not supported for Anthropic endpoints in this client yet.".to_string());
        }
        Ok(self.chat_url(base))
    }

    fn test_body(&self, _endpoint_type: &str, model: Option<&str>) -> serde_json::Value {
        serde_json::json!({
            "model": model.unwrap_or("claude-3-5-haiku-latest"),
            "messages": [{ "role": "user", "content": "ping" }],
            "max_tokens": 16,
        })
    }

    fn chat_body(
        &self,
        model: Option<&str>,
        messages: &[AiMessagePayload],
        max_tokens: u32,
    ) -> serde_json::Value {
        serde_json::json!({
            "model": model.unwrap_or("claude-3-5-sonnet-latest"),
            "messages": messages,
            "max_tokens": max_tokens,
        })
    }

    fn apply_auth(&self, request: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
        if let Some(token) = token {
            if !token.trim().is_empty() {
                return request
                    .header("x-api-key", token)
                    .header("anthropic-version", "2023-06-01");
            }
        }
        request
    }

    fn extract_text(&self, value: &serde_json::Value) -> String {
        value
            .get("content")
            .and_then(|parts| parts.as_array())
            .and_then(|parts| {
                parts.iter().find_map(|part| {
                    if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                        part.get("text").and_then(|text| text.as_str())
                    } else {
                        None
                    }
                })
            })
            .or_else(|| value.get("message").and_then(|message| message.as_str()))
            .unwrap_or("")
            .to_string()
    }
}

fn adapter_for(provider: AiProvider) -> &'static (dyn ProviderAdapter + Sync) {
    static OPENAI: OpenAiAdapter = OpenAiAdapter;
    static ANTHROPIC: AnthropicAdapter = AnthropicAdapter;
    match provider {
        AiProvider::OpenAi => &OPENAI,
        AiProvider::Anthropic => &ANTHROPIC,
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum AgentAction {
    Final {
        content: String,
    },
    ListTools,
    CallTool {
        tool: String,
        args: Value,
    },
    ReadFile {
        path: String,
    },
    ListDir {
        path: String,
    },
    SearchText {
        query: String,
        limit: Option<usize>,
    },
    WriteFile {
        path: String,
        content: String,
        create_dirs: Option<bool>,
    },
    ApplyPatch {
        path: String,
        find: String,
        replace: String,
        replace_all: Option<bool>,
        apply: Option<bool>,
    },
}

struct ToolOutcome {
    detail: String,
    result: String,
}

fn parse_agent_action(text: &str) -> Option<AgentAction> {
    fn clean_token(input: &str) -> String {
        input
            .trim()
            .trim_matches('`')
            .trim_matches('"')
            .trim_matches('\'')
            .trim_end_matches(',')
            .trim()
            .to_string()
    }

    fn strip_fences(input: &str) -> String {
        let trimmed = input.trim();
        if !trimmed.starts_with("```") {
            return trimmed.to_string();
        }
        let mut lines = trimmed.lines();
        let _ = lines.next();
        let mut out = Vec::new();
        for line in lines {
            if line.trim_start().starts_with("```") {
                break;
            }
            out.push(line);
        }
        if out.is_empty() {
            trimmed
                .replace("```json", "")
                .replace("```yaml", "")
                .replace("```yml", "")
                .replace("```", "")
                .trim()
                .to_string()
        } else {
            out.join("\n").trim().to_string()
        }
    }

    if let Ok(action) = serde_json::from_str::<AgentAction>(text.trim()) {
        return Some(action);
    }
    if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
        if let Some(obj) = value.as_object() {
            if let Some(action) = obj.get("action").and_then(|v| v.as_str()) {
                if action.eq_ignore_ascii_case("list_tools") {
                    return Some(AgentAction::ListTools);
                }
                if action.eq_ignore_ascii_case("call_tool") {
                    let tool = obj
                        .get("tool")
                        .and_then(|v| v.as_str())
                        .map(clean_token)
                        .unwrap_or_default();
                    if tool.is_empty() {
                        return None;
                    }
                    let args = obj
                        .get("args")
                        .cloned()
                        .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
                    return Some(AgentAction::CallTool { tool, args });
                }
                if action.eq_ignore_ascii_case("final") {
                    if let Some(content) = obj.get("content").and_then(|v| v.as_str()) {
                        return Some(AgentAction::Final {
                            content: content.to_string(),
                        });
                    }
                }
            }
            if let Some(tool) = obj.get("tool").and_then(|v| v.as_str()) {
                let tool = clean_token(tool);
                if tool.eq_ignore_ascii_case("list_tools") {
                    return Some(AgentAction::ListTools);
                }
            }
        }
    }
    // Fallback for simple YAML-like tool directives some models emit.
    // Example:
    // tool: list_tools
    // or:
    // tool: call_tool
    // name: core.query_semantic@v1
    // args: {"root":"...","query":{...}}
    let trimmed = strip_fences(text);
    if !trimmed.is_empty() {
        let mut action_name: Option<String> = None;
        let mut tool_name: Option<String> = None;
        let mut call_name: Option<String> = None;
        let mut args_raw: Option<String> = None;
        for line in trimmed.lines() {
            let line = line
                .trim()
                .trim_start_matches('-')
                .trim()
                .trim_start_matches('*')
                .trim();
            if line.is_empty() {
                continue;
            }
            // Accept "key:value", "key : value", and case variants.
            if let Some((raw_key, raw_value)) = line.split_once(':') {
                let key = raw_key.trim().to_ascii_lowercase();
                let value = clean_token(raw_value);
                if key == "action" || key == "tool request" || key == "request" {
                    action_name = Some(value);
                } else if key == "tool" {
                    tool_name = Some(value);
                } else if key == "name" || key == "tool_name" {
                    call_name = Some(value);
                } else if key == "args" {
                    args_raw = Some(raw_value.trim().to_string());
                }
            }
        }
        // Super-loose fallback for one-liners.
        if tool_name.is_none() {
            let lower = trimmed.to_ascii_lowercase();
            if lower.contains("tool: list_tools") || lower.contains("tool : list_tools") {
                tool_name = Some("list_tools".to_string());
            }
        }
        if action_name
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("list_tools"))
        {
            return Some(AgentAction::ListTools);
        }
        if let Some(tool) = tool_name {
            if tool.eq_ignore_ascii_case("list_tools") {
                return Some(AgentAction::ListTools);
            }
            if tool.eq_ignore_ascii_case("call_tool")
                || action_name
                    .as_deref()
                    .is_some_and(|value| value.eq_ignore_ascii_case("call_tool"))
            {
                let tool = call_name.unwrap_or_default();
                if tool.is_empty() {
                    return None;
                }
                let args = args_raw
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                    .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
                return Some(AgentAction::CallTool { tool, args });
            }
            // Also accept direct tool ids like "tool: core.query_semantic@v1".
            if tool.contains('@') || tool.contains('.') {
                let args = args_raw
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                    .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
                return Some(AgentAction::CallTool { tool, args });
            }
        }

        // Ultra-loose token fallback for prose-like outputs.
        let lower = trimmed.to_ascii_lowercase();
        if lower.contains("list_tools") {
            return Some(AgentAction::ListTools);
        }
        if lower.contains("call_tool") {
            if let Some(name_line) = trimmed
                .lines()
                .map(str::trim)
                .find(|line| line.to_ascii_lowercase().starts_with("name:"))
            {
                if let Some((_, raw_name)) = name_line.split_once(':') {
                    let tool = clean_token(raw_name);
                    if !tool.is_empty() {
                        return Some(AgentAction::CallTool {
                            tool,
                            args: Value::Object(serde_json::Map::new()),
                        });
                    }
                }
            }
        }
    }
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<AgentAction>(&text[start..=end]).ok()
}

fn parse_agent_actions(text: &str) -> Vec<AgentAction> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    if let Some(action) = parse_agent_action(trimmed) {
        return vec![action];
    }

    let mut actions = Vec::new();
    let mut depth = 0usize;
    let mut start: Option<usize> = None;
    let mut in_string = false;
    let mut escaped = false;

    for (idx, ch) in text.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if ch == '"' {
                in_string = false;
            }
            continue;
        }

        if ch == '"' {
            in_string = true;
            continue;
        }
        if ch == '{' {
            if depth == 0 {
                start = Some(idx);
            }
            depth += 1;
            continue;
        }
        if ch == '}' && depth > 0 {
            depth -= 1;
            if depth == 0 {
                if let Some(s) = start {
                    let candidate = &text[s..=idx];
                    if let Some(action) = parse_agent_action(candidate) {
                        actions.push(action);
                    }
                }
                start = None;
            }
        }
    }

    actions
}

fn read_file_under_root(root: &Path, path: &str) -> Result<String, String> {
    let resolved = resolve_under_root(root, Path::new(path))?;
    fs::read_to_string(&resolved).map_err(|e| e.to_string())
}

fn list_dir_under_root(root: &Path, path: &str) -> Result<String, String> {
    let resolved = resolve_under_root(root, Path::new(path))?;
    let mut dirs = Vec::new();
    let mut files = Vec::new();
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
    Ok(serde_json::json!({ "path": resolved, "dirs": dirs, "files": files }).to_string())
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
            if matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist" | "build") {
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

fn search_text_under_root(root: &Path, query: &str, limit: usize) -> Result<String, String> {
    let mut files = Vec::new();
    collect_files(root, root, &mut files)?;
    let mut hits = Vec::new();
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
                hits.push(serde_json::json!({
                    "path": rel.to_string_lossy(),
                    "line": line_no + 1,
                    "text": line,
                }));
                if hits.len() >= limit {
                    break;
                }
            }
        }
    }
    Ok(serde_json::Value::Array(hits).to_string())
}

fn write_file_under_root(root: &Path, path: &str, content: &str, create_dirs: bool) -> Result<String, String> {
    let resolved = resolve_under_root(root, Path::new(path))?;
    if let Some(parent) = resolved.parent() {
        if create_dirs {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        } else if !parent.exists() {
            return Err("Parent directory does not exist".to_string());
        }
    }
    fs::write(&resolved, content).map_err(|e| e.to_string())?;
    Ok(format!(
        "wrote {} bytes to {}",
        content.len(),
        resolved.to_string_lossy()
    ))
}

fn apply_patch_under_root(
    root: &Path,
    path: &str,
    find: &str,
    replace: &str,
    replace_all: bool,
    apply: bool,
) -> Result<ToolOutcome, String> {
    if find.is_empty() {
        return Err("'find' must not be empty".to_string());
    }
    let resolved = resolve_under_root(root, Path::new(path))?;
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

    let changed = if replace_all { matches } else { 1 };
    let preview = format!(
        "patch preview: file={}, replacements={}, before_bytes={}, after_bytes={}, apply={}",
        resolved.to_string_lossy(),
        changed,
        original.len(),
        updated.len(),
        apply
    );

    if apply {
        fs::write(&resolved, &updated).map_err(|e| e.to_string())?;
    }

    Ok(ToolOutcome {
        detail: if apply {
            format!("apply_patch:{}", path)
        } else {
            format!("preview_patch:{}", path)
        },
        result: preview,
    })
}

fn run_agent_tool(action: AgentAction, root: Option<&Path>) -> Result<ToolOutcome, String> {
    match action {
        AgentAction::Final { content } => Ok(ToolOutcome {
            detail: "final".to_string(),
            result: content,
        }),
        AgentAction::ListTools | AgentAction::CallTool { .. } => {
            Err("Use list_tools/call_tool handling path".to_string())
        }
        AgentAction::ReadFile { path } => {
            let root = root.ok_or_else(|| "Tool unavailable: root path missing".to_string())?;
            Ok(ToolOutcome {
                detail: format!("read_file:{}", path),
                result: read_file_under_root(root, &path)?,
            })
        }
        AgentAction::ListDir { path } => {
            let root = root.ok_or_else(|| "Tool unavailable: root path missing".to_string())?;
            Ok(ToolOutcome {
                detail: format!("list_dir:{}", path),
                result: list_dir_under_root(root, &path)?,
            })
        }
        AgentAction::SearchText { query, limit } => {
            let root = root.ok_or_else(|| "Tool unavailable: root path missing".to_string())?;
            let clamped = limit.unwrap_or(20).clamp(1, 100);
            Ok(ToolOutcome {
                detail: format!("search_text:{}", query),
                result: search_text_under_root(root, &query, clamped)?,
            })
        }
        AgentAction::WriteFile {
            path,
            content,
            create_dirs,
        } => {
            let root = root.ok_or_else(|| "Tool unavailable: root path missing".to_string())?;
            Ok(ToolOutcome {
                detail: format!("write_file:{}", path),
                result: write_file_under_root(root, &path, &content, create_dirs.unwrap_or(true))?,
            })
        }
        AgentAction::ApplyPatch {
            path,
            find,
            replace,
            replace_all,
            apply,
        } => {
            let root = root.ok_or_else(|| "Tool unavailable: root path missing".to_string())?;
            apply_patch_under_root(
                root,
                &path,
                &find,
                &replace,
                replace_all.unwrap_or(false),
                apply.unwrap_or(false),
            )
        }
    }
}

async fn request_json(
    url: String,
    token: Option<&str>,
    body: serde_json::Value,
    adapter: &(dyn ProviderAdapter + Sync),
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let request = client.post(url).header("Content-Type", "application/json");
    let request = adapter.apply_auth(request, token);
    let response = request.json(&body).send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("{} {}", status.as_u16(), text));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[command]
/// Sends a lightweight probe request to validate an AI endpoint configuration.
pub async fn ai_test_endpoint(payload: AiEndpointPayload) -> Result<serde_json::Value, String> {
    let provider = AiProvider::from_input(payload.provider.as_deref());
    let adapter = adapter_for(provider);
    let endpoint_type = payload.r#type.to_lowercase();
    let url = match adapter.test_url(&payload.url, &endpoint_type) {
        Ok(url) => url,
        Err(detail) => {
            return Ok(serde_json::json!({
                "ok": false,
                "detail": detail,
            }))
        }
    };

    let body = adapter.test_body(&endpoint_type, payload.model.as_deref());
    match request_json(url, payload.token.as_deref(), body, adapter).await {
        Ok(_) => Ok(serde_json::json!({ "ok": true })),
        Err(error) => {
            let mut parts = error.splitn(2, ' ');
            let status = parts
                .next()
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(0);
            let detail = parts.next().unwrap_or("");
            Ok(serde_json::json!({
                "ok": false,
                "status": status,
                "detail": detail,
            }))
        }
    }
}

#[command]
/// Runs a lightweight multi-step agent loop with optional local tools.
pub async fn ai_agent_run(
    state: tauri::State<'_, AppState>,
    payload: AiAgentPayload,
) -> Result<AiAgentResponse, String> {
    let provider = AiProvider::from_input(payload.provider.as_deref());
    let adapter = adapter_for(provider);
    let root_path = payload.root.as_ref().map(PathBuf::from);
    let root = root_path.as_deref();

    let mut steps = Vec::new();
    let mut last_tool_result: Option<String> = None;
    let mut conversation = payload.messages.clone();
    let tools_enabled = payload.enable_tools.unwrap_or(true);
    let clamp_tool_result = |value: &str| -> String {
        const LIMIT: usize = 4000;
        let mut out = String::new();
        for (idx, ch) in value.chars().enumerate() {
            if idx >= LIMIT {
                out.push_str("\n... (truncated)");
                break;
            }
            out.push(ch);
        }
        out
    };

    if tools_enabled {
        let root_note = root
            .map(|path| {
                format!(
                    "\nWorkspace root: {}\nAll tool paths must be under this root. Prefer relative paths without a drive letter.",
                    path.display()
                )
            })
            .unwrap_or_else(|| "\nWorkspace root: (unknown)\nAll tool paths must be under the workspace root.".to_string());
        conversation.insert(
            0,
            AiMessagePayload {
                role: "system".to_string(),
                content: {
                    let prompt = r#"You are a coding assistant with local tools. Respond ONLY with JSON using one of these actions:
{"action":"list_tools"}
{"action":"call_tool","tool":"tool_name@v1","args":{...}}
{"action":"final","content":"...json..."}

Legacy actions are still accepted: {"action":"read_file","path":"..."}, {"action":"list_dir","path":"..."}, {"action":"search_text","query":"...","limit":20}, {"action":"write_file","path":"...","content":"...","create_dirs":true}, {"action":"apply_patch","path":"...","find":"...","replace":"...","replace_all":false,"apply":false}.
Use apply_patch with apply=false first to preview; only set apply=true when confident.
All tool paths MUST be under the workspace root. Prefer relative paths like "src/foo.sysml". If a user gives an absolute path, ensure it is within the workspace root; otherwise refuse and ask for a path under the root.

When you are done, respond with {{"action":"final","content":"..."}} where content is a JSON object encoded as a string in this exact shape:
{{
  "summary": "short summary for the user",
  "next_steps": [
    {{ "id": "1", "label": "step text", "recommended": true, "action": "message to the agent" }},
    {{ "id": "2", "label": "step text", "recommended": false, "action": "message to the agent" }}
  ]
}}
Mark 1-3 steps with recommended=true. Do not include any extra text outside the JSON."#
                        .to_string();
                    prompt + &root_note
                },
            },
        );
    }

    for _ in 0..6 {
        let url = adapter.chat_url(&payload.url);
        let body = adapter.chat_body(
            payload.model.as_deref(),
            &conversation,
            payload.max_tokens.unwrap_or(512),
        );
        let response = request_json(url, payload.token.as_deref(), body, adapter).await?;

        let text = adapter.extract_text(&response);
        if !tools_enabled {
            let message = if text.is_empty() {
                if let Some(result) = last_tool_result.as_deref() {
                    format!("Tool result:\n{}", clamp_tool_result(result))
                } else {
                    "No response.".to_string()
                }
            } else {
                text
            };
            return Ok(AiAgentResponse {
                message,
                steps,
                final_response: None,
                final_error: None,
            });
        }

        let actions = parse_agent_actions(&text);
        if actions.is_empty() {
            let message = if text.is_empty() {
                if let Some(result) = last_tool_result.as_deref() {
                    format!("Tool result:\n{}", clamp_tool_result(result))
                } else {
                    "No response.".to_string()
                }
            } else {
                text
            };
            return Ok(AiAgentResponse {
                message,
                steps,
                final_response: None,
                final_error: None,
            });
        }

        for action in actions {
            if let AgentAction::Final { content } = action {
                match parse_agent_final(&content) {
                    Ok(final_response) => {
                        return Ok(AiAgentResponse {
                            message: final_response.summary.clone(),
                            steps,
                            final_response: Some(final_response),
                            final_error: None,
                        });
                    }
                    Err(error) => {
                        return Ok(AiAgentResponse {
                            message: content,
                            steps,
                            final_response: None,
                            final_error: Some(error),
                        });
                    }
                }
            }

            let outcome = match action {
                AgentAction::ListTools => Ok(ToolOutcome {
                    detail: "list_tools".to_string(),
                    result: serde_json::to_string(&tool_catalog()).map_err(|e| e.to_string())?,
                }),
                AgentAction::CallTool { tool, mut args } => {
                    if args.get("root").is_none() {
                        if let Some(root) = root {
                            if tool.starts_with("fs.") || tool.starts_with("core.") {
                                args["root"] = Value::String(root.to_string_lossy().to_string());
                            }
                        }
                    }
                    let value = execute_tool(state.core.clone(), &tool, args).await?;
                    let result = if value.is_string() {
                        value.as_str().unwrap_or_default().to_string()
                    } else {
                        value.to_string()
                    };
                    Ok(ToolOutcome {
                        detail: format!("call_tool:{}", tool),
                        result,
                    })
                }
                other => run_agent_tool(other, root),
            };

            match outcome {
                Ok(outcome) => {
                    last_tool_result = Some(outcome.result.clone());
                    steps.push(AiAgentStep {
                        kind: "tool".to_string(),
                        detail: outcome.detail.clone(),
                    });
                    conversation.push(AiMessagePayload {
                        role: "assistant".to_string(),
                        content: serde_json::json!({
                            "action": "tool_result",
                            "detail": outcome.detail,
                        })
                        .to_string(),
                    });
                    conversation.push(AiMessagePayload {
                        role: "user".to_string(),
                        content: format!("Tool result: {}", outcome.result),
                    });
                }
                Err(error) => {
                    steps.push(AiAgentStep {
                        kind: "tool_error".to_string(),
                        detail: error.clone(),
                    });
                    conversation.push(AiMessagePayload {
                        role: "user".to_string(),
                        content: format!("Tool error: {}", error),
                    });
                }
            }
        }
    }

    let message = if let Some(result) = last_tool_result.as_deref() {
        format!(
            "Agent stopped after max steps without a final answer.\n\nLast tool result:\n{}",
            clamp_tool_result(result)
        )
    } else {
        "Agent stopped after max steps without a final answer.".to_string()
    };
    Ok(AiAgentResponse {
        message,
        steps,
        final_response: None,
        final_error: Some("Agent stopped after max steps".to_string()),
    })
}
