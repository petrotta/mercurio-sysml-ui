use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;

use mercurio_model as walk;
use syster::ide::AnalysisHost;
use syster::parser::Direction;
use syster::syntax::normalized::Multiplicity;

use crate::project::load_project_config;
use crate::state::CoreState;
use crate::stdlib::{load_stdlib_into_host, resolve_stdlib_path};

#[derive(Serialize, Clone)]
pub struct StdlibMetamodelView {
    pub stdlib_path: Option<String>,
    pub stdlib_cache_hit: bool,
    pub type_count: usize,
    pub types: Vec<MetamodelTypeView>,
}

#[derive(Serialize, Clone)]
pub struct MetamodelTypeView {
    pub name: String,
    pub qualified_name: String,
    pub declared_supertypes: Vec<String>,
    pub supertypes: Vec<String>,
    pub documentation: Option<String>,
    pub modifiers: MetamodelModifiersView,
    pub attributes: Vec<MetamodelAttributeView>,
}

#[derive(Serialize, Clone)]
pub struct MetamodelAttributeView {
    pub name: String,
    pub qualified_name: String,
    pub declared_type: Option<String>,
    pub multiplicity: Option<String>,
    pub direction: Option<String>,
    pub documentation: Option<String>,
    pub modifiers: MetamodelModifiersView,
}

#[derive(Serialize, Clone)]
pub struct MetamodelModifiersView {
    pub is_public: bool,
    pub is_abstract: bool,
    pub is_variation: bool,
    pub is_readonly: bool,
    pub is_derived: bool,
    pub is_parallel: bool,
}

