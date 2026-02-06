use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::commands::ai_embeddings;

#[derive(Deserialize)]
pub struct RagIndexPayload {
    pub root: String,
    pub parsed_files: Vec<String>,
    pub symbols: Vec<RagSymbol>,
    pub endpoint: RagEndpoint,
}

#[derive(Deserialize)]
pub struct RagQueryPayload {
    pub root: String,
    pub query: String,
    pub endpoint: RagEndpoint,
}

#[derive(Deserialize)]
pub struct RagEndpoint {
    pub url: String,
    pub provider: String,
    pub model: Option<String>,
    pub token: Option<String>,
}

#[derive(Deserialize)]
pub struct RagSymbol {
    pub kind: String,
    pub qualified_name: String,
    pub name: String,
    pub file_path: String,
    pub doc: Option<String>,
    pub properties: Vec<RagProperty>,
}

#[derive(Deserialize)]
pub struct RagProperty {
    pub label: String,
    pub value: RagPropertyValue,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RagPropertyValue {
    Text { value: String },
    List { items: Vec<String> },
    Bool { value: bool },
    Number { value: f64 },
}

#[derive(Serialize)]
pub struct RagQueryResult {
    pub context: String,
    pub count: usize,
}

#[derive(Serialize, Deserialize, Clone)]
struct RagCacheEntry {
    id: String,
    path: String,
    kind: String,
    hash: String,
    embedding: Vec<f32>,
}

fn stringify_prop_value(value: &RagPropertyValue) -> String {
    match value {
        RagPropertyValue::Text { value } => value.clone(),
        RagPropertyValue::List { items } => items.join(", "),
        RagPropertyValue::Bool { value } => {
            if *value { "true".to_string() } else { "false".to_string() }
        }
        RagPropertyValue::Number { value } => value.to_string(),
    }
}

fn chunk_text(text: &str, size: usize, overlap: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    if text.is_empty() {
        return chunks;
    }
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    let mut index = 0usize;
    while index < len {
        let end = std::cmp::min(len, index + size);
        let slice: String = chars[index..end].iter().collect();
        let trimmed = slice.trim();
        if !trimmed.is_empty() {
            chunks.push(trimmed.to_string());
        }
        if end == len {
            break;
        }
        let back = overlap.min(end);
        index = end.saturating_sub(back);
    }
    chunks
}

fn hash_chunk(text: &str) -> String {
    let prefix: String = text.chars().take(64).collect();
    format!("{}:{}", text.len(), prefix)
}

fn read_cache(path: &Path) -> Vec<RagCacheEntry> {
    let Ok(content) = fs::read_to_string(path) else { return Vec::new() };
    content
        .lines()
        .filter_map(|line| serde_json::from_str::<RagCacheEntry>(line).ok())
        .collect()
}

fn write_cache(path: &Path, entries: &[RagCacheEntry]) -> Result<(), String> {
    let lines: Vec<String> = entries
        .iter()
        .map(|entry| serde_json::to_string(entry).unwrap_or_default())
        .collect();
    fs::write(path, lines.join("\n")).map_err(|e| e.to_string())
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    let mut dot = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;
    let len = std::cmp::min(a.len(), b.len());
    for i in 0..len {
        let av = a[i];
        let bv = b[i];
        dot += av * bv;
        norm_a += av * av;
        norm_b += bv * bv;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}

#[tauri::command]
pub async fn rag_index_update(payload: RagIndexPayload) -> Result<usize, String> {
    let root = PathBuf::from(&payload.root);
    let cache_path = root.join(".mercurio").join("rag-cache.jsonl");
    if let Some(parent) = cache_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let cached = read_cache(&cache_path);
    let mut cached_map: HashMap<String, RagCacheEntry> = HashMap::new();
    for entry in cached {
        cached_map.insert(entry.id.clone(), entry);
    }

    let parsed_set: std::collections::HashSet<String> = payload
        .parsed_files
        .iter()
        .map(|path| path.to_lowercase())
        .collect();
    let parsed_empty = parsed_set.is_empty();

    let mut chunks: Vec<(String, String, String, String)> = Vec::new();
    for symbol in payload
        .symbols
        .iter()
        .filter(|s| parsed_empty || parsed_set.contains(&s.file_path.to_lowercase()))
    {
        let mut parts = Vec::new();
        parts.push(format!("{} {}", symbol.kind, if symbol.qualified_name.is_empty() { &symbol.name } else { &symbol.qualified_name }));
        if let Some(doc) = &symbol.doc {
            if !doc.trim().is_empty() {
                parts.push(doc.trim().to_string());
            }
        }
        for prop in &symbol.properties {
            parts.push(format!("{}: {}", prop.label, stringify_prop_value(&prop.value)));
        }
        let text = parts.join("\n").trim().to_string();
        if !text.is_empty() {
            let id = format!("sym-{}:{}", symbol.file_path, if symbol.qualified_name.is_empty() { &symbol.name } else { &symbol.qualified_name });
            chunks.push((id, symbol.file_path.clone(), "symbol".to_string(), text));
        }
    }

    let allowed = [".sysml", ".kerml", ".sysmlx", ".kermlx", ".project"];
    let mut file_candidates: std::collections::HashSet<String> = std::collections::HashSet::new();
    if payload.parsed_files.is_empty() {
        for symbol in &payload.symbols {
            if allowed.iter().any(|ext| symbol.file_path.to_lowercase().ends_with(ext)) {
                file_candidates.insert(symbol.file_path.clone());
            }
        }
    } else {
        for path in &payload.parsed_files {
            if allowed.iter().any(|ext| path.to_lowercase().ends_with(ext)) {
                file_candidates.insert(path.clone());
            }
        }
    }

    for path in file_candidates.iter() {
        if let Ok(content) = fs::read_to_string(path) {
            for (index, chunk) in chunk_text(&content, 1200, 200).into_iter().enumerate() {
                let id = format!("file-{}-{}", path, index);
                chunks.push((id, path.clone(), "file".to_string(), chunk));
            }
        }
    }

    let mut to_embed = Vec::new();
    let mut updated_entries: Vec<RagCacheEntry> = Vec::new();
    for (id, path, kind, text) in &chunks {
        let hash = hash_chunk(text);
        match cached_map.get(id) {
            Some(existing) if existing.hash == hash => {
                updated_entries.push(existing.clone());
            }
            _ => {
                to_embed.push((id.clone(), path.clone(), kind.clone(), text.clone(), hash));
            }
        }
    }

    if !to_embed.is_empty() {
        let batch_inputs: Vec<String> = to_embed.iter().map(|(_, _, _, text, _)| text.clone()).collect();
        let vectors = ai_embeddings(crate::commands::ai::AiEmbeddingsPayload {
            url: payload.endpoint.url.clone(),
            provider: Some(payload.endpoint.provider.clone()),
            model: payload.endpoint.model.clone(),
            token: payload.endpoint.token.clone(),
            input: batch_inputs,
        })
        .await?;
        for (idx, (id, path, kind, _text, hash)) in to_embed.into_iter().enumerate() {
            if let Some(vec) = vectors.get(idx) {
                updated_entries.push(RagCacheEntry {
                    id,
                    path,
                    kind,
                    hash,
                    embedding: vec.clone(),
                });
            }
        }
    }

    write_cache(&cache_path, &updated_entries)?;
    Ok(updated_entries.len())
}

#[tauri::command]
pub async fn rag_query(payload: RagQueryPayload) -> Result<RagQueryResult, String> {
    let root = PathBuf::from(&payload.root);
    let cache_path = root.join(".mercurio").join("rag-cache.jsonl");
    let cached = read_cache(&cache_path);
    if cached.is_empty() {
        return Ok(RagQueryResult { context: "".to_string(), count: 0 });
    }
    let vectors = ai_embeddings(crate::commands::ai::AiEmbeddingsPayload {
        url: payload.endpoint.url.clone(),
        provider: Some(payload.endpoint.provider.clone()),
        model: payload.endpoint.model.clone(),
        token: payload.endpoint.token.clone(),
        input: vec![payload.query.clone()],
    })
    .await?;
    let query_vec = vectors.get(0).cloned().unwrap_or_default();
    let mut scored: Vec<(f32, &RagCacheEntry)> = cached.iter().map(|entry| (cosine_similarity(&query_vec, &entry.embedding), entry)).collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let top = scored.into_iter().take(6).collect::<Vec<_>>();
    let mut parts = Vec::new();
    for (score, entry) in top.iter() {
        parts.push(format!("- {} {} (score {:.3})", entry.kind.to_uppercase(), entry.path, score));
    }
    Ok(RagQueryResult {
        context: if parts.is_empty() { "".to_string() } else { format!("Retrieved context:\n{}", parts.join("\n")) },
        count: cached.len(),
    })
}
