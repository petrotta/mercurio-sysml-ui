use serde::Deserialize;
use serde_json::Value;

use super::super::context::SemanticEditContext;
use super::super::preview::{apply_text_update, preview_text_update};
use super::super::registry::{
    SemanticEditActionDefinition, SemanticEditAppliesTo, SemanticEditHandler,
    DEFAULT_AVAILABILITY,
};
use super::super::types::{
    SemanticEditApplyResult, SemanticEditFieldType, SemanticEditFieldView,
    SemanticEditPreviewResult,
};

const APPLIES_TO: &[SemanticEditAppliesTo] = &[SemanticEditAppliesTo {
    type_name: "*",
    include_subtypes: true,
}];
const FIELDS: &[SemanticEditFieldView] = &[SemanticEditFieldView {
    key: "new_name",
    label: "New Name",
    field_type: SemanticEditFieldType::Text,
    required: true,
    placeholder: Some("RenamedElement"),
    description: Some("Replaces the selected declaration name in the current file."),
    default_text: None,
    default_bool: None,
    options: &[],
}];

#[derive(Deserialize)]
struct Input {
    new_name: String,
}

fn handle_preview(
    ctx: &SemanticEditContext,
    input: Value,
) -> Result<SemanticEditPreviewResult, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let updated_text = rename_symbol_text(ctx, input.new_name.trim())?;
    preview_text_update(ctx, ACTION.id, ACTION.label, updated_text, 0)
}

fn handle_apply(
    ctx: &SemanticEditContext,
    input: Value,
) -> Result<SemanticEditApplyResult, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let updated_text = rename_symbol_text(ctx, input.new_name.trim())?;
    apply_text_update(ctx, ACTION.id, ACTION.label, updated_text, 0)
}

fn rename_symbol_text(ctx: &SemanticEditContext, new_name: &str) -> Result<String, String> {
    let current_name = ctx.target_name()?.trim();
    if new_name.is_empty() {
        return Err("A new name is required.".to_string());
    }
    if new_name.contains('\n') || new_name.contains('\r') {
        return Err("Rename values must be single-line.".to_string());
    }
    if new_name == current_name {
        return Ok(ctx.current_text.clone());
    }

    let name_range = match explicit_name_range(ctx, current_name)? {
        Some(range) => range,
        None => fallback_name_range(ctx, current_name)?,
    };
    if name_range.end <= name_range.start || name_range.end > ctx.current_text.len() {
        return Err("Computed an invalid rename span for the selected element.".to_string());
    }
    let existing = ctx
        .current_text
        .get(name_range.clone())
        .ok_or_else(|| "Unable to read the selected element name from the current file.".to_string())?;
    if existing.trim().is_empty() {
        return Err("The selected element name span is empty.".to_string());
    }

    let mut updated = String::with_capacity(
        ctx.current_text.len() + new_name.len().saturating_sub(existing.len()),
    );
    updated.push_str(&ctx.current_text[..name_range.start]);
    updated.push_str(new_name);
    updated.push_str(&ctx.current_text[name_range.end..]);
    Ok(updated)
}

fn explicit_name_range(
    ctx: &SemanticEditContext,
    current_name: &str,
) -> Result<Option<std::ops::Range<usize>>, String> {
    let Some(start_line) = ctx.target.short_name_start_line else {
        return Ok(None);
    };
    let Some(start_col) = ctx.target.short_name_start_col else {
        return Ok(None);
    };
    let start = byte_offset_for_position(&ctx.current_text, start_line as usize, start_col as usize)?;
    if let (Some(end_line), Some(end_col)) =
        (ctx.target.short_name_end_line, ctx.target.short_name_end_col)
    {
        let end = byte_offset_for_position(&ctx.current_text, end_line as usize, end_col as usize)?;
        if end > start {
            let slice = ctx.current_text.get(start..end).unwrap_or("");
            if slice == current_name {
                return Ok(Some(start..end));
            }
        }
    }
    let fallback_end = advance_chars(&ctx.current_text, start, current_name.chars().count())?;
    Ok(Some(start..fallback_end))
}

