type DescriptorViewProps = {
  descriptorViewMode: "view" | "json";
  projectDescriptor: {
    name?: string | null;
    author?: string | null;
    description?: string | null;
    organization?: string | null;
    default_library: boolean;
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
