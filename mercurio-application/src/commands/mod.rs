//! Tauri command modules.
//!
//! Intent: keep `lib.rs` focused on application bootstrap and analysis logic,
//! while grouping UI-invoked commands by concern.

pub mod ai;
pub mod core;
pub mod fs_ops;
pub mod git;
pub mod semantic_edit;
pub mod tools;
pub mod window;

pub use ai::{ai_agent_run, ai_test_endpoint};
pub use core::{create_project, get_user_projects_root};
pub use fs_ops::{create_file, list_dir, read_file, write_file};
pub use git::{
    detect_git_repo, git_commit, git_push, git_stage_paths, git_status, git_unstage_paths,
};
pub use semantic_edit::{apply_semantic_edit, list_semantic_edit_actions, preview_semantic_edit};
pub use tools::{call_tool, list_tools};
pub use window::{
    app_exit, show_in_explorer, window_close, window_minimize, window_toggle_maximize,
};
