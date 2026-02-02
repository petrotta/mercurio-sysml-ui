use notify::RecommendedWatcher;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use syster::ide::AnalysisHost;
use syster::syntax::SyntaxFile;

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Serialize, Clone)]
pub struct CompileFileResult {
    pub path: String,
    pub ok: bool,
    pub errors: Vec<String>,
    pub symbol_count: usize,
}

#[derive(Deserialize, Clone)]
#[serde(untagged)]
pub enum LibraryConfig {
    Default(String),
    Path { path: String },
}

#[derive(Deserialize, Default, Clone)]
pub struct ProjectConfig {
    pub library: Option<LibraryConfig>,
    pub src: Option<Vec<String>>,
    #[serde(rename = "import")]
    pub import_entries: Option<Vec<String>>,
}

#[derive(Serialize, Clone)]
pub struct ParseErrorView {
    pub message: String,
    pub line: usize,
    pub column: usize,
    pub kind: String,
}

#[derive(Serialize, Clone)]
pub struct ParseErrorsPayload {
    pub path: String,
    pub errors: Vec<ParseErrorView>,
}

#[derive(Serialize)]
pub struct StartupOpen {
    pub path: String,
    pub kind: String,
}

#[derive(Serialize, Clone)]
pub struct FsEventPayload {
    pub path: String,
    pub kind: String,
}

#[derive(Clone)]
pub struct AppState {
    pub watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
    pub stdlib_cache: Arc<Mutex<Option<StdlibCache>>>,
    pub canceled_compiles: Arc<Mutex<HashSet<u64>>>,
    pub analysis_host: Arc<Mutex<AnalysisHost>>,
    pub workspace: Arc<Mutex<WorkspaceState>>,
    pub stdlib_root: PathBuf,
    pub settings_path: PathBuf,
    pub settings: Arc<Mutex<AppSettings>>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct AppSettings {
    pub default_stdlib: Option<String>,
}

pub struct MercurioPaths {
    pub stdlib_root: PathBuf,
    pub settings_path: PathBuf,
}

pub struct StdlibCache {
    pub path: PathBuf,
    pub files: Vec<(PathBuf, SyntaxFile)>,
}

#[derive(Clone)]
pub struct UnsavedFile {
    pub path: PathBuf,
    pub content: String,
}

#[derive(Default)]
pub struct WorkspaceState {
    pub root: Option<PathBuf>,
    pub project_files: HashSet<PathBuf>,
    pub import_files: HashSet<PathBuf>,
    pub stdlib_path: Option<PathBuf>,
    pub file_mtimes: HashMap<PathBuf, SystemTime>,
    pub file_cache: HashMap<PathBuf, CompileFileResult>,
}

#[derive(Deserialize)]
pub struct PackagedStdlibManifest {
    pub stdlibs: Vec<PackagedStdlibEntry>,
}

#[derive(Deserialize)]
pub struct PackagedStdlibEntry {
    pub id: String,
    pub zip: String,
}

#[derive(Serialize)]
pub struct CompileResponse {
    pub ok: bool,
    pub files: Vec<CompileFileResult>,
    pub symbols: Vec<SymbolView>,
    pub unresolved: Vec<UnresolvedRefView>,
    pub library_path: Option<String>,
    pub parse_failed: bool,
}

#[derive(Serialize, Clone)]
pub struct CompileProgressPayload {
    pub run_id: u64,
    pub stage: String,
    pub file: Option<String>,
    pub index: Option<usize>,
    pub total: Option<usize>,
}

#[derive(Serialize)]
pub struct UnresolvedRefView {
    pub file_path: String,
    pub message: String,
    pub line: u32,
    pub column: u32,
    pub code: Option<String>,
}

#[derive(Serialize)]
pub struct SymbolView {
    pub file_path: String,
    pub name: String,
    pub short_name: Option<String>,
    pub qualified_name: String,
    pub kind: String,
    pub file: u32,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub short_name_start_line: Option<u32>,
    pub short_name_start_col: Option<u32>,
    pub short_name_end_line: Option<u32>,
    pub short_name_end_col: Option<u32>,
    pub doc: Option<String>,
    pub supertypes: Vec<String>,
    pub relationships: Vec<RelationshipView>,
    pub type_refs: Vec<TypeRefView>,
    pub is_public: bool,
    pub properties: Vec<PropertyItemView>,
}

#[derive(Serialize)]
pub struct PropertyItemView {
    pub name: String,
    pub label: String,
    pub value: PropertyValueView,
    pub hint: Option<String>,
    pub group: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PropertyValueView {
    Text { value: String },
    List { items: Vec<String> },
    Bool { value: bool },
    Number { value: u64 },
}

pub struct PropertyDescriptor {
    pub name: &'static str,
    pub label: &'static str,
    pub hint: Option<&'static str>,
    pub group: Option<&'static str>,
    pub getter: fn(&syster::hir::HirSymbol, &std::path::Path) -> PropertyValueView,
}

#[derive(Serialize)]
pub struct RelationshipView {
    pub kind: String,
    pub target: String,
    pub resolved_target: Option<String>,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

#[derive(Serialize)]
pub struct TypeRefPartView {
    pub kind: String,
    pub target: String,
    pub resolved_target: Option<String>,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TypeRefView {
    Simple { part: TypeRefPartView },
    Chain { parts: Vec<TypeRefPartView> },
}

#[derive(Serialize)]
pub struct LlmHintsMeta {
    pub path: String,
    pub modified_ms: u128,
}

#[derive(Deserialize)]
pub struct FrontendLogPayload {
    pub level: String,
    pub kind: String,
    pub message: String,
}
