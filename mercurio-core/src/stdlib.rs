use mercurio_sysml_core::vfs::Vfs;
use mercurio_sysml_semantics::stdlib::{
    build_metatype_index, load_stdlib_from_path, MetatypeIndex, MetatypeInfo, TypeId,
};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::state::CoreState;

const STDLIB_DIR: &str = "stdlib";

pub(crate) fn resolve_default_stdlib_path(
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

pub fn list_stdlib_versions_from_root(stdlib_root: &Path) -> Result<Vec<String>, String> {
    if !stdlib_root.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(stdlib_root).map_err(|e| e.to_string())?;
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

pub(crate) fn resolve_stdlib_path(
    stdlib_root: &Path,
    default_stdlib: Option<&str>,
    config: Option<&crate::LibraryConfig>,
    override_id: Option<&String>,
    project_root: &Path,
) -> ((), Option<PathBuf>) {
    match config {
        Some(crate::LibraryConfig::Path { path }) => {
            if path.trim().is_empty() {
                let discovered =
                    resolve_default_stdlib_path(project_root, stdlib_root, default_stdlib);
                ((), Some(discovered))
            } else {
                let raw_path = PathBuf::from(path);
                let resolved = if raw_path.is_absolute() {
                    raw_path
                } else {
                    project_root.join(raw_path)
                };
                ((), Some(resolved))
            }
        }
        Some(crate::LibraryConfig::Default(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("default") {
                let discovered =
                    resolve_default_stdlib_path(project_root, stdlib_root, default_stdlib);
                ((), Some(discovered))
            } else {
                let raw_path = PathBuf::from(trimmed);
                let resolved = if raw_path.is_absolute() {
                    raw_path
                } else {
                    project_root.join(raw_path)
                };
                ((), Some(resolved))
            }
        }
        None => {
            if let Some(stdlib_id) = override_id {
                let trimmed = stdlib_id.trim();
                if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("default") {
                    let discovered =
                        resolve_default_stdlib_path(project_root, stdlib_root, default_stdlib);
                    ((), Some(discovered))
                } else {
                    let resolved = stdlib_root.join(trimmed);
                    ((), Some(resolved))
                }
            } else {
                let discovered =
                    resolve_default_stdlib_path(project_root, stdlib_root, default_stdlib);
                ((), Some(discovered))
            }
        }
    }
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

#[derive(Serialize, Clone)]
pub struct StdlibMetamodelView {
    pub stdlib_path: Option<String>,
    pub stdlib_cache_hit: bool,
    pub type_count: usize,
    pub types: Vec<MetamodelTypeView>,
}

#[derive(Serialize, Clone)]
pub struct MetamodelTypeView {
    pub name: String,
    pub qualified_name: String,
    pub declared_supertypes: Vec<String>,
    pub supertypes: Vec<String>,
    pub documentation: Option<String>,
    pub modifiers: MetamodelModifiersView,
    pub attributes: Vec<MetamodelAttributeView>,
}

#[derive(Serialize, Clone)]
pub struct MetamodelAttributeView {
    pub name: String,
    pub qualified_name: String,
    pub declared_type: Option<String>,
    pub multiplicity: Option<String>,
    pub direction: Option<String>,
    pub documentation: Option<String>,
    pub modifiers: MetamodelModifiersView,
}

#[derive(Serialize, Clone)]
pub struct MetamodelModifiersView {
    pub is_public: bool,
    pub is_abstract: bool,
    pub is_variation: bool,
    pub is_readonly: bool,
    pub is_derived: bool,
    pub is_parallel: bool,
}

pub fn get_stdlib_metamodel(
    state: &CoreState,
    root: String,
) -> Result<StdlibMetamodelView, String> {
    let root_path = PathBuf::from(root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }

    let default_stdlib = state
        .settings
        .lock()
        .ok()
        .and_then(|settings| settings.default_stdlib.clone());

    let project_config = crate::project::load_project_config(&root_path).ok().flatten();
    let library_config = project_config
        .as_ref()
        .and_then(|config| config.library.as_ref());
    let stdlib_override = project_config
        .as_ref()
        .and_then(|config| config.stdlib.as_ref());
    let (_loader, stdlib_path) = resolve_stdlib_path(
        &state.stdlib_root,
        default_stdlib.as_deref(),
        library_config,
        stdlib_override,
        &root_path,
    );

    let cache_key = stdlib_path
        .as_ref()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "<none>".to_string());

    if let Ok(cache) = state.metamodel_cache.lock() {
        if let Some(cached) = cache.get(&cache_key) {
            let mut view = cached.clone();
            view.stdlib_cache_hit = true;
            return Ok(view);
        }
    }

    let mut types = Vec::new();
    if let Some(path) = stdlib_path.as_ref() {
        let normalized = normalized_compare_key(path);
        let mut from_snapshot = false;
        if let Ok(cache) = state.stdlib_cache.lock() {
            for entry in cache.values() {
                if normalized_compare_key(&entry.path) == normalized {
                    types = metamodel_types_from_index(entry.metatype_index.as_ref());
                    from_snapshot = true;
                    break;
                }
            }
        }
        if !from_snapshot {
            let mut vfs = Vfs::new();
            let files = load_stdlib_from_path(&mut vfs, path);
            let index = build_metatype_index(&vfs, &files);
            types = metamodel_types_from_index(&index);
        }
    }
    types.sort_by(|a, b| a.qualified_name.cmp(&b.qualified_name));

    let view = StdlibMetamodelView {
        stdlib_path: stdlib_path.map(|path| path.to_string_lossy().to_string()),
        stdlib_cache_hit: false,
        type_count: types.len(),
        types,
    };

    if let Ok(mut cache) = state.metamodel_cache.lock() {
        cache.insert(cache_key, view.clone());
    }

    Ok(view)
}

fn normalized_compare_key(path: &Path) -> String {
    let normalized = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    normalized
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
}

fn metamodel_types_from_index(index: &MetatypeIndex) -> Vec<MetamodelTypeView> {
    let qname_by_id = index
        .infos
        .iter()
        .map(|info| (info.id, info.qualified_name.clone()))
        .collect::<HashMap<_, _>>();
    let mut types = Vec::with_capacity(index.infos.len());
    for info in &index.infos {
        types.push(metamodel_type_from_info(info, index, &qname_by_id));
    }
    types
}

fn metamodel_type_from_info(
    info: &MetatypeInfo,
    index: &MetatypeIndex,
    qname_by_id: &HashMap<TypeId, String>,
) -> MetamodelTypeView {
    let supertypes = index
        .supertypes
        .get(&info.id)
        .map(|ids| {
            ids.iter()
                .filter_map(|id| qname_by_id.get(id).cloned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let attributes = index
        .all_attributes
        .get(&info.id)
        .map(|attrs| {
            attrs
                .iter()
                .map(|attr| MetamodelAttributeView {
                    name: attr.name.clone(),
                    qualified_name: format!("{}::{}", info.qualified_name, attr.name),
                    declared_type: attr.ty.clone(),
                    multiplicity: attr.multiplicity.clone(),
                    direction: None,
                    documentation: None,
                    modifiers: default_modifiers(),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    MetamodelTypeView {
        name: info.name.clone(),
        qualified_name: info.qualified_name.clone(),
        declared_supertypes: info.bases.clone(),
        supertypes,
        documentation: info.doc.clone(),
        modifiers: default_modifiers(),
        attributes,
    }
}

fn default_modifiers() -> MetamodelModifiersView {
    MetamodelModifiersView {
        is_public: true,
        is_abstract: false,
        is_variation: false,
        is_readonly: false,
        is_derived: false,
        is_parallel: false,
    }
}
