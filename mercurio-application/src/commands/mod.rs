//! Tauri command modules.
//!
//! Intent: keep `lib.rs` focused on application bootstrap and analysis logic,
//! while grouping UI-invoked commands by concern.

pub mod fs_ops;
pub mod tools;

pub use fs_ops::{list_dir, read_file, write_file};
pub use tools::call_tool;
