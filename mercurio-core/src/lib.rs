mod files;
pub use files::{
    get_ast_for_content, get_ast_for_path, get_parse_errors, get_parse_errors_for_content,
    get_parse_tree_for_content, read_diagram, resolve_under_root, write_diagram, DiagramFile,
    DiagramNode, DiagramOffset, DiagramSize, DiagramType, ParseErrorView, ParseErrorsPayload,
    ParseTreeNodeView,
};

mod project;
pub use project::{
    create_project_descriptor, ensure_project_descriptor, get_project_descriptor_view,
    load_project_config, load_project_descriptor, update_project_descriptor,
    write_project_descriptor, LibraryConfig, ProjectConfig, ProjectDescriptor,
    ProjectDescriptorUpdate, ProjectDescriptorView,
};

mod project_root_key;
mod workspace;
mod workspace_ir_cache;

mod compile;
pub use compile::{
    cancel_compile, compile_project_delta_sync, compile_project_delta_sync_with_options,
    compile_workspace_sync, load_library_symbols_sync, query_semantic_symbols, CompileFileResult,
    CompileProgressPayload, CompileRequest, CompileResponse, LibrarySymbolsRequest,
    LibrarySymbolsResponse, ParseErrorCategoryView, PropertyItemView, PropertyValueView,
    RelationshipView, SymbolView, TypeRefPartView, TypeRefView, UnresolvedRefView, UnsavedFile,
    UnsavedFileInput,
};

mod settings;
pub use settings::{
    ensure_mercurio_paths, load_app_settings, resolve_mercurio_user_dir, resolve_user_local_dir,
    save_app_settings, AppSettings, MercurioPaths, WindowBoundsSettings, WindowStateSettings,
};

mod state;
pub use state::{
    BackgroundCancelSummary, BackgroundJobView, BackgroundJobsSnapshot, CacheClearSummary,
    CoreState,
};

mod stdlib;
pub use stdlib::{
    get_stdlib_metamodel, list_stdlib_versions_from_root, MetamodelAttributeView,
    MetamodelModifiersView, MetamodelTypeView, StdlibMetamodelView,
};

mod project_model;
mod project_model_seed;
pub use project_model::{
    get_project_element_attributes, get_project_expression_records, get_project_model,
    ProjectElementAttributesView, ProjectElementInheritedAttributeView,
    ProjectExpressionRecordView, ProjectExpressionRecordsView, ProjectModelAttributeView,
    ProjectModelElementView, ProjectModelView,
};

mod symbol_index;
pub use symbol_index::{
    query_library_summary, query_library_symbols, query_project_semantic_projection_by_qualified_name,
    query_project_symbols, query_project_symbols_for_files, query_stdlib_documentation_symbols,
    query_symbol_metatype_mapping, query_symbols_by_metatype, IndexedSemanticElementView,
    IndexedSemanticProjectionElementView, IndexedSymbolView, LibraryIndexSummaryView,
    SymbolMetatypeMappingView,
};

pub use mercurio_sysml_semantics::semantic_contract::{
    SemanticElementProjectionView, SemanticElementView, SemanticFeatureView, SemanticPredicate,
    SemanticQuery, SemanticValueView,
};
pub use workspace::query_semantic;

mod export;
pub use export::export_model_to_path;
