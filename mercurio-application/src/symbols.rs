use crate::types::{
    PropertyDescriptor, PropertyItemView, PropertyValueView, RelationshipView, SymbolView,
    TypeRefPartView, TypeRefView,
};
use std::path::Path;
use syster::hir::{HirRelationship, HirSymbol, SymbolKind, TypeRef, TypeRefKind};

pub fn symbol_to_view(symbol: HirSymbol, file_path: &Path) -> SymbolView {
    let kind_label = symbol_kind_label(symbol.kind);
    let properties = build_properties(&symbol, file_path, &kind_label);
    SymbolView {
        file_path: file_path.to_string_lossy().to_string(),
        name: symbol.name.as_ref().to_string(),
        short_name: symbol.short_name.as_ref().map(|s| s.to_string()),
        qualified_name: symbol.qualified_name.as_ref().to_string(),
        kind: kind_label,
        file: symbol.file.into(),
        start_line: symbol.start_line,
        start_col: symbol.start_col,
        end_line: symbol.end_line,
        end_col: symbol.end_col,
        short_name_start_line: symbol.short_name_start_line,
        short_name_start_col: symbol.short_name_start_col,
        short_name_end_line: symbol.short_name_end_line,
        short_name_end_col: symbol.short_name_end_col,
        doc: symbol.doc.as_ref().map(|s| s.to_string()),
        supertypes: symbol
            .supertypes
            .into_iter()
            .map(|s| s.to_string())
            .collect(),
        relationships: symbol
            .relationships
            .into_iter()
            .map(relationship_to_view)
            .collect(),
        type_refs: symbol
            .type_refs
            .into_iter()
            .map(type_ref_to_view)
            .collect(),
        is_public: symbol.is_public,
        properties,
    }
}

fn relationship_to_view(rel: HirRelationship) -> RelationshipView {
    RelationshipView {
        kind: rel.kind.display().to_string(),
        target: rel.target.as_ref().to_string(),
        resolved_target: rel.resolved_target.as_ref().map(|s| s.to_string()),
        start_line: rel.start_line,
        start_col: rel.start_col,
        end_line: rel.end_line,
        end_col: rel.end_col,
    }
}

fn type_ref_to_view(type_ref: TypeRefKind) -> TypeRefView {
    match type_ref {
        TypeRefKind::Simple(r) => TypeRefView::Simple {
            part: type_ref_part_view(r),
        },
        TypeRefKind::Chain(chain) => TypeRefView::Chain {
            parts: chain.parts.into_iter().map(type_ref_part_view).collect(),
        },
    }
}

fn type_ref_part_view(type_ref: TypeRef) -> TypeRefPartView {
    TypeRefPartView {
        kind: type_ref.kind.display().to_string(),
        target: type_ref.target.as_ref().to_string(),
        resolved_target: type_ref.resolved_target.as_ref().map(|s| s.to_string()),
        start_line: type_ref.start_line,
        start_col: type_ref.start_col,
        end_line: type_ref.end_line,
        end_col: type_ref.end_col,
    }
}

const BASE_PROPERTY_DESCRIPTORS: &[PropertyDescriptor] = &[
    PropertyDescriptor {
        name: "name",
        label: "Name",
        hint: None,
        group: None,
        getter: prop_name,
    },
    PropertyDescriptor {
        name: "short_name",
        label: "Short name",
        hint: None,
        group: None,
        getter: prop_short_name,
    },
    PropertyDescriptor {
        name: "qualified_name",
        label: "Qualified name",
        hint: Some("qualified"),
        group: None,
        getter: prop_qualified_name,
    },
    PropertyDescriptor {
        name: "kind",
        label: "Kind",
        hint: None,
        group: None,
        getter: prop_kind,
    },
    PropertyDescriptor {
        name: "file_path",
        label: "File path",
        hint: Some("path"),
        group: None,
        getter: prop_file_path,
    },
    PropertyDescriptor {
        name: "public",
        label: "Public",
        hint: None,
        group: None,
        getter: prop_public,
    },
    PropertyDescriptor {
        name: "doc",
        label: "Doc",
        hint: Some("doc"),
        group: None,
        getter: prop_doc,
    },
    PropertyDescriptor {
        name: "supertypes",
        label: "Supertypes",
        hint: Some("list"),
        group: None,
        getter: prop_supertypes,
    },
    PropertyDescriptor {
        name: "relationships",
        label: "Relationships",
        hint: Some("list"),
        group: None,
        getter: prop_relationships,
    },
    PropertyDescriptor {
        name: "type_refs",
        label: "Type refs",
        hint: Some("list"),
        group: None,
        getter: prop_type_refs,
    },
];

