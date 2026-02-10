use std::path::{Path, PathBuf};

use syster::ide::AnalysisHost;
use syster::project::StdLibLoader;
use syster::syntax::SyntaxFile;

use crate::state::{CoreState, StdlibCache};

pub(crate) fn load_stdlib_cached(
    state: &CoreState,
    stdlib_path: &Path,
) -> Result<Vec<(PathBuf, SyntaxFile)>, String> {
    let mut guard = state
        .stdlib_cache
        .lock()
        .map_err(|_| "Stdlib cache lock poisoned".to_string())?;
    if let Some(cache) = guard.as_ref() {
        if cache.path == stdlib_path {
            return Ok(cache.files.clone());
        }
    }

    let mut host = AnalysisHost::new();
    let loader = StdLibLoader::with_path(stdlib_path.to_path_buf());
    loader.load_into_host(&mut host)?;
    let files = host
        .files()
        .iter()
        .map(|(path, file)| (path.clone(), file.clone()))
        .collect::<Vec<_>>();
    *guard = Some(StdlibCache {
        path: stdlib_path.to_path_buf(),
        files: files.clone(),
    });
    Ok(files)
}
