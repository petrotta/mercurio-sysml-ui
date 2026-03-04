use mercurio_symbol_index::{Scope, SymbolIndexStore, SymbolRecord};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::CoreState;

const WORKSPACE_IR_SCHEMA_VERSION: u32 = 1;
const WORKSPACE_IR_CACHE_FILE_NAME: &str = "workspace-ir-v1.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceIrCache {
    schema_version: u32,
    engine_version: String,
    project_root: String,
    written_at_unix_ms: u128,
    stdlib_signature: Option<String>,
    symbols: Vec<SymbolRecord>,
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
    PathBuf::from(project_root)
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
    if project_root.trim().is_empty() {
        return Err("Project root is empty".to_string());
    }
    let mut symbols = {
        let store = state
            .symbol_index
            .lock()
            .map_err(|_| "Symbol index lock poisoned".to_string())?;
        let mut rows = store.project_symbols(project_root, None);
        rows.extend(store.library_symbols(project_root, None));
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
    };
    let bytes = serde_json::to_vec_pretty(&snapshot).map_err(|e| e.to_string())?;
    let path = cache_file_path(project_root);
    write_atomic(&path, &bytes)
}

pub(crate) fn seed_symbol_index_from_workspace_ir_cache(
    state: &CoreState,
    project_root: &str,
) -> Result<bool, String> {
    let Some(cache) = read_cache_file(project_root)? else {
        return Ok(false);
    };
    if cache.schema_version != WORKSPACE_IR_SCHEMA_VERSION {
        return Ok(false);
    }
    if cache.engine_version != env!("CARGO_PKG_VERSION") {
        return Ok(false);
    }
    if normalized_path_key(&cache.project_root) != normalized_path_key(project_root) {
        return Ok(false);
    }
    if cache.symbols.is_empty() {
        return Ok(false);
    }

    let mut grouped = BTreeMap::<String, Vec<SymbolRecord>>::new();
    let mut stdlib_keys = BTreeSet::<String>::new();
    for mut symbol in cache.symbols {
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
        store.upsert_symbols_for_file(project_root, &file_path, rows);
    }
    if let Some(signature) = cache.stdlib_signature.as_deref() {
        if !signature.trim().is_empty() {
            for library_key in stdlib_keys {
                store.mark_stdlib_indexed(project_root, &library_key, signature);
            }
        }
    }
    store.rebuild_symbol_mappings(project_root);
    Ok(true)
}

pub(crate) fn clear_workspace_ir_cache(project_root: &str) -> Result<bool, String> {
    if project_root.trim().is_empty() {
        return Ok(false);
    }
    let path = cache_file_path(project_root);
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(path).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::AppSettings;
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

        let _ = fs::remove_dir_all(&root);
    }
}
