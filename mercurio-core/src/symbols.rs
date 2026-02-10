use std::collections::HashMap;
use std::path::PathBuf;

use mercurio_model as walk;
use syster::base::{LineCol, LineIndex, TextSize};
use syster::hir::SymbolKind;
use syster::parser::Direction;
use syster::syntax::normalized::Multiplicity;
use syster::parser::ast::Usage;
use syster::parser::AstNode;
use syster::syntax::SyntaxFile;
use syster::parser::{SyntaxKind, SyntaxNode};

use crate::compile::{PropertyItemView, PropertyValueView, SymbolView};

#[derive(Clone)]
pub(crate) struct ExprSpan {
    name: String,
    name_start_line: u32,
    name_start_col: u32,
    expr_start_line: u32,
    expr_start_col: u32,
    expr_end_line: u32,
    expr_end_col: u32,
}

pub(crate) fn collect_expr_spans(files: &HashMap<PathBuf, SyntaxFile>) -> HashMap<String, Vec<ExprSpan>> {
    let mut result: HashMap<String, Vec<ExprSpan>> = HashMap::new();
    for (path, syntax_file) in files {
        let line_index = syntax_file.line_index();
        let mut spans = Vec::new();
        let root = syntax_file.parse().syntax();
        for usage in root.descendants().filter_map(Usage::cast) {
            let Some(name) = usage.name() else { continue };
            let Some(name_text) = name.text() else { continue };
            let Some(expr) = usage.value_expression() else { continue };
            let name_range = name.syntax().text_range();
            let expr_range = expr.syntax().text_range();
            let name_start = line_index.line_col(name_range.start());
            let expr_start = line_index.line_col(expr_range.start());
            let expr_end = line_index.line_col(expr_range.end());
            spans.push(ExprSpan {
                name: name_text,
                name_start_line: name_start.line,
                name_start_col: name_start.col,
                expr_start_line: expr_start.line,
                expr_start_col: expr_start.col,
                expr_end_line: expr_end.line,
                expr_end_col: expr_end.col,
            });
        }
        result.insert(path.to_string_lossy().to_string(), spans);
    }
    result
}

pub(crate) fn build_symbols_from_walk(
    files: &HashMap<PathBuf, SyntaxFile>,
    expr_spans_by_file: &HashMap<String, Vec<ExprSpan>>,
) -> Vec<SymbolView> {
    if files.is_empty() {
        return Vec::new();
    }
    let mut walk_db = walk::Db::default();
    let mut file_paths: Vec<PathBuf> = files.keys().cloned().collect();
    file_paths.sort();

    let mut file_texts = Vec::new();
    let mut file_paths_input = Vec::new();
    let mut file_inputs: Vec<(PathBuf, walk::FileId, walk::FileText, walk::FilePath)> = Vec::new();
    let mut next_id: u32 = 1;

    for path in &file_paths {
        let Some(syntax) = files.get(path) else { continue };
        let file_id = walk::FileId(next_id);
        next_id += 1;
        let text = syntax.source_text();
        let path_str = path.to_string_lossy().to_string();
        let file_text = walk::FileText::new(&mut walk_db, file_id, text);
        let file_path = walk::FilePath::new(&mut walk_db, file_id, path_str);
        file_texts.push(file_text);
        file_paths_input.push(file_path);
        file_inputs.push((path.clone(), file_id, file_text, file_path));
    }

    let ws_files = walk::WorkspaceFiles::new(&mut walk_db, walk::WorkspaceId(1), file_texts, file_paths_input);
    let _workspace_index = walk::workspace_index(&walk_db, ws_files);

    let mut symbols: Vec<SymbolView> = Vec::new();
    for (path, file_id, file_text, file_path) in file_inputs {
        let text = file_text.text(&walk_db);
        let line_index = LineIndex::new(text);
        let file_index = walk::file_index(&walk_db, file_text, file_path);
        let mut attr_by_id: HashMap<walk::ElementId, walk::AttrInfo> = HashMap::new();
        for attr in &file_index.attrs {
            attr_by_id.insert(attr.element, attr.clone());
        }
        let mut owned_attr_infos: HashMap<walk::ElementId, Vec<walk::AttrInfo>> = HashMap::new();
        for (owner, attrs) in &file_index.owned_attrs {
            let bucket = owned_attr_infos.entry(*owner).or_default();
            for attr_id in attrs {
                if let Some(info) = attr_by_id.get(attr_id) {
                    bucket.push(info.clone());
                }
            }
        }
        let path_str = path.to_string_lossy().to_string();
        let expr_spans = expr_spans_by_file.get(&path_str);
        for element in &file_index.elements {
            let type_info = file_index.types.iter().find(|info| info.element == element.id);
            let owned_attrs = owned_attr_infos.get(&element.id).cloned().unwrap_or_default();
            symbols.push(symbol_to_view_walk(
                element,
                file_id,
                &path_str,
                &line_index,
                expr_spans,
                type_info,
                &owned_attrs,
            ));
        }
    }

    symbols.sort_by(|a, b| match a.file_path.cmp(&b.file_path) {
        std::cmp::Ordering::Equal => a.qualified_name.cmp(&b.qualified_name),
        other => other,
    });
    symbols
}

