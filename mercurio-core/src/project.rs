use std::path::Path;

pub use mercurio_sysml_pkg::workspace_config::{
    LibraryConfig, ProjectConfig, ProjectDescriptor, ProjectDescriptorUpdate, ProjectDescriptorView,
};

pub fn load_project_descriptor(root: &Path) -> Result<Option<ProjectDescriptor>, String> {
    mercurio_sysml_pkg::workspace_config::load_project_descriptor(root)
}

pub fn load_project_config(root: &Path) -> Result<Option<ProjectConfig>, String> {
    mercurio_sysml_pkg::workspace_config::load_project_config(root)
}

pub fn get_project_descriptor_view(root: &Path) -> Result<Option<ProjectDescriptorView>, String> {
    mercurio_sysml_pkg::workspace_config::get_project_descriptor_view(root)
}

pub fn write_project_descriptor(
    root: &Path,
    descriptor: &ProjectDescriptor,
) -> Result<ProjectDescriptorView, String> {
    mercurio_sysml_pkg::workspace_config::write_project_descriptor(root, descriptor)
}

pub fn create_project_descriptor(
    root: &Path,
    name: String,
    author: Option<String>,
    description: Option<String>,
    organization: Option<String>,
    use_default_library: bool,
) -> Result<ProjectDescriptorView, String> {
    mercurio_sysml_pkg::workspace_config::create_project_descriptor(
        root,
        name,
        author,
        description,
        organization,
        use_default_library,
    )
}

pub fn ensure_project_descriptor(root: &Path) -> Result<ProjectDescriptorView, String> {
    mercurio_sysml_pkg::workspace_config::ensure_project_descriptor(root)
}

pub fn update_project_descriptor(
    root: &Path,
    stdlib_root: &Path,
    update: ProjectDescriptorUpdate,
) -> Result<ProjectDescriptorView, String> {
    mercurio_sysml_pkg::workspace_config::update_project_descriptor(root, stdlib_root, update)
}
