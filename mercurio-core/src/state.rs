use mercurio_symbol_index::{InMemorySymbolIndex, SymbolIndex, SymbolIndexStore};
use mercurio_sysml_pkg::compile_support::StdlibSnapshotCacheEntry;
use mercurio_sysml_semantics::semantic_contract::{
    SemanticElementProjectionView, SemanticElementView,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::project_root_key::canonical_project_root;
use crate::settings::AppSettings;
use crate::workspace_ir_cache::{
    clear_workspace_ir_cache, flush_pending_workspace_ir_cache_persists,
};

#[derive(Serialize, Clone)]
pub struct CompileDiagnosticView {
    pub message: String,
    pub line: usize,
    pub column: usize,
    pub kind: String,
    pub source: String,
}

#[derive(Serialize, Clone)]
pub struct CompileFileResult {
    pub path: String,
    pub ok: bool,
    pub errors: Vec<CompileDiagnosticView>,
    pub symbol_count: usize,
}

#[derive(Clone)]
#[allow(dead_code)]
pub(crate) struct StdlibSymbol {
    pub(crate) file_path: String,
    pub(crate) name: String,
    pub(crate) qualified_name: String,
    pub(crate) kind: String,
    pub(crate) start_line: u32,
    pub(crate) start_col: u32,
    pub(crate) end_line: u32,
    pub(crate) end_col: u32,
}

pub(crate) type StdlibCache = StdlibSnapshotCacheEntry<StdlibSymbol>;
pub(crate) type ProjectSemanticCache = Arc<Vec<SemanticElementView>>;
pub(crate) type ProjectSemanticProjectionCache = Arc<Vec<SemanticElementProjectionView>>;

#[derive(Clone, Default)]
pub(crate) struct ProjectSemanticLookup {
    pub(crate) elements_by_file_qname: HashMap<(String, String), SemanticElementView>,
    pub(crate) best_elements_by_qname: HashMap<String, SemanticElementView>,
    pub(crate) projections_by_file_qname: HashMap<(String, String), SemanticElementProjectionView>,
    pub(crate) best_projections_by_qname: HashMap<String, SemanticElementProjectionView>,
}

#[derive(Clone)]
pub(crate) enum WorkspaceSnapshotCacheEntry {
    Stdlib(StdlibCache),
    ProjectSemantic(ProjectSemanticCache),
    ProjectSemanticProjection(ProjectSemanticProjectionCache),
}

pub(crate) type WorkspaceSnapshotCache = HashMap<String, WorkspaceSnapshotCacheEntry>;
pub(crate) type ProjectSemanticLookupCache = HashMap<String, ProjectSemanticLookup>;

#[derive(Default)]
pub(crate) struct WorkspaceState {
    pub(crate) file_mtimes: HashMap<PathBuf, SystemTime>,
    pub(crate) file_cache: HashMap<PathBuf, CompileFileResult>,
}

#[derive(Clone)]
pub(crate) struct BackgroundJobState {
    id: u64,
    kind: String,
    detail: Option<String>,
    started_at_ms: u128,
    cancel_compile_run_id: Option<u64>,
}

#[derive(Clone)]
pub(crate) struct PendingWorkspaceIrPersist {
    pub(crate) generation: u64,
    pub(crate) stdlib_signature: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct BackgroundJobView {
    pub id: u64,
    pub kind: String,
    pub detail: Option<String>,
    pub started_at_ms: u128,
    pub cancelable: bool,
    pub compile_run_id: Option<u64>,
}

#[derive(Serialize, Clone)]
pub struct BackgroundJobsSnapshot {
    pub total: usize,
    pub cancelable: usize,
    pub jobs: Vec<BackgroundJobView>,
}

#[derive(Serialize, Clone, Copy)]
pub struct BackgroundCancelSummary {
    pub active_jobs: usize,
    pub cancelable_jobs: usize,
    pub compile_cancel_requests: usize,
}

#[derive(Clone)]
pub struct CoreState {
    pub(crate) workspace_snapshot_cache: Arc<Mutex<WorkspaceSnapshotCache>>,
    pub(crate) project_semantic_lookup_cache: Arc<Mutex<ProjectSemanticLookupCache>>,
    pub(crate) canceled_compiles: Arc<Mutex<HashSet<u64>>>,
    pub(crate) workspace: Arc<Mutex<WorkspaceState>>,
    pub(crate) symbol_index: Arc<Mutex<SymbolIndex>>,
    pub(crate) background_jobs: Arc<Mutex<HashMap<u64, BackgroundJobState>>>,
    pub(crate) next_background_job_id: Arc<AtomicU64>,
    pub(crate) next_workspace_ir_persist_id: Arc<AtomicU64>,
    pub(crate) pending_workspace_ir_persists:
        Arc<Mutex<HashMap<String, PendingWorkspaceIrPersist>>>,
    pub stdlib_root: PathBuf,
    pub settings: Arc<Mutex<AppSettings>>,
}

#[derive(Serialize, Clone, Copy)]
pub struct CacheClearSummary {
    pub workspace_snapshot_entries: usize,
    pub metamodel_entries: usize,
    pub parsed_file_entries: usize,
    pub file_mtime_entries: usize,
    pub canceled_compile_entries: usize,
    pub symbol_index_cleared: bool,
    pub project_ir_cache_deleted: bool,
}

pub struct BackgroundJobHandle {
    state: CoreState,
    job_id: u64,
}

impl Drop for BackgroundJobHandle {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.state.background_jobs.lock() {
            jobs.remove(&self.job_id);
        }
    }
}

impl CoreState {
    pub fn new(stdlib_root: PathBuf, settings: AppSettings) -> Self {
        remove_legacy_symbol_index_db_files(&stdlib_root);
        let symbol_index = SymbolIndex::InMemory(InMemorySymbolIndex::default());
        Self {
            workspace_snapshot_cache: Arc::new(Mutex::new(HashMap::new())),
            project_semantic_lookup_cache: Arc::new(Mutex::new(HashMap::new())),
            canceled_compiles: Arc::new(Mutex::new(HashSet::new())),
            workspace: Arc::new(Mutex::new(WorkspaceState::default())),
            symbol_index: Arc::new(Mutex::new(symbol_index)),
            background_jobs: Arc::new(Mutex::new(HashMap::new())),
            next_background_job_id: Arc::new(AtomicU64::new(1)),
            next_workspace_ir_persist_id: Arc::new(AtomicU64::new(1)),
            pending_workspace_ir_persists: Arc::new(Mutex::new(HashMap::new())),
            stdlib_root,
            settings: Arc::new(Mutex::new(settings)),
        }
    }

    pub fn try_start_background_job(
        &self,
        kind: impl Into<String>,
        detail: Option<String>,
        cancel_compile_run_id: Option<u64>,
    ) -> Option<BackgroundJobHandle> {
        let job_id = self.next_background_job_id.fetch_add(1, Ordering::Relaxed);
        let state = BackgroundJobState {
            id: job_id,
            kind: kind.into(),
            detail,
            started_at_ms: current_time_ms(),
            cancel_compile_run_id,
        };
        let Ok(mut jobs) = self.background_jobs.lock() else {
            return None;
        };
        jobs.insert(job_id, state);
        Some(BackgroundJobHandle {
            state: self.clone(),
            job_id,
        })
    }

    pub fn background_jobs_snapshot(&self) -> Result<BackgroundJobsSnapshot, String> {
        let jobs = self
            .background_jobs
            .lock()
            .map_err(|_| "Background job map lock poisoned".to_string())?;
        let mut rows = jobs
            .values()
            .map(|job| BackgroundJobView {
                id: job.id,
                kind: job.kind.clone(),
                detail: job.detail.clone(),
                started_at_ms: job.started_at_ms,
                cancelable: job.cancel_compile_run_id.is_some(),
                compile_run_id: job.cancel_compile_run_id,
            })
            .collect::<Vec<_>>();
        rows.sort_by(|a, b| a.started_at_ms.cmp(&b.started_at_ms).then(a.id.cmp(&b.id)));
        let cancelable = rows.iter().filter(|row| row.cancelable).count();
        Ok(BackgroundJobsSnapshot {
            total: rows.len(),
            cancelable,
            jobs: rows,
        })
    }

    pub fn cancel_background_jobs(&self) -> Result<BackgroundCancelSummary, String> {
        let (active_jobs, run_ids) = {
            let jobs = self
                .background_jobs
                .lock()
                .map_err(|_| "Background job map lock poisoned".to_string())?;
            let run_ids = jobs
                .values()
                .filter_map(|job| job.cancel_compile_run_id)
                .collect::<HashSet<_>>();
            (jobs.len(), run_ids)
        };
        let cancelable_jobs = run_ids.len();
        let mut canceled = self
            .canceled_compiles
            .lock()
            .map_err(|_| "Canceled compile set lock poisoned".to_string())?;
        let mut compile_cancel_requests = 0usize;
        for run_id in run_ids {
            if canceled.insert(run_id) {
                compile_cancel_requests += 1;
            }
        }
        Ok(BackgroundCancelSummary {
            active_jobs,
            cancelable_jobs,
            compile_cancel_requests,
        })
    }

    pub fn clear_runtime_caches(&self) -> Result<CacheClearSummary, String> {
        self.clear_runtime_caches_for_root(None)
    }

    pub fn clear_runtime_caches_for_root(
        &self,
        project_root: Option<&str>,
    ) -> Result<CacheClearSummary, String> {
        flush_pending_workspace_ir_cache_persists(self, project_root)?;
        let workspace_snapshot_entries = {
            let mut cache = self
                .workspace_snapshot_cache
                .lock()
                .map_err(|_| "Workspace snapshot cache lock poisoned".to_string())?;
            let count = cache.len();
            cache.clear();
            count
        };
        if let Ok(mut lookup_cache) = self.project_semantic_lookup_cache.lock() {
            lookup_cache.clear();
        }
        let metamodel_entries = 0usize;
        let (parsed_file_entries, file_mtime_entries) = {
            let mut workspace = self
                .workspace
                .lock()
                .map_err(|_| "Workspace cache lock poisoned".to_string())?;
            let parsed = workspace.file_cache.len();
            let mtimes = workspace.file_mtimes.len();
            workspace.file_cache.clear();
            workspace.file_mtimes.clear();
            (parsed, mtimes)
        };
        let symbol_index_cleared = {
            let mut symbol_index = self
                .symbol_index
                .lock()
                .map_err(|_| "Symbol index lock poisoned".to_string())?;
            symbol_index.clear_all();
            true
        };
        let canceled_compile_entries = {
            let mut canceled = self
                .canceled_compiles
                .lock()
                .map_err(|_| "Canceled compile set lock poisoned".to_string())?;
            let count = canceled.len();
            canceled.clear();
            count
        };
        if let Ok(mut pending_persists) = self.pending_workspace_ir_persists.lock() {
            pending_persists.clear();
        }
        let project_ir_cache_deleted = match project_root {
            Some(root) => {
                let canonical_root = canonical_project_root(root);
                clear_workspace_ir_cache(&canonical_root)?
            }
            None => false,
        };
        Ok(CacheClearSummary {
            workspace_snapshot_entries,
            metamodel_entries,
            parsed_file_entries,
            file_mtime_entries,
            canceled_compile_entries,
            symbol_index_cleared,
            project_ir_cache_deleted,
        })
    }
}

fn current_time_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn remove_legacy_symbol_index_db_files(stdlib_root: &PathBuf) {
    let mut candidates = Vec::new();
    candidates.push(stdlib_root.join("symbol-index.db"));
    if let Some(parent) = stdlib_root.parent() {
        candidates.push(parent.join("symbol-index.db"));
    }
    for db_path in candidates {
        for suffix in ["", "-wal", "-shm"] {
            let path = PathBuf::from(format!("{}{}", db_path.to_string_lossy(), suffix));
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_job_snapshot_tracks_active_and_cancelable_jobs() {
        let stamp = current_time_ms();
        let root = std::env::temp_dir().join(format!("mercurio_bg_jobs_{stamp}"));
        let state = CoreState::new(root, AppSettings::default());

        let compile_job = state
            .try_start_background_job("compile", Some("run_id=11".to_string()), Some(11))
            .expect("start compile job");
        let _tool_job = state
            .try_start_background_job("tool", Some("core.query_semantic@v1".to_string()), None)
            .expect("start tool job");

        let snapshot = state
            .background_jobs_snapshot()
            .expect("background snapshot");
        assert_eq!(snapshot.total, 2);
        assert_eq!(snapshot.cancelable, 1);
        assert!(snapshot.jobs.iter().any(|job| job.kind == "compile"));
        assert!(snapshot.jobs.iter().any(|job| job.kind == "tool"));

        drop(compile_job);
        let snapshot_after_drop = state
            .background_jobs_snapshot()
            .expect("snapshot after drop");
        assert_eq!(snapshot_after_drop.total, 1);
        assert_eq!(snapshot_after_drop.cancelable, 0);
    }

    #[test]
    fn cancel_background_jobs_requests_compile_cancellation() {
        let stamp = current_time_ms();
        let root = std::env::temp_dir().join(format!("mercurio_bg_cancel_{stamp}"));
        let state = CoreState::new(root, AppSettings::default());
        let _compile_job = state
            .try_start_background_job("compile", Some("run_id=42".to_string()), Some(42))
            .expect("start compile job");

        let summary = state
            .cancel_background_jobs()
            .expect("cancel background jobs");
        assert_eq!(summary.active_jobs, 1);
        assert_eq!(summary.cancelable_jobs, 1);
        assert_eq!(summary.compile_cancel_requests, 1);

        let canceled = state.canceled_compiles.lock().expect("canceled lock");
        assert!(canceled.contains(&42));
    }
}
