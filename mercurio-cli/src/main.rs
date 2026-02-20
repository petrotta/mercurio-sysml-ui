use clap::{Parser, Subcommand};
use mercurio_core::{
    compile_workspace_sync,
    ensure_mercurio_paths,
    export_model_to_path,
    get_parse_errors,
    get_parse_errors_for_content,
    read_diagram,
    write_diagram,
    load_app_settings,
    CompileResponse,
    CoreState,
    DiagramFile,
    UnsavedFile,
};
use std::fs;
use std::io::{self, Read};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "mercurio-cli", version, about = "Mercurio CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Compile {
        #[arg(long)]
        root: String,
        #[arg(long)]
        allow_parse_errors: bool,
        #[arg(long, default_value_t = 0)]
        run_id: u64,
    },
    Parse {
        #[arg(long)]
        path: String,
        #[arg(long)]
        content: Option<String>,
    },
    Symbols {
        #[arg(long)]
        root: String,
        #[arg(long)]
        file: Option<String>,
        #[arg(long)]
        allow_parse_errors: bool,
        #[arg(long, default_value_t = 0)]
        run_id: u64,
    },
    DiagramRead {
        #[arg(long)]
        root: String,
        #[arg(long)]
        path: String,
    },
    DiagramWrite {
        #[arg(long)]
        root: String,
        #[arg(long)]
        path: String,
        #[arg(long)]
        input: Option<String>,
    },
    Export {
        #[arg(long)]
        root: String,
        #[arg(long)]
        output: String,
        #[arg(long, default_value = "jsonld")]
        format: String,
        #[arg(long)]
        include_stdlib: bool,
    },
}

fn main() {
    let cli = Cli::parse();
    let paths = match ensure_mercurio_paths() {
        Ok(paths) => paths,
        Err(err) => {
            eprintln!("Failed to resolve Mercurio paths: {err}");
            std::process::exit(1);
        }
    };
    let settings = load_app_settings(&paths.settings_path);
    let state = CoreState::new(paths.stdlib_root, settings);

    match cli.command {
        Commands::Compile { root, allow_parse_errors, run_id } => {
            let result = compile_workspace_sync(
                &state,
                root,
                run_id,
                allow_parse_errors,
                None,
                Vec::<UnsavedFile>::new(),
                |_| {},
            );
            match result {
                Ok(payload) => {
                    let json = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string());
                    println!("{json}");
                }
                Err(err) => {
                    eprintln!("Compile failed: {err}");
                    std::process::exit(1);
                }
            }
        }
        Commands::Parse { path, content } => {
            let path_buf = PathBuf::from(&path);
            let result = match content {
                Some(value) => get_parse_errors_for_content(&path_buf, &value),
                None => get_parse_errors(&path_buf),
            };
            match result {
                Ok(payload) => {
                    let json = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string());
                    println!("{json}");
                }
                Err(err) => {
                    eprintln!("Parse failed: {err}");
                    std::process::exit(1);
                }
            }
        }
        Commands::Symbols { root, file, allow_parse_errors, run_id } => {
            let target_path = file.as_ref().map(PathBuf::from);
            let result = compile_workspace_sync(
                &state,
                root,
                run_id,
                allow_parse_errors,
                target_path,
                Vec::<UnsavedFile>::new(),
                |_| {},
            );
            match result {
                Ok(payload) => {
                    let filtered = filter_symbols(payload, file.as_deref());
                    let json = serde_json::to_string_pretty(&filtered).unwrap_or_else(|_| "{}".to_string());
                    println!("{json}");
                }
                Err(err) => {
                    eprintln!("Symbols failed: {err}");
                    std::process::exit(1);
                }
            }
        }
        Commands::DiagramRead { root, path } => {
            let root_path = PathBuf::from(root);
            let path = PathBuf::from(path);
            match read_diagram(&root_path, &path) {
                Ok(diagram) => {
                    let json = serde_json::to_string_pretty(&diagram).unwrap_or_else(|_| "{}".to_string());
                    println!("{json}");
                }
                Err(err) => {
                    eprintln!("Diagram read failed: {err}");
                    std::process::exit(1);
                }
            }
        }
        Commands::DiagramWrite { root, path, input } => {
            let root_path = PathBuf::from(root);
            let target = PathBuf::from(path);
            let payload = match input {
                Some(path) => fs::read_to_string(path).map_err(|e| e.to_string()),
                None => read_stdin_to_string().map_err(|e| e.to_string()),
            };
            let payload = match payload {
                Ok(value) => value,
                Err(err) => {
                    eprintln!("Diagram write failed: {err}");
                    std::process::exit(1);
                }
            };
            let diagram: DiagramFile = match serde_json::from_str(&payload) {
                Ok(value) => value,
                Err(err) => {
                    eprintln!("Diagram write failed: {err}");
                    std::process::exit(1);
                }
            };
            if let Err(err) = write_diagram(&root_path, &target, diagram) {
                eprintln!("Diagram write failed: {err}");
                std::process::exit(1);
            }
        }
        Commands::Export { root, output, format, include_stdlib } => {
            if let Err(err) = export_model_to_path(&state, root, output, format, include_stdlib) {
                eprintln!("Export failed: {err}");
                std::process::exit(1);
            }
        }
    }
}

fn read_stdin_to_string() -> io::Result<String> {
    let mut buf = String::new();
    let mut stdin = io::stdin();
    stdin.read_to_string(&mut buf)?;
    Ok(buf)
}

fn filter_symbols(mut response: CompileResponse, file: Option<&str>) -> CompileResponse {
    if let Some(filter) = file {
        response.symbols = response
            .symbols
            .into_iter()
            .filter(|symbol| symbol.file_path == filter)
            .collect();
        response.files = response
            .files
            .into_iter()
            .filter(|file_result| file_result.path == filter)
            .collect();
        response.unresolved = response
            .unresolved
            .into_iter()
            .filter(|unresolved| unresolved.file_path == filter)
            .collect();
    }
    response
}
