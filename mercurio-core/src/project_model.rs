use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use mercurio_model as walk;
use syster::hir::SymbolKind;
use syster::ide::AnalysisHost;
use syster::syntax::parser::parse_with_result;

use mercurio_semantic::{
    build_walk_workspace, collect_metamodel_attributes, extract_doc_comment, format_direction,
    format_multiplicity, resolve_package_metatype, resolve_project_metatype, span_to_line_cols,
    type_names_match, SemanticPredicate, SemanticQuery,
};
pub use mercurio_semantic::{
    ProjectElementAttributesView, ProjectElementInheritedAttributeView, ProjectModelAttributeView,
    ProjectModelElementView, ProjectModelView,
};

use crate::project::load_project_config;
use crate::semantic::query_semantic;
use crate::state::CoreState;
use crate::metamodel::get_stdlib_metamodel;
use crate::stdlib::{load_stdlib_into_host, resolve_stdlib_path};
use crate::workspace::{collect_model_files, collect_project_files};

pub fn get_project_element_attributes(
    state: &CoreState,
    root: String,
    element_qualified_name: String,
    symbol_kind: Option<String>,
) -> Result<ProjectElementAttributesView, String> {
    let project = get_project_model(state, root.clone())?;
    let library = get_stdlib_metamodel(state, root.clone())?;

    let target = project
        .elements
        .iter()
        .find(|item| item.qualified_name == element_qualified_name)
        .cloned()
        .ok_or_else(|| format!("Element '{}' was not found in project model.", element_qualified_name));

    let target = match target {
        Ok(value) => value,
        Err(_) => {
            return build_fallback_attributes(
                element_qualified_name,
                symbol_kind,
                &library,
            );
        }
    };

    let mut diagnostics = target.diagnostics.clone();
    let attribute_values = load_element_attribute_values(state, &root, &element_qualified_name);
    let mut explicit_attributes = target.attributes.clone();
    for attr in &mut explicit_attributes {
        attr.cst_value = attribute_value_for_name(&attribute_values, &attr.name);
    }
    let mut inherited_attributes = Vec::new();

    let Some(metatype_qname) = target.metatype_qname.clone() else {
        diagnostics.push("Element has no resolved metatype; inherited attributes unavailable.".to_string());
        return Ok(ProjectElementAttributesView {
            element_qualified_name,
            metatype_qname: None,
            explicit_attributes,
            inherited_attributes,
            diagnostics,
        });
    };

    let mut type_by_qname = HashMap::new();
    for ty in &library.types {
        type_by_qname.insert(ty.qualified_name.clone(), ty);
    }

    let mut stack = vec![metatype_qname.clone()];
    let mut seen_types = HashSet::new();
    let mut inherited_by_qname: HashMap<String, ProjectElementInheritedAttributeView> = HashMap::new();

    let explicit_attr_qnames: HashSet<String> = explicit_attributes
        .iter()
        .filter_map(|attr| attr.metamodel_attribute_qname.clone())
        .collect();
    let explicit_attr_names: HashSet<String> = explicit_attributes
        .iter()
        .map(|attr| attr.name.clone())
        .collect();

    while let Some(current_qname) = stack.pop() {
        if !seen_types.insert(current_qname.clone()) {
            continue;
        }
        let Some(ty) = type_by_qname.get(&current_qname) else {
            continue;
        };

        for super_name in ty
            .declared_supertypes
            .iter()
            .chain(ty.supertypes.iter())
        {
            if let Some(super_qname) = resolve_qname_from_library(&type_by_qname, super_name) {
                stack.push(super_qname);
            }
        }

        for attr in &ty.attributes {
            if explicit_attr_qnames.contains(&attr.qualified_name) || explicit_attr_names.contains(&attr.name) {
                continue;
            }
            inherited_by_qname
                .entry(attr.qualified_name.clone())
                .or_insert(ProjectElementInheritedAttributeView {
                    name: attr.name.clone(),
                    qualified_name: attr.qualified_name.clone(),
                    declared_on: ty.qualified_name.clone(),
                    declared_type: attr.declared_type.clone(),
                    multiplicity: attr.multiplicity.clone(),
                    direction: attr.direction.clone(),
                    documentation: attr.documentation.clone(),
                    cst_value: attribute_value_for_name(&attribute_values, &attr.name),
                });
        }
    }

    inherited_attributes = inherited_by_qname.into_values().collect();
    inherited_attributes.sort_by(|a, b| a.qualified_name.cmp(&b.qualified_name));

    Ok(ProjectElementAttributesView {
        element_qualified_name,
        metatype_qname: Some(metatype_qname),
        explicit_attributes,
        inherited_attributes,
        diagnostics,
    })
}

