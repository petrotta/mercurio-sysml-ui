use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, EventTarget};
use time::macros::format_description;
use time::OffsetDateTime;

const LOG_BUFFER_LIMIT: usize = 2000;
const LOG_EVENT_NAME: &str = "app-log";
const TIMESTAMP_FORMAT: &[time::format_description::FormatItem<'static>] =
    format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");

static LOG_BUFFER: OnceLock<Mutex<VecDeque<AppLogRecord>>> = OnceLock::new();
static APP_HANDLE: OnceLock<Mutex<Option<tauri::AppHandle>>> = OnceLock::new();
static NEXT_LOG_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
pub struct AppLogRecord {
    pub seq: u64,
    pub timestamp_utc: String,
    pub level: String,
    pub kind: String,
    pub message: String,
}

#[derive(Deserialize)]
pub struct FrontendLogPayload {
    pub level: String,
    pub kind: String,
    pub message: String,
}

fn log_store() -> &'static Mutex<VecDeque<AppLogRecord>> {
    LOG_BUFFER.get_or_init(|| Mutex::new(VecDeque::with_capacity(LOG_BUFFER_LIMIT)))
}

fn app_handle_store() -> &'static Mutex<Option<tauri::AppHandle>> {
    APP_HANDLE.get_or_init(|| Mutex::new(None))
}

fn normalize_level(level: &str) -> String {
    match level.trim().to_ascii_uppercase().as_str() {
        "ERROR" => "ERROR".to_string(),
        "WARN" | "WARNING" => "WARN".to_string(),
        _ => "INFO".to_string(),
    }
}

fn normalize_kind(kind: &str) -> String {
    let trimmed = kind.trim();
    if trimmed.is_empty() {
        "app".to_string()
    } else {
        trimmed.to_ascii_lowercase()
    }
}

fn current_timestamp_utc() -> String {
    OffsetDateTime::now_utc()
        .format(TIMESTAMP_FORMAT)
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string())
}

fn emit_log_record(record: &AppLogRecord) {
    let handle = app_handle_store()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().cloned());
    if let Some(app) = handle {
        let _ = app.emit_to(
            EventTarget::webview_window("main"),
            LOG_EVENT_NAME,
            record.clone(),
        );
    }
}

pub fn set_app_handle(handle: tauri::AppHandle) {
    if let Ok(mut guard) = app_handle_store().lock() {
        *guard = Some(handle);
    }
}

pub fn log_event(level: &str, kind: &str, message: String) {
    let message = message.trim().to_string();
    if message.is_empty() {
        return;
    }

    let record = AppLogRecord {
        seq: NEXT_LOG_SEQ.fetch_add(1, Ordering::Relaxed),
        timestamp_utc: current_timestamp_utc(),
        level: normalize_level(level),
        kind: normalize_kind(kind),
        message,
    };
    if let Ok(mut buffer) = log_store().lock() {
        if buffer.len() >= LOG_BUFFER_LIMIT {
            buffer.pop_front();
        }
        buffer.push_back(record.clone());
    }
    eprintln!(
        "[{}] [{}] [{}] {}",
        record.timestamp_utc, record.level, record.kind, record.message
    );
    emit_log_record(&record);
}

#[tauri::command]
pub fn get_logs() -> Result<Vec<AppLogRecord>, String> {
    let buffer = log_store()
        .lock()
        .map_err(|_| "Log buffer lock poisoned".to_string())?;
    Ok(buffer.iter().cloned().collect())
}

#[tauri::command]
pub fn log_frontend(payload: FrontendLogPayload) -> Result<(), String> {
    let kind = if payload.kind.trim().is_empty() {
        "frontend"
    } else {
        payload.kind.trim()
    };
    log_event(&payload.level, kind, payload.message);
    Ok(())
}
