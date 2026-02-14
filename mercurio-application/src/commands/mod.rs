//! Tauri command modules.
//!
//! Intent: keep `lib.rs` focused on application bootstrap and analysis logic,
//! while grouping UI-invoked commands by concern.

pub mod ai;
pub mod core;
pub mod diagram;
pub mod fs_ops;
pub mod git;
pub mod stdlib;
pub mod window;

pub use ai::{ai_agent_run, ai_test_endpoint};
pub use core::{
    get_project_element_attributes, get_project_model, get_user_projects_root, query_semantic,
};
pub use diagram::{read_diagram, write_diagram};
pub use fs_ops::{
    create_dir, create_file, list_dir, open_in_explorer, path_exists, read_file, rename_path,
    write_file,
};
pub use git::{
    detect_git_repo, git_checkout_branch, git_commit, git_create_branch, git_list_branches, git_push,
    git_stage_paths, git_status, git_unstage_paths,
};
pub use stdlib::{get_stdlib_metamodel, list_stdlib_versions};
pub use window::{window_close, window_minimize, window_toggle_maximize};
