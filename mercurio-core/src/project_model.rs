use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use mercurio_symbol_index::{SymbolIndexStore, SymbolRecord};
use mercurio_sysml_pkg::project_model_projection::{
    collect_direct_metatype_attributes, collect_inherited_attributes,
    collect_inherited_metatype_attributes, collect_project_expression_records,
    resolve_mapped_metatype, symbol_to_attribute_rows, SymbolMetatypeMappingData,
};
pub use mercurio_sysml_pkg::project_model_projection::{
    ProjectExpressionRecordView, ProjectExpressionRecordsView,
};
pub use mercurio_sysml_semantics::semantic_project_model_contract::{
    ProjectElementAttributesView, ProjectElementInheritedAttributeView, ProjectModelAttributeView,
    ProjectModelElementView, ProjectModelView,
};
use mercurio_sysml_semantics::stdlib::MetatypeIndex;

use crate::project::load_project_config;
use crate::project_model_seed::seed_symbol_index_if_empty;
use crate::project_root_key::canonical_project_root;
use crate::state::{CoreState, WorkspaceSnapshotCacheEntry};
use crate::stdlib::resolve_stdlib_path;

fn resolve_symbol_metatype(
    store: &dyn SymbolIndexStore,
    root: &str,
    symbol: &SymbolRecord,
) -> (Option<String>, Vec<String>) {
    let mapping = store
        .symbol_mapping(root, &symbol.qualified_name, Some(&symbol.file_path))
        .or_else(|| store.symbol_mapping(root, &symbol.qualified_name, None))
        .map(|row| SymbolMetatypeMappingData {
            resolved_metatype_qname: row.resolved_metatype_qname,
            mapping_source: row.mapping_source,
            confidence: row.confidence,
            diagnostic: row.diagnostic,
        });
    resolve_mapped_metatype(
        &symbol.qualified_name,
        symbol.metatype_qname.as_deref(),
        symbol.properties_json.as_deref(),
        mapping.as_ref(),
    )
}

pub fn get_project_element_attributes(
    state: &CoreState,
    root: String,
    element_qualified_name: String,
    symbol_kind: Option<String>,
) -> Result<ProjectElementAttributesView, String> {
    let root = canonical_project_root(&root);
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }
    seed_symbol_index_if_empty(state, &root)?;

    let (symbol, metatype_qname, mut diagnostics) = {
        let store = state
            .symbol_index
            .lock()
            .map_err(|_| "Symbol index lock poisoned".to_string())?;
        let Some(symbol) =
            store.project_symbol(&root, &element_qualified_name, symbol_kind.as_deref())
        else {
            return Ok(ProjectElementAttributesView {
                element_qualified_name,
                metatype_qname: None,
                explicit_attributes: Vec::new(),
                inherited_attributes: Vec::new(),
                direct_metatype_attributes: Vec::new(),
                inherited_metatype_attributes: Vec::new(),
                expressions: Vec::new(),
                diagnostics: vec!["Element not found in current project symbol index.".to_string()],
            });
        };
        let (metatype_qname, diagnostics) = resolve_symbol_metatype(&*store, &root, &symbol);
        (symbol, metatype_qname, diagnostics)
    };

    if metatype_qname.is_none() {
        if diagnostics.is_empty() {
            diagnostics.push(format!(
                "Metatype unresolved: no mapping found for element '{}' (kind='{}', file='{}').",
                symbol.qualified_name, symbol.kind, symbol.file_path
            ));
        } else {
            diagnostics.push(format!(
                "Metatype unresolved for element '{}' (kind='{}').",
                symbol.qualified_name, symbol.kind
            ));
        }
        diagnostics.push(
            "Metatype mapping is unavailable for this symbol in the current index state."
                .to_string(),
        );
        diagnostics.push(
            "No per-request semantic refresh is performed in this endpoint; run compile to refresh symbol and metatype data.".to_string(),
        );
    }
    let explicit_attributes = symbol_to_attribute_rows(
        &symbol.qualified_name,
        &symbol.name,
        symbol.properties_json.as_deref(),
        metatype_qname.as_deref(),
    );
    let symbol_qualified_name = symbol.qualified_name.clone();
    let expression_view = get_project_expression_records(state, root.clone())?;
    let expressions = expression_view
        .records
        .into_iter()
        .filter(|record| {
            record.owner_qualified_name == symbol_qualified_name
                || record.qualified_name == symbol_qualified_name
        })
        .collect::<Vec<_>>();
    diagnostics.extend(expression_view.diagnostics);
    let (direct_metatype_attributes, inherited_metatype_attributes, inherited_attributes) =
        match load_stdlib_metatype_index(state, &root) {
            Ok(Some(index)) => {
                let direct = collect_direct_metatype_attributes(
                    &index,
                    metatype_qname.as_deref(),
                    &mut diagnostics,
                );
                let inherited_metatype = collect_inherited_metatype_attributes(
                    &index,
                    metatype_qname.as_deref(),
                    &mut diagnostics,
                );
                let inherited = collect_inherited_attributes(
                    &index,
                    metatype_qname.as_deref(),
                    &explicit_attributes,
                    &mut diagnostics,
                );
                (direct, inherited_metatype, inherited)
            }
            Ok(None) => {
                diagnostics.push(
                    "Inherited attributes unavailable because stdlib metatype index is unresolved."
                        .to_string(),
                );
                (Vec::new(), Vec::new(), Vec::new())
            }
            Err(error) => {
                diagnostics.push(format!("Unable to load stdlib metatype index: {error}"));
                (Vec::new(), Vec::new(), Vec::new())
            }
        };

    Ok(ProjectElementAttributesView {
        element_qualified_name,
        metatype_qname: metatype_qname.clone(),
        explicit_attributes,
        inherited_attributes,
        direct_metatype_attributes,
        inherited_metatype_attributes,
        expressions,
        diagnostics,
    })
}

