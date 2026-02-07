use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{Instant, SystemTime};
use std::sync::{Arc, Mutex};
use syster::base::constants::STDLIB_DIR;
use syster::base::FileId;
use syster::hir::{extract_symbols_unified, HirRelationship, HirSymbol, SymbolKind, TypeRef, TypeRefKind};
use syster::hir::SemanticChecker;
use syster::ide::AnalysisHost;
use syster::interchange::{detect_format, model_from_symbols, restore_ids_from_symbols, JsonLd, Kpar, ModelFormat, Xmi};
use syster::project::StdLibLoader;
use syster::syntax::SyntaxFile;
use syster::syntax::parser::parse_with_result;

#[derive(Serialize, Clone)]
pub struct CompileFileResult {
  pub path: String,
  pub ok: bool,
  pub errors: Vec<String>,
  pub symbol_count: usize,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(untagged)]
pub enum LibraryConfig {
    Default(String),
    Path { path: String },
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct ProjectConfig {
    pub library: Option<LibraryConfig>,
    pub stdlib: Option<String>,
    pub src: Option<Vec<String>>,
    #[serde(rename = "import", alias = "import_entries")]
    pub import_entries: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct ProjectDescriptor {
    pub name: Option<String>,
    pub author: Option<String>,
    pub description: Option<String>,
    pub organization: Option<String>,
    #[serde(flatten)]
    pub config: ProjectConfig,
}

#[derive(Serialize, Clone)]
pub struct ProjectDescriptorView {
    pub name: Option<String>,
    pub author: Option<String>,
    pub description: Option<String>,
    pub organization: Option<String>,
    pub default_library: bool,
    pub stdlib: Option<String>,
    pub library: Option<LibraryConfig>,
    pub src: Vec<String>,
    pub import_entries: Vec<String>,
    pub raw_json: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct DiagramFile {
    #[serde(default = "default_diagram_version")]
    pub version: u32,
    #[serde(default)]
    pub nodes: Vec<DiagramNode>,
    #[serde(default)]
    pub offsets: HashMap<String, DiagramOffset>,
    #[serde(default)]
    pub sizes: HashMap<String, DiagramSize>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct DiagramNode {
    pub qualified: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct DiagramOffset {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct DiagramSize {
    pub width: f64,
    pub height: f64,
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
pub struct CompileResponse {
    pub ok: bool,
    pub files: Vec<CompileFileResult>,
    pub symbols: Vec<SymbolView>,
    pub unresolved: Vec<UnresolvedRefView>,
    pub library_path: Option<String>,
    pub parse_failed: bool,
    pub stdlib_cache_hit: bool,
    pub parsed_files: Vec<String>,
    pub parse_duration_ms: u128,
    pub analysis_duration_ms: u128,
    pub stdlib_duration_ms: u128,
    pub total_duration_ms: u128,
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
    pub getter: fn(&HirSymbol, &Path) -> PropertyValueView,
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

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct AppSettings {
    pub default_stdlib: Option<String>,
}

pub struct MercurioPaths {
    pub stdlib_root: PathBuf,
    pub settings_path: PathBuf,
}

struct StdlibCache {
    path: PathBuf,
    files: Vec<(PathBuf, SyntaxFile)>,
}

#[derive(Clone)]
pub struct UnsavedFile {
    pub path: PathBuf,
    pub content: String,
}

#[derive(Default)]
struct WorkspaceState {
    root: Option<PathBuf>,
    project_files: HashSet<PathBuf>,
    import_files: HashSet<PathBuf>,
    stdlib_path: Option<PathBuf>,
    file_mtimes: HashMap<PathBuf, SystemTime>,
    file_cache: HashMap<PathBuf, CompileFileResult>,
}

#[derive(Clone)]
pub struct CoreState {
    stdlib_cache: Arc<Mutex<Option<StdlibCache>>>,
    canceled_compiles: Arc<Mutex<HashSet<u64>>>,
    analysis_host: Arc<Mutex<AnalysisHost>>,
    workspace: Arc<Mutex<WorkspaceState>>,
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

pub fn resolve_user_local_dir() -> PathBuf {
    if cfg!(target_os = "windows") {
        env::var_os("LOCALAPPDATA")
            .or_else(|| env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    } else {
        env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    }
}
pub fn resolve_mercurio_user_dir() -> PathBuf {
    resolve_user_local_dir().join(".mercurio")
}

pub fn ensure_mercurio_paths() -> Result<MercurioPaths, String> {
    let root = resolve_mercurio_user_dir();
    let stdlib_root = root.join("stdlib");
    fs::create_dir_all(&stdlib_root).map_err(|e| e.to_string())?;
    let settings_path = root.join("settings.json");
    Ok(MercurioPaths {
        stdlib_root,
        settings_path,
    })
}

pub fn load_app_settings(path: &Path) -> AppSettings {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => AppSettings::default(),
    }
}

pub fn save_app_settings(path: &Path, settings: &AppSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let payload = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, payload).map_err(|e| e.to_string())
}

fn default_diagram_version() -> u32 {
    1
}

fn normalize_diagram(diagram: &mut DiagramFile) {
    if diagram.version == 0 {
        diagram.version = 1;
    }
    for node in &mut diagram.nodes {
        if node.name.trim().is_empty() {
            node.name = node
                .qualified
                .split("::")
                .filter(|segment| !segment.is_empty())
                .last()
                .unwrap_or("Node")
                .to_string();
        }
    }
}

pub fn read_diagram(root: &Path, path: &Path) -> Result<DiagramFile, String> {
    let target_path = resolve_under_root(root, path)?;
    if !target_path.exists() {
        return Ok(DiagramFile::default());
    }
    let raw = fs::read_to_string(&target_path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(DiagramFile::default());
    }
    let mut diagram: DiagramFile =
        serde_json::from_str(&raw).map_err(|e| format!("Invalid diagram file: {}", e))?;
    normalize_diagram(&mut diagram);
    Ok(diagram)
}

pub fn write_diagram(root: &Path, path: &Path, diagram: DiagramFile) -> Result<(), String> {
    let target_path = resolve_under_root(root, path)?;
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut normalized = diagram;
    normalize_diagram(&mut normalized);
    let payload = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
    fs::write(target_path, payload).map_err(|e| e.to_string())
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new("\\")),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(segment) => normalized.push(segment),
        }
    }
    normalized
}

fn resolve_under_root(root: &Path, target: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let joined = if target.is_absolute() {
        target.to_path_buf()
    } else {
        root.join(target)
    };
    let normalized = normalize_path(&joined);
    if !normalized.starts_with(&root) {
        let root_str = root.to_string_lossy();
        let path_str = normalized.to_string_lossy();
        let strip = |value: &str| {
            let value = value.replace('/', "\\").to_lowercase();
            value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
        };
        let root_cmp = strip(&root_str);
        let path_cmp = strip(&path_str);
        if !path_cmp.starts_with(&root_cmp) {
            return Err("Path is outside the project root".to_string());
        }
    }
    Ok(normalized)
}

fn is_path_under_root(root: &Path, path: &str) -> bool {
    let root_norm = root.canonicalize().ok();
    let path_norm = PathBuf::from(path).canonicalize().ok();
    if let (Some(root_norm), Some(path_norm)) = (root_norm, path_norm) {
        return path_norm.starts_with(&root_norm);
    }
    let root_str = root.to_string_lossy().to_lowercase();
    let path_str = path.to_lowercase();
    if root_str.is_empty() || path_str.is_empty() {
        return false;
    }
    path_str.starts_with(&root_str)
}

fn is_import_extension(ext: &str) -> bool {
    matches!(
        ext.to_lowercase().as_str(),
        "xmi" | "sysmlx" | "kermlx" | "kpar" | "jsonld" | "json"
    )
}

fn is_model_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_lowercase().as_str(), "sysml" | "kerml"))
        .unwrap_or(false)
}

fn is_import_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| is_import_extension(ext))
        .unwrap_or(false)
}