fn build_fallback_attributes(
    element_qualified_name: String,
    symbol_kind: Option<String>,
    library: &crate::metamodel::StdlibMetamodelView,
) -> Result<ProjectElementAttributesView, String> {
    let diagnostics = Vec::new();
    let Some(kind) = symbol_kind.as_deref() else {
        return Err(format!(
            "Element '{}' was not found in project model and no symbol kind was provided.",
            element_qualified_name
        ));
    };

    let mut type_by_qname = HashMap::new();
    for ty in &library.types {
        type_by_qname.insert(ty.qualified_name.clone(), ty);
    }

    let metatype_qname = resolve_metatype_from_symbol_kind(kind, &type_by_qname)
        .ok_or_else(|| {
            format!(
                "Element '{}' could not resolve metatype from symbol kind '{}'.",
                element_qualified_name, kind
            )
        })?;

    let mut inherited_by_qname: HashMap<String, ProjectElementInheritedAttributeView> =
        HashMap::new();
    let mut stack = vec![metatype_qname.clone()];
    let mut seen_types = HashSet::new();

    while let Some(current_qname) = stack.pop() {
        if !seen_types.insert(current_qname.clone()) {
            continue;
        }
        let Some(ty) = type_by_qname.get(&current_qname) else {
            continue;
        };

        for super_name in ty
            .declared_supertypes
            .iter()
            .chain(ty.supertypes.iter())
        {
            if let Some(super_qname) = resolve_qname_from_library(&type_by_qname, super_name) {
                stack.push(super_qname);
            }
        }

        for attr in &ty.attributes {
            inherited_by_qname
                .entry(attr.qualified_name.clone())
                .or_insert(ProjectElementInheritedAttributeView {
                    name: attr.name.clone(),
                    qualified_name: attr.qualified_name.clone(),
                    declared_on: ty.qualified_name.clone(),
                    declared_type: attr.declared_type.clone(),
                    multiplicity: attr.multiplicity.clone(),
                    direction: attr.direction.clone(),
                    documentation: attr.documentation.clone(),
                    cst_value: None,
                });
        }
    }

    let mut inherited_attributes = inherited_by_qname.into_values().collect::<Vec<_>>();
    inherited_attributes.sort_by(|a, b| a.qualified_name.cmp(&b.qualified_name));

    Ok(ProjectElementAttributesView {
        element_qualified_name,
        metatype_qname: Some(metatype_qname),
        explicit_attributes: Vec::new(),
        inherited_attributes,
        diagnostics,
    })
}

fn resolve_metatype_from_symbol_kind(
    kind: &str,
    type_by_qname: &HashMap<String, &crate::metamodel::MetamodelTypeView>,
) -> Option<String> {
    let candidates = metatype_name_candidates(kind);
    let mut aggregate_matches = Vec::new();
    for candidate in &candidates {
        let mut matches = Vec::new();
        for qname in type_by_qname.keys() {
            let tail = qname.rsplit("::").next().unwrap_or(qname);
            if &normalize_key(tail) == candidate {
                matches.push(qname.clone());
            }
        }
        matches.sort();
        matches.dedup();
        if matches.len() == 1 {
            return matches.into_iter().next();
        }
        if !matches.is_empty() {
            aggregate_matches.extend(matches);
        }
    }
    aggregate_matches.sort();
    aggregate_matches.dedup();
    if aggregate_matches.len() == 1 {
        aggregate_matches.into_iter().next()
    } else {
        None
    }
}

fn normalize_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

