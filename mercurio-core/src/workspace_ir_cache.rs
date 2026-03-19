use mercurio_symbol_index::{Scope, SymbolIndexStore, SymbolRecord};
use mercurio_sysml_semantics::semantic_contract::SemanticElementProjectionView;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::project_root_key::canonical_project_root;
use crate::state::PendingWorkspaceIrPersist;
use crate::symbol_index::refresh_project_semantic_lookup;
use crate::{state::WorkspaceSnapshotCacheEntry, CoreState};

const WORKSPACE_IR_SCHEMA_VERSION: u32 = 2;
const WORKSPACE_IR_CACHE_FILE_NAME: &str = "workspace-ir-v1.json";
const WORKSPACE_IR_PERSIST_DEBOUNCE_MS: u64 = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceIrCache {
    schema_version: u32,
    engine_version: String,
    project_root: String,
    written_at_unix_ms: u128,
    stdlib_signature: Option<String>,
    symbols: Vec<SymbolRecord>,
    #[serde(default)]
    semantic_projections: Vec<SemanticElementProjectionView>,
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
    let mut symbols = {
        let store = state
            .symbol_index
            .lock()
            .map_err(|_| "Symbol index lock poisoned".to_string())?;
        let mut rows = store.project_symbols(&project_root, None);
        rows.extend(store.library_symbols(&project_root, None));
        if !raw_project_root.is_empty() && raw_project_root != project_root {
            rows.extend(store.project_symbols(&raw_project_root, None));
            rows.extend(store.library_symbols(&raw_project_root, None));
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
        symbols,
        semantic_projections,
    };
    let bytes = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;
    let path = cache_file_path(&project_root);
    write_atomic(&path, &bytes)
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
    let Some(cache) = read_cache_file(&project_root)? else {
        return Ok(false);
    };
    let WorkspaceIrCache {
        schema_version,
        engine_version,
        project_root: cached_project_root,
        written_at_unix_ms: _,
        stdlib_signature,
        symbols,
        semantic_projections,
    } = cache;
    if schema_version != WORKSPACE_IR_SCHEMA_VERSION {
        return Ok(false);
    }
    if engine_version != env!("CARGO_PKG_VERSION") {
        return Ok(false);
    }
    if normalized_path_key(&cached_project_root) != normalized_path_key(&project_root) {
        return Ok(false);
    }
    if symbols.is_empty() {
        return Ok(false);
    }

    let mut grouped = BTreeMap::<String, Vec<SymbolRecord>>::new();
    let mut stdlib_keys = BTreeSet::<String>::new();
    for mut symbol in symbols {
        symbol.project_root = project_root.to_string();
        if symbol.scope == Scope::Stdlib {
            if let Some(key) = symbol.library_key.as_ref() {
                if !key.trim().is_empty() {
                    stdlib_keys.insert(key.clone());
                }
            }
        }
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
    if let Some(signature) = stdlib_signature.as_deref() {
        if !signature.trim().is_empty() {
            for library_key in stdlib_keys {
                store.mark_stdlib_indexed(&project_root, &library_key, signature);
            }
        }
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

pub(crate) fn clear_workspace_ir_cache(project_root: &str) -> Result<bool, String> {
    let project_root = canonical_project_root(project_root);
    if project_root.trim().is_empty() {
        return Ok(false);
    }
    let path = cache_file_path(&project_root);
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(path).map_err(|e| e.to_string())?;
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
        scope: Scope,
        file_path: &str,
        qualified_name: &str,
    ) -> SymbolRecord {
        SymbolRecord {
            id: id.to_string(),
            project_root: project_root.to_string(),
            library_key: if scope == Scope::Stdlib {
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
                    Scope::Project,
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
                    Scope::Stdlib,
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

        state.clear_runtime_caches().expect("clear runtime caches");
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
            assert_eq!(store.library_symbols(&project_root, None).len(), 1);
            assert!(store.is_stdlib_index_fresh(&project_root, "stdlib-key", "sig-a"));
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
}
