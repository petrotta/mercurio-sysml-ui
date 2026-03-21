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
    key: "attribute_text",
    label: "Attribute",
    field_type: SemanticEditFieldType::Textarea,
    required: true,
    placeholder: Some("attribute mass: Real;"),
    description: Some("Adds an attribute statement to the selected part definition."),
    default_text: None,
    default_bool: None,
    options: &[],
}];

#[derive(Deserialize)]
struct Input {
    attribute_text: String,
}

fn handle_preview(
    ctx: &SemanticEditContext,
    input: Value,
) -> Result<SemanticEditPreviewResult, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let part_def_name = ctx.target_name()?;
    let attribute_text = input.attribute_text.trim();
    if attribute_text.is_empty() {
        return Err("Attribute text is required.".to_string());
    }
    let tx = TypedOps::tx().op(TypedOps::part_def(part_def_name).add_attribute(attribute_text));
    preview_tx(ctx, ACTION.id, ACTION.label, tx)
}

fn handle_apply(
    ctx: &SemanticEditContext,
    input: Value,
) -> Result<SemanticEditApplyResult, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let part_def_name = ctx.target_name()?;
    let attribute_text = input.attribute_text.trim();
    if attribute_text.is_empty() {
        return Err("Attribute text is required.".to_string());
    }
    let tx = TypedOps::tx().op(TypedOps::part_def(part_def_name).add_attribute(attribute_text));
    apply_tx(ctx, ACTION.id, ACTION.label, tx)
}

const ACTION: SemanticEditActionDefinition = SemanticEditActionDefinition {
    id: "part_definition.add_attribute",
    label: "Add Attribute",
    description: "Add an attribute statement to the selected part definition.",
    applies_to: APPLIES_TO,
    availability: DEFAULT_AVAILABILITY,
    fields: FIELDS,
    preview: handle_preview as SemanticEditHandler<SemanticEditPreviewResult>,
    apply: handle_apply as SemanticEditHandler<SemanticEditApplyResult>,
};

pub fn definition() -> &'static SemanticEditActionDefinition {
    &ACTION
}