pub(crate) fn build_usage_views(files: &HashMap<PathBuf, SyntaxFile>) -> Vec<SymbolView> {
    let mut usages: Vec<SymbolView> = Vec::new();
    for (path, syntax_file) in files {
        let line_index = syntax_file.line_index();
        let root = syntax_file.parse().syntax();
        let path_str = path.to_string_lossy().to_string();
        let source_text = syntax_file.source_text();
        for usage in root.descendants().filter_map(Usage::cast) {
            let is_nested = usage
                .syntax()
                .ancestors()
                .skip(1)
                .any(|ancestor| Usage::cast(ancestor).is_some());
            if is_nested {
                continue;
            }
            let range = usage.syntax().text_range();
            let start = line_index.line_col(range.start());
            let end = line_index.line_col(range.end());
            let kind_raw = format!("{:?}", usage.syntax().kind());
            let kind_label = if kind_raw.starts_with("SyntaxKind(") {
                "usage".to_string()
            } else {
                kind_raw.replace("_USAGE", "").replace('_', " ").to_lowercase()
            };
            let name_text = usage
                .name()
                .and_then(|name| name.text())
                .unwrap_or_else(|| kind_label.clone());
            let parent_chain = build_parent_chain(usage.syntax());
            let qualified_name = if parent_chain.is_empty() {
                name_text.clone()
            } else {
                format!("{}::{}", parent_chain.join("::"), name_text)
            };
            let typing = find_descendant_text(&source_text, usage.syntax(), "TYPING")
                .and_then(|value| trim_prefix(value, ":"));
            let target = find_descendant_text(&source_text, usage.syntax(), "SPECIALIZATION")
                .and_then(|value| trim_prefix(value, ":>"));
            let multiplicity = find_descendant_text(&source_text, usage.syntax(), "MULTIPLICITY");
            let modifiers = collect_usage_modifiers(usage.syntax());
            let span = format!(
                "L{}:{}-L{}:{}",
                start.line + 1,
                start.col + 1,
                end.line + 1,
                end.col + 1
            );
            let mut usage_properties: Vec<PropertyItemView> = Vec::new();
            if let Some(value) = typing.as_deref() {
                if !value.is_empty() {
                    usage_properties.push(PropertyItemView {
                        name: "usage_type".to_string(),
                        label: "Type".to_string(),
                        value: PropertyValueView::Text {
                            value: value.to_string(),
                        },
                        hint: Some("usage".to_string()),
                        group: None,
                    });
                }
            }
            if let Some(value) = target.as_deref() {
                if !value.is_empty() {
                    usage_properties.push(PropertyItemView {
                        name: "usage_target".to_string(),
                        label: "Target".to_string(),
                        value: PropertyValueView::Text {
                            value: value.to_string(),
                        },
                        hint: Some("usage".to_string()),
                        group: None,
                    });
                }
            }
            if let Some(value) = multiplicity.as_deref() {
                if !value.is_empty() {
                    usage_properties.push(PropertyItemView {
                        name: "usage_multiplicity".to_string(),
                        label: "Multiplicity".to_string(),
                        value: PropertyValueView::Text {
                            value: value.to_string(),
                        },
                        hint: Some("usage".to_string()),
                        group: None,
                    });
                }
            }
            if !modifiers.is_empty() {
                usage_properties.push(PropertyItemView {
                    name: "usage_modifiers".to_string(),
                    label: "Modifiers".to_string(),
                    value: PropertyValueView::List {
                        items: modifiers,
                    },
                    hint: Some("usage".to_string()),
                    group: None,
                });
            }
            usage_properties.push(PropertyItemView {
                name: "usage_span".to_string(),
                label: "Span".to_string(),
                value: PropertyValueView::Text { value: span },
                hint: Some("usage".to_string()),
                group: None,
            });
            usages.push(SymbolView {
                file_path: path_str.clone(),
                name: name_text.clone(),
                short_name: None,
                qualified_name,
                kind: kind_label,
                file: 0,
                start_line: start.line,
                start_col: start.col,
                end_line: end.line,
                end_col: end.col,
                expr_start_line: None,
                expr_start_col: None,
                expr_end_line: None,
                expr_end_col: None,
                short_name_start_line: None,
                short_name_start_col: None,
                short_name_end_line: None,
                short_name_end_col: None,
                doc: None,
                supertypes: Vec::new(),
                relationships: Vec::new(),
                type_refs: Vec::new(),
                is_public: false,
                properties: usage_properties,
            });
        }
    }
    usages
}

