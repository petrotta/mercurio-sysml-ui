import { useEffect, useMemo, useState } from "react";
import type { SymbolView } from "../types";

type PropertiesPaneProps = {
  selectedSymbols: SymbolView[] | null;
  getDoc: (path: string) => { path: string; text: string; dirty: boolean } | null;
  readFile: (path: string) => Promise<string>;
};

type SnippetState = {
  raw: string | null;
  expr: string | null;
  loading: boolean;
};

const symbolKey = (symbol: SymbolView) =>
  `${symbol.file_path}:${symbol.qualified_name}:${symbol.start_line}:${symbol.start_col}:${symbol.end_line}:${symbol.end_col}`;

const extractSnippet = (
  content: string,
  startLine: number | null | undefined,
  startCol: number | null | undefined,
  endLine: number | null | undefined,
  endCol: number | null | undefined,
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
    const slice = line.slice(startIdx, endIdx).trim();
    return slice.length ? slice : line.trim();
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
  return joined.length ? joined : (lines[start]?.trim() ?? joined);
};

export function PropertiesPane({ selectedSymbols, getDoc, readFile }: PropertiesPaneProps) {
  const [snippets, setSnippets] = useState<Record<string, SnippetState>>({});
  const normalizedSymbols = useMemo(
    () => (selectedSymbols && selectedSymbols.length ? selectedSymbols : null),
    [selectedSymbols],
  );

  useEffect(() => {
    let active = true;
    const loadAll = async () => {
      if (!normalizedSymbols) {
        setSnippets({});
        return;
      }
      const nextState: Record<string, SnippetState> = {};
      normalizedSymbols.forEach((symbol) => {
        nextState[symbolKey(symbol)] = { raw: null, expr: null, loading: true };
      });
      setSnippets(nextState);
      await Promise.all(
        normalizedSymbols.map(async (symbol) => {
          if (!symbol.file_path) return;
          const key = symbolKey(symbol);
          const cached = getDoc(symbol.file_path);
          const rangeStartLine = symbol.start_line;
          const rangeStartCol = symbol.start_col;
          const rangeEndLine = symbol.end_line;
          const rangeEndCol = symbol.end_col;
          const exprRangeStartLine = symbol.expr_start_line;
          const exprRangeStartCol = symbol.expr_start_col;
          const exprRangeEndLine = symbol.expr_end_line;
          const exprRangeEndCol = symbol.expr_end_col;
          const hasExprRange =
            exprRangeStartLine != null &&
            exprRangeStartCol != null &&
            exprRangeEndLine != null &&
            exprRangeEndCol != null;
          const apply = (content: string) => {
            const snippet = extractSnippet(
              content,
              rangeStartLine,
              rangeStartCol,
              rangeEndLine,
              rangeEndCol,
            );
            const expr = hasExprRange
              ? extractSnippet(
                  content,
                  exprRangeStartLine,
                  exprRangeStartCol,
                  exprRangeEndLine,
                  exprRangeEndCol,
                )
              : null;
            if (!active) return;
            setSnippets((prev) => ({
              ...prev,
              [key]: { raw: snippet, expr, loading: false },
            }));
          };
          if (cached) {
            apply(cached.text);
            return;
          }
          try {
            const content = await readFile(symbol.file_path);
            if (!active) return;
            apply(content);
          } catch {
            if (!active) return;
            setSnippets((prev) => ({
              ...prev,
              [key]: { raw: null, expr: null, loading: false },
            }));
          }
        }),
      );
    };
    void loadAll();
    return () => {
      active = false;
    };
  }, [getDoc, readFile, normalizedSymbols]);

  return (
    <div className="properties-pane">
      <div className="properties-header" />
      {normalizedSymbols ? (
        <div className="properties-body">
          {normalizedSymbols.map((symbol, idx) => {
            const key = symbolKey(symbol);
            const snippet = snippets[key];
            return (
              <div key={`${key}-${idx}`} className="properties-block">
                <div className="properties-title">
                  <span>{symbol.name}</span>
                  <span className="model-kind">{symbol.kind}</span>
                </div>
                {symbol.doc ? <div className="properties-doc">{symbol.doc}</div> : null}
                <div className="properties-list">
                  {symbol.properties.length ? (
                    symbol.properties.map((prop, index) => (
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
                  {snippet?.expr ? (
                    <div className="properties-row">
                      <div className="properties-key">Expression</div>
                      <div className="properties-value">{snippet.expr}</div>
                    </div>
                  ) : null}
                </div>
                <details className="properties-section" key={`parse-${symbol.qualified_name}`}>
                  <summary>Parse information</summary>
                  <div className="properties-parse">
                    {symbol.file == null &&
                    symbol.start_line == null &&
                    symbol.start_col == null &&
                    symbol.end_line == null &&
                    symbol.end_col == null ? (
                      <div className="muted">No parse data available.</div>
                    ) : (
                      <>
                        <div className="properties-row">
                          <div className="properties-key">File id</div>
                          <div className="properties-value">
                            {symbol.file == null ? "â€”" : String(symbol.file)}
                          </div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">File path</div>
                          <div className="properties-value">{symbol.file_path ?? "â€”"}</div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">Start line</div>
                          <div className="properties-value">{symbol.start_line ?? "â€”"}</div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">Start column</div>
                          <div className="properties-value">{symbol.start_col ?? "â€”"}</div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">End line</div>
                          <div className="properties-value">{symbol.end_line ?? "â€”"}</div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">End column</div>
                          <div className="properties-value">{symbol.end_col ?? "â€”"}</div>
                        </div>
                      </>
                    )}
                  </div>
                </details>
                <details className="properties-section" key={`raw-${symbol.qualified_name}`}>
                  <summary>Raw source</summary>
                  <div className="properties-parse">
                    {snippet?.loading ? (
                      <div className="muted">Loading source...</div>
                    ) : snippet?.raw ? (
                      <pre className="properties-raw">{snippet.raw}</pre>
                    ) : (
                      <div className="muted">No source available.</div>
                    )}
                  </div>
                </details>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="properties-body">
          <div className="muted">Select a model element to view its properties.</div>
        </div>
      )}
    </div>
  );
}
