use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

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

#[derive(Deserialize, Default, Clone)]
pub struct ProjectDescriptorUpdate {
    pub name: Option<String>,
    pub author: Option<String>,
    pub description: Option<String>,
    pub organization: Option<String>,
    pub src: Option<Vec<String>>,
    #[serde(rename = "import", alias = "import_entries")]
    pub import_entries: Option<Vec<String>>,
    pub stdlib: Option<String>,
    pub library: Option<LibraryConfig>,
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

fn default_src_patterns() -> Vec<String> {
    vec!["**/*.sysml".to_string(), "**/*.kerml".to_string()]
}

fn default_import_patterns() -> Vec<String> {
    vec!["**/*.sysmlx".to_string(), "**/*.kermlx".to_string()]
}

fn build_default_descriptor(name: Option<String>) -> ProjectDescriptor {
    ProjectDescriptor {
        name,
        author: None,
        description: None,
        organization: None,
        config: ProjectConfig {
            library: None,
            stdlib: Some("default".to_string()),
            src: Some(default_src_patterns()),
            import_entries: Some(default_import_patterns()),
        },
    }
}

pub fn write_project_descriptor(
    root: &Path,
    descriptor: &ProjectDescriptor,
) -> Result<ProjectDescriptorView, String> {
    let content = serde_json::to_string_pretty(descriptor).map_err(|e| e.to_string())?;
    let config_path = root.join(".project");
    fs::write(config_path, &content).map_err(|e| e.to_string())?;
    get_project_descriptor_view(root)?
        .ok_or_else(|| "Failed to load project descriptor".to_string())
}

pub fn create_project_descriptor(
    root: &Path,
    name: String,
    author: Option<String>,
    description: Option<String>,
    organization: Option<String>,
    use_default_library: bool,
) -> Result<ProjectDescriptorView, String> {
    if root.exists() {
        return Err("Project folder already exists".to_string());
    }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let descriptor = ProjectDescriptor {
        name: Some(name),
        author,
        description,
        organization,
        config: ProjectConfig {
            library: None,
            stdlib: if use_default_library {
                Some("default".to_string())
            } else {
                None
            },
            src: Some(default_src_patterns()),
            import_entries: Some(default_import_patterns()),
        },
    };
    write_project_descriptor(root, &descriptor)
}

pub fn ensure_project_descriptor(root: &Path) -> Result<ProjectDescriptorView, String> {
    if !root.exists() {
        return Err("Root path does not exist".to_string());
    }

    let config_path = root.join(".project");
    if config_path.exists() {
        return get_project_descriptor_view(root)?
            .ok_or_else(|| "Failed to load project descriptor".to_string());
    }

    if let Some(legacy) = load_project_descriptor(root)? {
        write_project_descriptor(root, &legacy)
    } else {
        let name = root
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value.to_string());
        let descriptor = build_default_descriptor(name);
        write_project_descriptor(root, &descriptor)
    }
}

pub fn update_project_descriptor(
    root: &Path,
    stdlib_root: &Path,
    update: ProjectDescriptorUpdate,
) -> Result<ProjectDescriptorView, String> {
    if !root.exists() {
        return Err("Root path does not exist".to_string());
    }

    if let Some(stdlib_id) = update.stdlib.as_ref() {
        let trimmed = stdlib_id.trim();
        if !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("default") {
            let candidate = stdlib_root.join(trimmed);
            if !candidate.exists() || !candidate.is_dir() {
                return Err("Stdlib version not found".to_string());
            }
        }
    }

    let descriptor = ProjectDescriptor {
        name: update.name,
        author: update.author,
        description: update.description,
        organization: update.organization,
        config: ProjectConfig {
            library: update.library,
            stdlib: update.stdlib,
            src: update.src,
            import_entries: update.import_entries,
        },
    };
    write_project_descriptor(root, &descriptor)
}
