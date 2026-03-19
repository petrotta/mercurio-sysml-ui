use serde::Serialize;

use crate::compile::load_library_symbols_sync;
use crate::project_model_seed::seed_symbol_index_if_empty;
use crate::project_root_key::canonical_project_root;
use crate::symbol_index::{query_library_symbols, query_project_symbols, IndexedSymbolView};
use crate::CoreState;

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceSymbolSnapshotView {
    pub project_symbols: Vec<IndexedSymbolView>,
    pub library_symbols: Vec<IndexedSymbolView>,
    pub library_path: Option<String>,
    pub library_hydrated: bool,
    pub diagnostics: Vec<String>,
}

pub fn get_workspace_symbol_snapshot(
    state: &CoreState,
    root: String,
    hydrate_library: bool,
) -> Result<WorkspaceSymbolSnapshotView, String> {
    let root = canonical_project_root(&root);
    seed_symbol_index_if_empty(state, &root)?;

    let project_symbols = query_project_symbols(state, root.clone(), None, None, None)?;
    let mut library_symbols = query_library_symbols(state, root.clone(), None, None, None)?;
    let mut library_path = None;
    let mut library_hydrated = false;
    let mut diagnostics = Vec::<String>::new();

    if hydrate_library && library_symbols.is_empty() {
        match load_library_symbols_sync(state, root.clone(), None, true) {
            Ok(response) => {
                library_path = response.library_path.clone();
                library_hydrated = !response.symbols.is_empty();
                library_symbols = query_library_symbols(state, root.clone(), None, None, None)?;
                if library_symbols.is_empty() && response.library_path.is_some() {
                    diagnostics.push(
                        "Library symbols are still empty after backend hydration.".to_string(),
                    );
                }
            }
            Err(error) => {
                diagnostics.push(format!("Library hydration failed: {error}"));
            }
        }
    }

    if library_path.is_none() {
        match load_library_symbols_sync(state, root, None, false) {
            Ok(response) => {
                library_path = response.library_path;
            }
            Err(error) => diagnostics.push(format!("Library metadata load failed: {error}")),
        }
    }

    Ok(WorkspaceSymbolSnapshotView {
        project_symbols,
        library_symbols,
        library_path,
        library_hydrated,
        diagnostics,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compile::compile_workspace_sync;
    use crate::settings::AppSettings;
    use crate::state::CoreState;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn workspace_symbol_snapshot_hydrates_project_and_library_symbols() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_workspace_symbol_snapshot_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { package Kernel { metaclass Element {} } }",
        )
        .expect("write library file");
        fs::write(
            project_dir.join("main.sysml"),
            "package P { part def A; }\n",
        )
        .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"snapshot\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        compile_workspace_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            1,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile workspace");

        let snapshot =
            get_workspace_symbol_snapshot(&state, project_dir.to_string_lossy().to_string(), true)
                .expect("workspace symbol snapshot");
        assert!(snapshot
            .project_symbols
            .iter()
            .any(|symbol| symbol.qualified_name == "P"));
        assert!(snapshot.library_path.is_some());

        let _ = fs::remove_dir_all(root);
    }
}
