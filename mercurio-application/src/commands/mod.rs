//! Tauri command modules.
//!
//! Intent: keep `lib.rs` focused on application bootstrap and analysis logic,
//! while grouping UI-invoked commands by concern.

pub mod core;
pub mod fs_ops;
pub mod semantic_edit;
pub mod tools;
pub mod window;

pub use core::{create_project, get_user_projects_root};
pub use fs_ops::{create_file, list_dir, read_file, write_file};
pub use semantic_edit::{apply_semantic_edit, list_semantic_edit_actions, preview_semantic_edit};
pub use tools::call_tool;
pub use window::{
    app_exit, show_in_explorer, window_close, window_minimize, window_toggle_maximize,
};