fn find_descendant_text(source: &str, node: &SyntaxNode, kind_name: &str) -> Option<String> {
    for descendant in node.descendants() {
        if format!("{:?}", descendant.kind()) == kind_name {
            return text_for_node(source, &descendant);
        }
    }
    None
}

fn text_for_node(source: &str, node: &SyntaxNode) -> Option<String> {
    let range = node.text_range();
    let start = u32::from(range.start()) as usize;
    let end = u32::from(range.end()) as usize;
    source.get(start..end).map(|value| value.trim().to_string())
}

fn trim_prefix(value: String, prefix: &str) -> Option<String> {
    let trimmed = value.trim();
    if let Some(rest) = trimmed.strip_prefix(prefix) {
        Some(rest.trim().to_string())
    } else {
        Some(trimmed.to_string())
    }
}

fn collect_usage_modifiers(node: &SyntaxNode) -> Vec<String> {
    let allowed = [
        "in",
        "out",
        "inout",
        "readonly",
        "variation",
        "derived",
        "parallel",
        "abstract",
        "public",
        "private",
    ];
    let mut mods = Vec::new();
    for child in node.descendants_with_tokens() {
        if let Some(token) = child.as_token() {
            let text = token.text().to_lowercase();
            if allowed.contains(&text.as_str()) && !mods.contains(&text) {
                mods.push(text);
            }
        }
    }
    mods
}

fn build_parent_chain(node: &SyntaxNode) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for ancestor in node.ancestors().skip(1) {
        if let Some(name) = extract_name(&ancestor) {
            names.push(name);
        }
    }
    names.reverse();
    names
}

fn extract_name(node: &SyntaxNode) -> Option<String> {
    for child in node.children() {
        if child.kind() == SyntaxKind::NAME {
            if let Some(value) = extract_ident(&child) {
                return Some(value);
            }
        }
    }
    None
}

fn extract_ident(node: &SyntaxNode) -> Option<String> {
    for child in node.children_with_tokens() {
        if let Some(token) = child.as_token() {
            if token.kind() == SyntaxKind::IDENT {
                return Some(token.text().to_string());
            }
        } else if let Some(n) = child.as_node() {
            if let Some(found) = extract_ident(&n) {
                return Some(found);
            }
        }
    }
    None
}

