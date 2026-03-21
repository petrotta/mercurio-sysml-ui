use serde::Deserialize;
use serde_json::Value;

use super::super::context::SemanticEditContext;
use super::super::preview::{apply_text_update, preview_text_update};
use super::super::registry::{
    SemanticEditActionDefinition, SemanticEditAppliesTo, SemanticEditHandler,
    DEFAULT_AVAILABILITY,
};
use super::super::types::{
    SemanticEditApplyResult, SemanticEditFieldOptionView, SemanticEditFieldType,
    SemanticEditFieldView, SemanticEditPreviewResult,
};

const NO_OPTIONS: &[SemanticEditFieldOptionView] = &[];
const APPLIES_TO: &[SemanticEditAppliesTo] = &[SemanticEditAppliesTo {
    type_name: "Package",
    include_subtypes: true,
}];
const FIELDS: &[SemanticEditFieldView] = &[
    SemanticEditFieldView {
        key: "source_qualified_name",
        label: "Source Element",
        field_type: SemanticEditFieldType::Readonly,
        required: true,
        placeholder: None,
        description: Some("The semantic element being moved."),
        default_text: None,
        default_bool: None,
        options: NO_OPTIONS,
    },
    SemanticEditFieldView {
        key: "source_kind",
        label: "Source Kind",
        field_type: SemanticEditFieldType::Readonly,
        required: true,
        placeholder: None,
        description: Some("The current metatype/kind of the dragged element."),
        default_text: None,
        default_bool: None,
        options: NO_OPTIONS,
    },
    SemanticEditFieldView {
        key: "source_file_path",
        label: "Source File",
        field_type: SemanticEditFieldType::Readonly,
        required: true,
        placeholder: None,
        description: Some("Same-file moves are supported in this action."),
        default_text: None,
        default_bool: None,
        options: NO_OPTIONS,
    },
];

#[derive(Deserialize)]
struct Input {
    source_symbol_id: Option<String>,
    source_qualified_name: String,
    source_name: String,
    source_kind: String,
    source_file_path: String,
    source_parent_qualified_name: Option<String>,
    source_start_line: u32,
    source_start_col: Option<u32>,
    source_end_line: u32,
    source_end_col: Option<u32>,
}

fn handle_preview(
    ctx: &SemanticEditContext,
    input: Value,
) -> Result<SemanticEditPreviewResult, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let updated_text = move_symbol_text(ctx, &input)?;
    preview_text_update(ctx, ACTION.id, ACTION.label, updated_text, 0)
}

fn handle_apply(
    ctx: &SemanticEditContext,
    input: Value,
) -> Result<SemanticEditApplyResult, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let updated_text = move_symbol_text(ctx, &input)?;
    apply_text_update(ctx, ACTION.id, ACTION.label, updated_text, 0)
}

