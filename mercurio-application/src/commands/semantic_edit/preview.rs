use std::fs;

use mercurio_sysml_pkg::parser::Parser;
use mercurio_sysml_pkg::typed_ops::Tx;
use mercurio_sysml_pkg::workspace::Workspace;

use super::context::SemanticEditContext;
use super::types::{SemanticEditApplyResult, SemanticEditPreviewResult};

pub fn preview_tx(
    ctx: &SemanticEditContext,
    action_id: &str,
    action_label: &str,
    tx: Tx<'_>,
) -> Result<SemanticEditPreviewResult, String> {
    let preview = tx
        .preview_with_policy(&ctx.current_text, ctx.conflict_policy)
        .map_err(|error| format!("{error:?}"))?;
    preview_text_update(
        ctx,
        action_id,
        action_label,
        preview.updated_text,
        preview.skipped_ops,
    )
}

pub fn apply_tx(
    ctx: &SemanticEditContext,
    action_id: &str,
    action_label: &str,
    tx: Tx<'_>,
) -> Result<SemanticEditApplyResult, String> {
    let file_path = ctx.file_path();
    let mut workspace = Workspace::new();
    let updated_text = tx
        .apply_atomic_with_policy(
            &mut workspace,
            file_path.clone(),
            &ctx.current_text,
            ctx.conflict_policy,
        )
        .map_err(|error| format!("{error:?}"))?;
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&file_path, &updated_text).map_err(|error| error.to_string())?;
    let diagnostics = parse_diagnostics(&updated_text);
    Ok(SemanticEditApplyResult {
        action_id: action_id.to_string(),
        action_label: action_label.to_string(),
        changed: updated_text != ctx.current_text,
        diagnostics,
        updated_text,
        skipped_ops: 0,
        file_path: file_path.to_string_lossy().to_string(),
    })
}

pub fn preview_text_update(
    ctx: &SemanticEditContext,
    action_id: &str,
    action_label: &str,
    updated_text: String,
    skipped_ops: usize,
) -> Result<SemanticEditPreviewResult, String> {
    let changed = updated_text != ctx.current_text;
    let diff = unified_diff(&ctx.current_text, &updated_text);
    let diagnostics = parse_diagnostics(&updated_text);
    Ok(SemanticEditPreviewResult {
        action_id: action_id.to_string(),
        action_label: action_label.to_string(),
        changed,
        diff,
        updated_text,
        diagnostics,
        skipped_ops,
    })
}

pub fn apply_text_update(
    ctx: &SemanticEditContext,
    action_id: &str,
    action_label: &str,
    updated_text: String,
    skipped_ops: usize,
) -> Result<SemanticEditApplyResult, String> {
    let file_path = ctx.file_path();
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&file_path, &updated_text).map_err(|error| error.to_string())?;
    let diagnostics = parse_diagnostics(&updated_text);
    Ok(SemanticEditApplyResult {
        action_id: action_id.to_string(),
        action_label: action_label.to_string(),
        changed: updated_text != ctx.current_text,
        diagnostics,
        updated_text,
        skipped_ops,
        file_path: file_path.to_string_lossy().to_string(),
    })
}

fn parse_diagnostics(text: &str) -> Vec<String> {
    let mut parser = Parser::new(text);
    let _ = parser.parse_root();
    parser
        .errors()
        .iter()
        .take(5)
        .map(|error| error.message.clone())
        .collect()
}

fn unified_diff(before: &str, after: &str) -> String {
    if before == after {
        return String::new();
    }
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();

    let mut prefix = 0usize;
    while prefix < a.len() && prefix < b.len() && a[prefix] == b[prefix] {
        prefix += 1;
    }

    let mut suffix = 0usize;
    while suffix < a.len().saturating_sub(prefix)
        && suffix < b.len().saturating_sub(prefix)
        && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix]
    {
        suffix += 1;
    }

    let a_mid_end = a.len().saturating_sub(suffix);
    let b_mid_end = b.len().saturating_sub(suffix);
    let removed = &a[prefix..a_mid_end];
    let added = &b[prefix..b_mid_end];

    let mut out = String::new();
    out.push_str("--- before\n");
    out.push_str("+++ after\n");
    out.push_str(&format!(
        "@@ -{},{} +{},{} @@\n",
        prefix + 1,
        removed.len().max(1),
        prefix + 1,
        added.len().max(1)
    ));
    for line in removed {
        out.push('-');
        out.push_str(line);
        out.push('\n');
    }
    for line in added {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    out
}
