use std::path::Path;

use rusqlite::{params, Connection};

use crate::model::{Scope, SymbolRecord};
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
        for (_, sql) in MIGRATIONS {
            self.conn.execute_batch(sql).map_err(|e| e.to_string())?;
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
                    "INSERT INTO symbols (id, project_root, library_key, scope, name, qualified_name, kind, metatype_qname, file_path, start_line, start_col, end_line, end_col, doc_text)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
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
            "SELECT id, project_root, library_key, scope, name, qualified_name, kind, metatype_qname, file_path, start_line, start_col, end_line, end_col, doc_text
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
                "SELECT id, project_root, library_key, scope, name, qualified_name, kind, metatype_qname, file_path, start_line, start_col, end_line, end_col, doc_text
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
                })
            });
            return match rows {
                Ok(iter) => iter.filter_map(|item| item.ok()).collect(),
                Err(_) => Vec::new(),
            };
        }
        let mut stmt = match self.conn.prepare(
            "SELECT id, project_root, library_key, scope, name, qualified_name, kind, metatype_qname, file_path, start_line, start_col, end_line, end_col, doc_text
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
            "SELECT id, project_root, library_key, scope, name, qualified_name, kind, metatype_qname, file_path, start_line, start_col, end_line, end_col, doc_text
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
            })
        });
        match rows {
            Ok(iter) => iter.filter_map(|item| item.ok()).collect(),
            Err(_) => Vec::new(),
        }
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
}
