pub const MIGRATION_0001_INIT: &str = r#"
CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  library_key TEXT,
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  metatype_qname TEXT,
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  start_col INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_col INTEGER NOT NULL,
  doc_text TEXT
);

CREATE INDEX IF NOT EXISTS idx_symbols_project_scope
  ON symbols(project_root, scope);
    
CREATE INDEX IF NOT EXISTS idx_symbols_metatype
  ON symbols(project_root, metatype_qname);

CREATE INDEX IF NOT EXISTS idx_symbols_kind
  ON symbols(project_root, kind);
"#;

pub const MIGRATION_0002_STDLIB_META: &str = r#"
CREATE TABLE IF NOT EXISTS stdlib_index_meta (
  project_root TEXT NOT NULL,
  library_key TEXT NOT NULL,
  signature TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_root, library_key)
);
"#;

pub const MIGRATION_0003_SYMBOL_MAPPINGS: &str = r#"
CREATE TABLE IF NOT EXISTS symbol_mappings (
  project_root TEXT NOT NULL,
  symbol_id TEXT NOT NULL,
  symbol_file_path TEXT NOT NULL,
  symbol_qualified_name TEXT NOT NULL,
  symbol_kind TEXT NOT NULL,
  resolved_metatype_qname TEXT,
  target_symbol_id TEXT,
  mapping_source TEXT NOT NULL,
  confidence REAL NOT NULL,
  diagnostic TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_root, symbol_id)
);

CREATE INDEX IF NOT EXISTS idx_symbol_mappings_lookup
  ON symbol_mappings(project_root, symbol_qualified_name, symbol_file_path);

CREATE INDEX IF NOT EXISTS idx_symbol_mappings_metatype
  ON symbol_mappings(project_root, resolved_metatype_qname);
"#;

pub const MIGRATION_0004_SYMBOL_PROPERTIES: &str = r#"
ALTER TABLE symbols ADD COLUMN properties_json TEXT;
"#;

pub const MIGRATION_0005_PROJECT_QNAME_INDEX: &str = r#"
CREATE INDEX IF NOT EXISTS idx_symbols_project_qname
  ON symbols(project_root, scope, qualified_name, file_path);
"#;

pub const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_init", MIGRATION_0001_INIT),
    ("0002_stdlib_meta", MIGRATION_0002_STDLIB_META),
    ("0003_symbol_mappings", MIGRATION_0003_SYMBOL_MAPPINGS),
    ("0004_symbol_properties", MIGRATION_0004_SYMBOL_PROPERTIES),
    ("0005_project_qname_index", MIGRATION_0005_PROJECT_QNAME_INDEX),
];
