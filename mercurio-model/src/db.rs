use salsa;

use crate::{FileId, WorkspaceId};

#[salsa::input]
pub struct FileText {
    pub file: FileId,
    #[return_ref]
    pub text: String,
}

#[salsa::input]
pub struct FilePath {
    pub file: FileId,
    #[return_ref]
    pub path: String,
}

#[salsa::input]
pub struct WorkspaceFiles {
    pub ws: WorkspaceId,
    #[return_ref]
    pub files: Vec<FileText>,
    #[return_ref]
    pub paths: Vec<FilePath>,
}

#[salsa::db]
#[derive(Default, Clone)]
pub struct Db {
    storage: salsa::Storage<Self>,
}

#[salsa::db]
impl salsa::Database for Db {
    fn salsa_event(&self, _event: &dyn Fn() -> salsa::Event) {}
}