fn discover_stdlib_path() -> PathBuf {
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
    {
        let stdlib_next_to_exe = exe_dir.join(STDLIB_DIR);
        if stdlib_next_to_exe.exists() && stdlib_next_to_exe.is_dir() {
            return stdlib_next_to_exe;
        }
    }

    PathBuf::from(STDLIB_DIR)
}

fn resolve_default_stdlib_path(
    root: &Path,
    stdlib_root: &Path,
    default_stdlib: Option<&str>,
) -> PathBuf {
    let root_stdlib = root.join(STDLIB_DIR);
    if root_stdlib.exists() && root_stdlib.is_dir() {
        return root_stdlib;
    }

    if let Some(version) = default_stdlib {
        let candidate = stdlib_root.join(version);
        if candidate.exists() && candidate.is_dir() {
            return candidate;
        }
    }
    if let Ok(versions) = list_stdlib_versions_from_root(stdlib_root) {
        if let Some(first) = versions.first() {
            let candidate = stdlib_root.join(first);
            if candidate.exists() && candidate.is_dir() {
                return candidate;
            }
        }
    }

    discover_stdlib_path()
}

fn load_stdlib_cached(
    state: &CoreState,
    stdlib_path: &Path,
) -> Result<Vec<(PathBuf, SyntaxFile)>, String> {
    let mut guard = state
        .stdlib_cache
        .lock()
        .map_err(|_| "Stdlib cache lock poisoned".to_string())?;
    if let Some(cache) = guard.as_ref() {
        if cache.path == stdlib_path {
            return Ok(cache.files.clone());
        }
    }

    let mut host = AnalysisHost::new();
    let loader = StdLibLoader::with_path(stdlib_path.to_path_buf());
    loader.load_into_host(&mut host)?;
    let files = host
        .files()
        .iter()
        .map(|(path, file)| (path.clone(), file.clone()))
        .collect::<Vec<_>>();
    *guard = Some(StdlibCache {
        path: stdlib_path.to_path_buf(),
        files: files.clone(),
    });
    Ok(files)
}

pub fn list_stdlib_versions_from_root(stdlib_root: &Path) -> Result<Vec<String>, String> {
    if !stdlib_root.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    let read_dir = fs::read_dir(stdlib_root).map_err(|e| e.to_string())?;
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
                entries.push(name.to_string());
            }
        }
    }
    entries.sort();
    Ok(entries)
}

