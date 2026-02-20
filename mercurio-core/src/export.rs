use crate::CoreState;

pub fn export_model_to_path(
    _state: &CoreState,
    _root: String,
    _output: String,
    _format: String,
    _include_stdlib: bool,
) -> Result<(), String> {
    Err("Export is unavailable in the no-parser-export build.".to_string())
}

