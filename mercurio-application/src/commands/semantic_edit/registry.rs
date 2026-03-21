use serde_json::Value;

use super::actions;
use super::context::{
    normalized_kind, target_direct_type_candidates, target_type_candidates, SemanticEditContext,
};
use super::types::{
    SemanticEditActionView, SemanticEditAppliesToView, SemanticEditApplyResult,
    SemanticEditPreviewResult,
    SemanticEditTargetPayload,
};

pub type SemanticEditHandler<T> = fn(&SemanticEditContext, Value) -> Result<T, String>;

pub struct SemanticEditActionDefinition {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub applies_to: &'static [SemanticEditAppliesTo],
    pub availability: SemanticEditAvailability,
    pub fields: &'static [super::types::SemanticEditFieldView],
    pub preview: SemanticEditHandler<SemanticEditPreviewResult>,
    pub apply: SemanticEditHandler<SemanticEditApplyResult>,
}

#[derive(Clone, Copy)]
pub struct SemanticEditAppliesTo {
    pub type_name: &'static str,
    pub include_subtypes: bool,
}

#[derive(Clone, Copy)]
pub struct SemanticEditAvailability {
    pub allow_library_symbols: bool,
    pub require_name: bool,
    pub require_qualified_name: bool,
    pub require_file_path: bool,
}

pub const DEFAULT_AVAILABILITY: SemanticEditAvailability = SemanticEditAvailability {
    allow_library_symbols: false,
    require_name: true,
    require_qualified_name: true,
    require_file_path: true,
};

impl SemanticEditActionDefinition {
    pub fn to_view(&self) -> SemanticEditActionView {
        SemanticEditActionView {
            id: self.id,
            label: self.label,
            description: self.description,
            applies_to: self
                .applies_to
                .iter()
                .map(|entry| SemanticEditAppliesToView {
                    type_name: entry.type_name,
                    include_subtypes: entry.include_subtypes,
                })
                .collect(),
            fields: self.fields.to_vec(),
        }
    }

    pub fn is_available_for(&self, target: &SemanticEditTargetPayload) -> bool {
        if !self.availability.allow_library_symbols
            && target
            .source_scope
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("library"))
        {
            return false;
        }
        if self.availability.require_name && target.name.trim().is_empty() {
            return false;
        }
        if self.availability.require_qualified_name && target.qualified_name.trim().is_empty() {
            return false;
        }
        if self.availability.require_file_path && target.file_path.trim().is_empty() {
            return false;
        }
        self.applies_to
            .iter()
            .any(|entry| {
                let target_candidates = if entry.include_subtypes {
                    target_type_candidates(target)
                } else {
                    target_direct_type_candidates(target)
                };
                target_matches_type(target_candidates.as_slice(), entry)
            })
    }
}

pub fn list_actions(target: &SemanticEditTargetPayload) -> Vec<SemanticEditActionView> {
    actions()
        .iter()
        .copied()
        .filter(|action| action.is_available_for(target))
        .map(SemanticEditActionDefinition::to_view)
        .collect()
}

pub fn find_action(action_id: &str) -> Option<&'static SemanticEditActionDefinition> {
    actions()
        .iter()
        .copied()
        .find(|action| action.id.eq_ignore_ascii_case(action_id.trim()))
}

fn actions() -> [&'static SemanticEditActionDefinition; 7] {
    [
        actions::add_part_definition::definition(),
        actions::add_part_usage::definition(),
        actions::add_attribute::definition(),
        actions::move_symbol_to_package::definition(),
        actions::rename_symbol::definition(),
        actions::set_part_primitive::definition(),
        actions::set_part_type::definition(),
    ]
}

fn target_matches_type(target_candidates: &[String], applies_to: &SemanticEditAppliesTo) -> bool {
    if applies_to.type_name.trim() == "*" {
        return true;
    }
    let expected_aliases = type_aliases(applies_to.type_name);
    if expected_aliases.is_empty() {
        return false;
    }
    target_candidates.iter().any(|candidate| {
        expected_aliases
            .iter()
            .any(|expected| candidate.eq_ignore_ascii_case(expected))
    })
}

fn type_aliases(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let push_unique = |items: &mut Vec<String>, candidate: String| {
        if !candidate.is_empty() && !items.iter().any(|existing| existing == &candidate) {
            items.push(candidate);
        }
    };
    push_unique(&mut out, trimmed.to_ascii_lowercase());
    push_unique(&mut out, normalized_kind(trimmed));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(kind: &str, metatype_qname: Option<&str>) -> SemanticEditTargetPayload {
        SemanticEditTargetPayload {
            symbol_id: None,
            qualified_name: "Model::Element".to_string(),
            name: "Element".to_string(),
            kind: kind.to_string(),
            metatype_qname: metatype_qname.map(|value| value.to_string()),
            metatype_lineage: None,
            metatype_supertypes: None,
            file_path: "C:\\model.sysml".to_string(),
            parent_qualified_name: None,
            start_line: Some(1),
            start_col: Some(1),
            end_line: Some(1),
            end_col: Some(2),
            short_name_start_line: None,
            short_name_start_col: None,
            short_name_end_line: None,
            short_name_end_col: None,
            source_scope: Some("project".to_string()),
        }
    }

    #[test]
    fn package_actions_match_exact_package_kind() {
        let actions = list_actions(&target("Package", None));
        assert!(actions.iter().any(|action| action.id == "package.add_part_definition"));
        assert!(actions.iter().any(|action| action.id == "package.add_part_usage"));
    }

    #[test]
    fn include_subtypes_matches_suffix_based_metatype() {
        let mut target = target("Definition", Some("Example::CustomPackage"));
        target.metatype_lineage = Some(vec![
            "Example::CustomPackage".to_string(),
            "Package".to_string(),
            "Namespace".to_string(),
        ]);
        let actions = list_actions(&target);
        assert!(actions.iter().any(|action| action.id == "package.add_part_definition"));
    }

    #[test]
    fn wildcard_actions_match_any_project_symbol() {
        let actions = list_actions(&target("PartDefinition", Some("SysML::PartDefinition")));
        assert!(actions.iter().any(|action| action.id == "element.rename"));
    }
}