pub fn get_parse_errors(path: &Path) -> Result<ParseErrorsPayload, String> {
    if !path.exists() {
        return Err("File does not exist".to_string());
    }
    if !is_model_file(path) {
        return Ok(ParseErrorsPayload {
            path: path.to_string_lossy().to_string(),
            errors: Vec::new(),
        });
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    get_parse_errors_for_content(path, &content)
}

pub fn get_parse_errors_for_content(path: &Path, content: &str) -> Result<ParseErrorsPayload, String> {
    if !is_model_file(path) {
        return Ok(ParseErrorsPayload {
            path: path.to_string_lossy().to_string(),
            errors: Vec::new(),
        });
    }
    let parse = parse_with_result(content, path);
    let errors = parse
        .errors
        .iter()
        .map(|err| ParseErrorView {
            message: err.message.clone(),
            line: err.position.line,
            column: err.position.column,
            kind: "parse".to_string(),
        })
        .collect::<Vec<_>>();
    Ok(ParseErrorsPayload {
        path: path.to_string_lossy().to_string(),
        errors,
    })
}

pub fn cancel_compile(state: &CoreState, run_id: u64) -> Result<(), String> {
    let mut set = state
        .canceled_compiles
        .lock()
        .map_err(|_| "Cancel lock poisoned".to_string())?;
    set.insert(run_id);
    Ok(())
}

pub fn compile_workspace_sync<F: Fn(CompileProgressPayload)>(
    state: &CoreState,
    root: String,
    run_id: u64,
    allow_parse_errors: bool,
    unsaved: Vec<UnsavedFile>,
    emit_progress: F,
) -> Result<CompileResponse, String> {
    let compile_start = Instant::now();
    let mut stdlib_cache_hit = false;
    let mut parsed_files: Vec<String> = Vec::new();
    let mut analysis_duration_ms: u128 = 0;
    let mut stdlib_duration_ms: u128 = 0;
    let root_path = PathBuf::from(root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }
    let default_stdlib = state
        .settings
        .lock()
        .ok()
        .and_then(|settings| settings.default_stdlib.clone());

    let _cancel_guard = CancelGuard {
        canceled: state.canceled_compiles.clone(),
        run_id,
    };

    let is_canceled = || {
        state
            .canceled_compiles
            .lock()
            .map(|set| set.contains(&run_id))
            .unwrap_or(false)
    };
    let check_cancel = || {
        if is_canceled() {
            return Err("Compile canceled".to_string());
        }
        Ok(())
    };
    let emit_progress = |stage: &str, file: Option<String>, index: Option<usize>, total: Option<usize>| {
        emit_progress(CompileProgressPayload {
            run_id,
            stage: stage.to_string(),
            file,
            index,
            total,
        });
    };

    let mut files = Vec::new();
    let mut used_project_src = false;
    let project_config = load_project_config(&root_path).ok().flatten();
    if let Some(config) = project_config.clone() {
        if let Some(src) = config.src {
            files = collect_project_files(&root_path, &src)?;
            used_project_src = true;
        }
    }
    if !used_project_src {
        collect_model_files(&root_path, &mut files)?;
    }
    check_cancel()?;

    let mut symbols = Vec::new();
    let mut file_results: Vec<CompileFileResult>;
    let mut unresolved = Vec::new();

    let mut analysis_host = state
        .analysis_host
        .lock()
        .map_err(|_| "Analysis host lock poisoned".to_string())?;
    let mut workspace = state
        .workspace
        .lock()
        .map_err(|_| "Workspace lock poisoned".to_string())?;

    let import_files = project_config
        .as_ref()
        .and_then(|config| config.import_entries.as_ref())
        .map(|imports| collect_project_imports(&root_path, imports))
        .transpose()?
        .unwrap_or_default();
    let import_set: HashSet<PathBuf> = import_files.iter().cloned().collect();

    let library_config = project_config.as_ref().and_then(|config| config.library.clone());
    let stdlib_override = project_config.as_ref().and_then(|config| config.stdlib.clone());
    let (stdlib_loader, _stdlib_source, stdlib_path_for_log) = match library_config {
        Some(LibraryConfig::Path { path }) => {
            if path.trim().is_empty() {
                let discovered = resolve_default_stdlib_path(
                    &root_path,
                    &state.stdlib_root,
                    default_stdlib.as_deref(),
                );
                (StdLibLoader::new(), "".to_string(), Some(discovered))
            } else {
                let raw_path = PathBuf::from(&path);
                let resolved = if raw_path.is_absolute() {
                    raw_path
                } else {
                    root_path.join(raw_path)
                };
                (StdLibLoader::with_path(resolved.clone()), "".to_string(), Some(resolved))
            }
        }
        Some(LibraryConfig::Default(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("default") {
                let discovered = resolve_default_stdlib_path(
                    &root_path,
                    &state.stdlib_root,
                    default_stdlib.as_deref(),
                );
                (StdLibLoader::new(), "".to_string(), Some(discovered))
            } else {
                let raw_path = PathBuf::from(trimmed);
                let resolved = if raw_path.is_absolute() {
                    raw_path
                } else {
                    root_path.join(raw_path)
                };
                (StdLibLoader::with_path(resolved.clone()), "".to_string(), Some(resolved))
            }
        }
        None => {
            if let Some(stdlib_id) = stdlib_override {
                let trimmed = stdlib_id.trim();
                if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("default") {
                    let discovered = resolve_default_stdlib_path(
                        &root_path,
                        &state.stdlib_root,
                        default_stdlib.as_deref(),
                    );
                    (StdLibLoader::new(), "".to_string(), Some(discovered))
                } else {
                    let resolved = state.stdlib_root.join(trimmed);
                    (StdLibLoader::new(), "".to_string(), Some(resolved))
                }
            } else {
                let discovered = resolve_default_stdlib_path(
                    &root_path,
                    &state.stdlib_root,
                    default_stdlib.as_deref(),
                );
                (StdLibLoader::new(), "".to_string(), Some(discovered))
            }
        }
    };
    let project_set: HashSet<PathBuf> = files.iter().cloned().collect();
    let needs_reset = workspace.root.as_ref() != Some(&root_path)
        || workspace.stdlib_path.as_ref() != stdlib_path_for_log.as_ref()
        || workspace.import_files != import_set;

    if needs_reset {
        *analysis_host = AnalysisHost::new();
        workspace.root = Some(root_path.clone());
        workspace.stdlib_path = stdlib_path_for_log.clone();
        workspace.import_files = import_set.clone();
        workspace.project_files.clear();
        workspace.file_mtimes.clear();
        workspace.file_cache.clear();

        if !import_files.is_empty() {
            load_imports_into_host(&mut analysis_host, &import_files)?;
        }

        let stdlib_path_exists = stdlib_path_for_log
            .as_ref()
            .map(|path| path.exists() && path.is_dir())
            .unwrap_or(false);
        let stdlib_start = Instant::now();
        if stdlib_path_exists {
            if let Some(stdlib_path) = stdlib_path_for_log.as_ref() {
                let cached_files = load_stdlib_cached(state, stdlib_path)?;
                for (path, file) in cached_files {
                    analysis_host.set_file(path, file);
                }
                stdlib_cache_hit = true;
            }
        } else {
            stdlib_loader.load_into_host(&mut analysis_host)?;
        }
        stdlib_duration_ms = stdlib_start.elapsed().as_millis();
    }

    let parse_start = Instant::now();
    let mut has_parse_errors = false;
    emit_progress("parsing", None, None, Some(files.len()));

    let mut unsaved_map = HashMap::new();
    for entry in unsaved {
        unsaved_map.insert(entry.path, entry.content);
    }

    let removed: Vec<PathBuf> = workspace
        .project_files
        .difference(&project_set)
        .cloned()
        .collect();
    for path in &removed {
        analysis_host.remove_file_path(path);
        workspace.file_mtimes.remove(path);
        workspace.file_cache.remove(path);
    }
    for path in &project_set {
        if !workspace.project_files.contains(path) {
            workspace.project_files.insert(path.clone());
        }
    }

    for (index, path) in files.iter().enumerate() {
        check_cancel()?;
        emit_progress(
            "parsing",
            Some(path.to_string_lossy().to_string()),
            Some(index + 1),
            Some(files.len()),
        );

        let mut should_parse = false;
        let mut content_override = None;
        if let Some(content) = unsaved_map.get(path) {
            should_parse = true;
            content_override = Some(content.as_str());
        } else {
            let meta = fs::metadata(path).map_err(|e| e.to_string())?;
            let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let known = workspace.file_mtimes.get(path);
            if known.is_none() || known != Some(&modified) {
                should_parse = true;
                workspace.file_mtimes.insert(path.clone(), modified);
            }
        }

        if should_parse || !workspace.file_cache.contains_key(path) {
            parsed_files.push(path.to_string_lossy().to_string());
            let content = match content_override {
                Some(value) => value.to_string(),
                None => fs::read_to_string(path).map_err(|e| e.to_string())?,
            };
            let parse = parse_with_result(&content, path);
            let errors = parse
                .errors
                .iter()
                .map(|e| format!("{:?}", e))
                .collect::<Vec<_>>();
            let ok = parse.content.is_some() && errors.is_empty();
            if !ok {
                has_parse_errors = true;
            }
            let mut symbol_count = 0;

            if let Some(syntax) = parse.content {
                let file_id = FileId::new(index as u32);
                let file_symbols = extract_symbols_unified(file_id, &syntax);
                symbol_count = file_symbols.len();
                analysis_host.set_file(path.to_path_buf(), syntax);
            }

            workspace.file_cache.insert(
                path.to_path_buf(),
                CompileFileResult {
                    path: path.to_string_lossy().to_string(),
                    ok,
                    errors,
                    symbol_count,
                },
            );
        } else if let Some(result) = workspace.file_cache.get(path) {
            if !result.ok {
                has_parse_errors = true;
            }
        }
    }

    file_results = workspace
        .project_files
        .iter()
        .filter_map(|path| workspace.file_cache.get(path).cloned())
        .collect();
    file_results.sort_by(|a, b| a.path.cmp(&b.path));
    if has_parse_errors && !allow_parse_errors {
        return Ok(CompileResponse {
            ok: false,
            files: file_results,
            symbols,
            unresolved,
            library_path: stdlib_path_for_log
                .as_ref()
                .map(|path| path.to_string_lossy().to_string()),
            parse_failed: true,
            stdlib_cache_hit,
            parsed_files,
            parse_duration_ms: parse_start.elapsed().as_millis(),
            analysis_duration_ms,
            stdlib_duration_ms,
            total_duration_ms: compile_start.elapsed().as_millis(),
        });
    }

    if analysis_host.file_count() > 0 {
        let analysis_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            check_cancel()?;
            emit_progress("analysis", None, None, None);
            let analysis_start = Instant::now();
            let _ = analysis_host.analysis();
            analysis_duration_ms = analysis_start.elapsed().as_millis();
            check_cancel()?;

            let project_file_ids = files
                .iter()
                .filter_map(|path| analysis_host.get_file_id_for_path(path))
                .collect::<Vec<_>>();
            if !project_file_ids.is_empty() {
                check_cancel()?;
                let semantic_total = project_file_ids.len();
                emit_progress("semantic", None, Some(0), Some(semantic_total));
                let symbol_index = analysis_host.symbol_index().clone();
                let canceled_compiles = state.canceled_compiles.clone();
                let run_id = run_id;
                let semantic_result = std::thread::Builder::new()
                    .name("semantic-check".to_string())
                    .stack_size(64 * 1024 * 1024)
                    .spawn(move || {
                        let mut checker = SemanticChecker::new(&symbol_index);
                        for (_index, file_id) in project_file_ids.into_iter().enumerate() {
                            let canceled = canceled_compiles
                                .lock()
                                .map(|set| set.contains(&run_id))
                                .unwrap_or(false);
                            if canceled {
                                return Err("Compile canceled".to_string());
                            }
                            checker.check_file(file_id);
                        }
                        Ok(checker.finish())
                    })
                    .map_err(|e| e.to_string())?
                    .join()
                    .map_err(|_| "Semantic checker thread panicked".to_string())?;
                let semantic_result = semantic_result?;
                unresolved = semantic_result
                    .into_iter()
                    .filter(|diag| diag.message.to_lowercase().contains("undefined reference"))
                    .filter_map(|diag| {
                        let path = analysis_host.get_file_path(diag.file)?;
                        Some(UnresolvedRefView {
                            file_path: path.to_string(),
                            message: diag.message.to_string(),
                            line: diag.start_line,
                            column: diag.start_col,
                            code: diag.code.map(|c| c.to_string()),
                        })
                    })
                    .collect();
            }

            check_cancel()?;
            let analysis_snapshot = analysis_host.analysis();
            let mut all_symbols: Vec<_> = analysis_snapshot
                .symbol_index()
                .all_symbols()
                .cloned()
                .collect();
            all_symbols.sort_by(|a, b| {
                let a_path = analysis_snapshot.get_file_path(a.file).unwrap_or("");
                let b_path = analysis_snapshot.get_file_path(b.file).unwrap_or("");
                match a_path.cmp(b_path) {
                    std::cmp::Ordering::Equal => a
                        .qualified_name
                        .as_ref()
                        .cmp(b.qualified_name.as_ref()),
                    other => other,
                }
            });
            symbols = all_symbols
                .into_iter()
                .map(|symbol| {
                    let file_path = analysis_snapshot.get_file_path(symbol.file).unwrap_or("");
                    symbol_to_view(symbol, Path::new(file_path))
                })
                .collect();
            Ok::<(), String>(())
        }));

        match analysis_result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => return Err(err),
            Err(_) => {
                return Err("Compile failed during analysis (panic).".to_string());
            }
        }
    }

    Ok(CompileResponse {
        ok: file_results.iter().all(|f| f.ok),
        files: file_results,
        symbols,
        unresolved,
        library_path: stdlib_path_for_log
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        parse_failed: false,
        stdlib_cache_hit,
        parsed_files,
        parse_duration_ms: parse_start.elapsed().as_millis(),
        analysis_duration_ms,
        stdlib_duration_ms,
        total_duration_ms: compile_start.elapsed().as_millis(),
    })
}