fn move_symbol_text(ctx: &SemanticEditContext, input: &Input) -> Result<String, String> {
    let _ = input.source_symbol_id.as_deref();
    let _ = input.source_start_col;
    let _ = input.source_end_col;
    let source_qname = input.source_qualified_name.trim();
    let source_kind = input.source_kind.trim();
    let source_name = input.source_name.trim();
    if source_qname.is_empty() {
        return Err("Dragged element qualified name is required.".to_string());
    }
    if source_name.is_empty() {
        return Err("Dragged element name is required.".to_string());
    }
    if source_kind.is_empty() {
        return Err("Dragged element kind is required.".to_string());
    }
    if input.source_file_path.trim().is_empty() {
        return Err("Dragged element file path is required.".to_string());
    }
    if normalize_path(input.source_file_path.as_str()) != normalize_path(&ctx.target.file_path) {
        return Err("Drag/drop moves are currently limited to the same file.".to_string());
    }
    let target_qname = ctx.target.qualified_name.trim();
    if target_qname.is_empty() {
        return Err("Destination package qualified name is required.".to_string());
    }
    if source_qname == target_qname {
        return Err("Cannot move an element into itself.".to_string());
    }
    if let Some(parent_qname) = input.source_parent_qualified_name.as_deref() {
        if parent_qname.trim() == target_qname {
            return Err("Element is already owned by the destination package.".to_string());
        }
    }
    if target_qname.starts_with(&format!("{source_qname}::")) {
        return Err("Cannot move an element into one of its descendants.".to_string());
    }
    if input.source_start_line == 0 || input.source_end_line == 0 {
        return Err("Dragged element line spans must be 1-based.".to_string());
    }
    if input.source_end_line < input.source_start_line {
        return Err("Dragged element end line must be after start line.".to_string());
    }
    let (target_start_line, target_end_line) = ctx.line_span()?;
    let source_start_line = input.source_start_line as usize;
    let source_end_line = input.source_end_line as usize;
    if source_start_line <= target_end_line && target_start_line <= source_end_line {
        return Err("Cannot move an element into a package span that overlaps the source text.".to_string());
    }

    let source_range = whole_line_range(&ctx.current_text, source_start_line, source_end_line)?;
    let source_block = ctx
        .current_text
        .get(source_range.clone())
        .ok_or_else(|| "Unable to locate the dragged element text in the current file.".to_string())?;
    if source_block.trim().is_empty() {
        return Err("Dragged element text is empty.".to_string());
    }

    let removed_line_count = source_end_line.saturating_sub(source_start_line) + 1;
    let target_insert_line = if source_start_line < target_end_line {
        target_end_line.saturating_sub(removed_line_count)
    } else {
        target_end_line
    };

    let mut without_source = String::with_capacity(ctx.current_text.len().saturating_sub(source_range.len()));
    without_source.push_str(&ctx.current_text[..source_range.start]);
    without_source.push_str(&ctx.current_text[source_range.end..]);

    let target_indent = target_body_indent(&without_source, target_insert_line)?;
    let moved_block = reindent_block(source_block, target_indent.as_str());
    let insert_offset = line_start_offset(&without_source, target_insert_line)?;

    let mut updated = String::with_capacity(without_source.len() + moved_block.len() + 1);
    updated.push_str(&without_source[..insert_offset]);
    updated.push_str(&moved_block);
    updated.push_str(&without_source[insert_offset..]);
    Ok(updated)
}

fn whole_line_range(text: &str, start_line: usize, end_line: usize) -> Result<std::ops::Range<usize>, String> {
    let start = line_start_offset(text, start_line)?;
    let end = line_start_offset(text, end_line + 1).unwrap_or(text.len());
    if end < start {
        return Err("Computed an invalid source range while moving the element.".to_string());
    }
    Ok(start..end)
}

fn line_start_offset(text: &str, line_number: usize) -> Result<usize, String> {
    if line_number == 0 {
        return Err("Line numbers must be 1-based.".to_string());
    }
    if line_number == 1 {
        return Ok(0);
    }
    let mut current_line = 1usize;
    for (index, ch) in text.char_indices() {
        if ch == '\n' {
            current_line += 1;
            if current_line == line_number {
                return Ok(index + 1);
            }
        }
    }
    if line_number == current_line + 1 {
        return Ok(text.len());
    }
    Err(format!("Line {line_number} is outside the current file."))
}

fn line_text<'a>(text: &'a str, line_number: usize) -> Result<&'a str, String> {
    let start = line_start_offset(text, line_number)?;
    let end = line_start_offset(text, line_number + 1).unwrap_or(text.len());
    text.get(start..end)
        .ok_or_else(|| format!("Unable to read line {line_number}."))
        .map(|value| value.trim_end_matches('\n').trim_end_matches('\r'))
}

fn target_body_indent(text: &str, closing_line: usize) -> Result<String, String> {
    let closing = line_text(text, closing_line)?;
    Ok(format!("{}  ", leading_whitespace(closing)))
}

fn leading_whitespace(value: &str) -> &str {
    let width = value
        .char_indices()
        .find_map(|(index, ch)| (!ch.is_whitespace()).then_some(index))
        .unwrap_or(value.len());
    &value[..width]
}

