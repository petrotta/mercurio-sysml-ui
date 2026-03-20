use mercurio_symbol_index::{SymbolIndexStore, SymbolRecord};
use mercurio_sysml_semantics::semantic_contract::SemanticElementProjectionView;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::project_root_key::canonical_project_root;
use crate::settings::resolve_mercurio_user_dir;
use crate::state::PendingWorkspaceIrPersist;
use crate::symbol_index::refresh_project_semantic_lookup;
use crate::workspace_tree::{
    collect_library_tree_manifest, collect_tree_manifest, WorkspaceTreeEntryView,
};
use crate::{state::WorkspaceSnapshotCacheEntry, CoreState};

const WORKSPACE_IR_SCHEMA_VERSION: u32 = 4;
const WORKSPACE_IR_CACHE_FILE_NAME: &str = "workspace-ir-v1.json";
const WORKSPACE_IR_PERSIST_DEBOUNCE_MS: u64 = 200;
const WORKSPACE_IR_ROOT_REGISTRY_FILE_NAME: &str = "cache-roots.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceIrCache {
    schema_version: u32,
    engine_version: String,
    project_root: String,
    written_at_unix_ms: u128,
    stdlib_signature: Option<String>,
    #[serde(default)]
    library_path: Option<String>,
    #[serde(default)]
    project_tree: Vec<WorkspaceTreeEntryView>,
    #[serde(default)]
    library_tree: Vec<WorkspaceTreeEntryView>,
    symbols: Vec<SymbolRecord>,
    #[serde(default)]
    semantic_projections: Vec<SemanticElementProjectionView>,
}

