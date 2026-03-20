use crate::project_root_key::canonical_project_root;
use crate::state::CoreState;
use crate::stdlib::seed_stdlib_index_if_missing;
use crate::workspace_ir_cache::seed_symbol_index_from_workspace_ir_cache;
use mercurio_symbol_index::SymbolIndexStore;

pub(crate) fn seed_symbol_index_if_empty(state: &CoreState, root: &str) -> Result<(), String> {
    let root = canonical_project_root(root);
    let need_seed = {
        let store = state
            .symbol_index
            .lock()
            .map_err(|_| "Symbol index lock poisoned".to_string())?;
        !store.has_project_symbols(&root)
    };
    if need_seed {
        let _ = seed_symbol_index_from_workspace_ir_cache(state, &root)?;
    }
    let _ = seed_stdlib_index_if_missing(state, &root)?;
    Ok(())
}
