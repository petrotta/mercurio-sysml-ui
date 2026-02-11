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
