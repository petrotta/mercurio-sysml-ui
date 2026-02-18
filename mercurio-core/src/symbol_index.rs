use mercurio_symbol_index::{SymbolIndexStore, SymbolRecord};
use serde::Serialize;

use crate::CoreState;

#[derive(Debug, Clone, Serialize)]
pub struct IndexedSymbolView {
    pub id: String,
    pub project_root: String,
    pub library_key: Option<String>,
    pub scope: String,
    pub name: String,
    pub qualified_name: String,
    pub kind: String,
    pub metatype_qname: Option<String>,
    pub file_path: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub doc_text: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LibraryIndexSummaryView {
    pub file_count: usize,
    pub symbol_count: usize,
    pub kind_counts: Vec<(String, usize)>,
}

fn to_view(record: SymbolRecord) -> IndexedSymbolView {
    IndexedSymbolView {
        id: record.id,
        project_root: record.project_root,
        library_key: record.library_key,
        scope: match record.scope {
            mercurio_symbol_index::Scope::Stdlib => "stdlib".to_string(),
            mercurio_symbol_index::Scope::Project => "project".to_string(),
        },
        name: record.name,
        qualified_name: record.qualified_name,
        kind: record.kind,
        metatype_qname: record.metatype_qname,
        file_path: record.file_path,
        start_line: record.start_line,
        start_col: record.start_col,
        end_line: record.end_line,
        end_col: record.end_col,
        doc_text: record.doc_text,
    }
}

pub fn query_symbols_by_metatype(
    state: &CoreState,
    project_root: String,
    metatype_qname: String,
) -> Result<Vec<IndexedSymbolView>, String> {
    let store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;
    Ok(store
        .symbols_by_metatype(&project_root, &metatype_qname)
        .into_iter()
        .map(to_view)
        .collect())
}

pub fn query_stdlib_documentation_symbols(
    state: &CoreState,
    library_key: String,
) -> Result<Vec<IndexedSymbolView>, String> {
    let store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;
    Ok(store
        .stdlib_documentation_symbols(&library_key)
        .into_iter()
        .map(to_view)
        .collect())
}

pub fn query_library_symbols(
    state: &CoreState,
    project_root: String,
    file_path: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Vec<IndexedSymbolView>, String> {
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(usize::MAX);
    let store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;
    Ok(store
        .library_symbols_paged(&project_root, file_path.as_deref(), offset, limit)
        .into_iter()
        .map(to_view)
        .collect())
}

pub fn query_library_summary(
    state: &CoreState,
    project_root: String,
) -> Result<LibraryIndexSummaryView, String> {
    let store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;
    let (file_count, symbol_count, kind_counts) = store.library_summary(&project_root);
    Ok(LibraryIndexSummaryView {
        file_count,
        symbol_count,
        kind_counts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        compile_workspace_sync, load_library_symbols_sync, settings::AppSettings, CoreState,
    };
    use std::fs;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn normalized_compare_key(path: &Path) -> String {
        let normalized = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        normalized
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase()
    }

    #[test]
    fn queries_return_indexed_symbols_after_compile_and_library_load() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_symbol_index_query_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { doc /* d */ package Root { metaclass Action specializes Element {} } }",
        )
        .expect("write library file");
        fs::write(project_dir.join("main.sysml"), "package P { action def DoThing; }\n")
            .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"index\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let _ = compile_workspace_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            1,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile");
        let _ = load_library_symbols_sync(
            &state,
            project_dir.to_string_lossy().to_string(),
            None,
            true,
        )
        .expect("load library symbols");

        let action_symbols = query_symbols_by_metatype(
            &state,
            project_dir.to_string_lossy().to_string(),
            "KerML::Action".to_string(),
        )
        .expect("query by metatype");
        assert!(!action_symbols.is_empty());

        let docs = query_stdlib_documentation_symbols(
            &state,
            normalized_compare_key(&library_dir),
        )
        .expect("query docs");
        assert!(!docs.is_empty());

        let all_stdlib = query_library_symbols(
            &state,
            project_dir.to_string_lossy().to_string(),
            None,
            Some(0),
            Some(10_000),
        )
        .expect("query all stdlib symbols");
        assert!(!all_stdlib.is_empty());

        let paged_stdlib = query_library_symbols(
            &state,
            project_dir.to_string_lossy().to_string(),
            None,
            Some(0),
            Some(1),
        )
        .expect("query paged stdlib symbols");
        assert_eq!(paged_stdlib.len(), 1);

        let _ = fs::remove_dir_all(root);
    }
}
