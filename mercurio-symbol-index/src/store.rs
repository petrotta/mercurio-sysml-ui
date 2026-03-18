use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;

use crate::model::{Scope, SymbolMetatypeMappingRecord, SymbolRecord};

fn normalized_path_key(path: &str) -> String {
    let resolved = PathBuf::from(path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path));
    resolved
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
}

fn normalized_root_key(project_root: &str) -> String {
    normalized_path_key(project_root)
}

pub trait SymbolIndexStore {
    fn upsert_symbols_for_file(
        &mut self,
        project_root: &str,
        file_path: &str,
        symbols: Vec<SymbolRecord>,
    );
    fn delete_symbols_for_file(&mut self, project_root: &str, file_path: &str);
    fn clear_all(&mut self);
    fn symbols_by_metatype(&self, project_root: &str, metatype_qname: &str) -> Vec<SymbolRecord>;
    fn library_symbols(&self, project_root: &str, file_path: Option<&str>) -> Vec<SymbolRecord>;
    fn library_symbols_paged(
        &self,
        project_root: &str,
        file_path: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Vec<SymbolRecord>;
    fn project_symbols(&self, project_root: &str, file_path: Option<&str>) -> Vec<SymbolRecord>;
    fn project_symbols_paged(
        &self,
        project_root: &str,
        file_path: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Vec<SymbolRecord>;
    fn project_symbol(
        &self,
        project_root: &str,
        qualified_name: &str,
        symbol_kind: Option<&str>,
    ) -> Option<SymbolRecord>;
    fn stdlib_documentation_symbols(&self, library_key: &str) -> Vec<SymbolRecord>;
    fn library_summary(&self, project_root: &str) -> (usize, usize, Vec<(String, usize)>);
    fn is_stdlib_index_fresh(&self, project_root: &str, library_key: &str, signature: &str)
        -> bool;
    fn mark_stdlib_indexed(&mut self, project_root: &str, library_key: &str, signature: &str);
    fn rebuild_symbol_mappings(&mut self, project_root: &str);
    fn symbol_mapping(
        &self,
        project_root: &str,
        symbol_qualified_name: &str,
        file_path: Option<&str>,
    ) -> Option<SymbolMetatypeMappingRecord>;
}

pub enum SymbolIndex {
    InMemory(InMemorySymbolIndex),
}

impl SymbolIndexStore for SymbolIndex {
    fn upsert_symbols_for_file(
        &mut self,
        project_root: &str,
        file_path: &str,
        symbols: Vec<SymbolRecord>,
    ) {
        match self {
            SymbolIndex::InMemory(store) => {
                store.upsert_symbols_for_file(project_root, file_path, symbols)
            }
        }
    }

    fn delete_symbols_for_file(&mut self, project_root: &str, file_path: &str) {
        match self {
            SymbolIndex::InMemory(store) => store.delete_symbols_for_file(project_root, file_path),
        }
    }

    fn clear_all(&mut self) {
        match self {
            SymbolIndex::InMemory(store) => store.clear_all(),
        }
    }

    fn symbols_by_metatype(&self, project_root: &str, metatype_qname: &str) -> Vec<SymbolRecord> {
        match self {
            SymbolIndex::InMemory(store) => store.symbols_by_metatype(project_root, metatype_qname),
        }
    }

    fn library_symbols(&self, project_root: &str, file_path: Option<&str>) -> Vec<SymbolRecord> {
        match self {
            SymbolIndex::InMemory(store) => store.library_symbols(project_root, file_path),
        }
    }

    fn library_symbols_paged(
        &self,
        project_root: &str,
        file_path: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Vec<SymbolRecord> {
        match self {
            SymbolIndex::InMemory(store) => {
                store.library_symbols_paged(project_root, file_path, offset, limit)
            }
        }
    }

    fn stdlib_documentation_symbols(&self, library_key: &str) -> Vec<SymbolRecord> {
        match self {
            SymbolIndex::InMemory(store) => store.stdlib_documentation_symbols(library_key),
        }
    }

    fn library_summary(&self, project_root: &str) -> (usize, usize, Vec<(String, usize)>) {
        match self {
            SymbolIndex::InMemory(store) => store.library_summary(project_root),
        }
    }

    fn is_stdlib_index_fresh(
        &self,
        project_root: &str,
        library_key: &str,
        signature: &str,
    ) -> bool {
        match self {
            SymbolIndex::InMemory(store) => {
                store.is_stdlib_index_fresh(project_root, library_key, signature)
            }
        }
    }

    fn mark_stdlib_indexed(&mut self, project_root: &str, library_key: &str, signature: &str) {
        match self {
            SymbolIndex::InMemory(store) => {
                store.mark_stdlib_indexed(project_root, library_key, signature)
            }
        }
    }

    fn project_symbols(&self, project_root: &str, file_path: Option<&str>) -> Vec<SymbolRecord> {
        match self {
            SymbolIndex::InMemory(store) => store.project_symbols(project_root, file_path),
        }
    }

    fn project_symbols_paged(
        &self,
        project_root: &str,
        file_path: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Vec<SymbolRecord> {
        match self {
            SymbolIndex::InMemory(store) => {
                store.project_symbols_paged(project_root, file_path, offset, limit)
            }
        }
    }

    fn project_symbol(
        &self,
        project_root: &str,
        qualified_name: &str,
        symbol_kind: Option<&str>,
    ) -> Option<SymbolRecord> {
        match self {
            SymbolIndex::InMemory(store) => {
                store.project_symbol(project_root, qualified_name, symbol_kind)
            }
        }
    }

    fn rebuild_symbol_mappings(&mut self, project_root: &str) {
        match self {
            SymbolIndex::InMemory(store) => store.rebuild_symbol_mappings(project_root),
        }
    }

    fn symbol_mapping(
        &self,
        project_root: &str,
        symbol_qualified_name: &str,
        file_path: Option<&str>,
    ) -> Option<SymbolMetatypeMappingRecord> {
        match self {
            SymbolIndex::InMemory(store) => {
                store.symbol_mapping(project_root, symbol_qualified_name, file_path)
            }
        }
    }
}

#[derive(Default)]
pub struct InMemorySymbolIndex {
    by_project_file: HashMap<(String, String), Vec<SymbolRecord>>,
    stdlib_freshness: HashMap<(String, String), String>,
    mappings_by_symbol: HashMap<(String, String), SymbolMetatypeMappingRecord>,
}

impl SymbolIndexStore for InMemorySymbolIndex {
    fn upsert_symbols_for_file(
        &mut self,
        project_root: &str,
        file_path: &str,
        symbols: Vec<SymbolRecord>,
    ) {
        self.by_project_file
            .insert((normalized_root_key(project_root), file_path.to_string()), symbols);
    }

    fn delete_symbols_for_file(&mut self, project_root: &str, file_path: &str) {
        self.by_project_file
            .remove(&(normalized_root_key(project_root), file_path.to_string()));
    }

    fn clear_all(&mut self) {
        self.by_project_file.clear();
        self.stdlib_freshness.clear();
        self.mappings_by_symbol.clear();
    }

    fn symbols_by_metatype(&self, project_root: &str, metatype_qname: &str) -> Vec<SymbolRecord> {
        let mut out = Vec::new();
        let project_root = normalized_root_key(project_root);
        for ((root, _), items) in &self.by_project_file {
            if root != &project_root {
                continue;
            }
            for symbol in items {
                if symbol.metatype_qname.as_deref() == Some(metatype_qname) {
                    out.push(symbol.clone());
                }
            }
        }
        out.sort_by(|a, b| {
            a.file_path
                .cmp(&b.file_path)
                .then(a.start_line.cmp(&b.start_line))
                .then(a.start_col.cmp(&b.start_col))
        });
        out
    }

    fn library_symbols(&self, project_root: &str, file_path: Option<&str>) -> Vec<SymbolRecord> {
        self.library_symbols_paged(project_root, file_path, 0, usize::MAX)
    }

    fn library_symbols_paged(
        &self,
        project_root: &str,
        file_path: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Vec<SymbolRecord> {
        let mut out = Vec::new();
        let project_root = normalized_root_key(project_root);
        for ((root, file), items) in &self.by_project_file {
            if root != &project_root {
                continue;
            }
            if let Some(target) = file_path {
                if normalized_path_key(file) != normalized_path_key(target) {
                    continue;
                }
            }
            for symbol in items {
                if symbol.scope == Scope::Stdlib {
                    out.push(symbol.clone());
                }
            }
        }
        out.sort_by(|a, b| {
            a.file_path
                .cmp(&b.file_path)
                .then(a.start_line.cmp(&b.start_line))
                .then(a.start_col.cmp(&b.start_col))
        });
        if offset >= out.len() {
            return Vec::new();
        }
        let end = offset.saturating_add(limit).min(out.len());
        out[offset..end].to_vec()
    }

    fn stdlib_documentation_symbols(&self, library_key: &str) -> Vec<SymbolRecord> {
        let mut out = Vec::new();
        for (_, items) in &self.by_project_file {
            for symbol in items {
                if symbol.scope == Scope::Stdlib
                    && symbol.kind == "Documentation"
                    && symbol.library_key.as_deref() == Some(library_key)
                {
                    out.push(symbol.clone());
                }
            }
        }
        out.sort_by(|a, b| {
            a.file_path
                .cmp(&b.file_path)
                .then(a.start_line.cmp(&b.start_line))
                .then(a.start_col.cmp(&b.start_col))
        });
        out
    }

    fn project_symbols(&self, project_root: &str, file_path: Option<&str>) -> Vec<SymbolRecord> {
        self.project_symbols_paged(project_root, file_path, 0, usize::MAX)
    }

    fn project_symbols_paged(
        &self,
        project_root: &str,
        file_path: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Vec<SymbolRecord> {
        let mut out = Vec::new();
        let project_root = normalized_root_key(project_root);
        for ((root, file), items) in &self.by_project_file {
            if root != &project_root {
                continue;
            }
            if let Some(target) = file_path {
                if normalized_path_key(file) != normalized_path_key(target) {
                    continue;
                }
            }
            for symbol in items {
                if symbol.scope == Scope::Project {
                    out.push(symbol.clone());
                }
            }
        }
        out.sort_by(|a, b| {
            a.file_path
                .cmp(&b.file_path)
                .then(a.start_line.cmp(&b.start_line))
                .then(a.start_col.cmp(&b.start_col))
        });
        if offset >= out.len() {
            return Vec::new();
        }
        let end = offset.saturating_add(limit).min(out.len());
        out[offset..end].to_vec()
    }

    fn project_symbol(
        &self,
        project_root: &str,
        qualified_name: &str,
        symbol_kind: Option<&str>,
    ) -> Option<SymbolRecord> {
        let mut out = self
            .project_symbols(project_root, None)
            .into_iter()
            .filter(|symbol| symbol.qualified_name == qualified_name)
            .collect::<Vec<_>>();
        if let Some(kind) = symbol_kind {
            if let Some(exact) = out
                .iter()
                .find(|symbol| symbol.kind.eq_ignore_ascii_case(kind))
            {
                return Some(exact.clone());
            }
        }
        out.sort_by(|a, b| {
            a.file_path
                .cmp(&b.file_path)
                .then(a.start_line.cmp(&b.start_line))
                .then(a.start_col.cmp(&b.start_col))
        });
        out.into_iter().next()
    }

    fn library_summary(&self, project_root: &str) -> (usize, usize, Vec<(String, usize)>) {
        let mut files = HashSet::<String>::new();
        let mut symbol_count = 0usize;
        let mut kinds = HashMap::<String, usize>::new();
        let project_root = normalized_root_key(project_root);
        for ((root, _), items) in &self.by_project_file {
            if root != &project_root {
                continue;
            }
            for symbol in items {
                if symbol.scope != Scope::Stdlib {
                    continue;
                }
                files.insert(symbol.file_path.clone());
                symbol_count += 1;
                *kinds.entry(symbol.kind.clone()).or_insert(0) += 1;
            }
        }
        let mut kind_counts = kinds.into_iter().collect::<Vec<_>>();
        kind_counts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        (files.len(), symbol_count, kind_counts)
    }

    fn is_stdlib_index_fresh(
        &self,
        project_root: &str,
        library_key: &str,
        signature: &str,
    ) -> bool {
        self.stdlib_freshness
            .get(&(normalized_root_key(project_root), library_key.to_string()))
            .map(|known| known == signature)
            .unwrap_or(false)
    }

    fn mark_stdlib_indexed(&mut self, project_root: &str, library_key: &str, signature: &str) {
        self.stdlib_freshness.insert(
            (normalized_root_key(project_root), library_key.to_string()),
            signature.to_string(),
        );
    }

    fn rebuild_symbol_mappings(&mut self, project_root: &str) {
        let project_root = normalized_root_key(project_root);
        self.mappings_by_symbol.retain(|(root, _), _| root != &project_root);

        let mut stdlib_by_qname = HashMap::<String, String>::new();
        let mut project_symbols = Vec::<SymbolRecord>::new();
        for ((root, _), items) in &self.by_project_file {
            if root != &project_root {
                continue;
            }
            for symbol in items {
                match symbol.scope {
                    Scope::Stdlib => {
                        stdlib_by_qname.insert(symbol.qualified_name.clone(), symbol.id.clone());
                    }
                    Scope::Project => project_symbols.push(symbol.clone()),
                }
            }
        }

        for symbol in project_symbols {
            let mut mapping = SymbolMetatypeMappingRecord {
                project_root: project_root.to_string(),
                symbol_id: symbol.id.clone(),
                symbol_file_path: symbol.file_path.clone(),
                symbol_qualified_name: symbol.qualified_name.clone(),
                symbol_kind: symbol.kind.clone(),
                resolved_metatype_qname: None,
                target_symbol_id: None,
                mapping_source: "unresolved".to_string(),
                confidence: 0.0,
                diagnostic: Some("Symbol has no metatype_qname.".to_string()),
            };
            if let Some(raw) = symbol
                .metatype_qname
                .clone()
                .filter(|s| !s.trim().is_empty())
            {
                if let Some(target_id) = stdlib_by_qname.get(&raw) {
                    mapping.resolved_metatype_qname = Some(raw.clone());
                    mapping.target_symbol_id = Some(target_id.clone());
                    mapping.mapping_source = "exact".to_string();
                    mapping.confidence = 1.0;
                    mapping.diagnostic = None;
                } else {
                    mapping.resolved_metatype_qname = Some(raw.clone());
                    mapping.mapping_source = "unresolved".to_string();
                    mapping.confidence = 0.0;
                    mapping.diagnostic = Some(format!(
                        "No exact stdlib symbol found for EMF metatype '{raw}'."
                    ));
                }
            }
            self.mappings_by_symbol
                .insert((project_root.to_string(), symbol.id), mapping);
        }
    }

    fn symbol_mapping(
        &self,
        project_root: &str,
        symbol_qualified_name: &str,
        file_path: Option<&str>,
    ) -> Option<SymbolMetatypeMappingRecord> {
        let project_root = normalized_root_key(project_root);
        let mut project_symbols = self
            .by_project_file
            .iter()
            .filter(|((root, _), _)| root == &project_root)
            .flat_map(|(_, items)| items.iter())
            .filter(|symbol| {
                symbol.scope == Scope::Project
                    && symbol.qualified_name == symbol_qualified_name
                    && file_path
                        .map(|path| normalized_path_key(&symbol.file_path) == normalized_path_key(path))
                        .unwrap_or(true)
            })
            .collect::<Vec<_>>();
        project_symbols.sort_by(|a, b| {
            a.file_path
                .cmp(&b.file_path)
                .then(a.start_line.cmp(&b.start_line))
                .then(a.start_col.cmp(&b.start_col))
        });
        let symbol = project_symbols.first()?;
        self.mappings_by_symbol
            .get(&(project_root, symbol.id.clone()))
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn symbol(
        id: &str,
        project_root: &str,
        library_key: Option<&str>,
        scope: Scope,
        kind: &str,
        metatype_qname: Option<&str>,
        file_path: &str,
    ) -> SymbolRecord {
        SymbolRecord {
            id: id.to_string(),
            project_root: project_root.to_string(),
            library_key: library_key.map(|v| v.to_string()),
            scope,
            name: id.to_string(),
            qualified_name: id.to_string(),
            parent_qualified_name: None,
            kind: kind.to_string(),
            metatype_qname: metatype_qname.map(|v| v.to_string()),
            file_path: file_path.to_string(),
            start_line: 1,
            start_col: 1,
            end_line: 1,
            end_col: 1,
            doc_text: None,
            properties_json: None,
        }
    }

    #[test]
    fn in_memory_queries_work() {
        let mut store = InMemorySymbolIndex::default();
        store.upsert_symbols_for_file(
            "p1",
            "Kernel.kerml",
            vec![symbol(
                "m1",
                "p1",
                Some("stdlib@1"),
                Scope::Stdlib,
                "Metaclass",
                None,
                "Kernel.kerml",
            )],
        );
        store.upsert_symbols_for_file(
            "p1",
            "a.sysml",
            vec![
                symbol(
                    "a1",
                    "p1",
                    None,
                    Scope::Project,
                    "ActionDef",
                    Some("m1"),
                    "a.sysml",
                ),
                symbol(
                    "d1",
                    "p1",
                    Some("stdlib@1"),
                    Scope::Stdlib,
                    "Documentation",
                    None,
                    "KerML.kerml",
                ),
            ],
        );
        store.rebuild_symbol_mappings("p1");
        assert_eq!(store.symbols_by_metatype("p1", "m1").len(), 1);
        assert_eq!(store.stdlib_documentation_symbols("stdlib@1").len(), 1);
        let summary = store.library_summary("p1");
        assert_eq!(summary.0, 2);
        assert_eq!(summary.1, 2);
        let mapping = store
            .symbol_mapping("p1", "a1", Some("a.sysml"))
            .expect("mapping");
        assert_eq!(mapping.mapping_source, "exact");
        assert_eq!(mapping.resolved_metatype_qname.as_deref(), Some("m1"));
    }

    #[test]
    fn freshness_round_trip_works() {
        let mut store = InMemorySymbolIndex::default();
        assert!(!store.is_stdlib_index_fresh("p1", "stdlib@1", "sig1"));
        store.mark_stdlib_indexed("p1", "stdlib@1", "sig1");
        assert!(store.is_stdlib_index_fresh("p1", "stdlib@1", "sig1"));
        assert!(!store.is_stdlib_index_fresh("p1", "stdlib@1", "sig2"));
    }

    #[test]
    fn in_memory_clear_all_removes_symbols_mappings_and_freshness() {
        let mut store = InMemorySymbolIndex::default();
        store.upsert_symbols_for_file(
            "p1",
            "Kernel.kerml",
            vec![symbol(
                "m1",
                "p1",
                Some("stdlib@1"),
                Scope::Stdlib,
                "Metaclass",
                None,
                "Kernel.kerml",
            )],
        );
        store.upsert_symbols_for_file(
            "p1",
            "a.sysml",
            vec![symbol(
                "a1",
                "p1",
                None,
                Scope::Project,
                "ActionDef",
                Some("m1"),
                "a.sysml",
            )],
        );
        store.mark_stdlib_indexed("p1", "stdlib@1", "sig1");
        store.rebuild_symbol_mappings("p1");
        assert!(!store.project_symbols("p1", None).is_empty());
        assert!(store.symbol_mapping("p1", "a1", None).is_some());
        assert!(store.is_stdlib_index_fresh("p1", "stdlib@1", "sig1"));

        store.clear_all();

        assert!(store.project_symbols("p1", None).is_empty());
        assert!(store.library_symbols("p1", None).is_empty());
        assert!(store.symbol_mapping("p1", "a1", None).is_none());
        assert!(!store.is_stdlib_index_fresh("p1", "stdlib@1", "sig1"));
    }

    #[test]
    fn in_memory_mapping_does_not_use_tail_or_collapsed_heuristics() {
        let mut store = InMemorySymbolIndex::default();
        store.upsert_symbols_for_file(
            "p1",
            "Kernel.kerml",
            vec![symbol(
                "KerML::Root::Action",
                "p1",
                Some("stdlib@1"),
                Scope::Stdlib,
                "Metaclass",
                None,
                "Kernel.kerml",
            )],
        );
        store.upsert_symbols_for_file(
            "p1",
            "a.sysml",
            vec![symbol(
                "a1",
                "p1",
                None,
                Scope::Project,
                "ActionDef",
                Some("Action"),
                "a.sysml",
            )],
        );

        store.rebuild_symbol_mappings("p1");
        let mapping = store
            .symbol_mapping("p1", "a1", Some("a.sysml"))
            .expect("mapping exists");
        assert_eq!(mapping.mapping_source, "unresolved");
        assert!(mapping.target_symbol_id.is_none());
        assert_eq!(mapping.resolved_metatype_qname.as_deref(), Some("Action"));
    }
}
