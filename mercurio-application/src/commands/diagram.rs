//! Diagram file commands and schema helpers.

use std::path::PathBuf;

use tauri::command;

use mercurio_core::{read_diagram as core_read_diagram, write_diagram as core_write_diagram, DiagramFile};

#[command]
pub fn read_diagram(root: String, path: String) -> Result<DiagramFile, String> {
    let root_path = PathBuf::from(root);
    let target_path = PathBuf::from(path);
    core_read_diagram(&root_path, &target_path)
}

#[command]
pub fn write_diagram(root: String, path: String, diagram: DiagramFile) -> Result<(), String> {
    let root_path = PathBuf::from(root);
    let target_path = PathBuf::from(path);
    core_write_diagram(&root_path, &target_path, diagram)
}