pub fn get_stdlib_metamodel(
    state: &CoreState,
    root: String,
) -> Result<StdlibMetamodelView, String> {
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
    let cache_key = stdlib_path
        .as_ref()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "<none>".to_string());

    if let Ok(cache) = state.metamodel_cache.lock() {
        if let Some(cached) = cache.get(&cache_key) {
            let mut view = cached.clone();
            view.stdlib_cache_hit = true;
            return Ok(view);
        }
    }

    let mut host = AnalysisHost::new();
    let mut stdlib_cache_hit = false;
    if let Some(path) = stdlib_path.as_ref() {
        stdlib_cache_hit = load_stdlib_into_host(state, &mut host, path)?;
    }

    let files = host.files();
    if files.is_empty() {
        return Ok(StdlibMetamodelView {
            stdlib_path: stdlib_path.map(|path| path.to_string_lossy().to_string()),
            stdlib_cache_hit,
            type_count: 0,
            types: Vec::new(),
        });
    }

    let mut walk_db = walk::Db::default();
    let mut paths: Vec<PathBuf> = files.keys().cloned().collect();
    paths.sort();

    let mut file_texts = Vec::new();
    let mut file_paths = Vec::new();
    let mut file_content_by_id: HashMap<walk::FileId, String> = HashMap::new();
    let mut next_id = 1u32;
    for path in &paths {
        let Some(syntax) = files.get(path) else {
            continue;
        };
        let file_id = walk::FileId(next_id);
        next_id += 1;
        let text = syntax.source_text();
        let path_text = path.to_string_lossy().to_string();
        file_content_by_id.insert(file_id, text.clone());
        file_texts.push(walk::FileText::new(&mut walk_db, file_id, text));
        file_paths.push(walk::FilePath::new(&mut walk_db, file_id, path_text));
    }

    let ws_files =
        walk::WorkspaceFiles::new(&mut walk_db, walk::WorkspaceId(1), file_texts, file_paths);
    let ws_index = walk::workspace_index(&walk_db, ws_files);

    let mut type_items = ws_index.types.clone();
    type_items.sort_by(|a, b| a.qualified_name.cmp(&b.qualified_name));

    let mut types = Vec::new();
    for ty in type_items {
        let Some(type_ref) = ws_index.type_by_qname.get(&ty.qualified_name).copied() else {
            continue;
        };
        let type_element = walk::element_info(&walk_db, ws_files, type_ref.element);
        let type_doc = type_element.as_ref().and_then(|element| {
            file_content_by_id
                .get(&element.file)
                .and_then(|text| extract_doc_comment(text, element.span.start as usize))
        });
        let type_mods = type_element
            .as_ref()
            .map(modifiers_from_element)
            .unwrap_or_else(MetamodelModifiersView::default_private);

        let mut attributes = Vec::new();
        let owned = walk::owned_attributes(&walk_db, ws_files, type_ref);
        for attr_ref in owned.iter().copied() {
            let Some(attr) = walk::attr_info(&walk_db, ws_files, attr_ref) else {
                continue;
            };
            let attr_element = walk::element_info(&walk_db, ws_files, attr_ref.element);
            let attr_doc = attr_element.as_ref().and_then(|element| {
                file_content_by_id
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
            let modifiers = attr_element
                .as_ref()
                .map(modifiers_from_element)
                .unwrap_or_else(MetamodelModifiersView::default_private);

            attributes.push(MetamodelAttributeView {
                name: attr.name,
                qualified_name: attr.qualified_name,
                declared_type: attr.declared_type,
                multiplicity,
                direction,
                documentation: attr_doc,
                modifiers,
            });
        }
        attributes.sort_by(|a, b| a.qualified_name.cmp(&b.qualified_name));

        types.push(MetamodelTypeView {
            name: ty.name,
            qualified_name: ty.qualified_name,
            declared_supertypes: ty.declared_supertypes,
            supertypes: ty.supertypes,
            documentation: type_doc,
            modifiers: type_mods,
            attributes,
        });
    }

    let view = StdlibMetamodelView {
        stdlib_path: stdlib_path.map(|path| path.to_string_lossy().to_string()),
        stdlib_cache_hit,
        type_count: types.len(),
        types,
    };

    if let Ok(mut cache) = state.metamodel_cache.lock() {
        cache.insert(cache_key, view.clone());
    }

    Ok(view)
}

impl MetamodelModifiersView {
    fn default_private() -> Self {
        Self {
            is_public: false,
            is_abstract: false,
            is_variation: false,
            is_readonly: false,
            is_derived: false,
            is_parallel: false,
        }
    }
}

fn modifiers_from_element(element: &walk::ElementInfo) -> MetamodelModifiersView {
    MetamodelModifiersView {
        is_public: element.is_public,
        is_abstract: element.is_abstract,
        is_variation: element.is_variation,
        is_readonly: element.is_readonly,
        is_derived: element.is_derived,
        is_parallel: element.is_parallel,
    }
}

fn format_direction(direction: Direction) -> String {
    match direction {
        Direction::In => "in".to_string(),
        Direction::Out => "out".to_string(),
        Direction::InOut => "inout".to_string(),
    }
}

fn format_multiplicity(mult: Option<Multiplicity>) -> Option<String> {
    let mult = mult?;
    let lower = mult.lower;
    let upper = mult.upper;
    if lower.is_none() && upper.is_none() {
        return None;
    }
    if let (Some(lo), Some(hi)) = (lower, upper) {
        if lo == hi {
            return Some(format!("[{}]", lo));
        }
    }
    let lo = lower
        .map(|v| v.to_string())
        .unwrap_or_else(|| "*".to_string());
    let hi = upper
        .map(|v| v.to_string())
        .unwrap_or_else(|| "*".to_string());
    Some(format!("[{}..{}]", lo, hi))
}

fn extract_doc_comment(text: &str, start_offset: usize) -> Option<String> {
    let safe_start = start_offset.min(text.len());
    let before = &text[..safe_start];
    let mut lines: Vec<&str> = before.lines().collect();
    if lines.is_empty() {
        return None;
    }

    while let Some(last) = lines.last() {
        if last.trim().is_empty() {
            lines.pop();
            continue;
        }
        break;
    }

    if lines.is_empty() {
        return None;
    }

    let mut doc_lines = Vec::new();
    let mut index = lines.len();
    while index > 0 {
        let line = lines[index - 1].trim_start();
        if let Some(rest) = line.strip_prefix("///") {
            doc_lines.push(rest.trim_start().to_string());
            index -= 1;
            continue;
        }
        if let Some(rest) = line.strip_prefix("//!") {
            doc_lines.push(rest.trim_start().to_string());
            index -= 1;
            continue;
        }
        break;
    }
    if !doc_lines.is_empty() {
        doc_lines.reverse();
        return Some(doc_lines.join("\n"));
    }

    let mut index = lines.len();
    while index > 0 {
        let line = lines[index - 1].trim_start();
        if let Some(rest) = line.strip_prefix("//") {
            doc_lines.push(rest.trim_start().to_string());
            index -= 1;
            continue;
        }
        break;
    }
    if !doc_lines.is_empty() {
        doc_lines.reverse();
        return Some(doc_lines.join("\n"));
    }

    let mut end = lines.len();
    while end > 0 && lines[end - 1].trim().is_empty() {
        end -= 1;
    }
    if end == 0 {
        return None;
    }
    if !lines[end - 1].trim_end().ends_with("*/") {
        return None;
    }

    let mut block = Vec::new();
    let mut idx = end;
    while idx > 0 {
        let current = lines[idx - 1].trim();
        block.push(current.to_string());
        if current.starts_with("/*") {
            block.reverse();
            let cleaned = block
                .into_iter()
                .map(clean_block_line)
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string();
            if cleaned.is_empty() {
                return None;
            }
            return Some(cleaned);
        }
        idx -= 1;
    }

    None
}

fn clean_block_line(line: String) -> String {
    let trimmed = line.trim();
    let without_open = trimmed.strip_prefix("/*").unwrap_or(trimmed);
    let without_close = without_open.strip_suffix("*/").unwrap_or(without_open);
    let without_star = without_close.strip_prefix('*').unwrap_or(without_close);
    without_star.trim().to_string()
}
