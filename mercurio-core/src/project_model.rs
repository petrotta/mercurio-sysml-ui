use std::fs;
use std::path::{Path, PathBuf};

use mercurio_sysml_semantics::semantic_contract::{SemanticPredicate, SemanticQuery};
pub use mercurio_sysml_semantics::semantic_project_model_contract::{
    ProjectElementAttributesView, ProjectElementInheritedAttributeView, ProjectModelAttributeView,
    ProjectModelElementView, ProjectModelView,
};

use crate::project::load_project_config;
use crate::state::CoreState;
use crate::workspace::{collect_model_files, collect_project_files, query_semantic};

pub fn get_project_element_attributes(
    state: &CoreState,
    root: String,
    element_qualified_name: String,
    _symbol_kind: Option<String>,
) -> Result<ProjectElementAttributesView, String> {
    let project = get_project_model(state, root)?;
    let Some(target) = project
        .elements
        .iter()
        .find(|item| item.qualified_name == element_qualified_name)
        .cloned()
    else {
        return Ok(ProjectElementAttributesView {
            element_qualified_name,
            metatype_qname: None,
            explicit_attributes: Vec::new(),
            inherited_attributes: Vec::new(),
            diagnostics: vec!["Element not found in current project model snapshot.".to_string()],
        });
    };

    Ok(ProjectElementAttributesView {
        element_qualified_name,
        metatype_qname: target.metatype_qname,
        explicit_attributes: target.attributes,
        inherited_attributes: Vec::<ProjectElementInheritedAttributeView>::new(),
        diagnostics: target.diagnostics,
    })
}

pub fn get_project_model(state: &CoreState, root: String) -> Result<ProjectModelView, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }

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

    let cache_key = build_project_model_cache_key(&root_path, &project_files);
    if let Ok(cache) = state.project_model_cache.lock() {
        if let Some(cached) = cache.get(&cache_key) {
            let mut view = cached.clone();
            view.project_cache_hit = true;
            return Ok(view);
        }
    }

    let query = SemanticQuery {
        metatype: None,
        metatype_is_a: None,
        predicates: Vec::<SemanticPredicate>::new(),
    };
    let semantic_elements = query_semantic(state, root, query)?;

    let mut elements = Vec::new();
    for element in semantic_elements {
        let mut attrs = Vec::new();
        let mut keys = element.attributes.keys().cloned().collect::<Vec<_>>();
        keys.sort();
        for key in keys {
            let value = element.attributes.get(&key).cloned();
            attrs.push(ProjectModelAttributeView {
                name: key.clone(),
                qualified_name: format!("{}::{}", element.qualified_name, key),
                declared_type: None,
                multiplicity: None,
                direction: None,
                documentation: None,
                cst_value: value,
                metamodel_attribute_qname: None,
                diagnostics: Vec::new(),
            });
        }

        elements.push(ProjectModelElementView {
            name: element.name,
            qualified_name: element.qualified_name,
            kind: "element".to_string(),
            file_path: element.file_path,
            start_line: 0,
            start_col: 0,
            end_line: 0,
            end_col: 0,
            metatype_qname: element.metatype_qname,
            declared_supertypes: Vec::new(),
            supertypes: Vec::new(),
            direct_specializations: Vec::new(),
            indirect_specializations: Vec::new(),
            documentation: None,
            attributes: attrs,
            diagnostics: Vec::new(),
        });
    }
    elements.sort_by(|a, b| a.qualified_name.cmp(&b.qualified_name));

    let view = ProjectModelView {
        stdlib_path: None,
        stdlib_cache_hit: false,
        project_cache_hit: false,
        element_count: elements.len(),
        elements,
        diagnostics: vec![
            "Project model is generated from semantic query projections (reduced fidelity)."
                .to_string(),
        ],
    };

    if let Ok(mut cache) = state.project_model_cache.lock() {
        cache.insert(cache_key, view.clone());
    }

    Ok(view)
}

fn build_project_model_cache_key(root_path: &Path, project_files: &[PathBuf]) -> String {
    let mut parts = Vec::new();
    parts.push(format!("root={}", root_path.to_string_lossy()));
    for path in project_files {
        let (len, modified) = match fs::metadata(path) {
            Ok(meta) => {
                let len = meta.len();
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|value| value.as_secs().to_string())
                    .unwrap_or_else(|| "0".to_string());
                (len, modified)
            }
            Err(_) => (0, "0".to_string()),
        };
        parts.push(format!("{}|{}|{}", path.to_string_lossy(), len, modified));
    }
    parts.join("::")
}