pub fn export_model_to_path(
    state: &CoreState,
    root: String,
    output: String,
    format: String,
    include_stdlib: bool,
) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }
    let default_stdlib = state
        .settings
        .lock()
        .ok()
        .and_then(|settings| settings.default_stdlib.clone());

    let project_config = load_project_config(&root_path).ok().flatten();
    let mut analysis_host = AnalysisHost::new();

    if let Some(imports) = project_config
        .as_ref()
        .and_then(|config| config.import_entries.as_ref())
    {
        let import_files = collect_project_imports(&root_path, imports)?;
        if !import_files.is_empty() {
            load_imports_into_host(&mut analysis_host, &import_files)?;
        }
    }

    let library_config = project_config.as_ref().and_then(|config| config.library.clone());
    let stdlib_override = project_config.as_ref().and_then(|config| config.stdlib.clone());
    let (stdlib_loader, stdlib_path_for_log) = match library_config {
        Some(LibraryConfig::Path { path }) => {
            if path.trim().is_empty() {
                let discovered = resolve_default_stdlib_path(
                    &root_path,
                    &state.stdlib_root,
                    default_stdlib.as_deref(),
                );
                (StdLibLoader::new(), Some(discovered))
            } else {
                let raw_path = PathBuf::from(&path);
                let resolved = if raw_path.is_absolute() {
                    raw_path
                } else {
                    root_path.join(raw_path)
                };
                (StdLibLoader::with_path(resolved.clone()), Some(resolved))
            }
        }
        Some(LibraryConfig::Default(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("default") {
                let discovered = resolve_default_stdlib_path(
                    &root_path,
                    &state.stdlib_root,
                    default_stdlib.as_deref(),
                );
                (StdLibLoader::new(), Some(discovered))
            } else {
                let raw_path = PathBuf::from(trimmed);
                let resolved = if raw_path.is_absolute() {
                    raw_path
                } else {
                    root_path.join(raw_path)
                };
                (StdLibLoader::with_path(resolved.clone()), Some(resolved))
            }
        }
        None => {
            if let Some(stdlib_id) = stdlib_override {
                let trimmed = stdlib_id.trim();
                if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("default") {
                    let discovered = resolve_default_stdlib_path(
                        &root_path,
                        &state.stdlib_root,
                        default_stdlib.as_deref(),
                    );
                    (StdLibLoader::new(), Some(discovered))
                } else {
                    let resolved = state.stdlib_root.join(trimmed);
                    (StdLibLoader::new(), Some(resolved))
                }
            } else {
                let discovered = resolve_default_stdlib_path(
                    &root_path,
                    &state.stdlib_root,
                    default_stdlib.as_deref(),
                );
                (StdLibLoader::new(), Some(discovered))
            }
        }
    };
    let stdlib_path_exists = stdlib_path_for_log
        .as_ref()
        .map(|path| path.exists() && path.is_dir())
        .unwrap_or(false);
    if stdlib_path_exists {
        stdlib_loader.load_into_host(&mut analysis_host)?;
    } else {
        stdlib_loader.load_into_host(&mut analysis_host)?;
    }

    let mut files = Vec::new();
    let mut used_project_src = false;
    if let Some(config) = project_config.clone() {
        if let Some(src) = config.src {
            files = collect_project_files(&root_path, &src)?;
            used_project_src = true;
        }
    }
    if !used_project_src {
        collect_model_files(&root_path, &mut files)?;
    }

    for path in &files {
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let parse = parse_with_result(&content, path);
        if parse.content.is_none() || !parse.errors.is_empty() {
            let name = path.to_string_lossy();
            return Err(format!("Parse failed for {}", name));
        }
        if let Some(syntax) = parse.content {
            analysis_host.set_file(path.to_path_buf(), syntax);
        }
    }

    let analysis = analysis_host.analysis();
    let mut symbols: Vec<_> = analysis.symbol_index().all_symbols().cloned().collect();
    if !include_stdlib {
        if let Some(stdlib_root) = stdlib_path_for_log.as_ref() {
            symbols.retain(|symbol| {
                if let Some(file_path) = analysis.get_file_path(symbol.file) {
                    !is_path_under_root(stdlib_root, file_path)
                } else {
                    true
                }
            });
        }
    }
    let mut model = model_from_symbols(&symbols);
    model = restore_ids_from_symbols(model, analysis.symbol_index());

    let format = match format.to_lowercase().as_str() {
        "sysmlx" | "kermlx" | "xmi" => "xmi",
        "kpar" => "kpar",
        "json" | "jsonld" | "json-ld" => "jsonld",
        other => return Err(format!("Unsupported export format: {}", other)),
    };
    let bytes = match format {
        "xmi" => Xmi.write(&model).map_err(|e| e.to_string())?,
        "kpar" => Kpar.write(&model).map_err(|e| e.to_string())?,
        "jsonld" => JsonLd.write(&model).map_err(|e| e.to_string())?,
        _ => return Err(format!("Unsupported export format: {}", format)),
    };

    fs::write(&output, bytes).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn load_project_descriptor(root: &Path) -> Result<Option<ProjectDescriptor>, String> {
    let config_path = root.join(".project");
    let legacy_path = root.join(".project.json");
    let path = if config_path.exists() {
        config_path
    } else if legacy_path.exists() {
        legacy_path
    } else {
        return Ok(None);
    };
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let parsed: ProjectDescriptor = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(Some(parsed))
}

pub fn load_project_config(root: &Path) -> Result<Option<ProjectConfig>, String> {
    Ok(load_project_descriptor(root)?.map(|descriptor| descriptor.config))
}

pub fn get_project_descriptor_view(root: &Path) -> Result<Option<ProjectDescriptorView>, String> {
    let descriptor = match load_project_descriptor(root)? {
        Some(value) => value,
        None => return Ok(None),
    };
    let default_library = matches!(
        descriptor.config.library,
        Some(LibraryConfig::Default(ref value)) if value == "default"
    ) || matches!(
        descriptor.config.stdlib,
        Some(ref value) if value.eq_ignore_ascii_case("default")
    );
    let src = descriptor.config.src.clone().unwrap_or_default();
    let import_entries = descriptor.config.import_entries.clone().unwrap_or_default();
    let raw_json = serde_json::to_string_pretty(&descriptor).map_err(|e| e.to_string())?;
    Ok(Some(ProjectDescriptorView {
        name: descriptor.name,
        author: descriptor.author,
        description: descriptor.description,
        organization: descriptor.organization,
        default_library,
        stdlib: descriptor.config.stdlib,
        library: descriptor.config.library,
        src,
        import_entries,
        raw_json,
    }))
}

fn load_imports_into_host(host: &mut AnalysisHost, imports: &[PathBuf]) -> Result<(), String> {
    for import in imports {
        if import.is_dir() {
            collect_model_files(import, &mut Vec::new())?;
        } else if is_import_file(import) {
            import_model_into_host(host, import)?;
        }
    }
    Ok(())
}

fn import_model_into_host(host: &mut AnalysisHost, path: &Path) -> Result<(), String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    let format_hint = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("xmi")
        .to_lowercase();
    let model = match format_hint.as_str() {
        "xmi" | "sysmlx" | "kermlx" => Xmi.read(&bytes).map_err(|e| e.to_string())?,
        "kpar" => Kpar.read(&bytes).map_err(|e| e.to_string())?,
        "jsonld" | "json" => JsonLd.read(&bytes).map_err(|e| e.to_string())?,
        _ => {
            if let Some(format) = detect_format(path) {
                format.read(&bytes).map_err(|e| e.to_string())?
            } else {
                return Err(format!("Unsupported import format: {}", format_hint));
            }
        }
    };
    let virtual_path = path.to_string_lossy();
    let _ = host.add_model(&model, &virtual_path);
    Ok(())
}

