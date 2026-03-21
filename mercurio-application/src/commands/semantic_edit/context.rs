use std::path::PathBuf;

use mercurio_sysml_pkg::typed_ops::TxConflictPolicy;

use super::types::SemanticEditTargetPayload;

pub struct SemanticEditContext {
    pub root: PathBuf,
    pub target: SemanticEditTargetPayload,
    pub current_text: String,
    pub conflict_policy: TxConflictPolicy,
}

impl SemanticEditContext {
    pub fn file_path(&self) -> PathBuf {
        PathBuf::from(self.target.file_path.trim())
    }

    pub fn target_name(&self) -> Result<&str, String> {
        let name = self.target.name.trim();
        if name.is_empty() {
            return Err("Selected element name is required for this action.".to_string());
        }
        Ok(name)
    }

    pub fn ensure_project_scope(&self) -> Result<(), String> {
        if self
            .target
            .source_scope
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("library"))
        {
            return Err("Semantic edits are unavailable for library symbols.".to_string());
        }
        Ok(())
    }

    pub fn line_span(&self) -> Result<(usize, usize), String> {
        let start_line = self
            .target
            .start_line
            .ok_or_else(|| "Target start line is required for this action.".to_string())?;
        let end_line = self
            .target
            .end_line
            .ok_or_else(|| "Target end line is required for this action.".to_string())?;
        if start_line == 0 || end_line == 0 {
            return Err("Target line spans must be 1-based.".to_string());
        }
        if end_line < start_line {
            return Err("Target end line must be greater than or equal to start line.".to_string());
        }
        Ok((start_line as usize, end_line as usize))
    }

}

pub fn parse_conflict_policy(raw: Option<&str>) -> TxConflictPolicy {
    match raw.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "skip" => TxConflictPolicy::Skip,
        "rebind_then_skip" => TxConflictPolicy::RebindThenSkip,
        _ => TxConflictPolicy::Abort,
    }
}

pub fn normalized_kind(value: &str) -> String {
    value
        .trim()
        .rsplit("::")
        .next()
        .unwrap_or(value.trim())
        .to_ascii_lowercase()
}

pub fn target_type_candidates(target: &super::types::SemanticEditTargetPayload) -> Vec<String> {
    let mut out = Vec::new();
    let push_unique = |items: &mut Vec<String>, value: String| {
        if !value.is_empty() && !items.iter().any(|existing| existing == &value) {
            items.push(value);
        }
    };
    for candidate in target_direct_type_candidates(target) {
        push_unique(&mut out, candidate);
    }
    if let Some(lineage) = target.metatype_lineage.as_ref() {
        for candidate in lineage {
            push_unique(&mut out, candidate.trim().to_ascii_lowercase());
            push_unique(&mut out, normalized_kind(candidate));
        }
    }
    if let Some(supertypes) = target.metatype_supertypes.as_ref() {
        for candidate in supertypes {
            push_unique(&mut out, candidate.trim().to_ascii_lowercase());
            push_unique(&mut out, normalized_kind(candidate));
        }
    }
    out
}

pub fn target_direct_type_candidates(
    target: &super::types::SemanticEditTargetPayload,
) -> Vec<String> {
    let mut out = Vec::new();
    let push_unique = |items: &mut Vec<String>, value: String| {
        if !value.is_empty() && !items.iter().any(|existing| existing == &value) {
            items.push(value);
        }
    };
    push_unique(&mut out, normalized_kind(target.kind.as_str()));
    if let Some(metatype_qname) = target.metatype_qname.as_deref() {
        push_unique(&mut out, metatype_qname.trim().to_ascii_lowercase());
        push_unique(&mut out, normalized_kind(metatype_qname));
    }
    out
}
