use std::path::Path;

use rusqlite::{params, Connection};

use crate::mapping::{best_tail_candidate, collapse_metatype_qname, tail_name};
use crate::model::{Scope, SymbolMetatypeMappingRecord, SymbolRecord};
use crate::schema::MIGRATIONS;
use crate::store::SymbolIndexStore;

pub struct SqliteSymbolIndexStore {
    conn: Connection,
}

impl SqliteSymbolIndexStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        let mut this = Self { conn };
        this.migrate()?;
        Ok(this)
    }

    pub fn in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let mut this = Self { conn };
        this.migrate()?;
        Ok(this)
    }

    fn migrate(&mut self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS applied_migrations (
                   name TEXT PRIMARY KEY,
                   applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );",
            )
            .map_err(|e| e.to_string())?;
        for (name, sql) in MIGRATIONS {
            let already_applied = self
                .conn
                .query_row(
                    "SELECT 1 FROM applied_migrations WHERE name = ?1 LIMIT 1",
                    params![name],
                    |_| Ok(()),
                )
                .is_ok();
            if already_applied {
                continue;
            }
            if let Err(err) = self.conn.execute_batch(sql) {
                let text = err.to_string();
                let duplicate_column = *name == "0004_symbol_properties"
                    && text.to_ascii_lowercase().contains("duplicate column name");
                if !duplicate_column {
                    return Err(text);
                }
            }
            self.conn
                .execute(
                    "INSERT OR IGNORE INTO applied_migrations(name) VALUES (?1)",
                    params![name],
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn scope_to_str(scope: Scope) -> &'static str {
        match scope {
            Scope::Stdlib => "stdlib",
            Scope::Project => "project",
        }
    }

    fn scope_from_str(value: &str) -> Scope {
        if value.eq_ignore_ascii_case("stdlib") {
            Scope::Stdlib
        } else {
            Scope::Project
        }
    }

    fn resolve_stdlib_target_for_metatype(
        tx: &rusqlite::Transaction<'_>,
        project_root: &str,
        raw_metatype: &str,
    ) -> (Option<String>, Option<String>, String, f32, Option<String>) {
        let exact_target = tx
            .query_row(
                "SELECT id
                 FROM symbols
                 WHERE project_root = ?1 AND scope = 'stdlib' AND qualified_name = ?2
                 LIMIT 1",
                params![project_root, raw_metatype],
                |row| row.get::<_, String>(0),
            )
            .ok();
        if let Some(target) = exact_target {
            return (
                Some(raw_metatype.to_string()),
                Some(target),
                "exact".to_string(),
                1.0,
                None,
            );
        }

        if let Some(collapsed) = collapse_metatype_qname(raw_metatype) {
            let collapsed_target = tx
                .query_row(
                    "SELECT id
                     FROM symbols
                     WHERE project_root = ?1 AND scope = 'stdlib' AND qualified_name = ?2
                     LIMIT 1",
                    params![project_root, collapsed],
                    |row| row.get::<_, String>(0),
                )
                .ok();
            if let Some(target) = collapsed_target {
                return (
                    Some(collapsed),
                    Some(target),
                    "collapsed".to_string(),
                    0.9,
                    Some(format!("Mapped from metatype_qname '{raw_metatype}'.")),
                );
            }
        }

        let tail = tail_name(raw_metatype);
        let mut stmt = match tx.prepare(
            "SELECT id, qualified_name
             FROM symbols
             WHERE project_root = ?1 AND scope = 'stdlib' AND qualified_name LIKE ?2
             ORDER BY qualified_name",
        ) {
            Ok(value) => value,
            Err(_) => {
                return (
                    Some(raw_metatype.to_string()),
                    None,
                    "unresolved".to_string(),
                    0.0,
                    Some(format!("No stdlib symbol found for metatype '{raw_metatype}'.")),
                )
            }
        };
        let like_pattern = format!("%::{}", tail);
        let candidates = stmt
            .query_map(params![project_root, like_pattern], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .ok()
            .map(|iter| iter.filter_map(|item| item.ok()).collect::<Vec<_>>())
            .unwrap_or_default();
        if candidates.len() == 1 {
            let (target_id, qname) = candidates[0].clone();
            return (
                Some(qname),
                Some(target_id),
                "tail_unique".to_string(),
                0.7,
                Some(format!("Mapped by unique tail '{tail}' from '{raw_metatype}'.")),
            );
        }
        if candidates.len() > 1 {
            let names = candidates.iter().map(|(_, qname)| qname.clone()).collect::<Vec<_>>();
            if let Some(best) = best_tail_candidate(raw_metatype, &names) {
                let target_id = candidates
                    .iter()
                    .find(|(_, qname)| qname == &best)
                    .map(|(id, _)| id.clone());
                return (
                    Some(best),
                    target_id,
                    "tail_ranked".to_string(),
                    0.5,
                    Some(format!("Mapped by ranked tail '{}' from '{}'.", tail, raw_metatype)),
                );
            }
            return (
                Some(raw_metatype.to_string()),
                None,
                "ambiguous_tail".to_string(),
                0.2,
                Some(format!(
                    "Metatype tail '{}' is ambiguous across stdlib symbols.",
                    tail
                )),
            );
        }
        (
            Some(raw_metatype.to_string()),
            None,
            "unresolved".to_string(),
            0.0,
            Some(format!("No stdlib symbol found for metatype '{raw_metatype}'.")),
        )
    }
}

impl SymbolIndexStore for SqliteSymbolIndexStore {
    fn upsert_symbols_for_file(
        &mut self,
        project_root: &str,
        file_path: &str,
        symbols: Vec<SymbolRecord>,
    ) {
        let tx = match self.conn.transaction() {
            Ok(tx) => tx,
            Err(_) => return,
        };
        if tx
            .execute(
                "DELETE FROM symbol_mappings WHERE project_root = ?1 AND symbol_file_path = ?2",
                params![project_root, file_path],
            )
            .is_err()
        {
            let _ = tx.rollback();
            return;
        }
        if tx
            .execute(
                "DELETE FROM symbols WHERE project_root = ?1 AND file_path = ?2",
                params![project_root, file_path],
            )
            .is_err()
        {
            let _ = tx.rollback();
            return;
        }
        for symbol in symbols {
            if tx
                .execute(
                    "INSERT INTO symbols (id, project_root, library_key, scope, name, qualified_name, kind, metatype_qname, file_path, start_line, start_col, end_line, end_col, doc_text, properties_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                    params![
                        symbol.id,
                        symbol.project_root,
                        symbol.library_key,
                        Self::scope_to_str(symbol.scope),
                        symbol.name,
                        symbol.qualified_name,
                        symbol.kind,
                        symbol.metatype_qname,
                        symbol.file_path,
                        symbol.start_line,
                        symbol.start_col,
                        symbol.end_line,
                        symbol.end_col,
                        symbol.doc_text,
                        symbol.properties_json,
                    ],
                )
                .is_err()
            {
                let _ = tx.rollback();
                return;
            }
        }
        let _ = tx.commit();
    }

    fn delete_symbols_for_file(&mut self, project_root: &str, file_path: &str) {
        let _ = self.conn.execute(
            "DELETE FROM symbol_mappings WHERE project_root = ?1 AND symbol_file_path = ?2",
            params![project_root, file_path],
        );
        let _ = self.conn.execute(
            "DELETE FROM symbols WHERE project_root = ?1 AND file_path = ?2",
            params![project_root, file_path],
        );
    }

    fn symbols_by_metatype(&self, project_root: &str, metatype_qname: &str) -> Vec<SymbolRecord> {
        let metatype_leaf = metatype_qname
            .rsplit("::")
            .next()
            .unwrap_or(metatype_qname)
            .to_string();
        let metatype_def = format!("{metatype_leaf}Def");
        let mut stmt = match self.conn.prepare(
            "SELECT id, project_root, library_key, scope, name, qualified_name, kind, metatype_qname, file_path, start_line, start_col, end_line, end_col, doc_text, properties_json
             FROM symbols
             WHERE project_root = ?1
               AND (metatype_qname = ?2 OR kind = ?3 OR kind = ?4)
             ORDER BY file_path, start_line, start_col",
        ) {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(
            params![project_root, metatype_qname, metatype_leaf, metatype_def],
            |row| {
                Ok(SymbolRecord {
                    id: row.get(0)?,
                    project_root: row.get(1)?,
                    library_key: row.get(2)?,
                    scope: Self::scope_from_str(row.get::<_, String>(3)?.as_str()),
                    name: row.get(4)?,
                    qualified_name: row.get(5)?,
                    kind: row.get(6)?,
                    metatype_qname: row.get(7)?,
                    file_path: row.get(8)?,
                    start_line: row.get(9)?,
                    start_col: row.get(10)?,
                    end_line: row.get(11)?,
                    end_col: row.get(12)?,
                    doc_text: row.get(13)?,
                    properties_json: row.get(14)?,
                })
            },
        );
        match rows {
            Ok(iter) => iter.filter_map(|item| item.ok()).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn library_symbols(&self, project_root: &str, file_path: Option<&str>) -> Vec<SymbolRecord> {
        self.library_symbols_paged(project_root, file_path, 0, usize::MAX)
    }

    fn library_symbols_paged(
        &self,
        project_root: &str,
        file_path: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Vec<SymbolRecord> {
        let mut out = Vec::new();
        let sql_limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let sql_offset = i64::try_from(offset).unwrap_or(i64::MAX);
        if let Some(file) = file_path {
            let mut stmt = match self.conn.prepare(
                "SELECT id, project_root, library_key, scope, name, qualified_name, kind, metatype_qname, file_path, start_line, start_col, end_line, end_col, doc_text, properties_json
                 FROM symbols
                 WHERE project_root = ?1 AND scope = 'stdlib' AND file_path = ?2
                 ORDER BY file_path, start_line, start_col
                 LIMIT ?3 OFFSET ?4",
            ) {
                Ok(stmt) => stmt,
                Err(_) => return Vec::new(),
            };
            let rows = stmt.query_map(params![project_root, file, sql_limit, sql_offset], |row| {
                Ok(SymbolRecord {
                    id: row.get(0)?,
                    project_root: row.get(1)?,
                    library_key: row.get(2)?,
                    scope: Self::scope_from_str(row.get::<_, String>(3)?.as_str()),
                    name: row.get(4)?,
                    qualified_name: row.get(5)?,
                    kind: row.get(6)?,
                    metatype_qname: row.get(7)?,
                    file_path: row.get(8)?,
                    start_line: row.get(9)?,
                    start_col: row.get(10)?,
                    end_line: row.get(11)?,
                    end_col: row.get(12)?,
                    doc_text: row.get(13)?,
                    properties_json: row.get(14)?,
                })
            });
            return match rows {
                Ok(iter) => iter.filter_map(|item| item.ok()).collect(),
                Err(_) => Vec::new(),
            };
        }
        let mut stmt = match self.conn.prepare(
            "SELECT id, project_root, library_key, scope, name, qualified_name, kind, metatype_qname, file_path, start_line, start_col, end_line, end_col, doc_text, properties_json
             FROM symbols
             WHERE project_root = ?1 AND scope = 'stdlib'
             ORDER BY file_path, start_line, start_col
             LIMIT ?2 OFFSET ?3",
        ) {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![project_root, sql_limit, sql_offset], |row| {
            Ok(SymbolRecord {
                id: row.get(0)?,
                project_root: row.get(1)?,
                library_key: row.get(2)?,
                scope: Self::scope_from_str(row.get::<_, String>(3)?.as_str()),
                name: row.get(4)?,
                qualified_name: row.get(5)?,
                kind: row.get(6)?,
                metatype_qname: row.get(7)?,
                file_path: row.get(8)?,
                start_line: row.get(9)?,
                start_col: row.get(10)?,
                end_line: row.get(11)?,
                end_col: row.get(12)?,
                doc_text: row.get(13)?,
                properties_json: row.get(14)?,
            })
        });
        match rows {
            Ok(iter) => {
                out.extend(iter.filter_map(|item| item.ok()));
                out
            }
            Err(_) => Vec::new(),
        }
    }

    fn stdlib_documentation_symbols(&self, library_key: &str) -> Vec<SymbolRecord> {
        let mut stmt = match self.conn.prepare(
            "SELECT id, project_root, library_key, scope, name, qualified_name, kind, metatype_qname, file_path, start_line, start_col, end_line, end_col, doc_text, properties_json
             FROM symbols
             WHERE scope = 'stdlib' AND library_key = ?1 AND kind = 'Documentation'
             ORDER BY file_path, start_line, start_col",
        ) {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![library_key], |row| {
            Ok(SymbolRecord {
                id: row.get(0)?,
                project_root: row.get(1)?,
                library_key: row.get(2)?,
                scope: Self::scope_from_str(row.get::<_, String>(3)?.as_str()),
                name: row.get(4)?,
                qualified_name: row.get(5)?,
                kind: row.get(6)?,
                metatype_qname: row.get(7)?,
                file_path: row.get(8)?,
                start_line: row.get(9)?,
                start_col: row.get(10)?,
                end_line: row.get(11)?,
                end_col: row.get(12)?,
                doc_text: row.get(13)?,
                properties_json: row.get(14)?,
            })
        });
        match rows {
            Ok(iter) => iter.filter_map(|item| item.ok()).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn project_symbols(&self, project_root: &str, file_path: Option<&str>) -> Vec<SymbolRecord> {
        let mut out = Vec::new();
        if let Some(file) = file_path {
            let mut stmt = match self.conn.prepare(
                "SELECT id, project_root, library_key, scope, name, qualified_name, kind, metatype_qname, file_path, start_line, start_col, end_line, end_col, doc_text, properties_json
                 FROM symbols
                 WHERE project_root = ?1 AND scope = 'project' AND file_path = ?2
                 ORDER BY file_path, start_line, start_col",
            ) {
                Ok(stmt) => stmt,
                Err(_) => return Vec::new(),
            };
            let rows = stmt.query_map(params![project_root, file], |row| {
                Ok(SymbolRecord {
                    id: row.get(0)?,
                    project_root: row.get(1)?,
                    library_key: row.get(2)?,
                    scope: Self::scope_from_str(row.get::<_, String>(3)?.as_str()),
                    name: row.get(4)?,
                    qualified_name: row.get(5)?,
                    kind: row.get(6)?,
                    metatype_qname: row.get(7)?,
                    file_path: row.get(8)?,
                    start_line: row.get(9)?,
                    start_col: row.get(10)?,
                    end_line: row.get(11)?,
                    end_col: row.get(12)?,
                    doc_text: row.get(13)?,
                    properties_json: row.get(14)?,
                })
            });
            return match rows {
                Ok(iter) => iter.filter_map(|item| item.ok()).collect(),
                Err(_) => Vec::new(),
            };
        }
        let mut stmt = match self.conn.prepare(
            "SELECT id, project_root, library_key, scope, name, qualified_name, kind, metatype_qname, file_path, start_line, start_col, end_line, end_col, doc_text, properties_json
             FROM symbols
             WHERE project_root = ?1 AND scope = 'project'
             ORDER BY file_path, start_line, start_col",
        ) {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![project_root], |row| {
            Ok(SymbolRecord {
                id: row.get(0)?,
                project_root: row.get(1)?,
                library_key: row.get(2)?,
                scope: Self::scope_from_str(row.get::<_, String>(3)?.as_str()),
                name: row.get(4)?,
                qualified_name: row.get(5)?,
                kind: row.get(6)?,
                metatype_qname: row.get(7)?,
                file_path: row.get(8)?,
                start_line: row.get(9)?,
                start_col: row.get(10)?,
                end_line: row.get(11)?,
                end_col: row.get(12)?,
                doc_text: row.get(13)?,
                properties_json: row.get(14)?,
            })
        });
        match rows {
            Ok(iter) => {
                out.extend(iter.filter_map(|item| item.ok()));
                out
            }
            Err(_) => Vec::new(),
        }
    }

    fn project_symbol(
        &self,
        project_root: &str,
        qualified_name: &str,
        symbol_kind: Option<&str>,
    ) -> Option<SymbolRecord> {
        if let Some(kind) = symbol_kind {
            let mut stmt = self.conn.prepare(
                "SELECT id, project_root, library_key, scope, name, qualified_name, kind, metatype_qname, file_path, start_line, start_col, end_line, end_col, doc_text, properties_json
                 FROM symbols
                 WHERE project_root = ?1 AND scope = 'project' AND qualified_name = ?2 AND lower(kind) = lower(?3)
                 ORDER BY file_path, start_line, start_col
                 LIMIT 1",
            ).ok()?;
            if let Ok(row) = stmt.query_row(params![project_root, qualified_name, kind], |row| {
                Ok(SymbolRecord {
                    id: row.get(0)?,
                    project_root: row.get(1)?,
                    library_key: row.get(2)?,
                    scope: Self::scope_from_str(row.get::<_, String>(3)?.as_str()),
                    name: row.get(4)?,
                    qualified_name: row.get(5)?,
                    kind: row.get(6)?,
                    metatype_qname: row.get(7)?,
                    file_path: row.get(8)?,
                    start_line: row.get(9)?,
                    start_col: row.get(10)?,
                    end_line: row.get(11)?,
                    end_col: row.get(12)?,
                    doc_text: row.get(13)?,
                    properties_json: row.get(14)?,
                })
            }) {
                return Some(row);
            }
        }
        let mut stmt = self.conn.prepare(
            "SELECT id, project_root, library_key, scope, name, qualified_name, kind, metatype_qname, file_path, start_line, start_col, end_line, end_col, doc_text, properties_json
             FROM symbols
             WHERE project_root = ?1 AND scope = 'project' AND qualified_name = ?2
             ORDER BY file_path, start_line, start_col
             LIMIT 1",
        ).ok()?;
        stmt.query_row(params![project_root, qualified_name], |row| {
            Ok(SymbolRecord {
                id: row.get(0)?,
                project_root: row.get(1)?,
                library_key: row.get(2)?,
                scope: Self::scope_from_str(row.get::<_, String>(3)?.as_str()),
                name: row.get(4)?,
                qualified_name: row.get(5)?,
                kind: row.get(6)?,
                metatype_qname: row.get(7)?,
                file_path: row.get(8)?,
                start_line: row.get(9)?,
                start_col: row.get(10)?,
                end_line: row.get(11)?,
                end_col: row.get(12)?,
                doc_text: row.get(13)?,
                properties_json: row.get(14)?,
            })
        }).ok()
    }

    fn library_summary(&self, project_root: &str) -> (usize, usize, Vec<(String, usize)>) {
        let file_count = self
            .conn
            .query_row(
                "SELECT COUNT(DISTINCT file_path)
                 FROM symbols
                 WHERE project_root = ?1 AND scope = 'stdlib'",
                params![project_root],
                |row| row.get::<_, i64>(0),
            )
            .ok()
            .and_then(|v| usize::try_from(v).ok())
            .unwrap_or(0);
        let symbol_count = self
            .conn
            .query_row(
                "SELECT COUNT(*)
                 FROM symbols
                 WHERE project_root = ?1 AND scope = 'stdlib'",
                params![project_root],
                |row| row.get::<_, i64>(0),
            )
            .ok()
            .and_then(|v| usize::try_from(v).ok())
            .unwrap_or(0);
        let mut kind_counts = Vec::new();
        let mut stmt = match self.conn.prepare(
            "SELECT kind, COUNT(*)
             FROM symbols
             WHERE project_root = ?1 AND scope = 'stdlib'
             GROUP BY kind
             ORDER BY COUNT(*) DESC, kind ASC",
        ) {
            Ok(stmt) => stmt,
            Err(_) => return (file_count, symbol_count, kind_counts),
        };
        let rows = stmt.query_map(params![project_root], |row| {
            let kind: String = row.get(0)?;
            let count: i64 = row.get(1)?;
            Ok((kind, usize::try_from(count).unwrap_or(0)))
        });
        if let Ok(iter) = rows {
            kind_counts.extend(iter.filter_map(|item| item.ok()));
        }
        (file_count, symbol_count, kind_counts)
    }

    fn is_stdlib_index_fresh(&self, project_root: &str, library_key: &str, signature: &str) -> bool {
        let mut stmt = match self.conn.prepare(
            "SELECT signature
             FROM stdlib_index_meta
             WHERE project_root = ?1 AND library_key = ?2",
        ) {
            Ok(stmt) => stmt,
            Err(_) => return false,
        };
        let known = stmt.query_row(params![project_root, library_key], |row| row.get::<_, String>(0));
        match known {
            Ok(value) => value == signature,
            Err(_) => false,
        }
    }

    fn mark_stdlib_indexed(&mut self, project_root: &str, library_key: &str, signature: &str) {
        let _ = self.conn.execute(
            "INSERT INTO stdlib_index_meta(project_root, library_key, signature, updated_at)
             VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
             ON CONFLICT(project_root, library_key)
             DO UPDATE SET signature = excluded.signature, updated_at = CURRENT_TIMESTAMP",
            params![project_root, library_key, signature],
        );
    }

    fn rebuild_symbol_mappings(&mut self, project_root: &str) {
        let tx = match self.conn.transaction() {
            Ok(tx) => tx,
            Err(_) => return,
        };
        if tx
            .execute(
                "DELETE FROM symbol_mappings WHERE project_root = ?1",
                params![project_root],
            )
            .is_err()
        {
            let _ = tx.rollback();
            return;
        }
        let mut stmt = match tx.prepare(
            "SELECT id, file_path, qualified_name, kind, metatype_qname
             FROM symbols
             WHERE project_root = ?1 AND scope = 'project'",
        ) {
            Ok(value) => value,
            Err(_) => return,
        };
        let rows = match stmt.query_map(params![project_root], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        }) {
            Ok(value) => value,
            Err(_) => return,
        };
        let project_symbols = rows.filter_map(|item| item.ok()).collect::<Vec<_>>();
        drop(stmt);

        for (symbol_id, symbol_file_path, symbol_qualified_name, symbol_kind, metatype_qname) in
            project_symbols
        {
            let (resolved_metatype_qname, target_symbol_id, mapping_source, confidence, diagnostic) =
                if let Some(raw) = metatype_qname.filter(|value| !value.trim().is_empty()) {
                    Self::resolve_stdlib_target_for_metatype(&tx, project_root, &raw)
                } else {
                    (
                        None,
                        None,
                        "unresolved".to_string(),
                        0.0,
                        Some("Symbol has no metatype_qname.".to_string()),
                    )
                };
            if tx
                .execute(
                    "INSERT INTO symbol_mappings(
                        project_root,
                        symbol_id,
                        symbol_file_path,
                        symbol_qualified_name,
                        symbol_kind,
                        resolved_metatype_qname,
                        target_symbol_id,
                        mapping_source,
                        confidence,
                        diagnostic,
                        updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, CURRENT_TIMESTAMP)",
                    params![
                        project_root,
                        symbol_id,
                        symbol_file_path,
                        symbol_qualified_name,
                        symbol_kind,
                        resolved_metatype_qname,
                        target_symbol_id,
                        mapping_source,
                        confidence,
                        diagnostic,
                    ],
                )
                .is_err()
            {
                let _ = tx.rollback();
                return;
            }
        }

        let _ = tx.commit();
    }

    fn symbol_mapping(
        &self,
        project_root: &str,
        symbol_qualified_name: &str,
        file_path: Option<&str>,
    ) -> Option<SymbolMetatypeMappingRecord> {
        let sql_with_file = "SELECT project_root, symbol_id, symbol_file_path, symbol_qualified_name, symbol_kind, resolved_metatype_qname, target_symbol_id, mapping_source, confidence, diagnostic
             FROM symbol_mappings
             WHERE project_root = ?1 AND symbol_qualified_name = ?2 AND symbol_file_path = ?3
             ORDER BY symbol_file_path ASC
             LIMIT 1";
        let sql_without_file = "SELECT project_root, symbol_id, symbol_file_path, symbol_qualified_name, symbol_kind, resolved_metatype_qname, target_symbol_id, mapping_source, confidence, diagnostic
             FROM symbol_mappings
             WHERE project_root = ?1 AND symbol_qualified_name = ?2
             ORDER BY symbol_file_path ASC
             LIMIT 1";
        let mut stmt = match self
            .conn
            .prepare(if file_path.is_some() { sql_with_file } else { sql_without_file })
        {
            Ok(value) => value,
            Err(_) => return None,
        };
        let mapper = |row: &rusqlite::Row<'_>| {
            Ok(SymbolMetatypeMappingRecord {
                project_root: row.get(0)?,
                symbol_id: row.get(1)?,
                symbol_file_path: row.get(2)?,
                symbol_qualified_name: row.get(3)?,
                symbol_kind: row.get(4)?,
                resolved_metatype_qname: row.get(5)?,
                target_symbol_id: row.get(6)?,
                mapping_source: row.get(7)?,
                confidence: row.get(8)?,
                diagnostic: row.get(9)?,
            })
        };
        if let Some(path) = file_path {
            stmt.query_row(params![project_root, symbol_qualified_name, path], mapper)
                .ok()
        } else {
            stmt.query_row(params![project_root, symbol_qualified_name], mapper)
                .ok()
        }
    }
}