fn collect_project_files(root: &Path, src: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for entry in src {
        let pattern = entry.trim();
        if pattern.is_empty() {
            continue;
        }
        let normalized = pattern.replace('\\', "/");
        if let Some((recursive, ext)) = parse_ext_pattern(&normalized) {
            if recursive {
                collect_model_files_by_extension(root, &ext, &mut out, &mut seen)?;
            } else {
                collect_model_files_in_root_by_extension(root, &ext, &mut out, &mut seen)?;
            }
            continue;
        }

        let resolved = resolve_under_root(root, Path::new(pattern))?;
        if resolved.is_file() {
            let key = resolved.to_string_lossy().to_string();
            if seen.insert(key.clone()) {
                out.push(PathBuf::from(key));
            }
        }
    }

    Ok(out)
}

fn collect_project_imports(root: &Path, imports: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for entry in imports {
        let pattern = entry.trim();
        if pattern.is_empty() {
            continue;
        }
        let normalized = pattern.replace('\\', "/");
        if let Some((recursive, ext)) = parse_ext_pattern(&normalized) {
            if recursive {
                collect_model_files_by_extension(root, &ext, &mut out, &mut seen)?;
            } else {
                collect_model_files_in_root_by_extension(root, &ext, &mut out, &mut seen)?;
            }
            continue;
        }

        let resolved = resolve_under_root(root, Path::new(pattern))?;
        if resolved.is_file() && is_import_file(&resolved) {
            let key = resolved.to_string_lossy().to_string();
            if seen.insert(key.clone()) {
                out.push(PathBuf::from(key));
            }
        }
    }

    Ok(out)
}

