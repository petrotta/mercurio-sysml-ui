use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use mercurio_symbol_index::SymbolIndexStore;
use mercurio_sysml_core::vfs::Vfs;
pub use mercurio_sysml_semantics::semantic_project_model_contract::{
    ProjectElementAttributesView, ProjectElementInheritedAttributeView, ProjectModelAttributeView,
    ProjectModelElementView, ProjectModelView,
};
use mercurio_sysml_semantics::stdlib::{
    build_metatype_index, load_stdlib_from_path, MetatypeIndex, MetatypeInfo,
};

use crate::compile::compile_project_delta_sync;
use crate::project::load_project_config;
use crate::project_model_seed::seed_symbol_index_if_empty;
use crate::project_model_transform::{resolve_mapped_metatype, symbol_to_attribute_rows};
use crate::state::CoreState;
use crate::stdlib::resolve_stdlib_path;

pub fn get_project_element_attributes(
    state: &CoreState,
    root: String,
    element_qualified_name: String,
    symbol_kind: Option<String>,
) -> Result<ProjectElementAttributesView, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }
    seed_symbol_index_if_empty(state, &root)?;

    let (mut symbol, mut metatype_qname, mut diagnostics) = {
        let store = state
            .symbol_index
            .lock()
            .map_err(|_| "Symbol index lock poisoned".to_string())?;
        let Some(symbol) = store.project_symbol(&root, &element_qualified_name, symbol_kind.as_deref()) else {
            return Ok(ProjectElementAttributesView {
                element_qualified_name,
                metatype_qname: None,
                explicit_attributes: Vec::new(),
                inherited_attributes: Vec::new(),
                diagnostics: vec!["Element not found in current project symbol index.".to_string()],
            });
        };
        let (metatype_qname, diagnostics) = resolve_mapped_metatype(&*store, &root, &symbol);
        (symbol, metatype_qname, diagnostics)
    };

    if metatype_qname.is_none() {
        let _ = compile_project_delta_sync(
            state,
            root.clone(),
            0,
            true,
            Some(PathBuf::from(symbol.file_path.clone())),
            Vec::new(),
            |_| {},
        );
        if let Ok(store) = state.symbol_index.lock() {
            if let Some(refreshed) = store.project_symbol(&root, &element_qualified_name, symbol_kind.as_deref()) {
                let (retry_metatype, retry_diagnostics) = resolve_mapped_metatype(&*store, &root, &refreshed);
                symbol = refreshed;
                metatype_qname = retry_metatype;
                diagnostics.extend(retry_diagnostics);
                if metatype_qname.is_some() {
                    diagnostics.push(
                        "Metatype resolved after targeted semantic refresh from mercurio-sysml."
                            .to_string(),
                    );
                }
            }
        }
    }

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
    }
    let explicit_attributes = symbol_to_attribute_rows(&symbol, metatype_qname.as_deref());
    let inherited_attributes = collect_inherited_attributes(
        state,
        &root,
        metatype_qname.as_deref(),
        &explicit_attributes,
        &mut diagnostics,
    );

    Ok(ProjectElementAttributesView {
        element_qualified_name,
        metatype_qname: metatype_qname.clone(),
        explicit_attributes,
        inherited_attributes,
        diagnostics,
    })
}

fn collect_inherited_attributes(
    state: &CoreState,
    root: &str,
    metatype_qname: Option<&str>,
    explicit_attributes: &[ProjectModelAttributeView],
    diagnostics: &mut Vec<String>,
) -> Vec<ProjectElementInheritedAttributeView> {
    let Some(metatype_qname) = metatype_qname else {
        diagnostics.push("Inherited attributes unavailable because metatype is unresolved.".to_string());
        return Vec::new();
    };

    let index = match load_stdlib_metatype_index(state, root) {
        Ok(Some(index)) => index,
        Ok(None) => return Vec::new(),
        Err(error) => {
            diagnostics.push(format!("Unable to load stdlib metatype index: {error}"));
            return Vec::new();
        }
    };

    let Some(metatype) = resolve_metatype_info(&index, metatype_qname) else {
        diagnostics.push(format!(
            "Metatype '{metatype_qname}' was not found in resolved stdlib metamodel."
        ));
        return Vec::new();
    };

    let explicit_names = explicit_attributes
        .iter()
        .map(|attr| attr.name.to_ascii_lowercase())
        .collect::<HashSet<_>>();

    let infos_by_id = index
        .infos
        .iter()
        .map(|info| (info.id, info))
        .collect::<HashMap<_, _>>();
    let mut inherited_by_name = HashMap::<String, ProjectElementInheritedAttributeView>::new();

    for super_id in index
        .supertypes
        .get(&metatype.id)
        .cloned()
        .unwrap_or_default()
    {
        let Some(super_info) = infos_by_id.get(&super_id).copied() else {
            continue;
        };
        for attr in &super_info.attributes {
            let attr_key = attr.name.to_ascii_lowercase();
            if explicit_names.contains(&attr_key) {
                continue;
            }
            inherited_by_name.insert(
                attr_key,
                ProjectElementInheritedAttributeView {
                    name: attr.name.clone(),
                    qualified_name: format!("{}::{}", super_info.qualified_name, attr.name),
                    declared_on: super_info.qualified_name.clone(),
                    declared_type: attr.ty.clone(),
                    multiplicity: attr.multiplicity.clone(),
                    direction: None,
                    documentation: None,
                    cst_value: attr.expr.clone(),
                },
            );
        }
    }

    let mut inherited = inherited_by_name.into_values().collect::<Vec<_>>();
    inherited.sort_by(|a, b| a.name.cmp(&b.name).then(a.declared_on.cmp(&b.declared_on)));
    inherited
}