fn metatype_name_candidates(kind: &str) -> Vec<String> {
    let normalized = normalize_key(kind);
    if normalized.is_empty() {
        return Vec::new();
    }
    let mut out = vec![normalized.clone()];
    for suffix in ["definition", "def", "usage", "use"] {
        if normalized.ends_with(suffix) && normalized.len() > suffix.len() {
            out.push(normalized[..normalized.len() - suffix.len()].to_string());
        }
    }
    let expanded = out.clone();
    for candidate in expanded {
        if candidate.starts_with("attribute") {
            out.push("feature".to_string());
            if candidate.len() > "attribute".len() {
                out.push(format!("feature{}", &candidate["attribute".len()..]));
            }
        }
    }
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for candidate in out {
        if seen.insert(candidate.clone()) {
            deduped.push(candidate);
        }
    }
    deduped
}

fn resolve_qname_from_library(
    type_by_qname: &HashMap<String, &crate::metamodel::MetamodelTypeView>,
    name: &str,
) -> Option<String> {
    if type_by_qname.contains_key(name) {
        return Some(name.to_string());
    }
    let mut matches = type_by_qname
        .keys()
        .filter(|qname| qname.rsplit("::").next().unwrap_or("") == name)
        .cloned()
        .collect::<Vec<_>>();
    matches.sort();
    if matches.len() == 1 {
        matches.into_iter().next()
    } else {
        None
    }
}

fn load_element_attribute_values(
    state: &CoreState,
    root: &str,
    element_qualified_name: &str,
) -> HashMap<String, String> {
    let query = SemanticQuery {
        metatype: None,
        metatype_is_a: None,
        predicates: vec![SemanticPredicate {
            name: "qualified_name".to_string(),
            equals: element_qualified_name.to_string(),
        }],
    };
    let Ok(elements) = query_semantic(state, root.to_string(), query) else {
        return HashMap::new();
    };
    elements
        .into_iter()
        .find(|item| item.qualified_name == element_qualified_name)
        .map(|item| item.attributes)
        .unwrap_or_default()
}

fn attribute_value_for_name(
    values: &HashMap<String, String>,
    attr_name: &str,
) -> Option<String> {
    let key = normalize_key(attr_name);
    values
        .iter()
        .find(|(name, _)| normalize_key(name) == key)
        .map(|(_, value)| value.clone())
}