fn parse_ext_pattern(pattern: &str) -> Option<(bool, String)> {
    let pattern = pattern.trim();
    if pattern.starts_with("**/") {
        let rest = &pattern[3..];
        if let Some(ext) = parse_simple_ext_pattern(rest) {
            return Some((true, ext));
        }
    }
    if pattern.contains('/') {
        return None;
    }
    parse_simple_ext_pattern(pattern).map(|ext| (false, ext))
}

fn parse_simple_ext_pattern(pattern: &str) -> Option<String> {
    let pattern = pattern.trim();
    if pattern.starts_with("*.") && pattern.len() > 2 {
        return Some(pattern[2..].to_lowercase());
    }
    None
}

fn collect_model_files_in_root_by_extension(
    root: &Path,
    ext: &str,
    out: &mut Vec<PathBuf>,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    let read_dir = fs::read_dir(root).map_err(|e| e.to_string())?;
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            continue;
        }
        if let Some(file_ext) = path.extension().and_then(|ext| ext.to_str()) {
            if file_ext.eq_ignore_ascii_case(ext) {
                let key = path.to_string_lossy().to_string();
                if seen.insert(key.clone()) {
                    out.push(PathBuf::from(key));
                }
            }
        }
    }
    Ok(())
}

fn collect_model_files_by_extension(
    root: &Path,
    ext: &str,
    out: &mut Vec<PathBuf>,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    let read_dir = fs::read_dir(root).map_err(|e| e.to_string())?;
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_model_files_by_extension(&path, ext, out, seen)?;
            continue;
        }
        if let Some(file_ext) = path.extension().and_then(|ext| ext.to_str()) {
            if file_ext.eq_ignore_ascii_case(ext) {
                let key = path.to_string_lossy().to_string();
                if seen.insert(key.clone()) {
                    out.push(PathBuf::from(key));
                }
            }
        }
    }
    Ok(())
}

