use std::collections::{HashSet};
use std::fs;
use std::path::PathBuf;

use mercurio_model as walk;
use mercurio_semantic::{build_semantic_index, build_walk_workspace, SemanticElementView, SemanticIndexInput, SemanticQuery};
use syster::ide::AnalysisHost;
use syster::syntax::parser::parse_with_result;

use crate::project::load_project_config;
use crate::state::CoreState;
use crate::stdlib::{load_stdlib_into_host, resolve_stdlib_path};
use crate::workspace::{collect_model_files, collect_project_files};

pub fn query_semantic(
    state: &CoreState,
    root: String,
    query: SemanticQuery,
) -> Result<Vec<SemanticElementView>, String> {
    let root_path = PathBuf::from(root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }

    let default_stdlib = state
        .settings
        .lock()
        .ok()
        .and_then(|settings| settings.default_stdlib.clone());

    let project_config = load_project_config(&root_path).ok().flatten();
    let mut project_files = Vec::new();
    if let Some(config) = project_config.as_ref() {
        if let Some(src) = config.src.as_ref() {
            project_files = collect_project_files(&root_path, src)?;
        }
    }
    if project_files.is_empty() {
        collect_model_files(&root_path, &mut project_files)?;
    }
    project_files.sort();
    project_files.dedup();

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

    let mut host = AnalysisHost::new();
    if let Some(path) = stdlib_path.as_ref() {
        load_stdlib_into_host(state, &mut host, path)?;
    }
    let stdlib_paths: HashSet<PathBuf> = host.files().keys().cloned().collect();

    for path in &project_files {
        let content = match fs::read_to_string(path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let parse = parse_with_result(&content, path);
        if let Some(syntax) = parse.content {
            host.set_file(path.clone(), syntax);
        }
    }

    let files = host.files();
    let project_file_set: HashSet<PathBuf> = project_files.iter().cloned().collect();
    let stdlib_file_list: Vec<PathBuf> = files
        .keys()
        .filter(|path| stdlib_paths.contains(*path))
        .cloned()
        .collect();
    let project_file_list: Vec<PathBuf> = files
        .keys()
        .filter(|path| project_file_set.contains(*path))
        .cloned()
        .collect();

    let stdlib_workspace = build_walk_workspace(files, &stdlib_file_list);
    let project_workspace = build_walk_workspace(files, &project_file_list);
    let (stdlib_db, stdlib_ws, _, _) = stdlib_workspace
        .ok_or_else(|| "No stdlib files were loaded.".to_string())?;
    let (project_db, project_ws, _, project_path_by_file) = project_workspace
        .ok_or_else(|| "No project model files were parsed.".to_string())?;

    let stdlib_index = walk::workspace_index(&stdlib_db, stdlib_ws);
    let project_index = walk::workspace_index(&project_db, project_ws);

    let input = SemanticIndexInput {
        files,
        project_db: &project_db,
        project_ws,
        project_index: &project_index,
        stdlib_index: &stdlib_index,
        project_path_by_file: &project_path_by_file,
    };

    let index = build_semantic_index(input);
    Ok(index.query(&query))
}
