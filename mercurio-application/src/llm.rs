use crate::logging::log_event;
use crate::types::LlmHintsMeta;
use std::fs;
use tauri::Manager;

#[tauri::command]
pub fn read_llm_instructions(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .resolve("llm/instructions.md", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())
        .and_then(|path| fs::read_to_string(path).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn read_llm_hints(app: tauri::AppHandle) -> Result<String, String> {
    let resource_path = app
        .path()
        .resolve("llm/hints.json", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    if let Ok(content) = fs::read_to_string(&resource_path) {
        return Ok(content);
    } else {
        log_event(
            "WARN",
            "hint",
            format!(
                "resource missing: {}",
                resource_path.to_string_lossy()
            ),
        );
    }
    let dev_root = std::env::current_dir().map_err(|e| e.to_string())?;
    let dev_path = dev_root.join("mercurio-application").join("llm").join("hints.json");
    fs::read_to_string(&dev_path).map_err(|e| {
        log_event(
            "ERROR",
            "hint",
            format!("dev hints missing: {} err={}", dev_path.to_string_lossy(), e),
        );
        e.to_string()
    })
}

#[tauri::command]
pub fn get_llm_hints_meta(app: tauri::AppHandle) -> Result<LlmHintsMeta, String> {
    let resource_path = app
        .path()
        .resolve("llm/hints.json", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    let (path, metadata) = if let Ok(meta) = fs::metadata(&resource_path) {
        (resource_path, meta)
    } else {
        let dev_root = std::env::current_dir().map_err(|e| e.to_string())?;
        let dev_path = dev_root.join("mercurio-application").join("llm").join("hints.json");
        let meta = fs::metadata(&dev_path).map_err(|e| e.to_string())?;
        (dev_path, meta)
    };
    let modified = metadata
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    Ok(LlmHintsMeta {
        path: path.to_string_lossy().to_string(),
        modified_ms: modified,
    })
}
