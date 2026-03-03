use mercurio_symbol_index::{InMemorySymbolIndex, SqliteSymbolIndexStore, SymbolIndex};
use mercurio_sysml_pkg::compile_support::StdlibSnapshotCacheEntry;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use crate::settings::AppSettings;
use crate::stdlib::StdlibMetamodelView;

#[derive(Serialize, Clone)]
pub struct CompileFileResult {
    pub path: String,
    pub ok: bool,
    pub errors: Vec<String>,
    pub symbol_count: usize,
}

#[derive(Clone)]
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

#[derive(Default)]
pub(crate) struct WorkspaceState {
    pub(crate) file_mtimes: HashMap<PathBuf, SystemTime>,
    pub(crate) file_cache: HashMap<PathBuf, CompileFileResult>,
}

#[derive(Clone)]
pub struct CoreState {
    pub(crate) stdlib_cache: Arc<Mutex<HashMap<String, StdlibCache>>>,
    pub(crate) canceled_compiles: Arc<Mutex<HashSet<u64>>>,
    pub(crate) workspace: Arc<Mutex<WorkspaceState>>,
    pub(crate) metamodel_cache: Arc<Mutex<HashMap<String, StdlibMetamodelView>>>,
    pub(crate) symbol_index: Arc<Mutex<SymbolIndex>>,
    pub stdlib_root: PathBuf,
    pub settings: Arc<Mutex<AppSettings>>,
}

impl CoreState {
    pub fn new(stdlib_root: PathBuf, settings: AppSettings) -> Self {
        let index_path = stdlib_root
            .parent()
            .map(|parent| parent.join("symbol-index.db"))
            .unwrap_or_else(|| stdlib_root.join("symbol-index.db"));
        let symbol_index = SqliteSymbolIndexStore::open(&index_path)
            .map(SymbolIndex::Sqlite)
            .unwrap_or_else(|_| SymbolIndex::InMemory(InMemorySymbolIndex::default()));
        Self {
            stdlib_cache: Arc::new(Mutex::new(HashMap::new())),
            canceled_compiles: Arc::new(Mutex::new(HashSet::new())),
            workspace: Arc::new(Mutex::new(WorkspaceState::default())),
            metamodel_cache: Arc::new(Mutex::new(HashMap::new())),
            symbol_index: Arc::new(Mutex::new(symbol_index)),
            stdlib_root,
            settings: Arc::new(Mutex::new(settings)),
        }
    }
}
