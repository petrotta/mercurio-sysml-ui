use serde::Serialize;
use std::path::PathBuf;
use std::time::Instant;

use crate::compile::load_library_symbols_sync;
use crate::project::load_project_config;
use crate::project_model_seed::seed_symbol_index_if_empty;
use crate::project_root_key::canonical_project_root;
use crate::stdlib::seed_stdlib_startup_cache_for_project;
use crate::symbol_index::{
    query_library_symbols_impl, query_project_symbols_impl, IndexedSymbolView,
};
use crate::workspace::{collect_model_files, collect_project_files};
use crate::workspace_ir_cache::{
    clear_workspace_ir_cache, describe_workspace_startup_cache_miss,
    load_workspace_ir_cache_snapshot, persist_workspace_ir_cache,
    seed_workspace_symbol_state_from_workspace_ir_cache,
};
use crate::workspace_tree::resolve_workspace_library_path;
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
    pub project_cache_load_ms: u64,
    pub project_cache_seed_symbol_index_ms: u64,
    pub project_cache_seed_projection_ms: u64,
    pub library_cache_load_ms: u64,
    pub library_cache_seed_symbol_index_ms: u64,
    pub library_cache_seed_projection_ms: u64,
    pub symbol_snapshot_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceStartupSnapshotView {
    pub project_symbols: Vec<IndexedSymbolView>,
    pub library_symbols: Vec<IndexedSymbolView>,
    pub project_semantic_projection_count: usize,
    pub library_path: Option<String>,
    pub cache_hit: bool,
    pub project_cache_hit: bool,
    pub library_cache_hit: bool,
    pub project_cache_miss_reason: Option<String>,
    pub library_cache_miss_reason: Option<String>,
    pub diagnostics: Vec<String>,
    pub timings: WorkspaceStartupSnapshotTimingsView,
    pub symbol_timings: WorkspaceSymbolSnapshotTimingsView,
}

fn elapsed_ms(started_at: Instant) -> u64 {
    started_at.elapsed().as_millis() as u64
}

fn workspace_has_project_model_files(state: &CoreState, root: &str) -> bool {
    let root_path = PathBuf::from(root);
    if !root_path.exists() {
        return false;
    }

    let project_config = load_project_config(&root_path).ok().flatten();
    let mut files = Vec::<PathBuf>::new();
    if let Some(src) = project_config.as_ref().and_then(|config| config.src.as_ref()) {
        if let Ok(selected) = collect_project_files(&root_path, src) {
            files = selected;
        }
    }
    if files.is_empty() && collect_model_files(&root_path, &mut files).is_err() {
        return false;
    }

    let library_root = resolve_workspace_library_path(state, &root_path)
        .and_then(|path| path.canonicalize().ok().or(Some(path)));
    files.into_iter().any(|path| {
        let canonical = path.canonicalize().ok().unwrap_or(path);
        if let Some(library_root) = library_root.as_ref() {
            if canonical.starts_with(library_root) {
                return false;
            }
        }
        canonical
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("sysml") || ext.eq_ignore_ascii_case("kerml"))
            .unwrap_or(false)
    })
}

fn project_snapshot_is_persistable(
    state: &CoreState,
    root: &str,
    snapshot: &WorkspaceSymbolSnapshotView,
) -> bool {
    !workspace_has_project_model_files(state, root) || !snapshot.project_symbols.is_empty()
}

fn count_project_semantic_projections(state: &CoreState, root: &str) -> usize {
    let root_prefix = format!("project-semantic|{}|", canonical_project_root(root));
    let Ok(cache) = state.workspace_snapshot_cache.lock() else {
        return 0;
    };
    cache
        .iter()
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
    include_project: bool,
    include_library: bool,
) -> Result<WorkspaceSymbolSnapshotView, String> {
    get_workspace_symbol_snapshot_with_options(
        state,
        root,
        hydrate_library,
        include_project,
        include_library,
        false,
        None,
    )
}