fn fallback_name_range(
    ctx: &SemanticEditContext,
    current_name: &str,
) -> Result<std::ops::Range<usize>, String> {
    let (start_line, end_line) = ctx.line_span()?;
    let scope_start = line_start_offset(&ctx.current_text, start_line)?;
    let scope_end = line_start_offset(&ctx.current_text, end_line + 1).unwrap_or(ctx.current_text.len());
    let scope = ctx
        .current_text
        .get(scope_start..scope_end)
        .ok_or_else(|| "Unable to read the selected declaration text.".to_string())?;
    let relative = scope
        .find(current_name)
        .ok_or_else(|| "Unable to locate the selected element name in its declaration span.".to_string())?;
    Ok((scope_start + relative)..(scope_start + relative + current_name.len()))
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

fn byte_offset_for_position(text: &str, line_number: usize, column_number: usize) -> Result<usize, String> {
    if column_number == 0 {
        return Err("Columns must be 1-based.".to_string());
    }
    let line_start = line_start_offset(text, line_number)?;
    let line_end = line_start_offset(text, line_number + 1).unwrap_or(text.len());
    let line_text = text
        .get(line_start..line_end)
        .ok_or_else(|| format!("Unable to read line {line_number}."))?;
    if column_number == 1 {
        return Ok(line_start);
    }
    let target_offset = column_number - 1;
    let char_count = line_text.chars().count();
    if target_offset > char_count {
        return Err(format!(
            "Column {column_number} is outside line {line_number}."
        ));
    }
    let mut seen = 0usize;
    for (index, _) in line_text.char_indices() {
        if seen == target_offset {
            return Ok(line_start + index);
        }
        seen += 1;
    }
    if seen == target_offset {
        return Ok(line_end);
    }
    Err(format!("Column {column_number} is outside line {line_number}."))
}

fn advance_chars(text: &str, start: usize, count: usize) -> Result<usize, String> {
    let slice = text
        .get(start..)
        .ok_or_else(|| "Invalid rename start offset.".to_string())?;
    if count == 0 {
        return Ok(start);
    }
    let mut seen = 0usize;
    for (index, ch) in slice.char_indices() {
        if ch == '\n' || ch == '\r' {
            return Err("Name span crossed a line boundary unexpectedly.".to_string());
        }
        seen += 1;
        if seen == count {
            return Ok(start + index + ch.len_utf8());
        }
    }
    Err("Selected name span ran past the end of the file.".to_string())
}

const ACTION: SemanticEditActionDefinition = SemanticEditActionDefinition {
    id: "element.rename",
    label: "Rename",
    description: "Rename the selected declaration in the current file.",
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

    fn context(text: &str) -> SemanticEditContext {
        SemanticEditContext {
            root: std::path::PathBuf::from("C:\\workspace"),
            target: crate::commands::semantic_edit::types::SemanticEditTargetPayload {
                symbol_id: None,
                qualified_name: "Example::Vehicle".to_string(),
                name: "Vehicle".to_string(),
                kind: "PartDefinition".to_string(),
                metatype_qname: Some("SysML::PartDefinition".to_string()),
                metatype_lineage: None,
                metatype_supertypes: None,
                file_path: "C:\\workspace\\model.sysml".to_string(),
                parent_qualified_name: Some("Example".to_string()),
                start_line: Some(2),
                start_col: Some(3),
                end_line: Some(2),
                end_col: Some(21),
                short_name_start_line: Some(2),
                short_name_start_col: Some(12),
                short_name_end_line: Some(2),
                short_name_end_col: Some(19),
                source_scope: Some("project".to_string()),
            },
            current_text: text.to_string(),
            conflict_policy: TxConflictPolicy::Abort,
        }
    }

    #[test]
    fn rename_uses_explicit_short_name_span() {
        let ctx = context("package Example {\n  part def Vehicle;\n}\n");
        let renamed = rename_symbol_text(&ctx, "Car").expect("rename to succeed");
        assert!(renamed.contains("part def Car;"));
        assert!(!renamed.contains("Vehicle;"));
    }

    #[test]
    fn rename_falls_back_to_declaration_search() {
        let mut ctx = context("package Example {\n  part def Vehicle;\n}\n");
        ctx.target.short_name_start_line = None;
        ctx.target.short_name_start_col = None;
        ctx.target.short_name_end_line = None;
        ctx.target.short_name_end_col = None;
        let renamed = rename_symbol_text(&ctx, "Truck").expect("fallback rename to succeed");
        assert!(renamed.contains("part def Truck;"));
    }
}
