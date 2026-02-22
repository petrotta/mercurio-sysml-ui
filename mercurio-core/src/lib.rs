mod files;
pub use files::{
    get_ast_for_content, get_ast_for_path, get_parse_errors, get_parse_errors_for_content,
    get_parse_tree_for_content,
    resolve_under_root,
    read_diagram, write_diagram, DiagramFile, DiagramNode, DiagramOffset, DiagramSize, DiagramType,
    ParseErrorView, ParseErrorsPayload, ParseTreeNodeView,
};

mod project;
pub use project::{
    create_project_descriptor, ensure_project_descriptor,
    get_project_descriptor_view, load_project_config, load_project_descriptor, LibraryConfig,
    ProjectConfig, ProjectDescriptor, ProjectDescriptorUpdate, ProjectDescriptorView,
    update_project_descriptor, write_project_descriptor,
};

mod workspace;
mod index_contract;
mod symbol_properties;

mod compile;
pub use compile::{
    cancel_compile, compile_project_delta_sync, compile_workspace_sync, load_library_symbols_sync,
    query_semantic_symbols,
    CompileFileResult, CompileProgressPayload, CompileRequest, CompileResponse,
    LibrarySymbolsRequest, LibrarySymbolsResponse,
    ParseErrorCategoryView,
    PropertyItemView, PropertyValueView, RelationshipView, SymbolView, TypeRefPartView,
    TypeRefView, UnresolvedRefView, UnsavedFile, UnsavedFileInput,
};

mod settings;
pub use settings::{
    ensure_mercurio_paths, load_app_settings, resolve_mercurio_user_dir, resolve_user_local_dir,
    save_app_settings, AppSettings, MercurioPaths,
};

mod state;
pub use state::CoreState;

mod stdlib;
pub use stdlib::{
    get_stdlib_metamodel, list_stdlib_versions_from_root, MetamodelAttributeView,
    MetamodelModifiersView, MetamodelTypeView, StdlibMetamodelView,
};

mod project_model;
mod project_model_seed;
mod project_model_transform;
pub use project_model::{
    get_project_element_attributes, get_project_model, ProjectElementAttributesView,
    ProjectElementInheritedAttributeView, ProjectModelAttributeView, ProjectModelElementView,
    ProjectModelView,
};

mod symbol_index;
pub use symbol_index::{
    query_library_summary, query_library_symbols, query_project_symbols, query_stdlib_documentation_symbols,
    query_symbol_metatype_mapping, query_symbols_by_metatype, IndexedSymbolView,
    LibraryIndexSummaryView, SymbolMetatypeMappingView,
};

pub use workspace::query_semantic;
pub use mercurio_sysml_semantics::semantic_contract::{
    SemanticElementView, SemanticPredicate, SemanticQuery,
};

mod export;
pub use export::export_model_to_path;