pub fn get_project_model(state: &CoreState, root: String) -> Result<ProjectModelView, String> {
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
    let cache_key = build_project_model_cache_key(&root_path, stdlib_path.as_ref(), &project_files);
    if let Ok(cache) = state.project_model_cache.lock() {
        if let Some(cached) = cache.get(&cache_key) {
            let mut view = cached.clone();
            view.project_cache_hit = true;
            return Ok(view);
        }
    }

    let mut host = AnalysisHost::new();
    let mut stdlib_cache_hit = false;
    if let Some(path) = stdlib_path.as_ref() {
        stdlib_cache_hit = load_stdlib_into_host(state, &mut host, path)?;
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
    let stdlib_file_list: Vec<PathBuf> = files
        .keys()
        .filter(|path| stdlib_paths.contains(*path))
        .cloned()
        .collect();
    let project_file_set: HashSet<PathBuf> = project_files.iter().cloned().collect();
    let project_file_list: Vec<PathBuf> = files
        .keys()
        .filter(|path| project_file_set.contains(*path))
        .cloned()
        .collect();

    let stdlib_workspace = build_walk_workspace(files, &stdlib_file_list);
    let project_workspace = build_walk_workspace(files, &project_file_list);
    let (stdlib_db, stdlib_ws, _, _) = match stdlib_workspace {
        Some(value) => value,
        None => {
            return Ok(ProjectModelView {
                stdlib_path: stdlib_path.map(|path| path.to_string_lossy().to_string()),
                stdlib_cache_hit,
                project_cache_hit: false,
                element_count: 0,
                elements: Vec::new(),
                diagnostics: vec!["No stdlib files were loaded.".to_string()],
            })
        }
    };
    let (project_db, project_ws, project_text_by_file, project_path_by_file) =
        match project_workspace {
            Some(value) => value,
            None => {
                return Ok(ProjectModelView {
                    stdlib_path: stdlib_path.map(|path| path.to_string_lossy().to_string()),
                    stdlib_cache_hit,
                    project_cache_hit: false,
                    element_count: 0,
                    elements: Vec::new(),
                    diagnostics: vec!["No project model files were parsed.".to_string()],
                })
            }
        };

    let stdlib_index = walk::workspace_index(&stdlib_db, stdlib_ws);
    let project_index = walk::workspace_index(&project_db, project_ws);

    let mut ref_to_qname: HashMap<walk::TypeRef, String> = HashMap::new();
    for (qname, tref) in &stdlib_index.type_by_qname {
        ref_to_qname.insert(*tref, qname.clone());
    }
    let mut project_ref_to_qname: HashMap<walk::TypeRef, String> = HashMap::new();
    for (qname, tref) in &project_index.type_by_qname {
        project_ref_to_qname.insert(*tref, qname.clone());
    }
    let mut type_info_by_qname: HashMap<String, walk::TypeInfo> = HashMap::new();
    for info in &stdlib_index.types {
        type_info_by_qname.insert(info.qualified_name.clone(), info.clone());
    }

    let mut elements = Vec::new();
    let mut diagnostics = Vec::new();

    let mut project_types = project_index.types.clone();
    project_types.sort_by(|a, b| a.qualified_name.cmp(&b.qualified_name));

    for ty in project_types {
        let Some(project_type_ref) = project_index.type_by_qname.get(&ty.qualified_name).copied()
        else {
            continue;
        };
        let Some(type_element) =
            walk::element_info(&project_db, project_ws, project_type_ref.element)
        else {
            continue;
        };

        let is_package = matches!(type_element.kind, SymbolKind::Package);
        let kind_hint = type_element.kind.display().to_string();
        let (metatype_ref, metatype_diag) = if is_package {
            resolve_package_metatype(&stdlib_index)
        } else {
            resolve_project_metatype(&stdlib_index, &ty, Some(kind_hint.as_str()))
        };
        let metatype_qname =
            metatype_ref.and_then(|reference| ref_to_qname.get(&reference).cloned());

        let mut element_diags = Vec::new();
        if let Some(diag) = metatype_diag {
            element_diags.push(diag);
        }

        let metamodel_attrs = metatype_ref.map(|reference| {
            collect_metamodel_attributes(
                &stdlib_db,
                stdlib_ws,
                &stdlib_index,
                &ref_to_qname,
                &type_info_by_qname,
                reference,
            )
        });

        let mut attributes = Vec::new();
        let owned_attrs = walk::owned_attributes(&project_db, project_ws, project_type_ref);
        for attr_ref in owned_attrs.iter().copied() {
            let Some(attr_info) = walk::attr_info(&project_db, project_ws, attr_ref) else {
                continue;
            };
            let attr_element = walk::element_info(&project_db, project_ws, attr_ref.element);
            let attr_doc = attr_element.as_ref().and_then(|element| {
                project_text_by_file
                    .get(&element.file)
                    .and_then(|text| extract_doc_comment(text, element.span.start as usize))
            });
            let multiplicity = attr_element
                .as_ref()
                .and_then(|element| format_multiplicity(element.multiplicity));
            let direction = attr_element
                .as_ref()
                .and_then(|element| element.direction)
                .map(format_direction);

            let mut attr_diags = Vec::new();
            let mut matched_attr_qname = None;
            if let Some(attrs) = metamodel_attrs.as_ref() {
                let matches: Vec<&walk::AttrInfo> = attrs
                    .iter()
                    .filter(|item| {
                        item.name == attr_info.name
                            || item.qualified_name == attr_info.qualified_name
                    })
                    .collect();
                if matches.is_empty() {
                    attr_diags.push(format!(
                        "Attribute '{}' is not defined on metatype '{}'.",
                        attr_info.name,
                        metatype_qname
                            .clone()
                            .unwrap_or_else(|| "<unresolved>".to_string())
                    ));
                } else if matches.len() > 1 {
                    attr_diags.push(format!(
                        "Attribute '{}' matches multiple metamodel attributes.",
                        attr_info.name
                    ));
                } else if let Some(found) = matches.first() {
                    matched_attr_qname = Some(found.qualified_name.clone());
                    if let (Some(project_declared), Some(meta_declared)) = (
                        attr_info.declared_type.as_ref(),
                        found.declared_type.as_ref(),
                    ) {
                        if !type_names_match(project_declared, meta_declared) {
                            attr_diags.push(format!(
                                "Declared type '{}' does not match metamodel type '{}'.",
                                project_declared, meta_declared
                            ));
                        }
                    }
                }
            }

            attributes.push(ProjectModelAttributeView {
                name: attr_info.name,
                qualified_name: attr_info.qualified_name,
                declared_type: attr_info.declared_type,
                multiplicity,
                direction,
                documentation: attr_doc,
                cst_value: None,
                metamodel_attribute_qname: matched_attr_qname,
                diagnostics: attr_diags,
            });
        }
        attributes.sort_by(|a, b| a.qualified_name.cmp(&b.qualified_name));

        let (start_line, start_col, end_line, end_col) = span_to_line_cols(
            project_text_by_file
                .get(&type_element.file)
                .map(|s| s.as_str()),
            type_element.span,
        );
        let file_path = project_path_by_file
            .get(&type_element.file)
            .cloned()
            .unwrap_or_default();
        let type_doc = project_text_by_file
            .get(&type_element.file)
            .and_then(|text| extract_doc_comment(text, type_element.span.start as usize));

        if metatype_qname.is_none() {
            if is_package {
                diagnostics.push(format!(
                    "Package '{}' could not resolve stdlib metatype 'Package'.",
                    ty.qualified_name
                ));
            } else {
                diagnostics.push(format!(
                    "Type '{}' has no resolved stdlib metatype.",
                    ty.qualified_name
                ));
            }
        }

        let direct_specializations = project_index
            .subtypes
            .get(&project_type_ref)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|tref| project_ref_to_qname.get(&tref).cloned())
            .collect::<Vec<_>>();

        let mut indirect_refs: Vec<walk::TypeRef> = Vec::new();
        let mut stack = project_index
            .subtypes
            .get(&project_type_ref)
            .cloned()
            .unwrap_or_default();
        let mut seen_refs: HashSet<walk::TypeRef> = HashSet::new();
        for tref in &stack {
            seen_refs.insert(*tref);
        }
        while let Some(current) = stack.pop() {
            if let Some(children) = project_index.subtypes.get(&current) {
                for child in children {
                    if seen_refs.insert(*child) {
                        indirect_refs.push(*child);
                        stack.push(*child);
                    }
                }
            }
        }
        let mut direct_specializations = direct_specializations;
        direct_specializations.sort();
        direct_specializations.dedup();

        let mut indirect_specializations = indirect_refs
            .into_iter()
            .filter_map(|tref| project_ref_to_qname.get(&tref).cloned())
            .collect::<Vec<_>>();
        indirect_specializations.sort();
        indirect_specializations.dedup();

        elements.push(ProjectModelElementView {
            name: ty.name,
            qualified_name: ty.qualified_name,
            kind: type_element.kind.display().to_string(),
            file_path,
            start_line,
            start_col,
            end_line,
            end_col,
            metatype_qname,
            declared_supertypes: ty.declared_supertypes,
            supertypes: ty.supertypes,
            direct_specializations,
            indirect_specializations,
            documentation: type_doc,
            attributes,
            diagnostics: element_diags,
        });
    }

    let view = ProjectModelView {
        stdlib_path: stdlib_path.map(|path| path.to_string_lossy().to_string()),
        stdlib_cache_hit,
        project_cache_hit: false,
        element_count: elements.len(),
        elements,
        diagnostics,
    };

    if let Ok(mut cache) = state.project_model_cache.lock() {
        cache.insert(cache_key, view.clone());
    }

    Ok(view)
}


fn build_project_model_cache_key(
    root_path: &Path,
    stdlib_path: Option<&PathBuf>,
    project_files: &[PathBuf],
) -> String {
    let mut parts = Vec::new();
    parts.push(format!("root={}", root_path.to_string_lossy()));
    parts.push(format!(
        "stdlib={}",
        stdlib_path
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|| "<none>".to_string())
    ));
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
