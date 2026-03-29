use mercurio_core::{
    compile_workspace_sync, get_project_element_property_sections, AppSettings, CoreState,
};

#[test]
#[ignore]
fn constrainttest_component_owned_attribute_is_populated() {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let root =
        std::env::temp_dir().join(format!("mercurio_constrainttest_property_sections_{stamp}"));
    let project_dir = root.join("project");
    std::fs::create_dir_all(&project_dir).expect("create project dir");

    let source_path = "C:\\dev\\git\\mercurio\\mercurio-sysml\\resources\\examples\\examples\\Simple Tests\\ConstraintTest.sysml";
    let source = std::fs::read_to_string(source_path).expect("read ConstraintTest.sysml");
    let file_path = project_dir.join("ConstraintTest.sysml");
    std::fs::write(&file_path, source).expect("write model file");
    std::fs::write(
        project_dir.join(".project"),
        "{\"name\":\"constrainttest\",\"use_default_library\":true,\"src\":[\"*.sysml\"]}",
    )
    .expect("write descriptor");

    let state = CoreState::new(root.join("unused_stdlib_root"), AppSettings::default());
    let _ = compile_workspace_sync(
        &state,
        project_dir.to_string_lossy().to_string(),
        1,
        true,
        None,
        Vec::new(),
        |_| {},
    )
    .expect("compile workspace");

    let sections = get_project_element_property_sections(
        &state,
        project_dir.to_string_lossy().to_string(),
        "ConstraintTest::Component".to_string(),
        Some(file_path.to_string_lossy().to_string()),
        None,
        None,
    )
    .expect("property sections");

    let owned_attribute = sections
        .sections
        .iter()
        .flat_map(|section| section.rows.iter())
        .find(|row| {
            row.label
                .starts_with("ownedAttribute : AttributeUsage[0..*]")
        })
        .expect("ownedAttribute row");

    assert_eq!(owned_attribute.value, "ConstraintTest::Component::mass");
}
