mod actions;
mod context;
mod preview;
mod registry;
mod types;

use std::path::PathBuf;

use tauri::command;

use context::{parse_conflict_policy, SemanticEditContext};
use registry::{find_action, list_actions};
pub use types::{
    ApplySemanticEditPayload, ListSemanticEditActionsPayload, PreviewSemanticEditPayload,
    SemanticEditActionView, SemanticEditApplyResult, SemanticEditPreviewResult,
};

#[command]
pub fn list_semantic_edit_actions(
    payload: ListSemanticEditActionsPayload,
) -> Result<Vec<SemanticEditActionView>, String> {
    Ok(list_actions(&payload.target))
}

#[command]
pub fn preview_semantic_edit(
    payload: PreviewSemanticEditPayload,
) -> Result<SemanticEditPreviewResult, String> {
    let action = find_action(&payload.action_id)
        .ok_or_else(|| format!("Unknown semantic edit action '{}'.", payload.action_id))?;
    if !action.is_available_for(&payload.target) {
        return Err(format!(
            "Action '{}' is unavailable for target kind '{}'.",
            action.label, payload.target.kind
        ));
    }
    let ctx = build_context(
        payload.root,
        payload.target,
        payload.current_text,
        payload.conflict_policy.as_deref(),
    )?;
    (action.preview)(&ctx, payload.input)
}

#[command]
pub fn apply_semantic_edit(
    payload: ApplySemanticEditPayload,
) -> Result<SemanticEditApplyResult, String> {
    let action = find_action(&payload.action_id)
        .ok_or_else(|| format!("Unknown semantic edit action '{}'.", payload.action_id))?;
    if !action.is_available_for(&payload.target) {
        return Err(format!(
            "Action '{}' is unavailable for target kind '{}'.",
            action.label, payload.target.kind
        ));
    }
    let ctx = build_context(
        payload.root,
        payload.target,
        payload.current_text,
        payload.conflict_policy.as_deref(),
    )?;
    (action.apply)(&ctx, payload.input)
}

fn build_context(
    root: String,
    target: types::SemanticEditTargetPayload,
    current_text: String,
    conflict_policy: Option<&str>,
) -> Result<SemanticEditContext, String> {
    let root = PathBuf::from(root.trim());
    if root.as_os_str().is_empty() {
        return Err("Project root is required.".to_string());
    }
    if target.file_path.trim().is_empty() {
        return Err("Target file path is required.".to_string());
    }
    let ctx = SemanticEditContext {
        root,
        target,
        current_text,
        conflict_policy: parse_conflict_policy(conflict_policy),
    };
    ctx.ensure_project_scope()?;
    Ok(ctx)
}
