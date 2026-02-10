use mercurio_model::*;

fn setup_db(text: &str) -> (Db, FileText, FilePath, WorkspaceFiles) {
    let mut db = Db::default();
    let file_id = FileId(1);
    let file_text = FileText::new(&mut db, file_id, text.to_string());
    let file_path = FilePath::new(&mut db, file_id, "test.sysml".to_string());
    let ws_files = WorkspaceFiles::new(&mut db, WorkspaceId(1), vec![file_text], vec![file_path]);
    (db, file_text, file_path, ws_files)
}

fn find_element_by_name(index: &FileIndex, name: &str) -> Option<ElementInfo> {
    index.elements.iter().find(|el| el.name == name).cloned()
}

#[test]
fn derived_types_and_attributes() {
    let text = r#"
part def Base {
  attribute a : Real;
}

part def Sub : Base {
  attribute b : Real;
}

part def Sub2 : Sub {
}
"#;
    let (db, _file_text, _file_path, ws_files) = setup_db(text);
    let ws_index = workspace_index(&db, ws_files);
    let base = *ws_index.type_by_qname.get("Base").expect("Base");
    let derived = derived_types(&db, ws_files, base);
    assert!(derived.iter().any(|ty| ty.element.id.0 != base.element.id.0));

    let owned = owned_attributes(&db, ws_files, base);
    assert!(!owned.is_empty());

    let sub2 = *ws_index.type_by_qname.get("Sub2").expect("Sub2");
    let all = all_attributes(&db, ws_files, sub2);
    assert!(all.len() >= owned.len());
}

#[test]
fn patch_helpers() {
    let text = r#"
part def Base {
  attribute a : Real;
}
"#;
    let (db, file_text, file_path, _ws_files) = setup_db(text);
    let index = file_index(&db, file_text, file_path);
    let base = find_element_by_name(&index, "Base").expect("Base element");

    let rename = rename_element_patch(text, &base, "Base2");
    let renamed = apply_patch(text, &rename);
    assert!(renamed.contains("Base2"));

    let add_attr = add_attribute_patch(text, &base, "attribute c : Real;").expect("add attr patch");
    let updated = apply_patch(text, &add_attr);
    assert!(updated.contains("attribute c : Real;"));
}
