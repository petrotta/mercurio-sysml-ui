use mercurio_symbol_index::{SymbolIndexStore, SymbolRecord};
use mercurio_sysml_semantics::semantic_project_model_contract::ProjectModelAttributeView;

use crate::symbol_properties::parse_symbol_properties_json;

fn metatype_from_symbol_properties(symbol: &SymbolRecord) -> Option<String> {
    let attrs = symbol
        .properties_json
        .as_deref()
        .and_then(|raw| parse_symbol_properties_json(&symbol.qualified_name, raw))
        .unwrap_or_default();
    attrs
        .iter()
        .find(|attr| {
            let name = attr.name.to_ascii_lowercase();
            name == "metatype_qname" || name == "emf::metatype" || name == "element::metatype"
        })
        .and_then(|attr| attr.cst_value.clone())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn resolve_mapped_metatype(
    store: &dyn SymbolIndexStore,
    root: &str,
    symbol: &SymbolRecord,
) -> (Option<String>, Vec<String>) {
    let mapping = store
        .symbol_mapping(root, &symbol.qualified_name, Some(&symbol.file_path))
        .or_else(|| store.symbol_mapping(root, &symbol.qualified_name, None));
    if let Some(link) = mapping {
        let mut metatype = link
            .resolved_metatype_qname
            .clone()
            .or_else(|| symbol.metatype_qname.clone());
        let mut diagnostics = Vec::new();
        if metatype.is_none() {
            metatype = metatype_from_symbol_properties(symbol);
            if let Some(value) = metatype.as_ref() {
                diagnostics.push(format!(
                    "Metatype sourced from semantic properties: {}",
                    value
                ));
            }
        }
        if link.mapping_source != "exact" {
            diagnostics.push(format!(
                "Metatype mapping source={} confidence={:.2}",
                link.mapping_source, link.confidence
            ));
        }
        if let Some(detail) = link.diagnostic {
            diagnostics.push(detail);
        }
        return (metatype, diagnostics);
    }
    let metatype = symbol
        .metatype_qname
        .clone()
        .or_else(|| metatype_from_symbol_properties(symbol));
    let diagnostics = if symbol.metatype_qname.is_none() && metatype.is_some() {
        vec!["Metatype sourced from semantic properties.".to_string()]
    } else {
        Vec::new()
    };
    (metatype, diagnostics)
}

pub(crate) fn symbol_to_attribute_rows(
    symbol: &SymbolRecord,
    metatype_qname: Option<&str>,
) -> Vec<ProjectModelAttributeView> {
    let mut attrs = symbol
        .properties_json
        .as_deref()
        .and_then(|raw| parse_symbol_properties_json(&symbol.qualified_name, raw))
        .unwrap_or_default();
    if !attrs.iter().any(|attr| attr.name == "metatype_qname") {
        if let Some(metatype) = metatype_qname {
            attrs.push(ProjectModelAttributeView {
                name: "metatype_qname".to_string(),
                qualified_name: format!("{}::metatype_qname", symbol.qualified_name),
                declared_type: None,
                multiplicity: None,
                direction: None,
                documentation: None,
                cst_value: Some(metatype.to_string()),
                metamodel_attribute_qname: None,
                diagnostics: Vec::new(),
            });
        }
    }
    if attrs.is_empty() {
        attrs.push(ProjectModelAttributeView {
            name: "name".to_string(),
            qualified_name: format!("{}::name", symbol.qualified_name),
            declared_type: None,
            multiplicity: None,
            direction: None,
            documentation: None,
            cst_value: Some(symbol.name.clone()),
            metamodel_attribute_qname: None,
            diagnostics: Vec::new(),
        });
    }
    attrs
}
