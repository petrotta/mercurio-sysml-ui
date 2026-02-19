use mercurio_core::{
    compile_project_delta_sync, ensure_mercurio_paths, load_app_settings, query_library_summary,
    query_project_symbols, CoreState,
};
use std::thread;
use std::time::Duration;

fn main() {
    let root = std::env::args().nth(1).unwrap_or_default();
    if root.trim().is_empty() {
        eprintln!("usage: cargo run --bin ui_probe -- <project-root>");
        std::process::exit(2);
    }

    let paths = match ensure_mercurio_paths() {
        Ok(paths) => paths,
        Err(err) => {
            eprintln!("Failed to resolve Mercurio paths: {err}");
            std::process::exit(1);
        }
    };
    let settings = load_app_settings(&paths.settings_path);
    let state = CoreState::new(paths.stdlib_root, settings);

    run_probe(&state, &root);
}

fn run_probe(state: &CoreState, root: &str) {
    let response = match compile_project_delta_sync(
        state,
        root.to_string(),
        999,
        true,
        None,
        Vec::new(),
        |_| {},
    ) {
        Ok(value) => value,
        Err(err) => {
            eprintln!("compile_project_delta_sync failed: {err}");
            std::process::exit(1);
        }
    };

    println!("compile.ok={}", response.ok);
    println!(
        "compile.project_symbol_count={} compile.library_symbol_count={}",
        response.project_symbol_count, response.library_symbol_count
    );
    println!(
        "compile.files={} parsed_files={}",
        response.files.len(),
        response.parsed_files.len()
    );

    thread::sleep(Duration::from_millis(750));
    let indexed_project = query_project_symbols(state, root.to_string(), None, Some(0), Some(1_000_000))
        .unwrap_or_default();
    println!("index.project_symbols={}", indexed_project.len());
    let sample = indexed_project
        .iter()
        .take(5)
        .map(|s| format!("{}:{}", s.kind, s.qualified_name))
        .collect::<Vec<_>>()
        .join(" | ");
    if !sample.is_empty() {
        println!("index.project_sample={sample}");
    }

    let library_summary = match query_library_summary(state, root.to_string()) {
        Ok(value) => value,
        Err(_) => {
            println!("index.library_files=0 index.library_symbols=0");
            return;
        }
    };
    println!(
        "index.library_files={} index.library_symbols={}",
        library_summary.file_count, library_summary.symbol_count
    );
}
