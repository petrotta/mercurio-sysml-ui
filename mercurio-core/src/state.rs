use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use syster::ide::AnalysisHost;
use syster::syntax::SyntaxFile;

#[derive(Serialize, Clone)]
pub struct CompileFileResult {
    pub path: String,
    pub ok: bool,
    pub errors: Vec<String>,
    pub symbol_count: usize,
}
use crate::settings::AppSettings;

pub(crate) struct StdlibCache {
    pub(crate) path: PathBuf,
    pub(crate) files: Vec<(PathBuf, SyntaxFile)>,
}

#[derive(Default)]
pub(crate) struct WorkspaceState {
    pub(crate) root: Option<PathBuf>,
    pub(crate) project_files: HashSet<PathBuf>,
    pub(crate) import_files: HashSet<PathBuf>,
    pub(crate) stdlib_path: Option<PathBuf>,
    pub(crate) file_mtimes: HashMap<PathBuf, SystemTime>,
    pub(crate) file_cache: HashMap<PathBuf, CompileFileResult>,
}

#[derive(Clone)]
pub struct CoreState {
    pub(crate) stdlib_cache: Arc<Mutex<Option<StdlibCache>>>,
    pub(crate) canceled_compiles: Arc<Mutex<HashSet<u64>>>,
    pub(crate) analysis_host: Arc<Mutex<AnalysisHost>>,
    pub(crate) workspace: Arc<Mutex<WorkspaceState>>,
    pub stdlib_root: PathBuf,
    pub settings: Arc<Mutex<AppSettings>>,
}

impl CoreState {
    pub fn new(stdlib_root: PathBuf, settings: AppSettings) -> Self {
        Self {
            stdlib_cache: Arc::new(Mutex::new(None)),
            canceled_compiles: Arc::new(Mutex::new(HashSet::new())),
            analysis_host: Arc::new(Mutex::new(AnalysisHost::new())),
            workspace: Arc::new(Mutex::new(WorkspaceState::default())),
            stdlib_root,
            settings: Arc::new(Mutex::new(settings)),
        }
    }
}