fn collect_model_files(root: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    collect_model_files_by_extension(root, "sysml", out, &mut HashSet::new())?;
    collect_model_files_by_extension(root, "kerml", out, &mut HashSet::new())?;
    Ok(())
}

fn symbol_to_view(symbol: HirSymbol, file_path: &Path) -> SymbolView {
    let kind_label = symbol_kind_label(symbol.kind);
    let properties = build_properties(&symbol, file_path, &kind_label);
    SymbolView {
        file_path: file_path.to_string_lossy().to_string(),
        name: symbol.name.as_ref().to_string(),
        short_name: symbol.short_name.as_ref().map(|s| s.to_string()),
        qualified_name: symbol.qualified_name.as_ref().to_string(),
        kind: kind_label,
        file: symbol.file.into(),
        start_line: symbol.start_line,
        start_col: symbol.start_col,
        end_line: symbol.end_line,
        end_col: symbol.end_col,
        short_name_start_line: symbol.short_name_start_line,
        short_name_start_col: symbol.short_name_start_col,
        short_name_end_line: symbol.short_name_end_line,
        short_name_end_col: symbol.short_name_end_col,
        doc: symbol.doc.as_ref().map(|s| s.to_string()),
        supertypes: symbol
            .supertypes
            .into_iter()
            .map(|s| s.to_string())
            .collect(),
        relationships: symbol
            .relationships
            .into_iter()
            .map(relationship_to_view)
            .collect(),
        type_refs: symbol
            .type_refs
            .into_iter()
            .map(type_ref_to_view)
            .collect(),
        is_public: symbol.is_public,
        properties,
    }
}

fn relationship_to_view(rel: HirRelationship) -> RelationshipView {
    RelationshipView {
        kind: rel.kind.display().to_string(),
        target: rel.target.as_ref().to_string(),
        resolved_target: rel.resolved_target.as_ref().map(|s| s.to_string()),
        start_line: rel.start_line,
        start_col: rel.start_col,
        end_line: rel.end_line,
        end_col: rel.end_col,
    }
}

fn type_ref_to_view(type_ref: TypeRefKind) -> TypeRefView {
    match type_ref {
        TypeRefKind::Simple(r) => TypeRefView::Simple {
            part: type_ref_part_view(r),
        },
        TypeRefKind::Chain(chain) => TypeRefView::Chain {
            parts: chain.parts.into_iter().map(type_ref_part_view).collect(),
        },
    }
}

fn type_ref_part_view(type_ref: TypeRef) -> TypeRefPartView {
    TypeRefPartView {
        kind: type_ref.kind.display().to_string(),
        target: type_ref.target.as_ref().to_string(),
        resolved_target: type_ref.resolved_target.as_ref().map(|s| s.to_string()),
        start_line: type_ref.start_line,
        start_col: type_ref.start_col,
        end_line: type_ref.end_line,
        end_col: type_ref.end_col,
    }
}

const BASE_PROPERTY_DESCRIPTORS: &[PropertyDescriptor] = &[
    PropertyDescriptor {
        name: "name",
        label: "Name",
        hint: None,
        group: None,
        getter: prop_name,
    },
    PropertyDescriptor {
        name: "short_name",
        label: "Short name",
        hint: None,
        group: None,
        getter: prop_short_name,
    },
    PropertyDescriptor {
        name: "qualified_name",
        label: "Qualified name",
        hint: Some("qualified"),
        group: None,
        getter: prop_qualified_name,
    },
    PropertyDescriptor {
        name: "kind",
        label: "Kind",
        hint: None,
        group: None,
        getter: prop_kind,
    },
    PropertyDescriptor {
        name: "file_path",
        label: "File path",
        hint: Some("path"),
        group: None,
        getter: prop_file_path,
    },
    PropertyDescriptor {
        name: "public",
        label: "Public",
        hint: None,
        group: None,
        getter: prop_public,
    },
    PropertyDescriptor {
        name: "doc",
        label: "Doc",
        hint: Some("doc"),
        group: None,
        getter: prop_doc,
    },
    PropertyDescriptor {
        name: "supertypes",
        label: "Supertypes",
        hint: Some("list"),
        group: None,
        getter: prop_supertypes,
    },
    PropertyDescriptor {
        name: "relationships",
        label: "Relationships",
        hint: Some("list"),
        group: None,
        getter: prop_relationships,
    },
    PropertyDescriptor {
        name: "type_refs",
        label: "Type refs",
        hint: Some("list"),
        group: None,
        getter: prop_type_refs,
    },
    PropertyDescriptor {
        name: "multiplicity",
        label: "Multiplicity",
        hint: Some("multiplicity"),
        group: None,
        getter: prop_multiplicity,
    },
    PropertyDescriptor {
        name: "expression_refs",
        label: "Expression refs",
        hint: Some("list"),
        group: None,
        getter: prop_expression_refs,
    },
];

