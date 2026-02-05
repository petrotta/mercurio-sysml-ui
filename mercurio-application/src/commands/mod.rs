//! Tauri command modules.
//!
//! Intent: keep `lib.rs` focused on application bootstrap and analysis logic,
//! while grouping UI-invoked commands by concern.

pub mod ai;
pub mod core;
pub mod diagram;
pub mod fs_ops;
pub mod stdlib;
pub mod window;

pub use ai::{ai_agent_run, ai_chat_completion, ai_test_endpoint};
pub use core::{get_default_root, get_startup_path};
pub use diagram::{read_diagram, write_diagram};
pub use fs_ops::{
    create_dir, create_file, create_package, delete_path, list_dir, open_in_explorer, path_exists,
    read_file, rename_path, write_file,
};
pub use stdlib::{get_default_stdlib, list_stdlib_versions, set_default_stdlib};
pub use window::{window_close, window_minimize, window_toggle_maximize};
