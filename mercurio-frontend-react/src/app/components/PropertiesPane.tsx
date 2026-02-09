import { useEffect, useState } from "react";
import type { SymbolView } from "../types";

type PropertiesPaneProps = {
  selectedSymbol: SymbolView | null;
  getDoc: (path: string) => { path: string; text: string; dirty: boolean } | null;
  readFile: (path: string) => Promise<string>;
};

const extractSnippet = (
  content: string,
  startLine: number | null | undefined,
  startCol: number | null | undefined,
  endLine: number | null | undefined,
  endCol: number | null | undefined,
  name?: string,
  preferRhs = true,
) => {
  if (startLine == null || endLine == null) return null;
  const lines = content.split(/\r?\n/);
  if (startLine < 0 || endLine < 0 || startLine >= lines.length) return null;
  const lastLine = Math.min(endLine, lines.length - 1);
  const start = Math.max(0, startLine);
  const end = Math.max(start, lastLine);
  if (start === end) {
    const line = lines[start] ?? "";
    const startIdx = Math.max(0, startCol ?? 0);
    const endIdx = endCol == null ? line.length : Math.min(line.length, Math.max(startIdx, endCol));
    const slice = line.slice(startIdx, endIdx);
    if (slice.trim().length && slice.trim().length > ((name?.length ?? 0) + 1)) {
      if (preferRhs) {
        const rhsIndex = slice.indexOf("=");
        if (rhsIndex >= 0) {
          return slice.slice(rhsIndex + 1).trim();
        }
      }
      return slice;
    }
    const fallback = line.trim();
    if (preferRhs) {
      const rhsIndex = fallback.indexOf("=");
      if (rhsIndex >= 0) {
        return fallback.slice(rhsIndex + 1).trim();
      }
    }
    return fallback;
  }
  const chunk = lines.slice(start, end + 1);
  if (chunk.length === 0) return null;
  if (startCol != null) {
    chunk[0] = chunk[0].slice(Math.max(0, startCol));
  }
  if (endCol != null) {
    const lastIndex = chunk.length - 1;
    chunk[lastIndex] = chunk[lastIndex].slice(0, Math.max(0, endCol));
  }
  const joined = chunk.join("\n").trim();
  if (joined.length && joined.length > ((name?.length ?? 0) + 1)) {
    if (preferRhs) {
      const rhsIndex = joined.indexOf("=");
      if (rhsIndex >= 0) {
        return joined.slice(rhsIndex + 1).trim();
      }
    }
    return joined;
  }
  const fallback = lines[start]?.trim() ?? joined;
  if (preferRhs) {
    const rhsIndex = fallback.indexOf("=");
    if (rhsIndex >= 0) {
      return fallback.slice(rhsIndex + 1).trim();
    }
  }
  return fallback;
};

export function PropertiesPane({ selectedSymbol, getDoc, readFile }: PropertiesPaneProps) {
  const [rawSnippet, setRawSnippet] = useState<string | null>(null);
  const [rawLoading, setRawLoading] = useState(false);

  useEffect(() => {
    let active = true;
    const loadSnippet = async () => {
      if (!selectedSymbol || !selectedSymbol.file_path) {
        setRawSnippet(null);
        setRawLoading(false);
        return;
      }
      const cached = getDoc(selectedSymbol.file_path);
      const hasExprRange =
        selectedSymbol.expr_start_line != null &&
        selectedSymbol.expr_start_col != null &&
        selectedSymbol.expr_end_line != null &&
        selectedSymbol.expr_end_col != null;
      const rangeStartLine = hasExprRange ? selectedSymbol.expr_start_line : selectedSymbol.start_line;
      const rangeStartCol = hasExprRange ? selectedSymbol.expr_start_col : selectedSymbol.start_col;
      const rangeEndLine = hasExprRange ? selectedSymbol.expr_end_line : selectedSymbol.end_line;
      const rangeEndCol = hasExprRange ? selectedSymbol.expr_end_col : selectedSymbol.end_col;
      if (cached) {
        const snippet = extractSnippet(
          cached.text,
          rangeStartLine,
          rangeStartCol,
          rangeEndLine,
          rangeEndCol,
          selectedSymbol.name,
          !hasExprRange,
        );
        setRawSnippet(snippet);
        setRawLoading(false);
        return;
      }
      setRawLoading(true);
      try {
        const content = await readFile(selectedSymbol.file_path);
        if (!active) return;
        const snippet = extractSnippet(
          content,
          rangeStartLine,
          rangeStartCol,
          rangeEndLine,
          rangeEndCol,
          selectedSymbol.name,
          !hasExprRange,
        );
        setRawSnippet(snippet);
      } catch {
        if (active) setRawSnippet(null);
      } finally {
        if (active) setRawLoading(false);
      }
    };
    void loadSnippet();
    return () => {
      active = false;
    };
  }, [getDoc, readFile, selectedSymbol]);

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
          <details className="properties-section" key={`raw-${selectedSymbol.qualified_name}`}>
            <summary>Raw source</summary>
            <div className="properties-parse">
              {rawLoading ? (
                <div className="muted">Loading source...</div>
              ) : rawSnippet ? (
                <pre className="properties-raw">{rawSnippet}</pre>
              ) : (
                <div className="muted">No source available.</div>
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
