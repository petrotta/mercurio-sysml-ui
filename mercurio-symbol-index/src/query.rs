pub fn query_symbols_by_metatype() -> &'static str {
    r#"
SELECT
  s.id,
  s.name,
  s.qualified_name,
  s.kind,
  s.metatype_qname,
  s.file_path,
  s.start_line,
  s.start_col,
  s.end_line,
  s.end_col
FROM symbols s
WHERE s.project_root = :project_root
  AND s.metatype_qname = :metatype_qname
ORDER BY s.file_path, s.start_line, s.start_col;
"#
}

pub fn query_symbols_by_metatype_with_subtypes() -> &'static str {
    r#"
SELECT DISTINCT
  s.id,
  s.name,
  s.qualified_name,
  s.kind,
  s.metatype_qname,
  s.file_path,
  s.start_line,
  s.start_col,
  s.end_line,
  s.end_col
FROM symbols s
JOIN metatype_closure mc
  ON mc.descendant_qname = s.metatype_qname
WHERE s.project_root = :project_root
  AND mc.ancestor_qname = :metatype_qname
ORDER BY s.file_path, s.start_line, s.start_col;
"#
}

pub fn query_documentation_symbols_for_stdlib() -> &'static str {
    r#"
SELECT
  s.id,
  s.name,
  s.qualified_name,
  s.file_path,
  s.start_line,
  s.start_col,
  s.end_line,
  s.end_col,
  s.doc_text
FROM symbols s
WHERE s.scope = 'stdlib'
  AND s.library_key = :library_key
  AND s.kind = 'Documentation'
ORDER BY s.file_path, s.start_line, s.start_col;
"#
}
