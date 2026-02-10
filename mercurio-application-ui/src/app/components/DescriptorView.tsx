type DescriptorViewProps = {
  descriptorViewMode: "view" | "json";
  projectDescriptor: {
    name?: string | null;
    author?: string | null;
    description?: string | null;
    organization?: string | null;
    default_library: boolean;
    stdlib?: string | null;
    library?: { path: string } | string | null;
    src?: string[];
    import_entries?: string[];
    raw_json?: string;
  } | null;
};

export function DescriptorView({ descriptorViewMode, projectDescriptor }: DescriptorViewProps) {
  return (
    <div className="descriptor-view">
      <div className="descriptor-header">Project Descriptor</div>
      {descriptorViewMode === "view" ? (
        projectDescriptor ? (
          <div className="descriptor-grid">
            <div className="descriptor-row">
              <div className="descriptor-label">Name</div>
              <div className="descriptor-value">{projectDescriptor.name || "—"}</div>
            </div>
            <div className="descriptor-row">
              <div className="descriptor-label">Author</div>
              <div className="descriptor-value">{projectDescriptor.author || "—"}</div>
            </div>
            <div className="descriptor-row">
              <div className="descriptor-label">Organization</div>
              <div className="descriptor-value">{projectDescriptor.organization || "—"}</div>
            </div>
            <div className="descriptor-row">
              <div className="descriptor-label">Description</div>
              <div className="descriptor-value">{projectDescriptor.description || "—"}</div>
            </div>
            <div className="descriptor-row">
              <div className="descriptor-label">Default library</div>
              <div className="descriptor-value">{projectDescriptor.default_library ? "Yes" : "No"}</div>
            </div>
            <div className="descriptor-row">
              <div className="descriptor-label">Stdlib</div>
              <div className="descriptor-value">{projectDescriptor.stdlib || "â€”"}</div>
            </div>
            <div className="descriptor-row">
              <div className="descriptor-label">Library Path</div>
              <div className="descriptor-value">
                {typeof projectDescriptor.library === "object" && projectDescriptor.library ? projectDescriptor.library.path : typeof projectDescriptor.library === "string" ? projectDescriptor.library : "â€”"}
              </div>
            </div>
            <div className="descriptor-row">
              <div className="descriptor-label">Files</div>
              <div className="descriptor-value">
                {projectDescriptor.src && projectDescriptor.src.length ? projectDescriptor.src.join(", ") : "â€”"}
              </div>
            </div>
            <div className="descriptor-row">
              <div className="descriptor-label">Libraries</div>
              <div className="descriptor-value">
                {projectDescriptor.import_entries && projectDescriptor.import_entries.length ? projectDescriptor.import_entries.join(", ") : "â€”"}
              </div>
            </div>
          </div>
        ) : (
          <div className="muted">No project descriptor found.</div>
        )
      ) : (
        <pre className="descriptor-json">
          {projectDescriptor?.raw_json || "{}"}
        </pre>
      )}
    </div>
  );
}
