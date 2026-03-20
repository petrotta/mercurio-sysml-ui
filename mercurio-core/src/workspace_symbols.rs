use serde::Serialize;
use std::path::PathBuf;
use std::time::Instant;

use crate::compile::load_library_symbols_sync;
use crate::project_model_seed::seed_symbol_index_if_empty;
use crate::project_root_key::canonical_project_root;
use crate::stdlib::seed_stdlib_index_from_cache_for_project;
use crate::symbol_index::{
    query_library_symbols_impl, query_project_symbols_impl, IndexedSymbolView,
};
use crate::workspace_ir_cache::{
    load_workspace_ir_cache_snapshot, seed_semantic_projection_cache_from_workspace_ir_cache,
    seed_symbol_index_from_workspace_ir_cache,
};
use crate::workspace_tree::{
    collect_library_tree_manifest, collect_tree_manifest, WorkspaceTreeEntryView,
};
use crate::CoreState;

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceSymbolSnapshotTimingsView {
    pub total_duration_ms: u64,
    pub seed_symbol_index_ms: u64,
    pub project_query_ms: u64,
    pub library_query_ms: u64,
    pub library_hydration_ms: u64,
    pub library_requery_ms: u64,
    pub library_metadata_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceSymbolSnapshotView {
    pub project_symbols: Vec<IndexedSymbolView>,
    pub library_symbols: Vec<IndexedSymbolView>,
    pub library_path: Option<String>,
    pub library_hydrated: bool,
    pub diagnostics: Vec<String>,
    pub timings: WorkspaceSymbolSnapshotTimingsView,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceStartupSnapshotTimingsView {
    pub total_duration_ms: u64,
    pub cache_load_ms: u64,
    pub cache_seed_symbol_index_ms: u64,
    pub cache_seed_projection_ms: u64,
    pub project_tree_collect_ms: u64,
    pub symbol_snapshot_ms: u64,
    pub library_tree_collect_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceStartupSnapshotView {
    pub project_tree: Vec<WorkspaceTreeEntryView>,
    pub library_tree: Vec<WorkspaceTreeEntryView>,
    pub project_symbols: Vec<IndexedSymbolView>,
    pub library_symbols: Vec<IndexedSymbolView>,
    pub project_semantic_projection_count: usize,
    pub library_path: Option<String>,
    pub cache_hit: bool,
    pub diagnostics: Vec<String>,
    pub timings: WorkspaceStartupSnapshotTimingsView,
    pub symbol_timings: WorkspaceSymbolSnapshotTimingsView,
}

fn elapsed_ms(started_at: Instant) -> u64 {
    started_at.elapsed().as_millis() as u64
}

fn count_project_semantic_projections(state: &CoreState, root: &str) -> usize {
    let root_prefix = format!("project-semantic|{}|", canonical_project_root(root));
    let Ok(cache) = state.workspace_snapshot_cache.lock() else {
        return 0;
    };
    cache.iter()
        .filter_map(|(key, entry)| match entry {
            crate::state::WorkspaceSnapshotCacheEntry::ProjectSemanticProjection(elements)
                if key.starts_with(&root_prefix) =>
            {
                Some(elements.len())
            }
            _ => None,
        })
        .max()
        .unwrap_or(0)
}

pub fn get_workspace_symbol_snapshot(
    state: &CoreState,
    root: String,
    hydrate_library: bool,
) -> Result<WorkspaceSymbolSnapshotView, String> {
    get_workspace_symbol_snapshot_with_options(state, root, hydrate_library, false, None)
}

fn get_workspace_symbol_snapshot_with_options(
    state: &CoreState,
    root: String,
    hydrate_library: bool,
    skip_seed_symbol_index: bool,
    known_library_path: Option<String>,
) -> Result<WorkspaceSymbolSnapshotView, String> {
    let total_started_at = Instant::now();
    let root = canonical_project_root(&root);
    let seed_symbol_index_ms = if skip_seed_symbol_index {
        0
    } else {
        let seed_symbol_index_started_at = Instant::now();
        seed_symbol_index_if_empty(state, &root)?;
        elapsed_ms(seed_symbol_index_started_at)
    };

    let project_query_started_at = Instant::now();
    let project_symbols =
        query_project_symbols_impl(state, root.clone(), None, None, None, !skip_seed_symbol_index)?;
    let project_query_ms = elapsed_ms(project_query_started_at);

    let library_query_started_at = Instant::now();
    let mut library_symbols =
        query_library_symbols_impl(state, root.clone(), None, None, None, !skip_seed_symbol_index)?;
    let library_query_ms = elapsed_ms(library_query_started_at);
    let mut library_path = known_library_path.filter(|value| !value.trim().is_empty());
    let mut library_hydrated = false;
    let mut diagnostics = Vec::<String>::new();
    let mut library_hydration_ms = 0;
    let mut library_requery_ms = 0;
    let mut library_metadata_ms = 0;

    if hydrate_library && library_symbols.is_empty() {
        let hydration_started_at = Instant::now();
        match load_library_symbols_sync(state, root.clone(), None, true) {
            Ok(response) => {
                library_path = response.library_path.clone();
                library_hydrated = !response.symbols.is_empty();
                let library_requery_started_at = Instant::now();
                library_symbols = query_library_symbols_impl(
                    state,
                    root.clone(),
                    None,
                    None,
                    None,
                    true,
                )?;
                library_requery_ms = elapsed_ms(library_requery_started_at);
                if library_symbols.is_empty() && response.library_path.is_some() {
                    diagnostics.push(
                        "Library symbols are still empty after backend hydration.".to_string(),
                    );
                }
            }
            Err(error) => {
                diagnostics.push(format!("Library hydration failed: {error}"));
            }
        }
        library_hydration_ms = elapsed_ms(hydration_started_at);
    }

    if library_path.is_none() {
        let metadata_started_at = Instant::now();
        match load_library_symbols_sync(state, root, None, false) {
            Ok(response) => {
                library_path = response.library_path;
            }
            Err(error) => diagnostics.push(format!("Library metadata load failed: {error}")),
        }
        library_metadata_ms = elapsed_ms(metadata_started_at);
    }

    Ok(WorkspaceSymbolSnapshotView {
        project_symbols,
        library_symbols,
        library_path,
        library_hydrated,
        diagnostics,
        timings: WorkspaceSymbolSnapshotTimingsView {
            total_duration_ms: elapsed_ms(total_started_at),
            seed_symbol_index_ms,
            project_query_ms,
            library_query_ms,
            library_hydration_ms,
            library_requery_ms,
            library_metadata_ms,
        },
    })
}

pub fn get_workspace_startup_snapshot(
    state: &CoreState,
    root: String,
    hydrate_library: bool,
    prefer_cache: bool,
) -> Result<WorkspaceStartupSnapshotView, String> {
    let total_started_at = Instant::now();
    let root = canonical_project_root(&root);
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }

    let mut diagnostics = Vec::<String>::new();
    let mut cache_hit = false;
    let mut project_tree = Vec::<WorkspaceTreeEntryView>::new();
    let mut library_tree = Vec::<WorkspaceTreeEntryView>::new();
    let mut library_path = None;
    let mut stdlib_signature = None;
    let mut cache_load_ms = 0;
    let mut cache_seed_symbol_index_ms = 0;
    let mut cache_seed_projection_ms = 0;
    let mut project_tree_collect_ms = 0;
    let mut library_tree_collect_ms = 0;

    if prefer_cache {
        let cache_load_started_at = Instant::now();
        if let Some(cache) = load_workspace_ir_cache_snapshot(&root)? {
            cache_hit = true;
            project_tree = cache.project_tree;
            library_tree = cache.library_tree;
            library_path = cache.library_path;
            stdlib_signature = cache.stdlib_signature;
            let cache_seed_symbol_index_started_at = Instant::now();
            let _ = seed_symbol_index_from_workspace_ir_cache(state, &root);
            if let (Some(path), Some(signature)) =
                (library_path.as_deref(), stdlib_signature.as_deref())
            {
                let library_root = PathBuf::from(path);
                let _ = seed_stdlib_index_from_cache_for_project(
                    state,
                    &root,
                    Some(&library_root),
                    signature,
                );
            }
            cache_seed_symbol_index_ms = elapsed_ms(cache_seed_symbol_index_started_at);
            let cache_seed_projection_started_at = Instant::now();
            let _ = seed_semantic_projection_cache_from_workspace_ir_cache(state, &root);
            cache_seed_projection_ms = elapsed_ms(cache_seed_projection_started_at);
        }
        cache_load_ms = elapsed_ms(cache_load_started_at);
    }

    if project_tree.is_empty() && !cache_hit {
        let project_tree_started_at = Instant::now();
        project_tree = collect_tree_manifest(&root_path)?;
        project_tree_collect_ms = elapsed_ms(project_tree_started_at);
    }

    let symbol_snapshot_started_at = Instant::now();
    let mut symbol_snapshot = get_workspace_symbol_snapshot_with_options(
        state,
        root.clone(),
        hydrate_library,
        cache_hit,
        library_path.clone(),
    )?;
    if cache_hit
        && symbol_snapshot.library_symbols.is_empty()
        && library_path
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    {
        // Recover from incomplete startup caches by hydrating stdlib once.
        let recovered_snapshot = get_workspace_symbol_snapshot_with_options(
            state,
            root.clone(),
            true,
            false,
            library_path.clone(),
        )?;
        if !recovered_snapshot.library_symbols.is_empty() {
            diagnostics.push(
                "Recovered missing library symbols during startup-cache restore.".to_string(),
            );
            symbol_snapshot = recovered_snapshot;
        }
    }
    let symbol_snapshot_ms = elapsed_ms(symbol_snapshot_started_at);
    if library_path.is_none() {
        library_path = symbol_snapshot.library_path.clone();
    }

    if library_tree.is_empty() && !cache_hit {
        let library_tree_started_at = Instant::now();
        let (resolved_library_path, resolved_library_tree) =
            collect_library_tree_manifest(state, &root_path)?;
        if library_path.is_none() {
            library_path = resolved_library_path;
        }
        library_tree = resolved_library_tree;
        library_tree_collect_ms = elapsed_ms(library_tree_started_at);
    }

    diagnostics.extend(symbol_snapshot.diagnostics.clone());

    Ok(WorkspaceStartupSnapshotView {
        project_tree,
        library_tree,
        project_symbols: symbol_snapshot.project_symbols,
        library_symbols: symbol_snapshot.library_symbols,
        project_semantic_projection_count: count_project_semantic_projections(state, &root),
        library_path,
        cache_hit,
        diagnostics,
        timings: WorkspaceStartupSnapshotTimingsView {
            total_duration_ms: elapsed_ms(total_started_at),
            cache_load_ms,
            cache_seed_symbol_index_ms,
            cache_seed_projection_ms,
            project_tree_collect_ms,
            symbol_snapshot_ms,
            library_tree_collect_ms,
        },
        symbol_timings: symbol_snapshot.timings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compile::{compile_workspace_sync, load_library_symbols_sync};
    use crate::settings::AppSettings;
    use crate::state::CoreState;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn workspace_symbol_snapshot_hydrates_project_and_library_symbols() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_workspace_symbol_snapshot_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { package Kernel { metaclass Element {} } }",
        )
        .expect("write library file");
        fs::write(
            project_dir.join("main.sysml"),
            "package P { part def A; }\n",
        )
        .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"snapshot\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        compile_workspace_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            1,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile workspace");

        let snapshot =
            get_workspace_symbol_snapshot(&state, project_dir.to_string_lossy().to_string(), true)
                .expect("workspace symbol snapshot");
        assert!(snapshot
            .project_symbols
            .iter()
            .any(|symbol| symbol.qualified_name == "P"));
        assert!(snapshot.library_path.is_some());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_startup_snapshot_cache_hit_preserves_project_and_library_symbols() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_workspace_startup_snapshot_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { package Kernel { metaclass Element {} } }",
        )
        .expect("write library file");
        fs::write(
            project_dir.join("main.sysml"),
            "package P { part def A; }\n",
        )
        .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"startup-cache\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let project_root = project_dir.to_string_lossy().to_string();
        compile_workspace_sync(&state, project_root.clone(), 1, true, None, Vec::new(), |_| {})
            .expect("compile workspace");

        let library = load_library_symbols_sync(&state, project_root.clone(), None, true)
            .expect("load library symbols");
        assert!(library.ok);
        assert!(!library.symbols.is_empty());

        crate::workspace_ir_cache::persist_workspace_ir_cache(&state, &project_root, None)
            .expect("persist workspace ir cache");
        state
            .clear_in_memory_caches_for_tests()
            .expect("clear in-memory caches");

        let snapshot = get_workspace_startup_snapshot(&state, project_root, true, true)
            .expect("workspace startup snapshot");
        assert!(snapshot.cache_hit);
        assert!(snapshot
            .project_symbols
            .iter()
            .any(|symbol| symbol.qualified_name == "P"));
        assert!(!snapshot.library_symbols.is_empty());
        assert!(snapshot.library_path.is_some());

        let _ = fs::remove_dir_all(root);
    }
}