fn get_workspace_symbol_snapshot_with_options(
    state: &CoreState,
    root: String,
    hydrate_library: bool,
    include_project: bool,
    include_library: bool,
    skip_seed_symbol_index: bool,
    known_library_path: Option<String>,
) -> Result<WorkspaceSymbolSnapshotView, String> {
    let total_started_at = Instant::now();
    let root = canonical_project_root(&root);
    let root_path = PathBuf::from(&root);
    let seed_symbol_index_ms = if skip_seed_symbol_index || (!include_project && !include_library)
    {
        0
    } else {
        let seed_symbol_index_started_at = Instant::now();
        seed_symbol_index_if_empty(state, &root)?;
        elapsed_ms(seed_symbol_index_started_at)
    };

    let (project_symbols, project_query_ms) = if include_project {
        let project_query_started_at = Instant::now();
        let project_symbols = query_project_symbols_impl(
            state,
            root.clone(),
            None,
            None,
            None,
            !skip_seed_symbol_index,
        )?;
        (project_symbols, elapsed_ms(project_query_started_at))
    } else {
        (Vec::new(), 0)
    };

    let (mut library_symbols, library_query_ms) = if include_library {
        let library_query_started_at = Instant::now();
        let library_symbols = query_library_symbols_impl(
            state,
            root.clone(),
            None,
            None,
            None,
            !skip_seed_symbol_index,
        )?;
        (library_symbols, elapsed_ms(library_query_started_at))
    } else {
        (Vec::new(), 0)
    };
    let mut library_path = known_library_path
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            resolve_workspace_library_path(state, &root_path)
                .map(|path| path.to_string_lossy().to_string())
        });
    let mut library_hydrated = false;
    let mut diagnostics = Vec::<String>::new();
    let mut library_hydration_ms = 0;
    let mut library_requery_ms = 0;
    let library_metadata_ms = 0;

    if include_library && hydrate_library && library_symbols.is_empty() {
        let hydration_started_at = Instant::now();
        match load_library_symbols_sync(state, root.clone(), None, true) {
            Ok(response) => {
                library_path = response.library_path.clone();
                library_hydrated = !response.symbols.is_empty();
                let library_requery_started_at = Instant::now();
                library_symbols =
                    query_library_symbols_impl(state, root.clone(), None, None, None, true)?;
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

    let mut snapshot = WorkspaceSymbolSnapshotView {
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
    };
    if include_project && project_snapshot_is_persistable(state, &root, &snapshot) {
        if let Err(error) = persist_workspace_ir_cache(state, &root, None) {
            snapshot
                .diagnostics
                .push(format!("Workspace cache persist failed: {error}"));
        }
    }

    Ok(snapshot)
}

pub fn get_workspace_startup_snapshot(
    state: &CoreState,
    root: String,
    hydrate_library: bool,
    prefer_cache: bool,
    include_project: bool,
    include_library: bool,
) -> Result<WorkspaceStartupSnapshotView, String> {
    let total_started_at = Instant::now();
    let root = canonical_project_root(&root);
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }

    let mut diagnostics = Vec::<String>::new();
    let mut library_path = None;
    let mut project_cache_hit = false;
    let mut library_cache_hit = false;
    let mut project_cache_miss_reason = None::<String>;
    let mut library_cache_miss_reason = None::<String>;
    let mut project_cache_load_ms = 0;
    let mut project_cache_seed_symbol_index_ms = 0;
    let mut project_cache_seed_projection_ms = 0;
    let mut library_cache_load_ms = 0;
    let mut library_cache_seed_symbol_index_ms = 0;
    let mut library_cache_seed_projection_ms = 0;

    if prefer_cache && include_project {
        let cache_load_started_at = Instant::now();
        project_cache_miss_reason = describe_workspace_startup_cache_miss(&root)?
            .map(ToString::to_string);
        if let Some(cache) = load_workspace_ir_cache_snapshot(&root)? {
            let cache_seed_summary =
                seed_workspace_symbol_state_from_workspace_ir_cache(state, &root)?;
            if cache_seed_summary.cache_hit {
                project_cache_hit = true;
                project_cache_miss_reason = None;
                library_path = cache.library_path;
                project_cache_seed_symbol_index_ms = cache_seed_summary.seed_symbol_index_ms;
                project_cache_seed_projection_ms = cache_seed_summary.seed_projection_ms;
            }
        }
        project_cache_load_ms = elapsed_ms(cache_load_started_at);
    }
    if let Some(reason) = project_cache_miss_reason.as_deref() {
        diagnostics.push(format!("Project cache miss reason: {reason}"));
    }

    if prefer_cache && include_library {
        let cache_load_started_at = Instant::now();
        let library_cache_summary = seed_stdlib_startup_cache_for_project(state, &root)?;
        library_cache_load_ms = elapsed_ms(cache_load_started_at);
        library_cache_hit = library_cache_summary.cache_hit;
        library_cache_miss_reason = library_cache_summary.cache_miss_reason;
        library_cache_seed_symbol_index_ms = library_cache_summary.seed_symbol_index_ms;
        library_cache_seed_projection_ms = library_cache_summary.seed_projection_ms;
        if library_path.is_none() {
            library_path = library_cache_summary.library_path;
        }
    }
    if let Some(reason) = library_cache_miss_reason.as_deref() {
        diagnostics.push(format!("Library cache miss reason: {reason}"));
    }

    let symbol_snapshot_started_at = Instant::now();
    let mut symbol_snapshot = get_workspace_symbol_snapshot_with_options(
        state,
        root.clone(),
        false,
        include_project,
        include_library,
        true,
        library_path.clone(),
    )?;
    if include_library
        && hydrate_library
        && !library_cache_hit
        && symbol_snapshot.library_symbols.is_empty()
        && library_path
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    {
        let recovered_snapshot = get_workspace_symbol_snapshot_with_options(
            state,
            root.clone(),
            true,
            false,
            true,
            false,
            library_path.clone(),
        )?;
        if !recovered_snapshot.library_symbols.is_empty() {
            diagnostics.push(
                "Recovered missing library symbols during startup library hydrate.".to_string(),
            );
            library_cache_hit = false;
            symbol_snapshot.library_symbols = recovered_snapshot.library_symbols;
            if symbol_snapshot.library_path.is_none() {
                symbol_snapshot.library_path = recovered_snapshot.library_path;
            }
            symbol_snapshot.library_hydrated = recovered_snapshot.library_hydrated;
            symbol_snapshot
                .diagnostics
                .extend(recovered_snapshot.diagnostics);
            symbol_snapshot.timings.library_query_ms = recovered_snapshot.timings.library_query_ms;
            symbol_snapshot.timings.library_hydration_ms =
                recovered_snapshot.timings.library_hydration_ms;
            symbol_snapshot.timings.library_requery_ms =
                recovered_snapshot.timings.library_requery_ms;
            symbol_snapshot.timings.total_duration_ms =
                symbol_snapshot.timings.total_duration_ms.max(
                    recovered_snapshot.timings.total_duration_ms,
                );
        }
    }
    if project_cache_hit
        && workspace_has_project_model_files(state, &root)
        && symbol_snapshot.project_symbols.is_empty()
    {
        project_cache_hit = false;
        project_cache_miss_reason =
            Some("startup_cache_restored_no_project_symbols".to_string());
        diagnostics.push("Project cache miss reason: startup_cache_restored_no_project_symbols".to_string());
        match clear_workspace_ir_cache(&root) {
            Ok(deleted) => diagnostics.push(format!(
                "Cleared incomplete workspace startup cache artifacts: {deleted}"
            )),
            Err(error) => diagnostics.push(format!(
                "Workspace cache invalidation failed after incomplete project restore: {error}"
            )),
        }
    }
    if project_cache_hit && include_project && symbol_snapshot.project_symbols.is_empty() {
        project_cache_hit = false;
        project_cache_miss_reason = Some("startup_cache_restored_no_symbols".to_string());
        diagnostics.push("Project cache miss reason: startup_cache_restored_no_symbols".to_string());
        match clear_workspace_ir_cache(&root) {
            Ok(deleted) => diagnostics.push(format!(
                "Cleared empty workspace startup cache artifacts: {deleted}"
            )),
            Err(error) => diagnostics.push(format!(
                "Workspace cache invalidation failed after empty restore: {error}"
            )),
        }
    }
    let symbol_snapshot_ms = elapsed_ms(symbol_snapshot_started_at);
    if library_path.is_none() {
        library_path = symbol_snapshot.library_path.clone();
    }

    diagnostics.extend(symbol_snapshot.diagnostics.clone());

    Ok(WorkspaceStartupSnapshotView {
        project_symbols: symbol_snapshot.project_symbols,
        library_symbols: symbol_snapshot.library_symbols,
        project_semantic_projection_count: count_project_semantic_projections(state, &root),
        library_path,
        cache_hit: project_cache_hit || library_cache_hit,
        project_cache_hit,
        library_cache_hit,
        project_cache_miss_reason,
        library_cache_miss_reason,
        diagnostics,
        timings: WorkspaceStartupSnapshotTimingsView {
            total_duration_ms: elapsed_ms(total_started_at),
            project_cache_load_ms,
            project_cache_seed_symbol_index_ms,
            project_cache_seed_projection_ms,
            library_cache_load_ms,
            library_cache_seed_symbol_index_ms,
            library_cache_seed_projection_ms,
            symbol_snapshot_ms,
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
    use crate::workspace_ir_cache::persist_workspace_ir_cache;
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
            get_workspace_symbol_snapshot(
                &state,
                project_dir.to_string_lossy().to_string(),
                true,
                true,
                true,
            )
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
        let root =
            std::env::temp_dir().join(format!("mercurio_workspace_startup_snapshot_{stamp}"));
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
        compile_workspace_sync(
            &state,
            project_root.clone(),
            1,
            true,
            None,
            Vec::new(),
            |_| {},
        )
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

        let snapshot = get_workspace_startup_snapshot(&state, project_root, true, true, true, true)
            .expect("workspace startup snapshot");
        assert!(snapshot.cache_hit, "{:?}", snapshot.diagnostics);
        assert!(snapshot.project_cache_hit);
        assert!(snapshot
            .project_symbols
            .iter()
            .any(|symbol| symbol.qualified_name == "P"));
        assert!(!snapshot.library_symbols.is_empty());
        assert!(snapshot.library_path.is_some());
        assert!(
            snapshot.library_cache_hit
                || snapshot.diagnostics.iter().any(|diagnostic| {
                    diagnostic
                        == "Recovered missing library symbols during startup library hydrate."
                }),
            "{:?}",
            snapshot.diagnostics
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_startup_snapshot_reports_missing_symbol_payload_reason() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "mercurio_workspace_startup_snapshot_reason_{stamp}"
        ));
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
                "{{\"name\":\"startup-cache-reason\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let project_root = project_dir.to_string_lossy().to_string();
        compile_workspace_sync(
            &state,
            project_root.clone(),
            1,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile workspace");
        load_library_symbols_sync(&state, project_root.clone(), None, true)
            .expect("load library symbols");
        crate::workspace_ir_cache::persist_workspace_ir_cache(&state, &project_root, None)
            .expect("persist workspace ir cache");
        fs::remove_file(
            project_dir
                .join(".mercurio")
                .join("cache")
                .join("workspace-project-symbols-v2.json"),
        )
        .expect("remove project symbol manifest");
        state
            .clear_in_memory_caches_for_tests()
            .expect("clear in-memory caches");

        let snapshot =
            get_workspace_startup_snapshot(&state, project_root, false, true, true, true)
            .expect("workspace startup snapshot");
        assert!(!snapshot.project_cache_hit);
        assert!(snapshot
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic
                == "Project cache miss reason: project_symbol_manifest_missing"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_symbol_snapshot_persists_complete_cache_for_startup_restore() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "mercurio_workspace_symbol_snapshot_persist_{stamp}"
        ));
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
                "{{\"name\":\"symbol-snapshot-persist\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let project_root = project_dir.to_string_lossy().to_string();
        compile_workspace_sync(
            &state,
            project_root.clone(),
            1,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile workspace");

        let snapshot =
            get_workspace_symbol_snapshot(&state, project_root.clone(), true, true, true)
            .expect("workspace symbol snapshot");
        assert!(!snapshot.library_symbols.is_empty());

        state
            .clear_in_memory_caches_for_tests()
            .expect("clear in-memory caches");

        let startup =
            get_workspace_startup_snapshot(&state, project_root, false, true, true, true)
            .expect("workspace startup snapshot");
        assert!(startup.cache_hit, "{:?}", startup.diagnostics);
        assert!(startup.project_cache_hit);
        assert!(
            startup.library_cache_hit
                || startup
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.starts_with("Library cache miss reason:")),
            "{:?}",
            startup.diagnostics
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_startup_snapshot_rejects_cache_without_project_symbols() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "mercurio_workspace_startup_missing_project_symbols_{stamp}"
        ));
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
                "{{\"name\":\"missing-project-symbols\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let project_root = project_dir.to_string_lossy().to_string();

        let library = load_library_symbols_sync(&state, project_root.clone(), None, true)
            .expect("load library symbols");
        assert!(library.ok);
        assert!(!library.symbols.is_empty());

        persist_workspace_ir_cache(&state, &project_root, None)
            .expect("persist incomplete workspace cache");
        state
            .clear_in_memory_caches_for_tests()
            .expect("clear in-memory caches");

        let snapshot = get_workspace_startup_snapshot(
            &state,
            project_root.clone(),
            false,
            true,
            true,
            false,
        )
            .expect("workspace startup snapshot");
        assert!(!snapshot.cache_hit);
        assert!(!snapshot.project_cache_hit);
        assert!(snapshot.project_symbols.is_empty());
        assert!(snapshot.diagnostics.iter().any(|diagnostic| {
            diagnostic
                == "Project cache miss reason: startup_cache_restored_no_project_symbols"
        }));

        let cache_dir = project_dir.join(".mercurio").join("cache");
        assert!(!cache_dir.join("workspace-startup-v1.json").exists());
        assert!(!cache_dir.join("workspace-project-symbols-v2.json").exists());
        assert!(!cache_dir.join("workspace-project-symbols-v2").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_startup_snapshot_rejects_empty_cache_restore() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("mercurio_workspace_startup_empty_restore_{stamp}"));
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
                "{{\"name\":\"empty-startup-cache\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let project_root = project_dir.to_string_lossy().to_string();
        persist_workspace_ir_cache(&state, &project_root, None)
            .expect("persist empty workspace cache");

        let snapshot = get_workspace_startup_snapshot(
            &state,
            project_root.clone(),
            false,
            true,
            true,
            true,
        )
            .expect("workspace startup snapshot");
        assert!(!snapshot.cache_hit);
        assert!(snapshot.project_symbols.is_empty());
        assert!(snapshot.library_symbols.is_empty());
        assert!(snapshot.diagnostics.iter().any(|diagnostic| {
            diagnostic == "Project cache miss reason: startup_cache_restored_no_project_symbols"
        }), "{:?}", snapshot.diagnostics);

        let cache_dir = project_dir.join(".mercurio").join("cache");
        assert!(!cache_dir.join("workspace-startup-v1.json").exists());
        assert!(!cache_dir.join("workspace-project-symbols-v2.json").exists());
        assert!(!cache_dir.join("workspace-project-symbols-v2").exists());

        let _ = fs::remove_dir_all(root);
    }
}