fn load_stdlib_metatype_index(
    state: &CoreState,
    root: &str,
) -> Result<Option<Arc<MetatypeIndex>>, String> {
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
    let Some(target_stdlib_path) = stdlib_path.as_ref() else {
        return Ok(None);
    };
    let target_key = normalize_compare_key(target_stdlib_path);
    let cache = state
        .workspace_snapshot_cache
        .lock()
        .map_err(|_| "Workspace snapshot cache lock poisoned".to_string())?;
    for entry in cache.values() {
        if let WorkspaceSnapshotCacheEntry::Stdlib(snapshot) = entry {
            if normalize_compare_key(&snapshot.path) == target_key {
                return Ok(Some(snapshot.metatype_index.clone()));
            }
        }
    }
    Ok(None)
}

fn normalize_compare_key(path: &std::path::Path) -> String {
    let normalized = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    normalized
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
}

pub fn get_project_model(state: &CoreState, root: String) -> Result<ProjectModelView, String> {
    let root = canonical_project_root(&root);
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }
    seed_symbol_index_if_empty(state, &root)?;

    let store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;
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
    let indexed = store.project_symbols(&root, None);
    let indexed_library = store.library_symbols(&root, None);

    let mut elements = Vec::new();
    for symbol in indexed.into_iter().chain(indexed_library.into_iter()) {
        let (metatype_qname, diagnostics) = resolve_symbol_metatype(&*store, &root, &symbol);
        let attributes = symbol_to_attribute_rows(
            &symbol.qualified_name,
            &symbol.name,
            symbol.properties_json.as_deref(),
            metatype_qname.as_deref(),
        );
        elements.push(ProjectModelElementView {
            name: symbol.name,
            qualified_name: symbol.qualified_name,
            kind: symbol.kind,
            file_path: symbol.file_path,
            start_line: symbol.start_line,
            start_col: symbol.start_col,
            end_line: symbol.end_line,
            end_col: symbol.end_col,
            metatype_qname,
            declared_supertypes: Vec::new(),
            supertypes: Vec::new(),
            direct_specializations: Vec::new(),
            indirect_specializations: Vec::new(),
            documentation: symbol.doc_text,
            attributes,
            diagnostics,
        });
    }
    elements.sort_by(|a, b| a.qualified_name.cmp(&b.qualified_name));
    let expression_view = collect_project_expression_records(
        elements
            .iter()
            .map(|element| element.file_path.as_str())
            .filter(|path| !path.is_empty()),
    );
    let mut diagnostics = expression_view.diagnostics;
    diagnostics.push("Project model is generated from persisted symbol index.".to_string());

    Ok(ProjectModelView {
        stdlib_path: stdlib_path.map(|path| path.to_string_lossy().to_string()),
        workspace_snapshot_hit: false,
        project_cache_hit: false,
        element_count: elements.len(),
        elements,
        expressions: expression_view.records,
        diagnostics,
    })
}

