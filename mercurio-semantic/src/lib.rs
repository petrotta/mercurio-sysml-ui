mod project_model;
mod semantic_index;

pub use project_model::{
    build_walk_workspace, collect_metamodel_attributes, extract_doc_comment,
    format_direction, format_multiplicity, resolve_package_metatype, resolve_project_metatype,
    resolve_type_ref, span_to_line_cols, type_names_match,
    ProjectElementAttributesView, ProjectElementInheritedAttributeView, ProjectModelAttributeView,
    ProjectModelElementView, ProjectModelView,
};

pub use semantic_index::{
    build_semantic_index, SemanticElementView, SemanticIndex, SemanticIndexInput, SemanticQuery,
    SemanticPredicate,
};
