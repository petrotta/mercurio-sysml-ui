use mercurio_symbol_index::{SymbolIndexStore, SymbolRecord};
use mercurio_sysml_semantics::semantic_contract::{
    SemanticElementCore, SemanticElementProjectionView, SemanticElementView, SemanticProvenance,
    SemanticSpan,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::project_root_key::canonical_project_root;
use crate::settings::resolve_mercurio_user_dir;
use crate::symbol_index::refresh_project_semantic_lookup;
use crate::workspace_tree::resolve_workspace_library_path;
use crate::{state::WorkspaceSnapshotCacheEntry, CoreState};

const WORKSPACE_IR_STARTUP_MANIFEST_SCHEMA_VERSION: u32 = 1;
const WORKSPACE_IR_PROJECT_SYMBOL_MANIFEST_SCHEMA_VERSION: u32 = 1;
const WORKSPACE_IR_PROJECT_SYMBOL_SHARD_SCHEMA_VERSION: u32 = 1;
const WORKSPACE_IR_STARTUP_MANIFEST_FILE_NAME: &str = "workspace-startup-v1.json";
const WORKSPACE_IR_PROJECT_SYMBOL_MANIFEST_FILE_NAME: &str = "workspace-project-symbols-v2.json";
const WORKSPACE_IR_PROJECT_SYMBOL_SHARD_FILE_PREFIX: &str = "workspace-project-symbol-shard-v2-";
const WORKSPACE_IR_PROJECT_SYMBOL_SHARD_DIR_NAME: &str = "workspace-project-symbols-v2";
// Early-development assumption: we do not carry read-compatibility for superseded
// workspace cache formats. Old cache files may remain only so global cache clear can remove them.
const WORKSPACE_IR_LEGACY_MONOLITHIC_BINARY_CACHE_FILE_NAME: &str = "workspace-ir-v1.bin";
const WORKSPACE_IR_LEGACY_JSON_CACHE_FILE_NAME: &str = "workspace-ir-v1.json";
const WORKSPACE_IR_LEGACY_SYMBOL_INDEX_BINARY_CACHE_FILE_NAME: &str =
    "workspace-symbol-index-v1.bin";
const WORKSPACE_IR_LEGACY_PROJECT_SYMBOL_PAYLOAD_FILE_NAME: &str = "workspace-symbols-v1.bin";
const WORKSPACE_IR_ROOT_REGISTRY_FILE_NAME: &str = "cache-roots.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceIrStartupManifest {
    schema_version: u32,
    engine_version: String,
    project_root: String,
    written_at_unix_ms: u128,
    stdlib_signature: Option<String>,
    #[serde(default)]
    library_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceIrProjectSymbolManifest {
    schema_version: u32,
    engine_version: String,
    project_root: String,
    written_at_unix_ms: u128,
    #[serde(default)]
    shards: Vec<WorkspaceIrProjectSymbolShardEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceIrProjectSymbolShardEntry {
    file_path: String,
    shard_file_name: String,
    symbol_count: usize,
    semantic_element_count: usize,
    semantic_projection_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceIrProjectSymbolShardPayload {
    schema_version: u32,
    engine_version: String,
    project_root: String,
    file_path: String,
    written_at_unix_ms: u128,
    #[serde(default)]
    symbols: Vec<SymbolRecord>,
    #[serde(default)]
    semantic_elements: Vec<SemanticElementView>,
    #[serde(default)]
    semantic_projections: Vec<SemanticElementProjectionView>,
}

#[derive(Debug, Clone)]
pub(crate) struct WorkspaceIrCacheSnapshot {
    pub(crate) library_path: Option<String>,
}

#[derive(Debug)]
enum WorkspaceIrStartupManifestStatus {
    Valid(WorkspaceIrStartupManifest),
    Missing,
    DeserializeFailed,
    SchemaMismatch,
    EngineMismatch,
    ProjectRootMismatch,
}

#[derive(Debug)]
enum WorkspaceIrProjectSymbolCacheStatus {
    Valid(WorkspaceIrProjectSymbolCache),
    Missing,
    DeserializeFailed,
    SchemaMismatch,
    EngineMismatch,
    ProjectRootMismatch,
    ShardMissing,
    ShardDeserializeFailed,
    ShardSchemaMismatch,
    ShardEngineMismatch,
    ShardProjectRootMismatch,
    ShardFilePathMismatch,
}

#[derive(Debug, Clone)]
struct WorkspaceIrProjectSymbolCache {
    manifest: WorkspaceIrProjectSymbolManifest,
    payloads: Vec<WorkspaceIrProjectSymbolShardPayload>,
}

fn normalized_path_key(path: &str) -> String {
    let resolved = PathBuf::from(path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path));
    resolved
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
}

fn startup_manifest_file_path(project_root: &str) -> PathBuf {
    workspace_cache_dir(project_root).join(WORKSPACE_IR_STARTUP_MANIFEST_FILE_NAME)
}

fn workspace_cache_dir(project_root: &str) -> PathBuf {
    PathBuf::from(canonical_project_root(project_root))
        .join(".mercurio")
        .join("cache")
}

fn project_symbol_manifest_file_path(project_root: &str) -> PathBuf {
    workspace_cache_dir(project_root).join(WORKSPACE_IR_PROJECT_SYMBOL_MANIFEST_FILE_NAME)
}

fn project_symbol_shard_dir(project_root: &str) -> PathBuf {
    workspace_cache_dir(project_root).join(WORKSPACE_IR_PROJECT_SYMBOL_SHARD_DIR_NAME)
}

fn project_symbol_shard_file_path(project_root: &str, shard_file_name: &str) -> PathBuf {
    workspace_cache_dir(project_root).join(shard_file_name)
}

fn legacy_project_symbol_payload_file_path(project_root: &str) -> PathBuf {
    workspace_cache_dir(project_root).join(WORKSPACE_IR_LEGACY_PROJECT_SYMBOL_PAYLOAD_FILE_NAME)
}

fn legacy_monolithic_binary_cache_file_path(project_root: &str) -> PathBuf {
    workspace_cache_dir(project_root).join(WORKSPACE_IR_LEGACY_MONOLITHIC_BINARY_CACHE_FILE_NAME)
}

fn legacy_json_cache_file_path(project_root: &str) -> PathBuf {
    workspace_cache_dir(project_root).join(WORKSPACE_IR_LEGACY_JSON_CACHE_FILE_NAME)
}

fn legacy_symbol_index_binary_cache_file_path(project_root: &str) -> PathBuf {
    workspace_cache_dir(project_root).join(WORKSPACE_IR_LEGACY_SYMBOL_INDEX_BINARY_CACHE_FILE_NAME)
}

fn synthesize_project_semantic_projection(
    project_root: &str,
    symbol: &SymbolRecord,
) -> SemanticElementProjectionView {
    let file_path = {
        let raw = symbol.file_path.trim();
        let path = PathBuf::from(raw);
        if path.is_absolute() {
            path
        } else {
            PathBuf::from(project_root).join(path)
        }
    };
    SemanticElementProjectionView {
        name: symbol.name.clone(),
        qualified_name: symbol.qualified_name.clone(),
        file_path: file_path.to_string_lossy().to_string(),
        metatype_qname: symbol.metatype_qname.clone(),
        classification_qname: None,
        core: Some(SemanticElementCore {
            name: symbol.name.clone(),
            qualified_name: symbol.qualified_name.clone(),
            semantic_kind: Some(symbol.kind.clone()),
            structural_metatype_qname: symbol.metatype_qname.clone(),
            classification_qname: None,
            declared_type_qname: None,
            definition_qname: None,
            owner_qname: symbol.parent_qualified_name.clone(),
            file_path: file_path.to_string_lossy().to_string(),
            span: Some(SemanticSpan {
                start_line: Some(symbol.start_line),
                start_col: Some(symbol.start_col),
                end_line: Some(symbol.end_line),
                end_col: Some(symbol.end_col),
            }),
            provenance: SemanticProvenance::default(),
        }),
        features: Vec::new(),
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let pid = std::process::id();
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("cache");
    let tmp_path = path.with_file_name(format!("{file_name}.tmp-{pid}-{nonce}"));
    fs::write(&tmp_path, bytes).map_err(|e| e.to_string())?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    match fs::rename(&tmp_path, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = fs::remove_file(&tmp_path);
            Err(err.to_string())
        }
    }
}

fn read_startup_manifest_file(
    project_root: &str,
) -> Result<WorkspaceIrStartupManifestStatus, String> {
    let path = startup_manifest_file_path(project_root);
    if !path.exists() {
        return Ok(WorkspaceIrStartupManifestStatus::Missing);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let parsed = match serde_json::from_str::<WorkspaceIrStartupManifest>(&raw) {
        Ok(parsed) => parsed,
        Err(_) => {
            let _ = fs::remove_file(&path);
            return Ok(WorkspaceIrStartupManifestStatus::DeserializeFailed);
        }
    };
    Ok(WorkspaceIrStartupManifestStatus::Valid(parsed))
}

fn read_validated_startup_manifest_file(
    project_root: &str,
) -> Result<Option<WorkspaceIrStartupManifest>, String> {
    let project_root = canonical_project_root(project_root);
    match read_startup_manifest_status(&project_root)? {
        WorkspaceIrStartupManifestStatus::Valid(cache) => Ok(Some(cache)),
        _ => Ok(None),
    }
}

fn read_project_symbol_manifest_file(
    project_root: &str,
) -> Result<WorkspaceIrProjectSymbolCacheStatus, String> {
    let path = project_symbol_manifest_file_path(project_root);
    if !path.exists() {
        return Ok(WorkspaceIrProjectSymbolCacheStatus::Missing);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let parsed = match serde_json::from_str::<WorkspaceIrProjectSymbolManifest>(&raw) {
        Ok(parsed) => parsed,
        Err(_) => {
            let _ = fs::remove_file(&path);
            return Ok(WorkspaceIrProjectSymbolCacheStatus::DeserializeFailed);
        }
    };
    Ok(WorkspaceIrProjectSymbolCacheStatus::Valid(
        WorkspaceIrProjectSymbolCache {
            manifest: parsed,
            payloads: Vec::new(),
        },
    ))
}

fn read_project_symbol_cache_status(
    project_root: &str,
) -> Result<WorkspaceIrProjectSymbolCacheStatus, String> {
    let project_root = canonical_project_root(project_root);
    let cache = match read_project_symbol_manifest_file(&project_root)? {
        WorkspaceIrProjectSymbolCacheStatus::Valid(cache) => cache,
        status => return Ok(status),
    };
    let manifest = cache.manifest;
    if manifest.schema_version != WORKSPACE_IR_PROJECT_SYMBOL_MANIFEST_SCHEMA_VERSION {
        return Ok(WorkspaceIrProjectSymbolCacheStatus::SchemaMismatch);
    }
    if manifest.engine_version != env!("CARGO_PKG_VERSION") {
        return Ok(WorkspaceIrProjectSymbolCacheStatus::EngineMismatch);
    }
    if normalized_path_key(&manifest.project_root) != normalized_path_key(&project_root) {
        return Ok(WorkspaceIrProjectSymbolCacheStatus::ProjectRootMismatch);
    }

    let mut payloads = Vec::with_capacity(manifest.shards.len());
    for shard in &manifest.shards {
        let shard_path = project_symbol_shard_file_path(&project_root, &shard.shard_file_name);
        if !shard_path.exists() {
            return Ok(WorkspaceIrProjectSymbolCacheStatus::ShardMissing);
        }
        let raw = fs::read_to_string(&shard_path).map_err(|e| e.to_string())?;
        let payload = match serde_json::from_str::<WorkspaceIrProjectSymbolShardPayload>(&raw) {
            Ok(payload) => payload,
            Err(_) => {
                let _ = fs::remove_file(&shard_path);
                return Ok(WorkspaceIrProjectSymbolCacheStatus::ShardDeserializeFailed);
            }
        };
        if payload.schema_version != WORKSPACE_IR_PROJECT_SYMBOL_SHARD_SCHEMA_VERSION {
            return Ok(WorkspaceIrProjectSymbolCacheStatus::ShardSchemaMismatch);
        }
        if payload.engine_version != env!("CARGO_PKG_VERSION") {
            return Ok(WorkspaceIrProjectSymbolCacheStatus::ShardEngineMismatch);
        }
        if normalized_path_key(&payload.project_root) != normalized_path_key(&project_root) {
            return Ok(WorkspaceIrProjectSymbolCacheStatus::ShardProjectRootMismatch);
        }
        if normalized_path_key(&payload.file_path) != normalized_path_key(&shard.file_path) {
            return Ok(WorkspaceIrProjectSymbolCacheStatus::ShardFilePathMismatch);
        }
        payloads.push(payload);
    }

    Ok(WorkspaceIrProjectSymbolCacheStatus::Valid(
        WorkspaceIrProjectSymbolCache { manifest, payloads },
    ))
}

fn read_validated_project_symbol_cache(
    project_root: &str,
) -> Result<Option<WorkspaceIrProjectSymbolCache>, String> {
    let project_root = canonical_project_root(project_root);
    match read_project_symbol_cache_status(&project_root)? {
        WorkspaceIrProjectSymbolCacheStatus::Valid(cache) => Ok(Some(cache)),
        _ => Ok(None),
    }
}

fn read_startup_manifest_status(
    project_root: &str,
) -> Result<WorkspaceIrStartupManifestStatus, String> {
    let project_root = canonical_project_root(project_root);
    let cache = match read_startup_manifest_file(&project_root)? {
        WorkspaceIrStartupManifestStatus::Valid(cache) => cache,
        status => return Ok(status),
    };
    if cache.schema_version != WORKSPACE_IR_STARTUP_MANIFEST_SCHEMA_VERSION {
        return Ok(WorkspaceIrStartupManifestStatus::SchemaMismatch);
    }
    if cache.engine_version != env!("CARGO_PKG_VERSION") {
        return Ok(WorkspaceIrStartupManifestStatus::EngineMismatch);
    }
    if normalized_path_key(&cache.project_root) != normalized_path_key(&project_root) {
        return Ok(WorkspaceIrStartupManifestStatus::ProjectRootMismatch);
    }
    Ok(WorkspaceIrStartupManifestStatus::Valid(cache))
}

pub(crate) fn describe_workspace_startup_cache_miss(
    project_root: &str,
) -> Result<Option<&'static str>, String> {
    match read_startup_manifest_status(project_root)? {
        WorkspaceIrStartupManifestStatus::Missing => return Ok(Some("startup_manifest_missing")),
        WorkspaceIrStartupManifestStatus::DeserializeFailed => {
            return Ok(Some("startup_manifest_deserialize_failed"));
        }
        WorkspaceIrStartupManifestStatus::SchemaMismatch => {
            return Ok(Some("startup_manifest_schema_mismatch"));
        }
        WorkspaceIrStartupManifestStatus::EngineMismatch => {
            return Ok(Some("startup_manifest_engine_mismatch"));
        }
        WorkspaceIrStartupManifestStatus::ProjectRootMismatch => {
            return Ok(Some("startup_manifest_project_root_mismatch"));
        }
        WorkspaceIrStartupManifestStatus::Valid(_) => {}
    }
    match read_project_symbol_cache_status(project_root)? {
        WorkspaceIrProjectSymbolCacheStatus::Missing => {
            Ok(Some("project_symbol_manifest_missing"))
        }
        WorkspaceIrProjectSymbolCacheStatus::DeserializeFailed => {
            Ok(Some("project_symbol_manifest_deserialize_failed"))
        }
        WorkspaceIrProjectSymbolCacheStatus::SchemaMismatch => {
            Ok(Some("project_symbol_manifest_schema_mismatch"))
        }
        WorkspaceIrProjectSymbolCacheStatus::EngineMismatch => {
            Ok(Some("project_symbol_manifest_engine_mismatch"))
        }
        WorkspaceIrProjectSymbolCacheStatus::ProjectRootMismatch => {
            Ok(Some("project_symbol_manifest_project_root_mismatch"))
        }
        WorkspaceIrProjectSymbolCacheStatus::ShardMissing => {
            Ok(Some("project_symbol_shard_missing"))
        }
        WorkspaceIrProjectSymbolCacheStatus::ShardDeserializeFailed => {
            Ok(Some("project_symbol_shard_deserialize_failed"))
        }
        WorkspaceIrProjectSymbolCacheStatus::ShardSchemaMismatch => {
            Ok(Some("project_symbol_shard_schema_mismatch"))
        }
        WorkspaceIrProjectSymbolCacheStatus::ShardEngineMismatch => {
            Ok(Some("project_symbol_shard_engine_mismatch"))
        }
        WorkspaceIrProjectSymbolCacheStatus::ShardProjectRootMismatch => {
            Ok(Some("project_symbol_shard_project_root_mismatch"))
        }
        WorkspaceIrProjectSymbolCacheStatus::ShardFilePathMismatch => {
            Ok(Some("project_symbol_shard_file_path_mismatch"))
        }
        WorkspaceIrProjectSymbolCacheStatus::Valid(_) => Ok(None),
    }
}

fn cache_root_registry_path() -> Result<PathBuf, String> {
    Ok(resolve_mercurio_user_dir().join(WORKSPACE_IR_ROOT_REGISTRY_FILE_NAME))
}

fn load_cache_root_registry() -> Result<Vec<String>, String> {
    let path = cache_root_registry_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let parsed = match serde_json::from_str::<Vec<String>>(&raw) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(Vec::new()),
    };
    let mut unique = BTreeSet::<String>::new();
    for root in parsed {
        let canonical = canonical_project_root(&root);
        if !canonical.trim().is_empty() {
            unique.insert(canonical);
        }
    }
    Ok(unique.into_iter().collect())
}

fn write_cache_root_registry(roots: &[String]) -> Result<(), String> {
    let path = cache_root_registry_path()?;
    let bytes = serde_json::to_vec(roots).map_err(|e| e.to_string())?;
    write_atomic(&path, &bytes)
}

fn register_cache_root(project_root: &str) -> Result<(), String> {
    let canonical_root = canonical_project_root(project_root);
    if canonical_root.trim().is_empty() {
        return Ok(());
    }
    let mut roots = load_cache_root_registry()?;
    if roots.iter().any(|existing| existing == &canonical_root) {
        return Ok(());
    }
    roots.push(canonical_root);
    roots.sort();
    write_cache_root_registry(&roots)
}

fn remove_file_if_exists(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(path).map_err(|e| e.to_string())?;
    Ok(true)
}

fn remove_project_symbol_cache_artifacts(project_root: &str) -> Result<usize, String> {
    let mut deleted = 0usize;
    if remove_file_if_exists(&project_symbol_manifest_file_path(project_root))? {
        deleted += 1;
    }
    let cache_dir = workspace_cache_dir(project_root);
    if cache_dir.exists() {
        for entry in fs::read_dir(&cache_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if !file_name.starts_with(WORKSPACE_IR_PROJECT_SYMBOL_SHARD_FILE_PREFIX) {
                continue;
            }
            fs::remove_file(&path).map_err(|e| e.to_string())?;
            deleted += 1;
        }
    }
    let shard_dir = project_symbol_shard_dir(project_root);
    if shard_dir.exists() {
        fs::remove_dir_all(&shard_dir).map_err(|e| e.to_string())?;
        deleted += 1;
    }
    Ok(deleted)
}

pub(crate) fn clear_all_workspace_ir_caches() -> Result<usize, String> {
    let roots = load_cache_root_registry()?;
    let mut delete_failures = Vec::<String>::new();
    let mut retained = Vec::<String>::new();
    let mut deleted = 0usize;

    for root in roots {
        let mut root_failed = false;
        match remove_project_symbol_cache_artifacts(&root) {
            Ok(count) => {
                deleted += count;
            }
            Err(error) => {
                root_failed = true;
                delete_failures.push(format!(
                    "{}: {}",
                    project_symbol_manifest_file_path(&root).to_string_lossy(),
                    error
                ));
            }
        }
        for path in [
            startup_manifest_file_path(&root),
            legacy_project_symbol_payload_file_path(&root),
            legacy_monolithic_binary_cache_file_path(&root),
            legacy_json_cache_file_path(&root),
            legacy_symbol_index_binary_cache_file_path(&root),
        ] {
            if !path.exists() {
                continue;
            }
            match fs::remove_file(&path) {
                Ok(()) => {
                    deleted += 1;
                }
                Err(error) => {
                    root_failed = true;
                    delete_failures.push(format!("{}: {}", path.to_string_lossy(), error));
                }
            }
        }
        if root_failed {
            retained.push(root);
        }
    }

    write_cache_root_registry(&retained)?;
    if delete_failures.is_empty() {
        Ok(deleted)
    } else {
        Err(format!(
            "Failed to delete workspace IR cache files: {}",
            delete_failures.join("; ")
        ))
    }
}

pub(crate) fn clear_workspace_ir_cache(project_root: &str) -> Result<usize, String> {
    let root = canonical_project_root(project_root);
    let mut deleted = 0usize;
    let mut failures = Vec::<String>::new();
    match remove_project_symbol_cache_artifacts(&root) {
        Ok(count) => {
            deleted += count;
        }
        Err(error) => failures.push(format!(
            "{}: {}",
            project_symbol_manifest_file_path(&root).to_string_lossy(),
            error
        )),
    }
    for path in [
        startup_manifest_file_path(&root),
        legacy_project_symbol_payload_file_path(&root),
        legacy_monolithic_binary_cache_file_path(&root),
        legacy_json_cache_file_path(&root),
        legacy_symbol_index_binary_cache_file_path(&root),
    ] {
        if !path.exists() {
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => {
                deleted += 1;
            }
            Err(error) => failures.push(format!("{}: {}", path.to_string_lossy(), error)),
        }
    }
    if failures.is_empty() {
        Ok(deleted)
    } else {
        Err(format!(
            "Failed to delete workspace IR cache files for root '{}': {}",
            root,
            failures.join("; ")
        ))
    }
}

pub(crate) fn load_workspace_ir_cache_snapshot(
    project_root: &str,
) -> Result<Option<WorkspaceIrCacheSnapshot>, String> {
    let Some(cache) = read_validated_startup_manifest_file(project_root)? else {
        return Ok(None);
    };
    Ok(Some(WorkspaceIrCacheSnapshot {
        library_path: cache.library_path,
    }))
}

pub(crate) fn persist_workspace_ir_cache(
    state: &CoreState,
    project_root: &str,
    stdlib_signature: Option<&str>,
) -> Result<(), String> {
    let _persist_guard = state
        .workspace_ir_persist_lock
        .lock()
        .map_err(|_| "Workspace IR persist lock poisoned".to_string())?;
    let raw_project_root = project_root.trim().to_string();
    let project_root = canonical_project_root(project_root);
    if project_root.trim().is_empty() {
        return Err("Project root is empty".to_string());
    }
    let project_root_path = PathBuf::from(&project_root);
    let mut symbols = {
        let store = state
            .symbol_index
            .lock()
            .map_err(|_| "Symbol index lock poisoned".to_string())?;
        let mut rows = store.project_symbols(&project_root, None);
        if !raw_project_root.is_empty() && raw_project_root != project_root {
            rows.extend(store.project_symbols(&raw_project_root, None));
        }
        rows
    };
    symbols.sort_by(|a, b| {
        a.file_path
            .cmp(&b.file_path)
            .then(a.start_line.cmp(&b.start_line))
            .then(a.start_col.cmp(&b.start_col))
            .then(a.qualified_name.cmp(&b.qualified_name))
            .then(a.kind.cmp(&b.kind))
    });
    symbols.dedup_by(|left, right| left.id == right.id);
    let semantic_elements = {
        let mut root_prefixes = vec![format!("project-semantic|{}|", project_root)];
        if !raw_project_root.is_empty() && raw_project_root != project_root {
            root_prefixes.push(format!("project-semantic|{}|", raw_project_root));
        }
        let mut by_file_and_qname = BTreeMap::<(String, String), SemanticElementView>::new();
        let cache = state
            .workspace_snapshot_cache
            .lock()
            .map_err(|_| "Workspace snapshot cache lock poisoned".to_string())?;
        for (key, entry) in cache.iter() {
            if !root_prefixes.iter().any(|prefix| key.starts_with(prefix)) {
                continue;
            }
            let WorkspaceSnapshotCacheEntry::ProjectSemantic(elements) = entry else {
                continue;
            };
            for element in elements.iter() {
                let dedupe_key = (element.file_path.clone(), element.qualified_name.clone());
                let should_replace = by_file_and_qname
                    .get(&dedupe_key)
                    .map(|existing| {
                        existing.attributes.len() < element.attributes.len()
                            || (existing.metatype_qname.is_none()
                                && element.metatype_qname.is_some())
                    })
                    .unwrap_or(true);
                if should_replace {
                    by_file_and_qname.insert(dedupe_key, element.clone());
                }
            }
        }
        by_file_and_qname.into_values().collect::<Vec<_>>()
    };
    let semantic_projections = {
        let mut root_prefixes = vec![format!("project-semantic|{}|", project_root)];
        if !raw_project_root.is_empty() && raw_project_root != project_root {
            root_prefixes.push(format!("project-semantic|{}|", raw_project_root));
        }
        let mut by_file_and_qname =
            BTreeMap::<(String, String), SemanticElementProjectionView>::new();
        let cache = state
            .workspace_snapshot_cache
            .lock()
            .map_err(|_| "Workspace snapshot cache lock poisoned".to_string())?;
        for (key, entry) in cache.iter() {
            if !root_prefixes.iter().any(|prefix| key.starts_with(prefix)) {
                continue;
            }
            let WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(elements) = entry else {
                continue;
            };
            for element in elements.iter() {
                let dedupe_key = (element.file_path.clone(), element.qualified_name.clone());
                let should_replace = by_file_and_qname
                    .get(&dedupe_key)
                    .map(|existing| existing.features.len() < element.features.len())
                    .unwrap_or(true);
                if should_replace {
                    by_file_and_qname.insert(dedupe_key, element.clone());
                }
            }
        }
        by_file_and_qname.into_values().collect::<Vec<_>>()
    };
    let semantic_projections = if semantic_projections.is_empty() {
        let mut by_file_and_qname =
            BTreeMap::<(String, String), SemanticElementProjectionView>::new();
        for symbol in &symbols {
            let projection = synthesize_project_semantic_projection(&project_root, symbol);
            let dedupe_key = (
                projection.file_path.clone(),
                projection.qualified_name.clone(),
            );
            by_file_and_qname.entry(dedupe_key).or_insert(projection);
        }
        by_file_and_qname.into_values().collect::<Vec<_>>()
    } else {
        semantic_projections
    };
    let written_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let library_path = resolve_workspace_library_path(state, &project_root_path)
        .map(|path| path.to_string_lossy().to_string());
    let full_symbol_index_snapshot = {
        let store = state
            .symbol_index
            .lock()
            .map_err(|_| "Symbol index lock poisoned".to_string())?;
        store.snapshot_for_root(&project_root)
    };
    let derived_stdlib_signature = if let Some(signature) = stdlib_signature {
        Some(signature.to_string())
    } else {
        let normalized_library_key = library_path
            .as_deref()
            .map(normalized_path_key)
            .unwrap_or_default();
        if normalized_library_key.is_empty() {
            full_symbol_index_snapshot
                .stdlib_freshness
                .first()
                .map(|(_, signature)| signature.clone())
        } else {
            full_symbol_index_snapshot
                .stdlib_freshness
                .iter()
                .find(|(library_key, _)| *library_key == normalized_library_key)
                .map(|(_, signature)| signature.clone())
        }
    };
    let mut symbols_by_file = BTreeMap::<String, Vec<SymbolRecord>>::new();
    for symbol in symbols {
        symbols_by_file
            .entry(symbol.file_path.clone())
            .or_default()
            .push(symbol);
    }
    let mut semantic_elements_by_file = BTreeMap::<String, Vec<SemanticElementView>>::new();
    for element in semantic_elements {
        semantic_elements_by_file
            .entry(element.file_path.clone())
            .or_default()
            .push(element);
    }
    let mut semantic_projections_by_file =
        BTreeMap::<String, Vec<SemanticElementProjectionView>>::new();
    for projection in semantic_projections {
        semantic_projections_by_file
            .entry(projection.file_path.clone())
            .or_default()
            .push(projection);
    }

    let mut shard_entries = Vec::<WorkspaceIrProjectSymbolShardEntry>::new();
    let mut file_paths = BTreeSet::<String>::new();
    file_paths.extend(symbols_by_file.keys().cloned());
    file_paths.extend(semantic_elements_by_file.keys().cloned());
    file_paths.extend(semantic_projections_by_file.keys().cloned());

    for (index, file_path) in file_paths.into_iter().enumerate() {
        let symbols = symbols_by_file.remove(&file_path).unwrap_or_default();
        let semantic_elements = semantic_elements_by_file.remove(&file_path).unwrap_or_default();
        let semantic_projections = semantic_projections_by_file.remove(&file_path).unwrap_or_default();
        let shard_file_name = format!(
            "{}{written_at_unix_ms}-{index:04}.json",
            WORKSPACE_IR_PROJECT_SYMBOL_SHARD_FILE_PREFIX
        );
        let shard_payload = WorkspaceIrProjectSymbolShardPayload {
            schema_version: WORKSPACE_IR_PROJECT_SYMBOL_SHARD_SCHEMA_VERSION,
            engine_version: env!("CARGO_PKG_VERSION").to_string(),
            project_root: project_root.to_string(),
            file_path: file_path.clone(),
            written_at_unix_ms,
            symbols: symbols.clone(),
            semantic_elements: semantic_elements.clone(),
            semantic_projections: semantic_projections.clone(),
        };
        let shard_payload_bytes =
            serde_json::to_vec(&shard_payload).map_err(|e| e.to_string())?;
        let shard_path = project_symbol_shard_file_path(&project_root, &shard_file_name);
        write_atomic(
            &shard_path,
            &shard_payload_bytes,
        )?;
        shard_entries.push(WorkspaceIrProjectSymbolShardEntry {
            file_path,
            shard_file_name,
            symbol_count: symbols.len(),
            semantic_element_count: semantic_elements.len(),
            semantic_projection_count: semantic_projections.len(),
        });
    }

    let project_symbol_manifest = WorkspaceIrProjectSymbolManifest {
        schema_version: WORKSPACE_IR_PROJECT_SYMBOL_MANIFEST_SCHEMA_VERSION,
        engine_version: env!("CARGO_PKG_VERSION").to_string(),
        project_root: project_root.to_string(),
        written_at_unix_ms,
        shards: shard_entries,
    };
    let startup_manifest = WorkspaceIrStartupManifest {
        schema_version: WORKSPACE_IR_STARTUP_MANIFEST_SCHEMA_VERSION,
        engine_version: env!("CARGO_PKG_VERSION").to_string(),
        project_root: project_root.to_string(),
        written_at_unix_ms,
        stdlib_signature: derived_stdlib_signature,
        library_path,
    };
    let project_symbol_manifest_bytes =
        serde_json::to_vec(&project_symbol_manifest).map_err(|e| e.to_string())?;
    write_atomic(
        &project_symbol_manifest_file_path(&project_root),
        &project_symbol_manifest_bytes,
    )?;
    let startup_manifest_bytes =
        serde_json::to_vec(&startup_manifest).map_err(|e| e.to_string())?;
    write_atomic(
        &startup_manifest_file_path(&project_root),
        &startup_manifest_bytes,
    )?;
    register_cache_root(&project_root)?;
    Ok(())
}

fn clear_project_semantic_cache_entries(
    state: &CoreState,
    root_keys: &[String],
) -> Result<(), String> {
    {
        let mut workspace_cache = state
            .workspace_snapshot_cache
            .lock()
            .map_err(|_| "Workspace snapshot cache lock poisoned".to_string())?;
        for root_key in root_keys {
            let root_prefix = format!("project-semantic|{}|", root_key);
            workspace_cache.retain(|key, _| !key.starts_with(&root_prefix));
        }
    }
    let mut lookup_cache = state
        .project_semantic_lookup_cache
        .lock()
        .map_err(|_| "Project semantic lookup cache lock poisoned".to_string())?;
    for root_key in root_keys {
        lookup_cache.remove(&canonical_project_root(root_key));
    }
    Ok(())
}

fn seed_semantic_state_from_cache_payload(
    state: &CoreState,
    project_root: &str,
    root_keys: &[String],
    semantic_elements: Vec<SemanticElementView>,
    semantic_projections: Vec<SemanticElementProjectionView>,
) -> Result<bool, String> {
    clear_project_semantic_cache_entries(state, root_keys)?;
    if semantic_elements.is_empty() && semantic_projections.is_empty() {
        return Ok(false);
    }

    {
        let mut workspace_cache = state
            .workspace_snapshot_cache
            .lock()
            .map_err(|_| "Workspace snapshot cache lock poisoned".to_string())?;
        for root_key in root_keys {
            if !semantic_elements.is_empty() {
                workspace_cache.insert(
                    format!("project-semantic|{}|workspace-ir-elements", root_key),
                    WorkspaceSnapshotCacheEntry::ProjectSemantic(std::sync::Arc::new(
                        semantic_elements.clone(),
                    )),
                );
            }
            if !semantic_projections.is_empty() {
                workspace_cache.insert(
                    format!("project-semantic|{}|workspace-ir-projection", root_key),
                    WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(std::sync::Arc::new(
                        semantic_projections.clone(),
                    )),
                );
            }
        }
    }

    let _ = refresh_project_semantic_lookup(
        state,
        project_root,
        semantic_elements.as_slice(),
        semantic_projections.as_slice(),
    );
    Ok(true)
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct WorkspaceIrSymbolSeedSummary {
    pub(crate) cache_hit: bool,
    pub(crate) seed_symbol_index_ms: u64,
    pub(crate) seed_projection_ms: u64,
}

pub(crate) fn seed_workspace_symbol_state_from_workspace_ir_cache(
    state: &CoreState,
    project_root: &str,
) -> Result<WorkspaceIrSymbolSeedSummary, String> {
    let raw_project_root = project_root.trim().to_string();
    let project_root = canonical_project_root(project_root);
    let Some(cache) = read_validated_project_symbol_cache(&project_root)? else {
        return Ok(WorkspaceIrSymbolSeedSummary::default());
    };
    let mut semantic_elements = Vec::<SemanticElementView>::new();
    let mut semantic_projections = Vec::<SemanticElementProjectionView>::new();
    let mut project_symbol_files = Vec::<(String, Vec<SymbolRecord>)>::new();
    for payload in cache.payloads {
        semantic_elements.extend(payload.semantic_elements);
        semantic_projections.extend(payload.semantic_projections);
        project_symbol_files.push((payload.file_path, payload.symbols));
    }
    let mut root_keys = vec![project_root.clone()];
    if !raw_project_root.is_empty() && raw_project_root != project_root {
        root_keys.push(raw_project_root.clone());
    }
    let seed_symbol_index_started_at = Instant::now();
    let mut store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;
    store.replace_project_symbols_for_root(&project_root, project_symbol_files);
    store.rebuild_symbol_mappings(&project_root);
    let semantic_projections = if semantic_projections.is_empty() {
        let mut by_file_and_qname =
            BTreeMap::<(String, String), SemanticElementProjectionView>::new();
        for symbol in store.project_symbols(&project_root, None) {
            let projection = synthesize_project_semantic_projection(&project_root, &symbol);
            let dedupe_key = (
                projection.file_path.clone(),
                projection.qualified_name.clone(),
            );
            by_file_and_qname.entry(dedupe_key).or_insert(projection);
        }
        by_file_and_qname.into_values().collect::<Vec<_>>()
    } else {
        semantic_projections
    };
    drop(store);
    let seed_symbol_index_ms = seed_symbol_index_started_at.elapsed().as_millis() as u64;
    let seed_projection_started_at = Instant::now();
    let _ = seed_semantic_state_from_cache_payload(
        state,
        &project_root,
        &root_keys,
        semantic_elements,
        semantic_projections,
    )?;
    Ok(WorkspaceIrSymbolSeedSummary {
        cache_hit: true,
        seed_symbol_index_ms,
        seed_projection_ms: seed_projection_started_at.elapsed().as_millis() as u64,
    })
}

pub(crate) fn seed_symbol_index_from_workspace_ir_cache(
    state: &CoreState,
    project_root: &str,
) -> Result<bool, String> {
    Ok(seed_workspace_symbol_state_from_workspace_ir_cache(state, project_root)?.cache_hit)
}

pub(crate) fn seed_semantic_projection_cache_from_workspace_ir_cache(
    state: &CoreState,
    project_root: &str,
) -> Result<bool, String> {
    let raw_project_root = project_root.trim().to_string();
    let project_root = canonical_project_root(project_root);
    let Some(cache) = read_validated_project_symbol_cache(&project_root)? else {
        return Ok(false);
    };
    let mut semantic_elements = Vec::<SemanticElementView>::new();
    let mut semantic_projections = Vec::<SemanticElementProjectionView>::new();
    for payload in cache.payloads {
        semantic_elements.extend(payload.semantic_elements);
        semantic_projections.extend(payload.semantic_projections);
    }
    let mut root_keys = vec![project_root.clone()];
    if !raw_project_root.is_empty() && raw_project_root != project_root {
        root_keys.push(raw_project_root.clone());
    }

    seed_semantic_state_from_cache_payload(
        state,
        &project_root,
        &root_keys,
        semantic_elements,
        semantic_projections,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{settings::AppSettings, state::WorkspaceSnapshotCacheEntry};
    use mercurio_symbol_index::SymbolIndexStore;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn symbol(
        id: &str,
        project_root: &str,
        scope: mercurio_symbol_index::Scope,
        file_path: &str,
        qualified_name: &str,
    ) -> SymbolRecord {
        SymbolRecord {
            id: id.to_string(),
            project_root: project_root.to_string(),
            library_key: if scope == mercurio_symbol_index::Scope::Stdlib {
                Some("stdlib-key".to_string())
            } else {
                None
            },
            scope,
            name: qualified_name
                .rsplit("::")
                .next()
                .unwrap_or(qualified_name)
                .to_string(),
            qualified_name: qualified_name.to_string(),
            parent_qualified_name: qualified_name
                .rsplit_once("::")
                .map(|(parent, _)| parent.to_string()),
            kind: "Package".to_string(),
            metatype_qname: Some("KerML::Kernel::Package".to_string()),
            file_path: file_path.to_string(),
            start_line: 1,
            start_col: 1,
            end_line: 1,
            end_col: 1,
            doc_text: None,
            properties_json: None,
        }
    }

    fn projection(file_path: &str, qualified_name: &str) -> SemanticElementProjectionView {
        SemanticElementProjectionView {
            name: qualified_name
                .rsplit("::")
                .next()
                .unwrap_or(qualified_name)
                .to_string(),
            qualified_name: qualified_name.to_string(),
            file_path: file_path.to_string(),
            metatype_qname: Some("sysml::Package".to_string()),
            classification_qname: None,
            core: None,
            features: vec![],
        }
    }

    fn semantic_element(file_path: &str, qualified_name: &str) -> SemanticElementView {
        let mut attributes = std::collections::HashMap::new();
        attributes.insert("declaredName".to_string(), "Main".to_string());
        attributes.insert("semantic_kind".to_string(), "Package".to_string());
        SemanticElementView {
            name: qualified_name
                .rsplit("::")
                .next()
                .unwrap_or(qualified_name)
                .to_string(),
            qualified_name: qualified_name.to_string(),
            metatype_qname: Some("sysml::Package".to_string()),
            classification_qname: None,
            file_path: file_path.to_string(),
            core: None,
            typed_attributes: std::collections::BTreeMap::new(),
            attributes,
        }
    }

    #[test]
    fn workspace_ir_cache_round_trips_into_symbol_index() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_workspace_ir_cache_{stamp}"));
        fs::create_dir_all(&root).expect("create root");
        let project_root = root.to_string_lossy().to_string();
        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());

        {
            let mut store = state.symbol_index.lock().expect("index lock");
            store.upsert_symbols_for_file(
                &project_root,
                "main.sysml",
                vec![symbol(
                    "p1",
                    &project_root,
                    mercurio_symbol_index::Scope::Project,
                    "main.sysml",
                    "Demo::Main",
                )],
            );
            store.upsert_symbols_for_file(
                &project_root,
                "Kernel.kerml",
                vec![symbol(
                    "l1",
                    &project_root,
                    mercurio_symbol_index::Scope::Stdlib,
                    "Kernel.kerml",
                    "KerML::Kernel::Package",
                )],
            );
            store.rebuild_symbol_mappings(&project_root);
        }
        {
            let mut workspace_cache = state
                .workspace_snapshot_cache
                .lock()
                .expect("workspace cache lock");
            workspace_cache.insert(
                format!("project-semantic|{}|typed-full", project_root),
                WorkspaceSnapshotCacheEntry::ProjectSemantic(std::sync::Arc::new(vec![
                    semantic_element("main.sysml", "Demo::Main"),
                ])),
            );
            workspace_cache.insert(
                format!("project-semantic|{}|typed", project_root),
                WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(std::sync::Arc::new(vec![
                    projection("main.sysml", "Demo::Main"),
                ])),
            );
        }
        persist_workspace_ir_cache(&state, &project_root, Some("sig-a"))
            .expect("persist workspace cache");

        state
            .clear_in_memory_caches_for_tests()
            .expect("clear runtime caches");
        {
            let store = state.symbol_index.lock().expect("index lock");
            assert!(store.project_symbols(&project_root, None).is_empty());
        }

        let seeded = seed_symbol_index_from_workspace_ir_cache(&state, &project_root)
            .expect("seed from cache");
        assert!(seeded);
        {
            let store = state.symbol_index.lock().expect("index lock");
            assert_eq!(store.project_symbols(&project_root, None).len(), 1);
            assert_eq!(store.library_symbols(&project_root, None).len(), 0);
        }
        {
            let workspace_cache = state
                .workspace_snapshot_cache
                .lock()
                .expect("workspace cache lock");
            let restored_projection = workspace_cache.iter().find_map(|(key, entry)| match entry {
                WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(elements)
                    if key.starts_with(&format!("project-semantic|{}|", project_root)) =>
                {
                    Some(elements.clone())
                }
                _ => None,
            });
            let restored_projection = restored_projection.expect("restored projection cache");
            assert!(restored_projection
                .iter()
                .any(|element| element.qualified_name == "Demo::Main"));
            let restored_semantic = workspace_cache.iter().find_map(|(key, entry)| match entry {
                WorkspaceSnapshotCacheEntry::ProjectSemantic(elements)
                    if key.starts_with(&format!("project-semantic|{}|", project_root)) =>
                {
                    Some(elements.clone())
                }
                _ => None,
            });
            let restored_semantic = restored_semantic.expect("restored semantic cache");
            assert!(restored_semantic
                .iter()
                .any(|element| element.qualified_name == "Demo::Main"
                    && element.attributes.contains_key("declaredName")));
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn workspace_ir_cache_persists_startup_manifest_and_project_symbol_manifest_separately() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_workspace_ir_split_cache_{stamp}"));
        fs::create_dir_all(&root).expect("create root");
        fs::write(root.join("main.sysml"), "package Demo {}").expect("write project file");
        let project_root = root.to_string_lossy().to_string();
        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());

        persist_workspace_ir_cache(&state, &project_root, Some("sig-split"))
            .expect("persist split workspace cache");

        assert!(startup_manifest_file_path(&project_root).exists());
        assert!(project_symbol_manifest_file_path(&project_root).exists());
        assert!(!legacy_monolithic_binary_cache_file_path(&project_root).exists());

        let startup_manifest = read_validated_startup_manifest_file(&project_root)
            .expect("read startup manifest")
            .expect("startup manifest exists");
        assert_eq!(
            startup_manifest.stdlib_signature.as_deref(),
            Some("sig-split")
        );

        let project_symbol_cache = read_validated_project_symbol_cache(&project_root)
            .expect("read project symbol cache")
            .expect("project symbol cache exists");
        assert!(project_symbol_cache.manifest.shards.is_empty());
        assert!(project_symbol_cache.payloads.is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn workspace_ir_cache_restore_preserves_existing_library_symbols_and_freshness() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("mercurio_workspace_ir_binary_restore_{stamp}"));
        fs::create_dir_all(&root).expect("create root");
        let project_root = root.to_string_lossy().to_string();
        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());

        {
            let mut store = state.symbol_index.lock().expect("index lock");
            store.upsert_symbols_for_file(
                &project_root,
                "main.sysml",
                vec![symbol(
                    "p1",
                    &project_root,
                    mercurio_symbol_index::Scope::Project,
                    "main.sysml",
                    "Demo::Main",
                )],
            );
            store.upsert_symbols_for_file(
                &project_root,
                "Kernel.kerml",
                vec![symbol(
                    "l1",
                    &project_root,
                    mercurio_symbol_index::Scope::Stdlib,
                    "Kernel.kerml",
                    "KerML::Kernel::Package",
                )],
            );
            store.mark_stdlib_indexed(&project_root, "stdlib-key", "sig-lib");
            store.rebuild_symbol_mappings(&project_root);
        }

        persist_workspace_ir_cache(&state, &project_root, Some("sig-lib"))
            .expect("persist workspace cache");

        state
            .clear_in_memory_caches_for_tests()
            .expect("clear runtime caches");
        {
            let mut store = state.symbol_index.lock().expect("index lock");
            store.upsert_symbols_for_file(
                &project_root,
                "Kernel.kerml",
                vec![symbol(
                    "l1",
                    &project_root,
                    mercurio_symbol_index::Scope::Stdlib,
                    "Kernel.kerml",
                    "KerML::Kernel::Package",
                )],
            );
            store.mark_stdlib_indexed(&project_root, "stdlib-key", "sig-lib");
        }

        let seeded = seed_symbol_index_from_workspace_ir_cache(&state, &project_root)
            .expect("seed from cache");
        assert!(seeded);

        let store = state.symbol_index.lock().expect("index lock");
        assert_eq!(store.project_symbols(&project_root, None).len(), 1);
        assert_eq!(store.library_symbols(&project_root, None).len(), 1);
        assert!(store.is_stdlib_index_fresh(&project_root, "stdlib-key", "sig-lib"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn workspace_ir_cache_synthesizes_projection_rows_when_live_cache_is_empty() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("mercurio_workspace_ir_projection_synth_{stamp}"));
        fs::create_dir_all(&root).expect("create root");
        let project_root = root.to_string_lossy().to_string();
        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());

        {
            let mut store = state.symbol_index.lock().expect("index lock");
            store.upsert_symbols_for_file(
                &project_root,
                "main.sysml",
                vec![symbol(
                    "p1",
                    &project_root,
                    mercurio_symbol_index::Scope::Project,
                    "main.sysml",
                    "Demo::Main",
                )],
            );
            store.rebuild_symbol_mappings(&project_root);
        }

        persist_workspace_ir_cache(&state, &project_root, Some("sig-b"))
            .expect("persist workspace cache");

        state
            .clear_in_memory_caches_for_tests()
            .expect("clear runtime caches");

        let seeded = seed_symbol_index_from_workspace_ir_cache(&state, &project_root)
            .expect("seed from cache");
        assert!(seeded);

        let workspace_cache = state
            .workspace_snapshot_cache
            .lock()
            .expect("workspace cache lock");
        let restored_projection = workspace_cache.iter().find_map(|(key, entry)| match entry {
            WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(elements)
                if key.starts_with(&format!("project-semantic|{}|", project_root)) =>
            {
                Some(elements.clone())
            }
            _ => None,
        });
        let restored_projection =
            restored_projection.expect("restored synthesized projection cache");
        assert!(restored_projection
            .iter()
            .any(|element| element.qualified_name == "Demo::Main"));

        let _ = fs::remove_dir_all(&root);
    }
}
