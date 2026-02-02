use crate::types::FrontendLogPayload;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_BUFFER: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

fn log_store() -> &'static Mutex<Vec<String>> {
    LOG_BUFFER.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn log_event(level: &str, kind: &str, message: String) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| format!("{}.{:03}", d.as_secs(), d.subsec_millis()))
        .unwrap_or_else(|_| "0.000".to_string());
    let line = format!("[{}] [{}] [{}] {}", timestamp, level, kind, message);
    if let Ok(mut buffer) = log_store().lock() {
        buffer.push(line);
        if buffer.len() > 2000 {
            let drain = buffer.len() - 2000;
            buffer.drain(0..drain);
        }
    }
}

#[tauri::command]
pub fn get_logs() -> Result<Vec<String>, String> {
    let buffer = log_store()
        .lock()
        .map_err(|_| "Log buffer lock poisoned".to_string())?;
    Ok(buffer.clone())
}

#[tauri::command]
pub fn log_frontend(payload: FrontendLogPayload) -> Result<(), String> {
    let level = if payload.level.trim().is_empty() {
        "INFO"
    } else {
        payload.level.trim()
    };
    let kind = if payload.kind.trim().is_empty() {
        "frontend"
    } else {
        payload.kind.trim()
    };
    log_event(level, kind, payload.message);
    Ok(())
}