pub fn get_project_expression_records(
    state: &CoreState,
    root: String,
) -> Result<ProjectExpressionRecordsView, String> {
    let root = canonical_project_root(&root);
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }
    seed_symbol_index_if_empty(state, &root)?;

    let store = state
        .symbol_index
        .lock()
        .map_err(|_| "Symbol index lock poisoned".to_string())?;

    let indexed = store.project_symbols(&root, None);
    let indexed_library = store.library_symbols(&root, None);
    let mut file_paths = HashSet::<String>::new();
    for symbol in indexed.into_iter().chain(indexed_library.into_iter()) {
        if !symbol.file_path.is_empty() {
            file_paths.insert(symbol.file_path);
        }
    }
    Ok(collect_project_expression_records(file_paths.into_iter()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compile::compile_workspace_sync;
    use crate::settings::AppSettings;
    use crate::state::CoreState;
    use crate::stdlib::get_stdlib_metamodel;
    use mercurio_symbol_index::SymbolIndexStore;
    use std::fs;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn compile_for_index(state: &CoreState, project_root: &Path) {
        let _ = compile_workspace_sync(
            state,
            project_root.to_string_lossy().to_string(),
            1,
            true,
            None,
            Vec::new(),
            |_| {},
        )
        .expect("compile workspace");
    }

    #[test]
    fn project_model_is_built_from_symbol_index() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_project_model_db_{stamp}"));
        let project_dir = root.join("project");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(
            project_dir.join("main.sysml"),
            "package P { action def DoThing; }\n",
        )
        .expect("write model file");
        fs::write(
            project_dir.join(".project"),
            "{\"name\":\"pm-db\",\"use_default_library\":true,\"src\":[\"*.sysml\"]}",
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        compile_for_index(&state, &project_dir);
        let view = get_project_model(&state, project_dir.to_string_lossy().to_string())
            .expect("get project model");
        assert!(view.element_count > 0);
        assert!(view.expressions.is_empty());
        assert!(view
            .diagnostics
            .iter()
            .any(|line| line.contains("persisted symbol index")));
        assert!(view
            .elements
            .iter()
            .any(|element| element.qualified_name == "P"));

        let attrs = get_project_element_attributes(
            &state,
            project_dir.to_string_lossy().to_string(),
            "P".to_string(),
            Some("Package".to_string()),
        )
        .expect("get element attrs");
        assert_eq!(attrs.element_qualified_name, "P");
        assert!(!attrs.explicit_attributes.is_empty());
        assert!(attrs.expressions.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn project_model_missing_symbol_reports_index_message() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_project_model_db_miss_{stamp}"));
        let project_dir = root.join("project");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(project_dir.join("main.sysml"), "package P {}\n").expect("write model file");
        fs::write(
            project_dir.join(".project"),
            "{\"name\":\"pm-db\",\"use_default_library\":true,\"src\":[\"*.sysml\"]}",
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        compile_for_index(&state, &project_dir);
        let attrs = get_project_element_attributes(
            &state,
            project_dir.to_string_lossy().to_string(),
            "Missing::Symbol".to_string(),
            None,
        )
        .expect("get missing element attrs");
        assert!(attrs
            .diagnostics
            .iter()
            .any(|line| line.contains("project symbol index")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn db_model_maps_package_to_kerml_package_with_filter_condition() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_project_model_pkg_meta_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");

        let library_source = r#"
standard library package KerML {
  package Kernel {
    metaclass Namespace specializes Element {
      var feature ownedMember : Element[0..*] ordered;
    }
    metaclass Package specializes Namespace {
      var feature filterCondition : Expression[0..*] ordered;
    }
  }
}
"#;
        fs::write(library_dir.join("KerML.kerml"), library_source).expect("write library file");
        fs::write(project_dir.join("main.sysml"), "package P {}\n").expect("write model file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"pm-db\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        compile_for_index(&state, &project_dir);
        let attrs = get_project_element_attributes(
            &state,
            project_dir.to_string_lossy().to_string(),
            "P".to_string(),
            Some("Package".to_string()),
        )
        .expect("project element attributes");
        assert!(!attrs.direct_metatype_attributes.is_empty());
        assert!(attrs
            .direct_metatype_attributes
            .iter()
            .any(|attr| attr.name == "filterCondition"));
        assert!(!attrs.inherited_metatype_attributes.is_empty());

        let mapped = {
            let store = state.symbol_index.lock().expect("symbol index lock");
            store.symbol_mapping(
                &project_dir.to_string_lossy(),
                "P",
                Some(&project_dir.join("main.sysml").to_string_lossy()),
            )
        }
        .expect("symbol mapping");
        let mapped_qname = mapped
            .resolved_metatype_qname
            .clone()
            .or(attrs.metatype_qname.clone())
            .unwrap_or_else(|| "KerML::Kernel::Package".to_string());

        let metamodel = get_stdlib_metamodel(&state, project_dir.to_string_lossy().to_string())
            .expect("stdlib metamodel");
        let package_candidates = metamodel
            .types
            .iter()
            .filter(|t| t.name == "Package" || t.qualified_name.ends_with("::Package"))
            .map(|t| format!("{} attrs={}", t.qualified_name, t.attributes.len()))
            .collect::<Vec<_>>();
        println!("Package candidates: {:?}", package_candidates);
        let package_type = metamodel
            .types
            .iter()
            .find(|t| t.qualified_name == mapped_qname)
            .or_else(|| {
                let tail = mapped_qname
                    .rsplit("::")
                    .next()
                    .unwrap_or(mapped_qname.as_str());
                let mut candidates = metamodel
                    .types
                    .iter()
                    .filter(|t| t.qualified_name.ends_with(&format!("::{tail}")))
                    .collect::<Vec<_>>();
                candidates.sort_by(|a, b| {
                    let a_has_filter = a
                        .attributes
                        .iter()
                        .any(|attr| attr.name == "filterCondition");
                    let b_has_filter = b
                        .attributes
                        .iter()
                        .any(|attr| attr.name == "filterCondition");
                    b_has_filter
                        .cmp(&a_has_filter)
                        .then(b.qualified_name.len().cmp(&a.qualified_name.len()))
                });
                candidates.into_iter().next()
            })
            .expect("mapped package metatype exists");

        assert_eq!(package_type.name, "Package");
        let package_attrs = package_type
            .attributes
            .iter()
            .map(|a| a.name.clone())
            .collect::<Vec<_>>();
        println!(
            "Package metatype attributes (db-backed path): {:?}",
            package_attrs
        );
        assert!(package_type
            .attributes
            .iter()
            .any(|a| a.name == "filterCondition"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn db_model_package_includes_namespace_inherited_attribute_set() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("mercurio_project_model_pkg_inherited_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");

        let library_source = r#"
standard library package KerML {
  package Kernel {
    metaclass Element {}
    metaclass Membership specializes Element {}
    metaclass Import specializes Element {}
    metaclass Expression specializes Element {}

    metaclass Namespace specializes Element {
      derived abstract var feature membership : Membership[0..*] ordered;
      derived composite var feature ownedImport : Import[0..*] ordered subsets ownedRelationship;
      derived var feature 'member' : Element[0..*] ordered;
      derived var feature ownedMember : Element[0..*] ordered subsets 'member';
      derived composite var feature ownedMembership : Membership[0..*] ordered subsets membership, ownedRelationship;
      derived var feature importedMembership : Membership[0..*] ordered subsets membership;
    }

    metaclass Package specializes Namespace {
      derived var feature filterCondition : Expression[0..*] ordered subsets ownedMember;
    }
  }
}
"#;
        fs::write(library_dir.join("KerML.kerml"), library_source).expect("write library file");
        fs::write(project_dir.join("main.sysml"), "package P {}\n").expect("write model file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"pm-db\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        compile_for_index(&state, &project_dir);
        let _ = get_project_element_attributes(
            &state,
            project_dir.to_string_lossy().to_string(),
            "P".to_string(),
            Some("Package".to_string()),
        )
        .expect("project element attributes");

        let metamodel = get_stdlib_metamodel(&state, project_dir.to_string_lossy().to_string())
            .expect("stdlib metamodel");
        let package_type = metamodel
            .types
            .iter()
            .find(|t| t.qualified_name == "KerML::Kernel::Package")
            .or_else(|| metamodel.types.iter().find(|t| t.name == "Package"))
            .expect("package metatype");
        let attr_names = package_type
            .attributes
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>();

        for expected in [
            "membership",
            "ownedImport",
            "member",
            "ownedMember",
            "ownedMembership",
            "importedMembership",
            "filterCondition",
        ] {
            assert!(
                attr_names.iter().any(|name| *name == expected),
                "expected attribute '{expected}' in Package attrs {:?}",
                attr_names
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn db_model_package_includes_element_namespace_and_package_attributes() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("mercurio_project_model_pkg_full_chain_{stamp}"));
        let library_dir = root.join("stdlib");
        let project_dir = root.join("project");
        fs::create_dir_all(&library_dir).expect("create library dir");
        fs::create_dir_all(&project_dir).expect("create project dir");

        let library_source = r#"
standard library package KerML {
  package Kernel {
    metaclass Relationship specializes Element {}
    metaclass OwningMembership specializes Relationship {}
    metaclass Documentation specializes Element {}
    metaclass Annotation specializes Relationship {}
    metaclass TextualRepresentation specializes Element {}
    metaclass Import specializes Element {}
    metaclass Membership specializes Element {}
    metaclass Expression specializes Element {}

    abstract metaclass Element {
      var feature elementId : String[1..1];
      var feature aliasIds : String[0..*] ordered;
      var feature declaredShortName : String[0..1];
      var feature declaredName : String[0..1];
      var feature isImpliedIncluded : Boolean[1..1];
      derived var feature shortName : String[0..1];
      derived var feature name : String[0..1];
      derived var feature qualifiedName : String[0..1];
      derived var feature isLibraryElement : Boolean[1..1];
      var feature owningRelationship : Relationship[0..1];
      composite var feature ownedRelationship : Relationship[0..*] ordered;
      derived var feature owningMembership : OwningMembership[0..1] subsets owningRelationship;
      derived var feature owningNamespace : Namespace[0..1];
      derived var feature owner : Element[0..1];
      derived var feature ownedElement : Element[0..*] ordered;
      derived var feature documentation : Documentation[0..*] ordered subsets ownedElement;
      derived composite var feature ownedAnnotation : Annotation[0..*] ordered subsets ownedRelationship;
      derived var feature textualRepresentation : TextualRepresentation[0..*] ordered subsets ownedElement;
    }

    metaclass Namespace specializes Element {
      derived abstract var feature membership : Membership[0..*] ordered;
      derived composite var feature ownedImport : Import[0..*] ordered subsets ownedRelationship;
      derived var feature 'member' : Element[0..*] ordered;
      derived var feature ownedMember : Element[0..*] ordered subsets 'member';
      derived composite var feature ownedMembership : Membership[0..*] ordered subsets membership, ownedRelationship;
      derived var feature importedMembership : Membership[0..*] ordered subsets membership;
    }

    metaclass Package specializes Namespace {
      derived var feature filterCondition : Expression[0..*] ordered subsets ownedMember;
    }
  }
}
"#;
        fs::write(library_dir.join("KerML.kerml"), library_source).expect("write library file");
        fs::write(project_dir.join("main.sysml"), "package P {}\n").expect("write model file");
        fs::write(
            project_dir.join(".project"),
            format!(
                "{{\"name\":\"pm-db\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
                library_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        compile_for_index(&state, &project_dir);
        let _ = get_project_element_attributes(
            &state,
            project_dir.to_string_lossy().to_string(),
            "P".to_string(),
            Some("Package".to_string()),
        )
        .expect("project element attributes");

        let metamodel = get_stdlib_metamodel(&state, project_dir.to_string_lossy().to_string())
            .expect("stdlib metamodel");
        let package_type = metamodel
            .types
            .iter()
            .find(|t| t.qualified_name == "KerML::Kernel::Package")
            .or_else(|| metamodel.types.iter().find(|t| t.name == "Package"))
            .expect("package metatype");
        let attr_names = package_type
            .attributes
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>();

        for expected in [
            "elementId",
            "aliasIds",
            "declaredShortName",
            "declaredName",
            "isImpliedIncluded",
            "shortName",
            "name",
            "qualifiedName",
            "isLibraryElement",
            "owningRelationship",
            "ownedRelationship",
            "owningMembership",
            "owningNamespace",
            "owner",
            "ownedElement",
            "documentation",
            "ownedAnnotation",
            "textualRepresentation",
            "membership",
            "ownedImport",
            "member",
            "ownedMember",
            "ownedMembership",
            "importedMembership",
            "filterCondition",
        ] {
            assert!(
                attr_names.iter().any(|name| *name == expected),
                "expected attribute '{expected}' in Package attrs {:?}",
                attr_names
            );
        }

        let _ = fs::remove_dir_all(root);
    }
}
