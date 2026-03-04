use std::path::{Path, PathBuf};

use mercurio_sysml_semantics::semantic_contract::{SemanticElementView, SemanticQuery};

use crate::project::load_project_config;
use crate::state::CoreState;
use crate::stdlib::resolve_stdlib_path;

pub(crate) fn collect_project_files(root: &Path, src: &[String]) -> Result<Vec<PathBuf>, String> {
    mercurio_sysml_pkg::workspace_query::collect_project_files(root, src)
}

pub(crate) fn collect_model_files(root: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    mercurio_sysml_pkg::workspace_query::collect_model_files(root, out)
}

pub fn query_semantic(
    state: &CoreState,
    root: String,
    query: SemanticQuery,
) -> Result<Vec<SemanticElementView>, String> {
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
    let src_patterns = project_config
        .as_ref()
        .and_then(|config| config.src.as_deref());

    mercurio_sysml_pkg::workspace_query::semantic_query_from_root(
        &root_path,
        src_patterns,
        stdlib_path.as_deref(),
        &query,
    )
}