fn symbol_to_view_walk(
    element: &walk::ElementInfo,
    file_id: walk::FileId,
    file_path: &str,
    line_index: &LineIndex,
    expr_spans: Option<&Vec<ExprSpan>>,
    type_info: Option<&walk::TypeInfo>,
    owned_attrs: &[walk::AttrInfo],
) -> SymbolView {
    let kind_label = symbol_kind_label(element.kind);
    let start = line_col_from_offset(line_index, element.span.start);
    let end = line_col_from_offset(line_index, element.span.end);
    let name_start = line_col_from_offset(line_index, element.name_span.start);
    let expr_span = expr_spans.and_then(|spans| find_expr_span_for_element(element, &name_start, spans));
    let properties = build_properties_from_walk(element, file_path, type_info, owned_attrs, &kind_label);
    SymbolView {
        file_path: file_path.to_string(),
        name: element.name.clone(),
        short_name: None,
        qualified_name: element.qualified_name.clone(),
        kind: kind_label,
        file: file_id.0,
        start_line: start.line,
        start_col: start.col,
        end_line: end.line,
        end_col: end.col,
        expr_start_line: expr_span.map(|span| span.expr_start_line),
        expr_start_col: expr_span.map(|span| span.expr_start_col),
        expr_end_line: expr_span.map(|span| span.expr_end_line),
        expr_end_col: expr_span.map(|span| span.expr_end_col),
        short_name_start_line: None,
        short_name_start_col: None,
        short_name_end_line: None,
        short_name_end_col: None,
        doc: None,
        supertypes: type_info
            .map(|info| info.supertypes.clone())
            .unwrap_or_default(),
        relationships: Vec::new(),
        type_refs: Vec::new(),
        is_public: false,
        properties,
    }
}

