use crate::compile::is_model_file;
use crate::types::{ParseErrorView, ParseErrorsPayload};
use std::path::PathBuf;
use syster::syntax::parser::parse_with_result;

#[tauri::command]
pub fn get_parse_errors(path: String) -> Result<ParseErrorsPayload, String> {
    let file_path = PathBuf::from(&path);
    if !file_path.exists() {
        return Err("File does not exist".to_string());
    }
    if !is_model_file(&file_path) {
        return Ok(ParseErrorsPayload {
            path,
            errors: Vec::new(),
        });
    }
    let content = std::fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let parse = parse_with_result(&content, &file_path);
    let errors = parse
        .errors
        .iter()
        .map(|err| ParseErrorView {
            message: err.message.clone(),
            line: err.position.line,
            column: err.position.column,
            kind: format!("{:?}", err.kind),
        })
        .collect();
    Ok(ParseErrorsPayload { path, errors })
}

#[tauri::command]
pub fn get_parse_errors_for_content(path: String, content: String) -> Result<ParseErrorsPayload, String> {
    let file_path = PathBuf::from(&path);
    if !is_model_file(&file_path) {
        return Ok(ParseErrorsPayload {
            path,
            errors: Vec::new(),
        });
    }
    if content.is_empty() {
        return Ok(ParseErrorsPayload {
            path,
            errors: Vec::new(),
        });
    }
    let parse = parse_with_result(&content, &file_path);
    let errors = parse
        .errors
        .iter()
        .map(|err| ParseErrorView {
            message: err.message.clone(),
            line: err.position.line,
            column: err.position.column,
            kind: format!("{:?}", err.kind),
        })
        .collect();
    Ok(ParseErrorsPayload { path, errors })
}
