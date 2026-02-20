use mercurio_symbol_index::{Scope, SymbolRecord};

pub const CANONICAL_SYMBOL_ID_VERSION: &str = "v2";

pub struct CanonicalSymbolRecordArgs<'a> {
    pub scope: Scope,
    pub name: &'a str,
    pub qualified_name: &'a str,
    pub kind: &'a str,
    pub metatype_qname: Option<&'a str>,
    pub file_path: &'a str,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub doc_text: Option<&'a str>,
    pub properties_json: Option<&'a str>,
}

pub fn canonical_symbol_id(
    project_root: &str,
    scope: Scope,
    normalized_file_key: &str,
    qualified_name: &str,
    kind: &str,
    start_line: u32,
    start_col: u32,
    end_line: u32,
    end_col: u32,
) -> String {
    let scope_text = match scope {
        Scope::Stdlib => "stdlib",
        Scope::Project => "project",
    };
    format!(
        "{CANONICAL_SYMBOL_ID_VERSION}|{project_root}|{scope_text}|{normalized_file_key}|{qualified_name}|{kind}|{start_line}|{start_col}|{end_line}|{end_col}"
    )
}

pub fn canonical_symbol_record(
    project_root: &str,
    normalized_file_key: &str,
    library_key: Option<&str>,
    args: CanonicalSymbolRecordArgs<'_>,
) -> SymbolRecord {
    SymbolRecord {
        id: canonical_symbol_id(
            project_root,
            args.scope,
            normalized_file_key,
            args.qualified_name,
            args.kind,
            args.start_line,
            args.start_col,
            args.end_line,
            args.end_col,
        ),
        project_root: project_root.to_string(),
        library_key: if args.scope == Scope::Stdlib {
            library_key.map(|value| value.to_string())
        } else {
            None
        },
        scope: args.scope,
        name: args.name.to_string(),
        qualified_name: args.qualified_name.to_string(),
        kind: args.kind.to_string(),
        metatype_qname: args.metatype_qname.map(|value| value.to_string()),
        file_path: args.file_path.to_string(),
        start_line: args.start_line,
        start_col: args.start_col,
        end_line: args.end_line,
        end_col: args.end_col,
        doc_text: args.doc_text.map(|value| value.to_string()),
        properties_json: args.properties_json.map(|value| value.to_string()),
    }
}