const PARSE_PROPERTY_DESCRIPTORS: &[PropertyDescriptor] = &[
    PropertyDescriptor {
        name: "file_id",
        label: "File id",
        hint: None,
        group: Some("parse"),
        getter: prop_file_id,
    },
    PropertyDescriptor {
        name: "start_line",
        label: "Start line",
        hint: None,
        group: Some("parse"),
        getter: prop_start_line,
    },
    PropertyDescriptor {
        name: "start_col",
        label: "Start column",
        hint: None,
        group: Some("parse"),
        getter: prop_start_col,
    },
    PropertyDescriptor {
        name: "end_line",
        label: "End line",
        hint: None,
        group: Some("parse"),
        getter: prop_end_line,
    },
    PropertyDescriptor {
        name: "end_col",
        label: "End column",
        hint: None,
        group: Some("parse"),
        getter: prop_end_col,
    },
];

fn property_descriptors_for_kind(kind_label: &str) -> Vec<&'static PropertyDescriptor> {
    let mut descriptors: Vec<&'static PropertyDescriptor> = Vec::new();
    descriptors.extend(BASE_PROPERTY_DESCRIPTORS);
    descriptors.extend(PARSE_PROPERTY_DESCRIPTORS);
    let _kind = kind_label.to_lowercase();
    descriptors
}

fn build_properties(
    symbol: &HirSymbol,
    file_path: &Path,
    kind_label: &str,
) -> Vec<PropertyItemView> {
    property_descriptors_for_kind(kind_label)
        .into_iter()
        .map(|descriptor| PropertyItemView {
            name: descriptor.name.to_string(),
            label: descriptor.label.to_string(),
            value: (descriptor.getter)(symbol, file_path),
            hint: descriptor.hint.map(|hint| hint.to_string()),
            group: descriptor.group.map(|group| group.to_string()),
        })
        .collect()
}

fn prop_name(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Text {
        value: symbol.name.as_ref().to_string(),
    }
}

fn prop_short_name(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Text {
        value: symbol
            .short_name
            .as_ref()
            .map(|s| s.to_string())
            .unwrap_or_default(),
    }
}

fn prop_qualified_name(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Text {
        value: symbol.qualified_name.as_ref().to_string(),
    }
}

fn prop_kind(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Text {
        value: symbol_kind_label(symbol.kind),
    }
}

fn prop_file_path(_symbol: &HirSymbol, file_path: &Path) -> PropertyValueView {
    PropertyValueView::Text {
        value: file_path.to_string_lossy().to_string(),
    }
}

fn prop_public(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Bool {
        value: symbol.is_public,
    }
}

fn prop_doc(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Text {
        value: symbol.doc.as_ref().map(|s| s.to_string()).unwrap_or_default(),
    }
}

fn prop_supertypes(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::List {
        items: symbol.supertypes.iter().map(|s| s.to_string()).collect(),
    }
}

fn prop_relationships(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    let items = symbol
        .relationships
        .iter()
        .map(|rel| {
            let target = rel
                .resolved_target
                .as_ref()
                .unwrap_or(&rel.target)
                .as_ref()
                .to_string();
            format!("{} -> {}", rel.kind.display(), target)
        })
        .collect::<Vec<_>>();
    PropertyValueView::List { items }
}

fn prop_type_refs(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    let items = symbol
        .type_refs
        .iter()
        .filter_map(type_ref_display_target)
        .collect::<Vec<_>>();
    PropertyValueView::List { items }
}

fn prop_file_id(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    let file_id: u32 = symbol.file.into();
    PropertyValueView::Number {
        value: file_id as u64,
    }
}

fn prop_start_line(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Number {
        value: symbol.start_line as u64 + 1,
    }
}

fn prop_start_col(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Number {
        value: symbol.start_col as u64 + 1,
    }
}

fn prop_end_line(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Number {
        value: symbol.end_line as u64 + 1,
    }
}

fn prop_end_col(symbol: &HirSymbol, _file_path: &Path) -> PropertyValueView {
    PropertyValueView::Number {
        value: symbol.end_col as u64 + 1,
    }
}

fn type_ref_display_target(type_ref: &TypeRefKind) -> Option<String> {
    match type_ref {
        TypeRefKind::Simple(part) => Some(
            part.resolved_target
                .as_ref()
                .unwrap_or(&part.target)
                .as_ref()
                .to_string(),
        ),
        TypeRefKind::Chain(chain) => chain.parts.last().map(|part| {
            part.resolved_target
                .as_ref()
                .unwrap_or(&part.target)
                .as_ref()
                .to_string()
        }),
    }
}

fn symbol_kind_label(kind: SymbolKind) -> String {
    kind.display().to_string()
}
