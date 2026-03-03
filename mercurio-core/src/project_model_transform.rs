use mercurio_symbol_index::{SymbolIndexStore, SymbolRecord};
use mercurio_sysml_pkg::project_model_projection::metatype_from_symbol_properties;

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
            metatype = metatype_from_symbol_properties(
                &symbol.qualified_name,
                symbol.properties_json.as_deref(),
            );
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
        .or_else(|| {
            metatype_from_symbol_properties(&symbol.qualified_name, symbol.properties_json.as_deref())
        });
    let diagnostics = if symbol.metatype_qname.is_none() && metatype.is_some() {
        vec!["Metatype sourced from semantic properties.".to_string()]
    } else {
        Vec::new()
    };
    (metatype, diagnostics)
}
