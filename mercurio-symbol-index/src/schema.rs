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

pub const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_init", MIGRATION_0001_INIT),
    ("0002_stdlib_meta", MIGRATION_0002_STDLIB_META),
];