fn load_stdlib_metatype_index(state: &CoreState, root: &str) -> Result<Option<Arc<MetatypeIndex>>, String> {
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
    let Some(path) = stdlib_path else {
        return Ok(None);
    };
    if !path.exists() {
        return Err(format!(
            "Resolved stdlib path does not exist: {}",
            path.to_string_lossy()
        ));
    }

    if let Ok(cache) = state.stdlib_cache.lock() {
        let target = normalize_compare_key(&path);
        if let Some(found) = cache
            .values()
            .find(|entry| normalize_compare_key(&entry.path) == target)
            .map(|entry| entry.metatype_index.clone())
        {
            return Ok(Some(found));
        }
    }

    let mut vfs = Vfs::new();
    let files = load_stdlib_from_path(&mut vfs, &path);
    Ok(Some(Arc::new(build_metatype_index(&vfs, &files))))
}

fn resolve_metatype_info<'a>(index: &'a MetatypeIndex, metatype_qname: &str) -> Option<&'a MetatypeInfo> {
    if let Some(found) = index
        .infos
        .iter()
        .find(|info| info.qualified_name == metatype_qname)
    {
        return Some(found);
    }
    let tail = metatype_qname.rsplit("::").next().unwrap_or(metatype_qname);
    let matches = index
        .infos
        .iter()
        .filter(|info| info.qualified_name.rsplit("::").next().unwrap_or(info.name.as_str()) == tail)
        .collect::<Vec<_>>();
    if matches.len() == 1 {
        return matches.first().copied();
    }
    None
}

fn normalize_compare_key(path: &std::path::Path) -> String {
    let normalized = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    normalized
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
}

pub fn get_project_model(state: &CoreState, root: String) -> Result<ProjectModelView, String> {
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

    let mut elements = Vec::new();
    for symbol in indexed {
        let (metatype_qname, diagnostics) = resolve_mapped_metatype(&*store, &root, &symbol);
        let attributes = symbol_to_attribute_rows(&symbol, metatype_qname.as_deref());
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

    Ok(ProjectModelView {
        stdlib_path: None,
        stdlib_cache_hit: false,
        project_cache_hit: false,
        element_count: elements.len(),
        elements,
        diagnostics: vec!["Project model is generated from persisted symbol index.".to_string()],
    })
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::AppSettings;
    use crate::state::CoreState;
    use crate::stdlib::get_stdlib_metamodel;
    use mercurio_symbol_index::SymbolIndexStore;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn project_model_is_built_from_symbol_index() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mercurio_project_model_db_{stamp}"));
        let project_dir = root.join("project");
        fs::create_dir_all(&project_dir).expect("create project dir");
        fs::write(project_dir.join("main.sysml"), "package P { action def DoThing; }\n")
            .expect("write model file");
        fs::write(
            project_dir.join(".project"),
            "{\"name\":\"pm-db\",\"use_default_library\":true,\"src\":[\"*.sysml\"]}",
        )
        .expect("write descriptor");

        let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
        let view = get_project_model(&state, project_dir.to_string_lossy().to_string())
            .expect("get project model");
        assert!(view.element_count > 0);
        assert!(view
            .diagnostics
            .iter()
            .any(|line| line.contains("persisted symbol index")));
        assert!(view.elements.iter().any(|element| element.qualified_name == "P"));

        let attrs = get_project_element_attributes(
            &state,
            project_dir.to_string_lossy().to_string(),
            "P".to_string(),
            Some("Package".to_string()),
        )
        .expect("get element attrs");
        assert_eq!(attrs.element_qualified_name, "P");
        assert!(!attrs.explicit_attributes.is_empty());

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
        let attrs = get_project_element_attributes(
            &state,
            project_dir.to_string_lossy().to_string(),
            "P".to_string(),
            Some("Package".to_string()),
        )
        .expect("project element attributes");

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
                let tail = mapped_qname.rsplit("::").next().unwrap_or(mapped_qname.as_str());
                let mut candidates = metamodel
                    .types
                    .iter()
                    .filter(|t| t.qualified_name.ends_with(&format!("::{tail}")))
                    .collect::<Vec<_>>();
                candidates.sort_by(|a, b| {
                    let a_has_filter = a.attributes.iter().any(|attr| attr.name == "filterCondition");
                    let b_has_filter = b.attributes.iter().any(|attr| attr.name == "filterCondition");
                    b_has_filter.cmp(&a_has_filter).then(b.qualified_name.len().cmp(&a.qualified_name.len()))
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
        println!("Package metatype attributes (db-backed path): {:?}", package_attrs);
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
        let root = std::env::temp_dir().join(format!("mercurio_project_model_pkg_inherited_{stamp}"));
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
        let root = std::env::temp_dir().join(format!("mercurio_project_model_pkg_full_chain_{stamp}"));
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
