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
    type_name: "PartDefinition",
    include_subtypes: true,
}];
const FIELDS: &[SemanticEditFieldView] = &[SemanticEditFieldView {
    key: "is_primitive",
    label: "Primitive",
    field_type: SemanticEditFieldType::Checkbox,
    required: true,
    placeholder: None,
    description: Some("Sets the selected part definition's `isPrimitive` attribute."),
    default_text: None,
    default_bool: Some(true),
    options: &[],
}];

#[derive(Deserialize)]
struct Input {
    is_primitive: bool,
}

fn handle_preview(
    ctx: &SemanticEditContext,
    input: Value,
) -> Result<SemanticEditPreviewResult, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let part_def_name = ctx.target_name()?;
    let tx = TypedOps::tx().op(TypedOps::part_def(part_def_name).set_is_primitive(input.is_primitive));
    preview_tx(ctx, ACTION.id, ACTION.label, tx)
}

fn handle_apply(
    ctx: &SemanticEditContext,
    input: Value,
) -> Result<SemanticEditApplyResult, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let part_def_name = ctx.target_name()?;
    let tx = TypedOps::tx().op(TypedOps::part_def(part_def_name).set_is_primitive(input.is_primitive));
    apply_tx(ctx, ACTION.id, ACTION.label, tx)
}

const ACTION: SemanticEditActionDefinition = SemanticEditActionDefinition {
    id: "part_definition.set_primitive",
    label: "Set Primitive",
    description: "Set the selected part definition's primitive flag.",
    applies_to: APPLIES_TO,
    availability: DEFAULT_AVAILABILITY,
    fields: FIELDS,
    preview: handle_preview as SemanticEditHandler<SemanticEditPreviewResult>,
    apply: handle_apply as SemanticEditHandler<SemanticEditApplyResult>,
};

pub fn definition() -> &'static SemanticEditActionDefinition {
    &ACTION
}
