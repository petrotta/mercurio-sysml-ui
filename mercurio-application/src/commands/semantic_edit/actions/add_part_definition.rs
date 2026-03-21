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
    type_name: "Package",
    include_subtypes: true,
}];
const FIELDS: &[SemanticEditFieldView] = &[SemanticEditFieldView {
    key: "part_name",
    label: "Part Definition Name",
    field_type: SemanticEditFieldType::Text,
    required: true,
    placeholder: Some("Vehicle"),
    description: Some("Adds a new `part def` declaration to the selected package."),
    default_text: None,
    default_bool: None,
    options: &[],
}];

#[derive(Deserialize)]
struct Input {
    part_name: String,
}

fn handle_preview(
    ctx: &SemanticEditContext,
    input: Value,
) -> Result<SemanticEditPreviewResult, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let package_name = ctx.target_name()?;
    let part_name = input.part_name.trim();
    if part_name.is_empty() {
        return Err("Part definition name is required.".to_string());
    }
    let tx = TypedOps::tx().op(TypedOps::package(package_name).add_part_def(part_name));
    preview_tx(ctx, ACTION.id, ACTION.label, tx)
}

fn handle_apply(
    ctx: &SemanticEditContext,
    input: Value,
) -> Result<SemanticEditApplyResult, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let package_name = ctx.target_name()?;
    let part_name = input.part_name.trim();
    if part_name.is_empty() {
        return Err("Part definition name is required.".to_string());
    }
    let tx = TypedOps::tx().op(TypedOps::package(package_name).add_part_def(part_name));
    apply_tx(ctx, ACTION.id, ACTION.label, tx)
}

const ACTION: SemanticEditActionDefinition = SemanticEditActionDefinition {
    id: "package.add_part_definition",
    label: "Add Part Definition",
    description: "Insert a new part definition into the selected package.",
    applies_to: APPLIES_TO,
    availability: DEFAULT_AVAILABILITY,
    fields: FIELDS,
    preview: handle_preview as SemanticEditHandler<SemanticEditPreviewResult>,
    apply: handle_apply as SemanticEditHandler<SemanticEditApplyResult>,
};

pub fn definition() -> &'static SemanticEditActionDefinition {
    &ACTION
}
