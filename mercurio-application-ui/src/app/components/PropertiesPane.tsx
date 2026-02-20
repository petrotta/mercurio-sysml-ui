import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { SymbolView } from "../types";

type PropertiesPaneProps = {
  selectedSymbols: SymbolView[] | null;
  getDoc: (path: string) => { path: string; text: string; dirty: boolean } | null;
  readFile: (path: string) => Promise<string>;
  onOpenInProjectModel: (symbol: SymbolView) => void;
  onOpenQualifiedNameInSource: (qualifiedName: string) => void;
};

type SnippetState = {
  expr: string | null;
};

const symbolKey = (symbol: SymbolView) =>
  `${symbol.file_path}:${symbol.qualified_name}:${symbol.start_line}:${symbol.start_col}:${symbol.end_line}:${symbol.end_col}`;
const QUALIFIED_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)+$/;

const isQualifiedName = (value: string | null | undefined): value is string =>
  Boolean(value && QUALIFIED_NAME_PATTERN.test(value.trim()));

const propertyValueToText = (value: SymbolView["properties"][number]["value"]): string | null => {
  if ("type" in value && value.type === "text") return value.value ?? null;
  if ("type" in value && value.type === "bool") return value.value ? "true" : "false";
  if ("type" in value && value.type === "number") return String(value.value);
  return null;
};

const resolveTopDocumentation = (symbol: SymbolView): string | null => {
  if (symbol.doc && symbol.doc.trim()) return symbol.doc;
  const docProp = symbol.properties.find((prop) => {
    const key = (prop.name || "").toLowerCase();
    const label = (prop.label || "").toLowerCase();
    return key === "documentation" || label === "documentation" || key === "doc" || label === "doc";
  });
  if (!docProp || docProp.value.type !== "text") return null;
  const text = (docProp.value.value || "").trim();
  return text ? text : null;
};

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

export function PropertiesPane({
  selectedSymbols,
  getDoc,
  readFile,
  onOpenInProjectModel,
  onOpenQualifiedNameInSource,
}: PropertiesPaneProps) {
  const [snippets, setSnippets] = useState<Record<string, SnippetState>>({});
  const [keyColumnPercent, setKeyColumnPercent] = useState(32);
  const linkButtonStyle = {
    border: "none",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    textDecoration: "underline",
    padding: 0,
    font: "inherit",
  } as const;
  const normalizedSymbols = useMemo(
    () => (selectedSymbols && selectedSymbols.length ? selectedSymbols : null),
    [selectedSymbols],
  );
  const renderPropertyValue = (value: string | null): ReactNode => {
    const text = value?.trim() || "";
    if (!text) return null;
    if (!isQualifiedName(text)) return text;
    return (
      <button
        type="button"
        className="model-kind"
        onClick={() => onOpenQualifiedNameInSource(text)}
        title={`Open ${text} source`}
        style={linkButtonStyle}
      >
        {text}
      </button>
    );
  };

  useEffect(() => {
    let active = true;
    const loadAll = async () => {
      if (!normalizedSymbols) {
        setSnippets({});
        return;
      }
      const nextState: Record<string, SnippetState> = {};
      normalizedSymbols.forEach((symbol) => {
        nextState[symbolKey(symbol)] = { expr: null };
      });
      setSnippets(nextState);

      await Promise.all(
        normalizedSymbols.map(async (symbol) => {
          if (!symbol.file_path) return;
          const key = symbolKey(symbol);
          const cached = getDoc(symbol.file_path);
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
              [key]: { expr },
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
              [key]: { expr: null },
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
    <div className="properties-pane" style={{ ["--properties-key-col" as string]: `${keyColumnPercent}%` }}>
      <div className="properties-header">
        <label className="properties-split-control">
          Split
          <input
            type="range"
            min={20}
            max={50}
            step={1}
            value={keyColumnPercent}
            onChange={(event) => setKeyColumnPercent(Number(event.target.value))}
            aria-label="Adjust properties key/value split"
          />
        </label>
      </div>
      {normalizedSymbols ? (
        <div className="properties-body">
          {normalizedSymbols.map((symbol, idx) => {
            const key = symbolKey(symbol);
            const snippet = snippets[key];
            const topDocumentation = resolveTopDocumentation(symbol);
            const baseProperties = [
              { label: "Kind", value: symbol.kind || "n/a" },
              { label: "Qualified name", value: symbol.qualified_name || "n/a" },
              { label: "File", value: symbol.file_path || "n/a" },
              {
                label: "Span",
                value: `${symbol.start_line ?? 0}:${symbol.start_col ?? 0} - ${symbol.end_line ?? 0}:${symbol.end_col ?? 0}`,
              },
            ];
            const dynamicProperties = Array.isArray(symbol.properties) ? symbol.properties : [];
            return (
              <div key={`${key}-${idx}`} className="properties-block">
                <div className="properties-title">
                  <span>{symbol.name}</span>
                  <button
                    type="button"
                    className="model-kind"
                    onClick={() => onOpenInProjectModel(symbol)}
                    title="Open in Project Model"
                    style={linkButtonStyle}
                  >
                    {symbol.kind}
                  </button>
                </div>
                {topDocumentation ? <div className="properties-doc">{topDocumentation}</div> : null}
                <details className="properties-section" key={`element-${symbol.qualified_name}`} open>
                  <summary>Element details</summary>
                  <div className="properties-parse">
                    <div className="properties-row properties-row-header">
                      <div className="properties-key properties-key-header">Key</div>
                      <div className="properties-value properties-value-header">Value</div>
                    </div>
                    {baseProperties.map((prop, index) => (
                      <div key={`core-${prop.label}-${index}`} className="properties-row">
                        <div className="properties-key">{prop.label}</div>
                        <div className="properties-value">{renderPropertyValue(prop.value)}</div>
                      </div>
                    ))}
                    {dynamicProperties.length ? (
                      dynamicProperties.map((prop, index) => (
                        <div key={`${prop.name}-${index}`} className="properties-row">
                          <div className="properties-key">{prop.label}</div>
                          <div className="properties-value">
                            {"type" in prop.value && prop.value.type === "list"
                              ? prop.value.items.map((item, itemIndex) => (
                                  <div key={`${prop.name}-${index}-${itemIndex}`}>{renderPropertyValue(item)}</div>
                                ))
                              : renderPropertyValue(propertyValueToText(prop.value))}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="muted">No additional properties.</div>
                    )}
                    {snippet?.expr ? (
                      <div className="properties-row">
                        <div className="properties-key">Expression</div>
                        <div className="properties-value">{renderPropertyValue(snippet.expr)}</div>
                      </div>
                    ) : null}
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
