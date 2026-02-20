use serde_json::Value as JsonValue;

use mercurio_sysml_semantics::semantic_project_model_contract::ProjectModelAttributeView;

pub fn parse_symbol_properties_json(
    symbol_qualified_name: &str,
    raw: &str,
) -> Option<Vec<ProjectModelAttributeView>> {
    let parsed: JsonValue = serde_json::from_str(raw).ok()?;
    let arr = if let Some(arr) = parsed.as_array() {
        arr
    } else {
        let schema = parsed.get("schema").and_then(|v| v.as_u64()).unwrap_or(0);
        if schema != 1 {
            return None;
        }
        parsed.get("properties")?.as_array()?
    };
    let mut out = Vec::new();
    for entry in arr {
        let name = entry.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        let value_text = entry.get("value").and_then(property_value_to_text);
        out.push(ProjectModelAttributeView {
            name: name.to_string(),
            qualified_name: format!("{}::{}", symbol_qualified_name, name),
            declared_type: None,
            multiplicity: None,
            direction: None,
            documentation: None,
            cst_value: value_text,
            metamodel_attribute_qname: None,
            diagnostics: Vec::new(),
        });
    }
    Some(out)
}

pub fn property_value_to_text(value: &JsonValue) -> Option<String> {
    let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "text" => value
            .get("value")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        "bool" => value
            .get("value")
            .and_then(|v| v.as_bool())
            .map(|v| if v { "true".to_string() } else { "false".to_string() }),
        "number" => value.get("value").and_then(|v| {
            v.as_u64()
                .map(|n| n.to_string())
                .or_else(|| v.as_i64().map(|n| n.to_string()))
        }),
        "list" => value.get("items").and_then(|v| v.as_array()).map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|v| v.to_string()))
                .collect::<Vec<_>>()
                .join(", ")
        }),
        _ => None,
    }
}
