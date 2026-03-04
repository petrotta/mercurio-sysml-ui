use crate::state::CoreState;
use crate::workspace_ir_cache::seed_symbol_index_from_workspace_ir_cache;
use mercurio_symbol_index::SymbolIndexStore;

pub(crate) fn seed_symbol_index_if_empty(state: &CoreState, root: &str) -> Result<(), String> {
    let need_seed = {
        let store = state
            .symbol_index
            .lock()
            .map_err(|_| "Symbol index lock poisoned".to_string())?;
        store.project_symbols(root, None).is_empty()
    };
    if need_seed {
        let _ = seed_symbol_index_from_workspace_ir_cache(state, root)?;
    }
    Ok(())
}
