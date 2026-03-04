use mercurio_core::{
    ensure_mercurio_paths, load_app_settings, load_library_symbols_sync, AppSettings, CoreState,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn main() {
    let paths = match ensure_mercurio_paths() {
        Ok(paths) => paths,
        Err(err) => {
            eprintln!("Failed to resolve Mercurio paths: {err}");
            std::process::exit(1);
        }
    };
    let settings = load_app_settings(&paths.settings_path);
    let stdlib_dir = match resolve_stdlib_dir(&paths.stdlib_root, &settings) {
        Some(path) => path,
        None => {
            eprintln!(
                "No stdlib found under {}",
                paths.stdlib_root.to_string_lossy()
            );
            std::process::exit(2);
        }
    };

    let root = std::env::temp_dir().join(format!("mercurio_stdlib_bench_{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    if let Err(err) = fs::create_dir_all(&root) {
        eprintln!("Failed to create temp root: {err}");
        std::process::exit(1);
    }
    if let Err(err) = fs::write(root.join("main.sysml"), "package Bench { part def A; }\n") {
        eprintln!("Failed to write project file: {err}");
        std::process::exit(1);
    }
    let descriptor = format!(
        "{{\"name\":\"bench\",\"library\":{{\"path\":\"{}\"}},\"src\":[\"*.sysml\"]}}",
        stdlib_dir.to_string_lossy().replace('\\', "\\\\")
    );
    if let Err(err) = fs::write(root.join(".project"), descriptor) {
        eprintln!("Failed to write descriptor: {err}");
        std::process::exit(1);
    }

    let root_str = root.to_string_lossy().to_string();

    println!("stdlib_path={}", stdlib_dir.to_string_lossy());
    bench_mode(
        &CoreState::new(paths.stdlib_root.clone(), settings.clone()),
        &root_str,
        false,
        "files_only",
    );
    bench_mode(
        &CoreState::new(paths.stdlib_root.clone(), settings),
        &root_str,
        true,
        "full_symbols",
    );
}

fn resolve_stdlib_dir(stdlib_root: &Path, settings: &AppSettings) -> Option<PathBuf> {
    if let Some(default_id) = settings.default_stdlib.as_ref() {
        let candidate = stdlib_root.join(default_id);
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    let read = fs::read_dir(stdlib_root).ok()?;
    let mut dirs = read
        .filter_map(|entry| entry.ok().map(|v| v.path()))
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    dirs.sort();
    dirs.into_iter().next()
}

fn bench_mode(state: &CoreState, root: &str, include_symbols: bool, label: &str) {
    let start1 = Instant::now();
    let first = load_library_symbols_sync(state, root.to_string(), None, include_symbols)
        .expect("first load_library_symbols_sync");
    let wall1 = start1.elapsed().as_millis();

    let start2 = Instant::now();
    let second = load_library_symbols_sync(state, root.to_string(), None, include_symbols)
        .expect("second load_library_symbols_sync");
    let wall2 = start2.elapsed().as_millis();

    println!("mode={label} include_symbols={include_symbols}");
    println!(
        "cold: cache_hit={} stdlib_ms={} total_ms={} wall_ms={}",
        first.workspace_snapshot_hit, first.stdlib_duration_ms, first.total_duration_ms, wall1
    );
    println!(
        "warm: cache_hit={} stdlib_ms={} total_ms={} wall_ms={}",
        second.workspace_snapshot_hit, second.stdlib_duration_ms, second.total_duration_ms, wall2
    );
    if second.stdlib_duration_ms > 0 {
        let ratio = first.stdlib_duration_ms as f64 / second.stdlib_duration_ms as f64;
        println!("speedup_stdlib_ms={ratio:.2}x");
    }
}