#[derive(Debug, Clone)]
pub(crate) struct WorkspaceIrCacheSnapshot {
    pub(crate) library_path: Option<String>,
    pub(crate) stdlib_signature: Option<String>,
    pub(crate) project_tree: Vec<WorkspaceTreeEntryView>,
    pub(crate) library_tree: Vec<WorkspaceTreeEntryView>,
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

fn cache_file_path(project_root: &str) -> PathBuf {
    PathBuf::from(canonical_project_root(project_root))
        .join(".mercurio")
        .join("cache")
        .join(WORKSPACE_IR_CACHE_FILE_NAME)
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
        features: Vec::new(),
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp_path = path.with_extension("tmp");
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

fn read_cache_file(project_root: &str) -> Result<Option<WorkspaceIrCache>, String> {
    let path = cache_file_path(project_root);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let parsed: WorkspaceIrCache = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(Some(parsed))
}

fn read_validated_cache_file(project_root: &str) -> Result<Option<WorkspaceIrCache>, String> {
    let project_root = canonical_project_root(project_root);
    let Some(cache) = read_cache_file(&project_root)? else {
        return Ok(None);
    };
    if cache.schema_version != WORKSPACE_IR_SCHEMA_VERSION {
        return Ok(None);
    }
    if cache.engine_version != env!("CARGO_PKG_VERSION") {
        return Ok(None);
    }
    if normalized_path_key(&cache.project_root) != normalized_path_key(&project_root) {
        return Ok(None);
    }
    Ok(Some(cache))
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
    let parsed = serde_json::from_str::<Vec<String>>(&raw).map_err(|e| e.to_string())?;
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

pub(crate) fn clear_all_workspace_ir_caches() -> Result<usize, String> {
    let roots = load_cache_root_registry()?;
    let mut delete_failures = Vec::<String>::new();
    let mut retained = Vec::<String>::new();
    let mut deleted = 0usize;

    for root in roots {
        let path = cache_file_path(&root);
        if !path.exists() {
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => {
                deleted += 1;
            }
            Err(error) => {
                retained.push(root.clone());
                delete_failures.push(format!("{}: {}", path.to_string_lossy(), error));
            }
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

pub(crate) fn load_workspace_ir_cache_snapshot(
    project_root: &str,
) -> Result<Option<WorkspaceIrCacheSnapshot>, String> {
    let Some(cache) = read_validated_cache_file(project_root)? else {
        return Ok(None);
    };
    Ok(Some(WorkspaceIrCacheSnapshot {
        library_path: cache.library_path,
        stdlib_signature: cache.stdlib_signature,
        project_tree: cache.project_tree,
        library_tree: cache.library_tree,
    }))
}

pub(crate) fn persist_workspace_ir_cache(
    state: &CoreState,
    project_root: &str,
    stdlib_signature: Option<&str>,
) -> Result<(), String> {
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
            let dedupe_key = (projection.file_path.clone(), projection.qualified_name.clone());
            by_file_and_qname.entry(dedupe_key).or_insert(projection);
        }
        by_file_and_qname.into_values().collect::<Vec<_>>()
    } else {
        semantic_projections
    };
    let project_tree = collect_tree_manifest(&project_root_path)?;
    let (library_path, library_tree) = collect_library_tree_manifest(state, &project_root_path)?;

    let written_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let snapshot = WorkspaceIrCache {
        schema_version: WORKSPACE_IR_SCHEMA_VERSION,
        engine_version: env!("CARGO_PKG_VERSION").to_string(),
        project_root: project_root.to_string(),
        written_at_unix_ms,
        stdlib_signature: stdlib_signature.map(|value| value.to_string()),
        library_path,
        project_tree,
        library_tree,
        symbols,
        semantic_projections,
    };
    let bytes = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;
    let path = cache_file_path(&project_root);
    write_atomic(&path, &bytes)?;
    register_cache_root(&project_root)?;
    Ok(())
}

pub(crate) fn schedule_workspace_ir_cache_persist(
    state: CoreState,
    project_root: String,
    stdlib_signature: Option<String>,
) {
    let project_root = canonical_project_root(&project_root);
    if project_root.trim().is_empty() {
        return;
    }
    let generation = state
        .next_workspace_ir_persist_id
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut pending) = state.pending_workspace_ir_persists.lock() {
        pending.insert(
            project_root.clone(),
            PendingWorkspaceIrPersist {
                generation,
                stdlib_signature: stdlib_signature.clone(),
            },
        );
    } else {
        return;
    }

    thread::spawn(move || {
        thread::sleep(std::time::Duration::from_millis(
            WORKSPACE_IR_PERSIST_DEBOUNCE_MS,
        ));
        let should_persist = state
            .pending_workspace_ir_persists
            .lock()
            .ok()
            .and_then(|pending| pending.get(&project_root).cloned())
            .map(|latest| latest.generation == generation)
            .unwrap_or(false);
        if !should_persist {
            return;
        }

        let _background_job = state.try_start_background_job(
            "workspace-ir-persist",
            Some(project_root.clone()),
            None,
        );
        let _ = persist_workspace_ir_cache(&state, &project_root, stdlib_signature.as_deref());

        if let Ok(mut pending) = state.pending_workspace_ir_persists.lock() {
            if pending.get(&project_root).map(|entry| entry.generation) == Some(generation) {
                pending.remove(&project_root);
            }
        }
    });
}

pub(crate) fn flush_pending_workspace_ir_cache_persists(
    state: &CoreState,
    project_root: Option<&str>,
) -> Result<(), String> {
    let roots = {
        let mut pending = state
            .pending_workspace_ir_persists
            .lock()
            .map_err(|_| "Pending workspace IR persist lock poisoned".to_string())?;
        let mut roots = pending
            .iter()
            .filter_map(|(root, entry)| {
                if project_root
                    .map(|target| canonical_project_root(target) == *root)
                    .unwrap_or(true)
                {
                    Some((root.clone(), entry.stdlib_signature.clone()))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        for (root, _) in &roots {
            pending.remove(root);
        }
        roots.sort_by(|a, b| a.0.cmp(&b.0));
        roots
    };

    for (root, stdlib_signature) in roots {
        persist_workspace_ir_cache(state, &root, stdlib_signature.as_deref())?;
    }
    Ok(())
}

pub(crate) fn seed_symbol_index_from_workspace_ir_cache(
    state: &CoreState,
    project_root: &str,
) -> Result<bool, String> {
    let raw_project_root = project_root.trim().to_string();
    let project_root = canonical_project_root(project_root);
    let Some(cache) = read_validated_cache_file(&project_root)? else {
        return Ok(false);
    };
    let WorkspaceIrCache {
        written_at_unix_ms: _,
        library_path: _,
        project_tree: _,
        library_tree: _,
        symbols,
        semantic_projections,
        schema_version: _,
        engine_version: _,
        project_root: _,
        stdlib_signature: _,
    } = cache;
    if symbols.is_empty() {
        return Ok(false);
    }

    let mut grouped = BTreeMap::<String, Vec<SymbolRecord>>::new();
    for mut symbol in symbols {
        symbol.project_root = project_root.to_string();
        grouped
            .entry(symbol.file_path.clone())
            .or_default()
            .push(symbol);
    }

    let mut store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;
    for (file_path, rows) in grouped {
        store.upsert_symbols_for_file(&project_root, &file_path, rows);
    }
    store.rebuild_symbol_mappings(&project_root);
    drop(store);

    if !semantic_projections.is_empty() {
        let mut workspace_cache = state
            .workspace_snapshot_cache
            .lock()
            .map_err(|_| "Workspace snapshot cache lock poisoned".to_string())?;
        let mut keys = vec![format!("project-semantic|{}|workspace-ir", project_root)];
        if !raw_project_root.is_empty() && raw_project_root != project_root {
            keys.push(format!(
                "project-semantic|{}|workspace-ir",
                raw_project_root
            ));
        }
        for key in keys {
            workspace_cache.insert(
                key,
                WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(std::sync::Arc::new(
                    semantic_projections.clone(),
                )),
            );
        }
    }
    let _ =
        refresh_project_semantic_lookup(state, &project_root, &[], semantic_projections.as_slice());
    Ok(true)
}

pub(crate) fn seed_semantic_projection_cache_from_workspace_ir_cache(
    state: &CoreState,
    project_root: &str,
) -> Result<bool, String> {
    let raw_project_root = project_root.trim().to_string();
    let project_root = canonical_project_root(project_root);
    let Some(cache) = read_validated_cache_file(&project_root)? else {
        return Ok(false);
    };
    let WorkspaceIrCache {
        library_path: _,
        project_tree: _,
        library_tree: _,
        semantic_projections,
        schema_version: _,
        engine_version: _,
        project_root: _,
        ..
    } = cache;
    if semantic_projections.is_empty() {
        return Ok(false);
    }

    {
        let mut workspace_cache = state
            .workspace_snapshot_cache
            .lock()
            .map_err(|_| "Workspace snapshot cache lock poisoned".to_string())?;
        let mut keys = vec![format!("project-semantic|{}|workspace-ir", project_root)];
        if !raw_project_root.is_empty() && raw_project_root != project_root {
            keys.push(format!(
                "project-semantic|{}|workspace-ir",
                raw_project_root
            ));
        }
        for key in keys {
            workspace_cache.insert(
                key,
                WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(std::sync::Arc::new(
                    semantic_projections.clone(),
                )),
            );
        }
    }

    let _ =
        refresh_project_semantic_lookup(state, &project_root, &[], semantic_projections.as_slice());
    Ok(true)
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
            features: vec![],
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
        }

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
        let restored_projection = restored_projection.expect("restored synthesized projection cache");
        assert!(restored_projection
            .iter()
            .any(|element| element.qualified_name == "Demo::Main"));

        let _ = fs::remove_dir_all(&root);
    }
}