fn build_properties_from_walk(
    element: &walk::ElementInfo,
    file_path: &str,
    type_info: Option<&walk::TypeInfo>,
    owned_attrs: &[walk::AttrInfo],
    kind_label: &str,
) -> Vec<PropertyItemView> {
    let mut props = Vec::new();
    props.push(PropertyItemView {
        name: "name".to_string(),
        label: "Name".to_string(),
        value: PropertyValueView::Text {
            value: element.name.clone(),
        },
        hint: None,
        group: None,
    });
    props.push(PropertyItemView {
        name: "qualified_name".to_string(),
        label: "Qualified name".to_string(),
        value: PropertyValueView::Text {
            value: element.qualified_name.clone(),
        },
        hint: Some("qualified".to_string()),
        group: None,
    });
    props.push(PropertyItemView {
        name: "kind".to_string(),
        label: "Kind".to_string(),
        value: PropertyValueView::Text {
            value: kind_label.to_string(),
        },
        hint: None,
        group: None,
    });
    props.push(PropertyItemView {
        name: "visibility".to_string(),
        label: "Visibility".to_string(),
        value: PropertyValueView::Text {
            value: if element.is_public { "public" } else { "private" }.to_string(),
        },
        hint: None,
        group: Some("modifiers".to_string()),
    });
    props.push(PropertyItemView {
        name: "is_abstract".to_string(),
        label: "Abstract".to_string(),
        value: PropertyValueView::Bool {
            value: element.is_abstract,
        },
        hint: None,
        group: Some("modifiers".to_string()),
    });
    props.push(PropertyItemView {
        name: "is_variation".to_string(),
        label: "Variation".to_string(),
        value: PropertyValueView::Bool {
            value: element.is_variation,
        },
        hint: None,
        group: Some("modifiers".to_string()),
    });
    props.push(PropertyItemView {
        name: "is_readonly".to_string(),
        label: "Readonly".to_string(),
        value: PropertyValueView::Bool {
            value: element.is_readonly,
        },
        hint: None,
        group: Some("modifiers".to_string()),
    });
    props.push(PropertyItemView {
        name: "is_derived".to_string(),
        label: "Derived".to_string(),
        value: PropertyValueView::Bool {
            value: element.is_derived,
        },
        hint: None,
        group: Some("modifiers".to_string()),
    });
    props.push(PropertyItemView {
        name: "is_parallel".to_string(),
        label: "Parallel".to_string(),
        value: PropertyValueView::Bool {
            value: element.is_parallel,
        },
        hint: None,
        group: Some("modifiers".to_string()),
    });
    if let Some(direction) = element.direction {
        props.push(PropertyItemView {
            name: "direction".to_string(),
            label: "Direction".to_string(),
            value: PropertyValueView::Text {
                value: format_direction(direction),
            },
            hint: None,
            group: Some("modifiers".to_string()),
        });
    }
    if let Some(mult) = element.multiplicity {
        if let Some(value) = format_multiplicity(mult) {
            props.push(PropertyItemView {
                name: "multiplicity".to_string(),
                label: "Multiplicity".to_string(),
                value: PropertyValueView::Text { value },
                hint: None,
                group: Some("modifiers".to_string()),
            });
        }
    }
    if let Some(type_name) = element.declared_type.as_ref() {
        if !type_name.is_empty() {
            props.push(PropertyItemView {
                name: "type".to_string(),
                label: "Type".to_string(),
                value: PropertyValueView::Text {
                    value: type_name.clone(),
                },
                hint: None,
                group: None,
            });
        }
    }
    props.push(PropertyItemView {
        name: "file_path".to_string(),
        label: "File path".to_string(),
        value: PropertyValueView::Text {
            value: file_path.to_string(),
        },
        hint: Some("path".to_string()),
        group: None,
    });
    if let Some(info) = type_info {
        if !info.supertypes.is_empty() {
            props.push(PropertyItemView {
                name: "supertypes".to_string(),
                label: "Supertypes".to_string(),
                value: PropertyValueView::List {
                    items: info.supertypes.clone(),
                },
                hint: Some("list".to_string()),
                group: None,
            });
        }
    }
    if !owned_attrs.is_empty() {
        let items = owned_attrs
            .iter()
            .map(|attr| {
                let mut label = attr.name.clone();
                if let Some(declared) = attr.declared_type.as_ref() {
                    if !declared.is_empty() {
                        label.push_str(": ");
                        label.push_str(declared);
                    }
                }
                if attr.qualified_name != attr.name {
                    label.push_str(" [");
                    label.push_str(&attr.qualified_name);
                    label.push(']');
                }
                label
            })
            .collect();
        props.push(PropertyItemView {
            name: "owned_attributes".to_string(),
            label: "Owned attributes".to_string(),
            value: PropertyValueView::List { items },
            hint: Some("list".to_string()),
            group: None,
        });
    }
    props
}

fn format_direction(direction: Direction) -> String {
    match direction {
        Direction::In => "in".to_string(),
        Direction::Out => "out".to_string(),
        Direction::InOut => "inout".to_string(),
    }
}

fn format_multiplicity(mult: Multiplicity) -> Option<String> {
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
    let lo = lower.map(|v| v.to_string()).unwrap_or_else(|| "*".to_string());
    let hi = upper.map(|v| v.to_string()).unwrap_or_else(|| "*".to_string());
    Some(format!("[{}..{}]", lo, hi))
}

fn line_col_from_offset(line_index: &LineIndex, offset: u32) -> LineCol {
    line_index.line_col(TextSize::from(offset))
}

fn find_expr_span_for_element<'a>(
    element: &walk::ElementInfo,
    name_start: &LineCol,
    spans: &'a [ExprSpan],
) -> Option<&'a ExprSpan> {
    spans
        .iter()
        .find(|span| {
            span.name == element.name
                && span.name_start_line == name_start.line
                && span.name_start_col == name_start.col
        })
        .or_else(|| spans.iter().find(|span| span.name == element.name && span.name_start_line == name_start.line))
}

fn symbol_kind_label(kind: SymbolKind) -> String {
    kind.display().to_string()
}
