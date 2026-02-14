use std::fs;
use std::path::PathBuf;

use syster::ide::AnalysisHost;
use syster::interchange::{
    model_from_symbols, restore_ids_from_symbols, JsonLd, Kpar, ModelFormat, Xmi,
};
use syster::syntax::parser::parse_with_result;

use crate::files::is_path_under_root;
use crate::project::load_project_config;
use crate::stdlib::{load_stdlib_into_host, resolve_stdlib_path};
use crate::workspace::{
    collect_model_files, collect_project_files, collect_project_imports, load_imports_into_host,
};
use crate::CoreState;

pub fn export_model_to_path(
    state: &CoreState,
    root: String,
    output: String,
    format: String,
    include_stdlib: bool,
) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Root path does not exist".to_string());
    }
    let default_stdlib = state
        .settings
        .lock()
        .ok()
        .and_then(|settings| settings.default_stdlib.clone());

    let project_config = load_project_config(&root_path).ok().flatten();
    let mut analysis_host = AnalysisHost::new();

    if let Some(imports) = project_config
        .as_ref()
        .and_then(|config| config.import_entries.as_ref())
    {
        let import_files = collect_project_imports(&root_path, imports)?;
        if !import_files.is_empty() {
            load_imports_into_host(&mut analysis_host, &import_files)?;
        }
    }

    let library_config = project_config
        .as_ref()
        .and_then(|config| config.library.as_ref());
    let stdlib_override = project_config
        .as_ref()
        .and_then(|config| config.stdlib.as_ref());
    let (_stdlib_loader, stdlib_path_for_log) = resolve_stdlib_path(
        &state.stdlib_root,
        default_stdlib.as_deref(),
        library_config,
        stdlib_override,
        &root_path,
    );

    if let Some(stdlib_path) = stdlib_path_for_log.as_ref() {
        let _cache_hit = load_stdlib_into_host(state, &mut analysis_host, stdlib_path)?;
    }

    let mut files = Vec::new();
    let mut used_project_src = false;
    if let Some(config) = project_config.clone() {
        if let Some(src) = config.src {
            files = collect_project_files(&root_path, &src)?;
            used_project_src = true;
        }
    }
    if !used_project_src {
        collect_model_files(&root_path, &mut files)?;
    }

    for path in files.iter() {
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let parse = parse_with_result(&content, path);
        if let Some(syntax) = parse.content {
            analysis_host.set_file(path.to_path_buf(), syntax);
        }
    }

    let analysis = analysis_host.analysis();
    let mut symbols: Vec<_> = analysis.symbol_index().all_symbols().cloned().collect();
    if !include_stdlib {
        if let Some(stdlib_root) = stdlib_path_for_log.as_ref() {
            symbols.retain(|symbol| {
                if let Some(file_path) = analysis.get_file_path(symbol.file) {
                    !is_path_under_root(stdlib_root, file_path)
                } else {
                    true
                }
            });
        }
    }
    let mut model = model_from_symbols(&symbols);
    model = restore_ids_from_symbols(model, analysis.symbol_index());

    let format = match format.to_lowercase().as_str() {
        "sysmlx" | "kermlx" | "xmi" => "xmi",
        "kpar" => "kpar",
        "json" | "jsonld" | "json-ld" => "jsonld",
        other => return Err(format!("Unsupported export format: {}", other)),
    };
    let bytes = match format {
        "xmi" => Xmi.write(&model).map_err(|e| e.to_string())?,
        "kpar" => Kpar.write(&model).map_err(|e| e.to_string())?,
        "jsonld" => JsonLd.write(&model).map_err(|e| e.to_string())?,
        _ => return Err(format!("Unsupported export format: {}", format)),
    };

    fs::write(&output, bytes).map_err(|e| e.to_string())?;
    Ok(())
}
