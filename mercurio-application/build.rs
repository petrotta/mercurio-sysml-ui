use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    if let Err(err) = ensure_tauri_sidecar_name() {
        println!("cargo:warning=failed to prepare mercurio-cli sidecar name: {err}");
    }

    tauri_build::build()
}

fn ensure_tauri_sidecar_name() -> Result<(), String> {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").map_err(|e| e.to_string())?);
    let workspace_root = manifest_dir
        .parent()
        .ok_or("failed to resolve workspace root from CARGO_MANIFEST_DIR")?;

    let profile = env::var("PROFILE").map_err(|e| e.to_string())?;
    let target_triple = env::var("TARGET").map_err(|e| e.to_string())?;

    let bin_name = if cfg!(windows) {
        "mercurio-cli.exe"
    } else {
        "mercurio-cli"
    };

    let sidecar_name = if cfg!(windows) {
        format!("mercurio-cli-{target_triple}.exe")
    } else {
        format!("mercurio-cli-{target_triple}")
    };

    let source = workspace_root.join("target").join(&profile).join(bin_name);
    let sidecar = workspace_root.join("target").join(&profile).join(sidecar_name);

    println!("cargo:rerun-if-changed={}", source.display());

    if sidecar.exists() || !source.exists() {
        return Ok(());
    }

    fs::copy(&source, &sidecar).map_err(|e| {
        format!(
            "copy {} -> {} failed: {e}",
            source.display(),
            sidecar.display()
        )
    })?;

    Ok(())
}
