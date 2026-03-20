//! Tauri command modules.
//!
//! Intent: keep `lib.rs` focused on application bootstrap and analysis logic,
//! while grouping UI-invoked commands by concern.

pub mod fs_ops;
pub mod tools;
pub mod window;

pub use fs_ops::{create_file, list_dir, read_file, write_file};
pub use tools::call_tool;
pub use window::{
    app_exit, show_in_explorer, window_close, window_minimize, window_toggle_maximize,
};
