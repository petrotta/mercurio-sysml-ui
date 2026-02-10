use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use syster::ide::AnalysisHost;
use syster::interchange::{detect_format, JsonLd, Kpar, ModelFormat, Xmi};

use crate::files::{is_import_file, resolve_under_root};

pub(crate) fn load_imports_into_host(host: &mut AnalysisHost, imports: &[PathBuf]) -> Result<(), String> {
    for import in imports {
        if import.is_dir() {
            collect_model_files(import, &mut Vec::new())?;
        } else if is_import_file(import) {
            import_model_into_host(host, import)?;
        }
    }
    Ok(())
}

fn import_model_into_host(host: &mut AnalysisHost, path: &Path) -> Result<(), String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    let format_hint = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("xmi")
        .to_lowercase();
    let model = match format_hint.as_str() {
        "xmi" | "sysmlx" | "kermlx" => Xmi.read(&bytes).map_err(|e| e.to_string())?,
        "kpar" => Kpar.read(&bytes).map_err(|e| e.to_string())?,
        "jsonld" | "json" => JsonLd.read(&bytes).map_err(|e| e.to_string())?,
        _ => {
            if let Some(format) = detect_format(path) {
                format.read(&bytes).map_err(|e| e.to_string())?
            } else {
                return Err(format!("Unsupported import format: {}", format_hint));
            }
        }
    };
    let virtual_path = path.to_string_lossy();
    let _ = host.add_model(&model, &virtual_path);
    Ok(())
}

pub(crate) fn collect_project_files(root: &Path, src: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for entry in src {
        let pattern = entry.trim();
        if pattern.is_empty() {
            continue;
        }
        let normalized = pattern.replace('\\', "/");
        if let Some((recursive, ext)) = parse_ext_pattern(&normalized) {
            if recursive {
                collect_model_files_by_extension(root, &ext, &mut out, &mut seen)?;
            } else {
                collect_model_files_in_root_by_extension(root, &ext, &mut out, &mut seen)?;
            }
            continue;
        }

        let resolved = resolve_under_root(root, Path::new(pattern))?;
        if resolved.is_file() {
            let key = resolved.to_string_lossy().to_string();
            if seen.insert(key.clone()) {
                out.push(PathBuf::from(key));
            }
        }
    }

    Ok(out)
}

pub(crate) fn collect_project_imports(root: &Path, imports: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for entry in imports {
        let pattern = entry.trim();
        if pattern.is_empty() {
            continue;
        }
        let normalized = pattern.replace('\\', "/");
        if let Some((recursive, ext)) = parse_ext_pattern(&normalized) {
            if recursive {
                collect_model_files_by_extension(root, &ext, &mut out, &mut seen)?;
            } else {
                collect_model_files_in_root_by_extension(root, &ext, &mut out, &mut seen)?;
            }
            continue;
        }

        let resolved = resolve_under_root(root, Path::new(pattern))?;
        if resolved.is_file() && is_import_file(&resolved) {
            let key = resolved.to_string_lossy().to_string();
            if seen.insert(key.clone()) {
                out.push(PathBuf::from(key));
            }
        }
    }

    Ok(out)
}

fn parse_ext_pattern(pattern: &str) -> Option<(bool, String)> {
    let pattern = pattern.trim();
    if pattern.starts_with("**/") {
        let rest = &pattern[3..];
        if let Some(ext) = parse_simple_ext_pattern(rest) {
            return Some((true, ext));
        }
    }
    if pattern.contains('/') {
        return None;
    }
    parse_simple_ext_pattern(pattern).map(|ext| (false, ext))
}

fn parse_simple_ext_pattern(pattern: &str) -> Option<String> {
    let pattern = pattern.trim();
    if pattern.starts_with("*.") && pattern.len() > 2 {
        return Some(pattern[2..].to_lowercase());
    }
    None
}

fn collect_model_files_in_root_by_extension(
    root: &Path,
    ext: &str,
    out: &mut Vec<PathBuf>,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    let read_dir = fs::read_dir(root).map_err(|e| e.to_string())?;
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            continue;
        }
        if let Some(file_ext) = path.extension().and_then(|ext| ext.to_str()) {
            if file_ext.eq_ignore_ascii_case(ext) {
                let key = path.to_string_lossy().to_string();
                if seen.insert(key.clone()) {
                    out.push(PathBuf::from(key));
                }
            }
        }
    }
    Ok(())
}

fn collect_model_files_by_extension(
    root: &Path,
    ext: &str,
    out: &mut Vec<PathBuf>,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    let read_dir = fs::read_dir(root).map_err(|e| e.to_string())?;
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_model_files_by_extension(&path, ext, out, seen)?;
            continue;
        }
        if let Some(file_ext) = path.extension().and_then(|ext| ext.to_str()) {
            if file_ext.eq_ignore_ascii_case(ext) {
                let key = path.to_string_lossy().to_string();
                if seen.insert(key.clone()) {
                    out.push(PathBuf::from(key));
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn collect_model_files(root: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    collect_model_files_by_extension(root, "sysml", out, &mut HashSet::new())?;
    collect_model_files_by_extension(root, "kerml", out, &mut HashSet::new())?;
    Ok(())
}
