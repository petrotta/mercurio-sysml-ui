use mercurio_symbol_index::{SymbolIndexStore, SymbolMetatypeMappingRecord, SymbolRecord};
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

#[derive(Debug, Clone, Serialize)]
pub struct SymbolMetatypeMappingView {
    pub project_root: String,
    pub symbol_id: String,
    pub symbol_file_path: String,
    pub symbol_qualified_name: String,
    pub symbol_kind: String,
    pub resolved_metatype_qname: Option<String>,
    pub target_symbol_id: Option<String>,
    pub mapping_source: String,
    pub confidence: f32,
    pub diagnostic: Option<String>,
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

fn to_mapping_view(record: SymbolMetatypeMappingRecord) -> SymbolMetatypeMappingView {
    SymbolMetatypeMappingView {
        project_root: record.project_root,
        symbol_id: record.symbol_id,
        symbol_file_path: record.symbol_file_path,
        symbol_qualified_name: record.symbol_qualified_name,
        symbol_kind: record.symbol_kind,
        resolved_metatype_qname: record.resolved_metatype_qname,
        target_symbol_id: record.target_symbol_id,
        mapping_source: record.mapping_source,
        confidence: record.confidence,
        diagnostic: record.diagnostic,
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

pub fn query_project_symbols(
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
    let mut symbols = store.project_symbols(&project_root, file_path.as_deref());
    symbols.sort_by(|a, b| {
        a.file_path
            .cmp(&b.file_path)
            .then(a.start_line.cmp(&b.start_line))
            .then(a.start_col.cmp(&b.start_col))
            .then(a.qualified_name.cmp(&b.qualified_name))
    });
    Ok(symbols
        .into_iter()
        .skip(offset)
        .take(limit)
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

pub fn query_symbol_metatype_mapping(
    state: &CoreState,
    project_root: String,
    symbol_qualified_name: String,
    file_path: Option<String>,
) -> Result<Option<SymbolMetatypeMappingView>, String> {
    let store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;
    Ok(store
        .symbol_mapping(&project_root, &symbol_qualified_name, file_path.as_deref())
        .map(to_mapping_view))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        compile_project_delta_sync, compile_workspace_sync, load_library_symbols_sync,
        settings::AppSettings, CoreState,
    };
    use std::fs;
    use std::path::Path;
    use std::thread;
    use std::time::Duration;
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

        let mapping = query_symbol_metatype_mapping(
            &state,
            project_dir.to_string_lossy().to_string(),
            "P".to_string(),
            Some(project_dir.join("main.sysml").to_string_lossy().to_string()),
        )
        .expect("query symbol mapping")
        .expect("mapping exists");
        assert_eq!(mapping.symbol_qualified_name, "P");
        assert!(!mapping.mapping_source.is_empty());
        let mapped_metatype = mapping
            .resolved_metatype_qname
            .clone()
            .expect("resolved metatype");
        let mapped_symbols = query_symbols_by_metatype(
            &state,
            project_dir.to_string_lossy().to_string(),
            mapped_metatype,
        )
        .expect("query by mapped metatype");
        assert!(!mapped_symbols.is_empty());

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

    #[test]
    fn ui_like_flow_populates_project_and_library_symbols() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_ui_like_flow_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            library_dir.join("KerML.kerml"),
            "standard library package KerML { package Root { metaclass Action specializes Element {} } }",
        )
        .expect("write library file");
        fs::write(
            project_dir.join("main.sysml"),
            "package P { action def DoThing; part def Car; }\n",
        )
        .expect("write project file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"ui-like\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"**/*.sysml\",\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let project_root = project_dir.to_string_lossy().to_string();

        // UI startup path: metadata-only library load (files known, symbols deferred).
        let metadata_only = load_library_symbols_sync(&state, project_root.clone(), None, false)
            .expect("metadata-only library load");
        assert!(metadata_only.ok);
        assert!(!metadata_only.library_files.is_empty());
        assert_eq!(metadata_only.symbols.len(), 0);

        // UI background compile path: project delta compile (no library symbols in response).
        let delta = compile_project_delta_sync(
            &state,
            project_root.clone(),
            42,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("delta compile");
        assert!(delta.ok);
        assert!(delta.project_symbol_count > 0);
        assert!(delta.symbols.iter().any(|s| s.qualified_name == "P"));

        // UI fallback/index query path: project symbols should become queryable.
        let mut indexed_project = Vec::new();
        for _ in 0..20 {
            indexed_project =
                query_project_symbols(&state, project_root.clone(), None, Some(0), Some(10_000))
                    .expect("query indexed project symbols");
            if !indexed_project.is_empty() {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        assert!(
            !indexed_project.is_empty(),
            "indexed project symbols should not remain empty after UI-like flow"
        );
        assert!(indexed_project.iter().any(|s| s.qualified_name == "P"));

        // UI bootstrap path: explicit library symbol load.
        let library_full = load_library_symbols_sync(&state, project_root.clone(), None, true)
            .expect("full library load");
        assert!(library_full.ok);
        assert!(!library_full.symbols.is_empty());

        let indexed_library = query_library_symbols(
            &state,
            project_root,
            None,
            Some(0),
            Some(10_000),
        )
        .expect("query indexed library symbols");
        assert!(!indexed_library.is_empty());

        let _ = fs::remove_dir_all(root);
    }
}
