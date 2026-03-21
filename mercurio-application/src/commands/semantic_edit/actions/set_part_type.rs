use serde::Deserialize;
use serde_json::Value;

use mercurio_sysml_pkg::typed_ops::TypedOps;

use super::super::context::SemanticEditContext;
use super::super::preview::{apply_tx, preview_tx};
use super::super::registry::{
    SemanticEditActionDefinition, SemanticEditAppliesTo, SemanticEditHandler,
    DEFAULT_AVAILABILITY,
};
use super::super::types::{
    SemanticEditApplyResult, SemanticEditFieldType, SemanticEditFieldView,
    SemanticEditPreviewResult,
};

const APPLIES_TO: &[SemanticEditAppliesTo] = &[SemanticEditAppliesTo {
    type_name: "PartUsage",
    include_subtypes: true,
}];
const FIELDS: &[SemanticEditFieldView] = &[SemanticEditFieldView {
    key: "type_name",
    label: "Type Name",
    field_type: SemanticEditFieldType::Text,
    required: true,
    placeholder: Some("Engine"),
    description: Some("Updates the selected part usage type."),
    default_text: None,
    default_bool: None,
    options: &[],
}];

#[derive(Deserialize)]
struct Input {
    type_name: String,
}

fn handle_preview(
    ctx: &SemanticEditContext,
    input: Value,
) -> Result<SemanticEditPreviewResult, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let part_usage_name = ctx.target_name()?;
    let type_name = input.type_name.trim();
    if type_name.is_empty() {
        return Err("Type name is required.".to_string());
    }
    let tx = TypedOps::tx().op(TypedOps::part(part_usage_name).set_type(type_name));
    preview_tx(ctx, ACTION.id, ACTION.label, tx)
}

fn handle_apply(
    ctx: &SemanticEditContext,
    input: Value,
) -> Result<SemanticEditApplyResult, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let part_usage_name = ctx.target_name()?;
    let type_name = input.type_name.trim();
    if type_name.is_empty() {
        return Err("Type name is required.".to_string());
    }
    let tx = TypedOps::tx().op(TypedOps::part(part_usage_name).set_type(type_name));
    apply_tx(ctx, ACTION.id, ACTION.label, tx)
}

const ACTION: SemanticEditActionDefinition = SemanticEditActionDefinition {
    id: "part_usage.set_type",
    label: "Change Type",
    description: "Update the selected part usage type reference.",
    applies_to: APPLIES_TO,
    availability: DEFAULT_AVAILABILITY,
    fields: FIELDS,
    preview: handle_preview as SemanticEditHandler<SemanticEditPreviewResult>,
    apply: handle_apply as SemanticEditHandler<SemanticEditApplyResult>,
};

pub fn definition() -> &'static SemanticEditActionDefinition {
    &ACTION
}