fn reindent_block(block: &str, target_indent: &str) -> String {
    let mut lines = block
        .lines()
        .map(|line| line.trim_end_matches('\r'))
        .collect::<Vec<_>>();
    while lines.first().is_some_and(|line| line.trim().is_empty()) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    let min_indent = lines
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|line| leading_whitespace(line).chars().count())
        .min()
        .unwrap_or(0);
    let mut out = String::new();
    for line in lines {
        if line.trim().is_empty() {
            out.push('\n');
            continue;
        }
        let trimmed = strip_leading_chars(line, min_indent);
        out.push_str(target_indent);
        out.push_str(trimmed);
        out.push('\n');
    }
    out
}

fn strip_leading_chars(value: &str, count: usize) -> &str {
    let mut remaining = count;
    let mut start = 0usize;
    for (index, ch) in value.char_indices() {
        if remaining == 0 {
            start = index;
            break;
        }
        if !ch.is_whitespace() {
            start = index;
            break;
        }
        remaining -= 1;
        start = index + ch.len_utf8();
    }
    &value[start..]
}

fn normalize_path(value: &str) -> String {
    value.trim().replace('\\', "/").to_ascii_lowercase()
}

const ACTION: SemanticEditActionDefinition = SemanticEditActionDefinition {
    id: "package.move_symbol_here",
    label: "Move Here",
    description: "Move a dragged semantic element into the selected package.",
    applies_to: APPLIES_TO,
    availability: DEFAULT_AVAILABILITY,
    fields: FIELDS,
    preview: handle_preview as SemanticEditHandler<SemanticEditPreviewResult>,
    apply: handle_apply as SemanticEditHandler<SemanticEditApplyResult>,
};

pub fn definition() -> &'static SemanticEditActionDefinition {
    &ACTION
}

#[cfg(test)]
mod tests {
    use super::*;
    use mercurio_sysml_pkg::typed_ops::TxConflictPolicy;

    fn context(current_text: &str) -> SemanticEditContext {
        SemanticEditContext {
            root: "C:\\project".into(),
            target: super::super::super::types::SemanticEditTargetPayload {
                symbol_id: None,
                qualified_name: "Root::B".to_string(),
                name: "B".to_string(),
                kind: "Package".to_string(),
                metatype_qname: Some("sysml::Package".to_string()),
                metatype_lineage: Some(vec!["sysml::Package".to_string()]),
                metatype_supertypes: Some(vec!["sysml::Namespace".to_string()]),
                file_path: "C:\\project\\model.sysml".to_string(),
                parent_qualified_name: Some("Root".to_string()),
                start_line: Some(4),
                start_col: Some(1),
                end_line: Some(6),
                end_col: Some(2),
                short_name_start_line: None,
                short_name_start_col: None,
                short_name_end_line: None,
                short_name_end_col: None,
                source_scope: Some("project".to_string()),
            },
            current_text: current_text.to_string(),
            conflict_policy: TxConflictPolicy::Abort,
        }
    }

    #[test]
    fn move_symbol_text_rehomes_block_before_destination_closing_brace() {
        let current_text = "package Root {\n  package A {\n    part def Wheel;\n  }\n  package B {\n  }\n}\n";
        let updated = move_symbol_text(
            &context(current_text),
            &Input {
                source_symbol_id: None,
                source_qualified_name: "Root::A::Wheel".to_string(),
                source_name: "Wheel".to_string(),
                source_kind: "PartDefinition".to_string(),
                source_file_path: "C:\\project\\model.sysml".to_string(),
                source_parent_qualified_name: Some("Root::A".to_string()),
                source_start_line: 3,
                source_start_col: Some(5),
                source_end_line: 3,
                source_end_col: Some(20),
            },
        )
        .expect("move should succeed");
        assert!(updated.contains("package A {\n  }\n  package B {\n    part def Wheel;\n  }\n"));
        assert!(!updated.contains("package A {\n    part def Wheel;\n  }\n"));
    }
}