const PARSE_PROPERTY_DESCRIPTORS: &[PropertyDescriptor] = &[
    PropertyDescriptor {
        name: "file_id",
        label: "File id",
        hint: None,
        group: Some("parse"),
        getter: prop_file_id,
    },
    PropertyDescriptor {
        name: "start_line",
        label: "Start line",
        hint: None,
        group: Some("parse"),
        getter: prop_start_line,
    },
    PropertyDescriptor {
        name: "start_col",
        label: "Start column",
        hint: None,
        group: Some("parse"),
        getter: prop_start_col,
    },
    PropertyDescriptor {
        name: "end_line",
        label: "End line",
        hint: None,
        group: Some("parse"),
        getter: prop_end_line,
    },
    PropertyDescriptor {
        name: "end_col",
        label: "End column",
        hint: None,
        group: Some("parse"),
        getter: prop_end_col,
    },
];

fn property_descriptors_for_kind(kind_label: &str) -> Vec<&'static PropertyDescriptor> {
    let mut descriptors: Vec<&'static PropertyDescriptor> = Vec::new();
    descriptors.extend(BASE_PROPERTY_DESCRIPTORS);
    descriptors.extend(PARSE_PROPERTY_DESCRIPTORS);
    let _kind = kind_label.to_lowercase();
    descriptors
}

fn build_properties(
    symbol: &HirSymbol,
    file_path: &Path,
    kind_label: &str,
) -> Vec<PropertyItemView> {
    property_descriptors_for_kind(kind_label)
        .into_iter()
        .map(|descriptor| PropertyItemView {
            name: descriptor.name.to_string(),
            label: descriptor.label.to_string(),
            value: (descriptor.getter)(symbol, file_path),
            hint: descriptor.hint.map(|hint| hint.to_string()),
            group: descriptor.group.map(|group| group.to_string()),
        })
        .collect()
}

fn prop_name(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Text {
        value: symbol.name.as_ref().to_string(),
    }
}

fn prop_short_name(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Text {
        value: symbol
            .short_name
            .as_ref()
            .map(|s| s.to_string())
            .unwrap_or_default(),
    }
}

fn prop_qualified_name(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Text {
        value: symbol.qualified_name.as_ref().to_string(),
    }
}

fn prop_kind(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Text {
        value: symbol_kind_label(symbol.kind),
    }
}

fn prop_file_path(_symbol: &HirSymbol, file_path: &Path) -> PropertyValueView {
    PropertyValueView::Text {
        value: file_path.to_string_lossy().to_string(),
    }
}

fn prop_public(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Bool {
        value: symbol.is_public,
    }
}

fn prop_doc(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Text {
        value: symbol.doc.as_ref().map(|s| s.to_string()).unwrap_or_default(),
    }
}

fn prop_supertypes(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::List {
        items: symbol.supertypes.iter().map(|s| s.to_string()).collect(),
    }
}

fn prop_relationships(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    let items = symbol
        .relationships
        .iter()
        .map(|rel| {
            let target = rel
                .resolved_target
                .as_ref()
                .unwrap_or(&rel.target)
                .as_ref()
                .to_string();
            format!("{} -> {}", rel.kind.display(), target)
        })
        .collect::<Vec<_>>();
    PropertyValueView::List { items }
}

fn prop_type_refs(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    let items = symbol
        .type_refs
        .iter()
        .filter_map(type_ref_display_target)
        .collect::<Vec<_>>();
    PropertyValueView::List { items }
}

fn prop_expression_refs(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    let mut items = Vec::new();
    for type_ref in &symbol.type_refs {
        match type_ref {
            TypeRefKind::Simple(part) => {
                if matches!(part.kind, syster::hir::RefKind::Expression) {
                    items.push(part.target.as_ref().to_string());
                }
            }
            TypeRefKind::Chain(chain) => {
                let has_expression = chain
                    .parts
                    .iter()
                    .any(|part| matches!(part.kind, syster::hir::RefKind::Expression));
                if has_expression {
                    items.push(chain.as_dotted_string());
                }
            }
        }
    }
    PropertyValueView::List { items }
}

fn prop_multiplicity(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    let value = match symbol.multiplicity {
        None => String::new(),
        Some(m) => {
            let lower = m
                .lower
                .map(|v| v.to_string())
                .unwrap_or_else(|| "*".to_string());
            let upper = m
                .upper
                .map(|v| v.to_string())
                .unwrap_or_else(|| "*".to_string());
            if m.lower.is_some() && m.upper.is_some() && m.lower == m.upper {
                format!("[{}]", lower)
            } else {
                format!("[{}..{}]", lower, upper)
            }
        }
    };
    PropertyValueView::Text { value }
}

fn prop_file_id(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    let file_id: u32 = symbol.file.into();
    PropertyValueView::Number {
        value: file_id as u64,
    }
}

fn prop_start_line(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Number {
        value: symbol.start_line as u64 + 1,
    }
}

fn prop_start_col(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Number {
        value: symbol.start_col as u64 + 1,
    }
}

fn prop_end_line(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Number {
        value: symbol.end_line as u64 + 1,
    }
}

fn prop_end_col(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Number {
        value: symbol.end_col as u64 + 1,
    }
}

fn type_ref_display_target(type_ref: &TypeRefKind) -> Option<String> {
    match type_ref {
        TypeRefKind::Simple(part) => Some(
            part.resolved_target
                .as_ref()
                .unwrap_or(&part.target)
                .as_ref()
                .to_string(),
        ),
        TypeRefKind::Chain(chain) => chain.parts.last().map(|part| {
            part.resolved_target
                .as_ref()
                .unwrap_or(&part.target)
                .as_ref()
                .to_string()
        }),
    }
}

fn symbol_kind_label(kind: SymbolKind) -> String {
    kind.display().to_string()
}

struct CancelGuard {
    canceled: Arc<Mutex<HashSet<u64>>>,
    run_id: u64,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        if let Ok(mut canceled) = self.canceled.lock() {
            canceled.remove(&self.run_id);
        }
    }
}
