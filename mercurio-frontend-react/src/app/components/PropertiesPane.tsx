import type { SymbolView } from "../types";

type PropertiesPaneProps = {
  selectedSymbol: SymbolView | null;
};

export function PropertiesPane({ selectedSymbol }: PropertiesPaneProps) {
  return (
    <div className="properties-pane">
      <div className="properties-header" />
      {selectedSymbol ? (
        <div className="properties-body">
          <div className="properties-title">
            <span>{selectedSymbol.name}</span>
            <span className="model-kind">{selectedSymbol.kind}</span>
          </div>
          {selectedSymbol.doc ? <div className="properties-doc">{selectedSymbol.doc}</div> : null}
          <div className="properties-list">
            {selectedSymbol.properties.length ? (
              selectedSymbol.properties.map((prop, index) => (
                <div key={`${prop.name}-${index}`} className="properties-row">
                  <div className="properties-key">{prop.label}</div>
                  <div className="properties-value">
                    {"type" in prop.value && prop.value.type === "text" ? prop.value.value : null}
                    {"type" in prop.value && prop.value.type === "bool" ? (prop.value.value ? "true" : "false") : null}
                    {"type" in prop.value && prop.value.type === "number" ? String(prop.value.value) : null}
                    {"type" in prop.value && prop.value.type === "list" ? prop.value.items.join(", ") : null}
                  </div>
                </div>
              ))
            ) : (
              <div className="muted">No properties.</div>
            )}
          </div>
          <details className="properties-section" key={`parse-${selectedSymbol.qualified_name}`}>
            <summary>Parse information</summary>
            <div className="properties-parse">
              {selectedSymbol.file == null &&
              selectedSymbol.start_line == null &&
              selectedSymbol.start_col == null &&
              selectedSymbol.end_line == null &&
              selectedSymbol.end_col == null ? (
                <div className="muted">No parse data available.</div>
              ) : (
                <>
                  <div className="properties-row">
                    <div className="properties-key">File id</div>
                    <div className="properties-value">
                      {selectedSymbol.file == null ? "—" : String(selectedSymbol.file)}
                    </div>
                  </div>
                  <div className="properties-row">
                    <div className="properties-key">File path</div>
                    <div className="properties-value">{selectedSymbol.file_path ?? "—"}</div>
                  </div>
                  <div className="properties-row">
                    <div className="properties-key">Start line</div>
                    <div className="properties-value">{selectedSymbol.start_line ?? "—"}</div>
                  </div>
                  <div className="properties-row">
                    <div className="properties-key">Start column</div>
                    <div className="properties-value">{selectedSymbol.start_col ?? "—"}</div>
                  </div>
                  <div className="properties-row">
                    <div className="properties-key">End line</div>
                    <div className="properties-value">{selectedSymbol.end_line ?? "—"}</div>
                  </div>
                  <div className="properties-row">
                    <div className="properties-key">End column</div>
                    <div className="properties-value">{selectedSymbol.end_col ?? "—"}</div>
                  </div>
                </>
              )}
            </div>
          </details>
        </div>
      ) : (
        <div className="properties-body">
          <div className="muted">Select a model element to view its properties.</div>
        </div>
      )}
    </div>
  );
}
