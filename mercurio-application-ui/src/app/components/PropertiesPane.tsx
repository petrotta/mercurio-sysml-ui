import { useEffect, useMemo, useState } from "react";
import type { ProjectElementAttributesView, SymbolView } from "../types";

type PropertiesPaneProps = {
  selectedSymbols: SymbolView[] | null;
  getDoc: (path: string) => { path: string; text: string; dirty: boolean } | null;
  readFile: (path: string) => Promise<string>;
  onOpenInProjectModel: (symbol: SymbolView) => void;
  onOpenAttributeInProjectModel: (symbol: SymbolView, attrQualifiedName: string, attrName: string) => void;
  onOpenAttributeSourceText: (symbol: SymbolView, attrQualifiedName: string, attrName: string) => void;
  loadElementAttributes: (symbol: SymbolView) => Promise<ProjectElementAttributesView | null>;
};

type SnippetState = {
  raw: string | null;
  expr: string | null;
  loading: boolean;
};

type AttributeContextMenuState = {
  x: number;
  y: number;
  symbol: SymbolView;
  attrQualifiedName: string;
  attrName: string;
};

const symbolKey = (symbol: SymbolView) =>
  `${symbol.file_path}:${symbol.qualified_name}:${symbol.start_line}:${symbol.start_col}:${symbol.end_line}:${symbol.end_col}`;

const normalizeAttrKey = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const propertyValueToText = (value: SymbolView["properties"][number]["value"]): string | null => {
  if ("type" in value && value.type === "text") return value.value ?? null;
  if ("type" in value && value.type === "bool") return value.value ? "true" : "false";
  if ("type" in value && value.type === "number") return String(value.value);
  if ("type" in value && value.type === "list") return value.items.join(", ");
  return null;
};

const resolveFallbackAttrValue = (symbol: SymbolView, attrName: string): string | null => {
  const key = normalizeAttrKey(attrName);
  if (key === "name" && symbol.name) return symbol.name;
  if (key === "qualifiedname" && symbol.qualified_name) return symbol.qualified_name;
  if (key === "kind" && symbol.kind) return symbol.kind;
  const prop = symbol.properties.find(
    (item) => normalizeAttrKey(item.name || "") === key || normalizeAttrKey(item.label || "") === key,
  );
  if (!prop) return null;
  return propertyValueToText(prop.value);
};

const resolveAttributeValue = (
  symbol: SymbolView,
  attrName: string,
  cstValue: string | null | undefined,
): string | null => {
  const raw = cstValue != null && cstValue.trim() ? cstValue : resolveFallbackAttrValue(symbol, attrName);
  if (!raw) return null;
  const value = raw.trim();
  return value.length ? value : null;
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
  onOpenAttributeInProjectModel,
  onOpenAttributeSourceText,
  loadElementAttributes,
}: PropertiesPaneProps) {
  const [snippets, setSnippets] = useState<Record<string, SnippetState>>({});
  const [metatypeAttrs, setMetatypeAttrs] = useState<
    Record<string, { loading: boolean; error: string; data: ProjectElementAttributesView | null }>
  >({});
  const [attributeContextMenu, setAttributeContextMenu] = useState<AttributeContextMenuState | null>(null);
  const normalizedSymbols = useMemo(
    () => (selectedSymbols && selectedSymbols.length ? selectedSymbols : null),
    [selectedSymbols],
  );

  useEffect(() => {
    const onDocClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || !target.closest(".context-menu")) {
        setAttributeContextMenu(null);
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

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

  useEffect(() => {
    let active = true;
    const loadAll = async () => {
      if (!normalizedSymbols) {
        setMetatypeAttrs({});
        return;
      }
      const nextState: Record<
        string,
        { loading: boolean; error: string; data: ProjectElementAttributesView | null }
      > = {};
      normalizedSymbols.forEach((symbol) => {
        nextState[symbolKey(symbol)] = { loading: true, error: "", data: null };
      });
      setMetatypeAttrs(nextState);

      await Promise.all(
        normalizedSymbols.map(async (symbol) => {
          const key = symbolKey(symbol);
          try {
            const data = await loadElementAttributes(symbol);
            if (!active) return;
            setMetatypeAttrs((prev) => ({
              ...prev,
              [key]: { loading: false, error: "", data },
            }));
          } catch (error) {
            if (!active) return;
            setMetatypeAttrs((prev) => ({
              ...prev,
              [key]: { loading: false, error: String(error), data: null },
            }));
          }
        }),
      );
    };

    void loadAll();
    return () => {
      active = false;
    };
  }, [normalizedSymbols, loadElementAttributes]);

  return (
    <div className="properties-pane">
      <div className="properties-header" />
      {normalizedSymbols ? (
        <div className="properties-body">
          {normalizedSymbols.map((symbol, idx) => {
            const key = symbolKey(symbol);
            const snippet = snippets[key];
            const topDocumentation = resolveTopDocumentation(symbol);
            const meta = metatypeAttrs[key];
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
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "inherit",
                      cursor: "pointer",
                      textDecoration: "underline",
                      padding: 0,
                      font: "inherit",
                    }}
                  >
                    {symbol.kind}
                  </button>
                </div>
                {topDocumentation ? <div className="properties-doc">{topDocumentation}</div> : null}
                <div className="properties-list">
                  {baseProperties.map((prop, index) => (
                    <div key={`core-${prop.label}-${index}`} className="properties-row">
                      <div className="properties-key">{prop.label}</div>
                      <div className="properties-value">{prop.value}</div>
                    </div>
                  ))}
                  {dynamicProperties.length ? (
                    dynamicProperties.map((prop, index) => (
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
                    <div className="muted">No additional properties.</div>
                  )}
                  {snippet?.expr ? (
                    <div className="properties-row">
                      <div className="properties-key">Expression</div>
                      <div className="properties-value">{snippet.expr}</div>
                    </div>
                  ) : null}
                </div>
                <details className="properties-section" key={`meta-${symbol.qualified_name}`} open>
                  <summary>Metatype attributes</summary>
                  <div className="properties-parse">
                    {meta?.loading ? <div className="muted">Loading metatype attributes...</div> : null}
                    {!meta?.loading && meta?.error ? <div className="muted">{meta.error}</div> : null}
                    {!meta?.loading && !meta?.error && !meta?.data ? (
                      <div className="muted">No metatype attribute data.</div>
                    ) : null}
                    {!meta?.loading && meta?.data ? (
                      <>
                        <div className="properties-row">
                          <div className="properties-key">Metatype</div>
                          <div className="properties-value">{meta.data.metatype_qname || "unresolved"}</div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">Explicit attrs</div>
                          <div className="properties-value">{meta.data.explicit_attributes.length}</div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">Inherited attrs</div>
                          <div className="properties-value">{meta.data.inherited_attributes.length}</div>
                        </div>
                        {meta.data.explicit_attributes.map((attr) => {
                          const value = resolveAttributeValue(symbol, attr.name, attr.cst_value);
                          return (
                            <div
                              key={`explicit-${attr.qualified_name}`}
                              className={`properties-row ${value ? "" : "properties-row-empty"}`}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setAttributeContextMenu({
                                  x: event.clientX,
                                  y: event.clientY,
                                  symbol,
                                  attrQualifiedName: attr.qualified_name,
                                  attrName: attr.name,
                                });
                              }}
                            >
                              <div className="properties-key" />
                              <div className="properties-value">
                                {attr.name}
                                {value ? ` = ${value}` : ""}
                                {attr.declared_type ? `: ${attr.declared_type}` : ""}
                                {attr.multiplicity ? ` ${attr.multiplicity}` : ""}
                              </div>
                            </div>
                          );
                        })}
                        {meta.data.inherited_attributes.map((attr) => {
                          const value = resolveAttributeValue(symbol, attr.name, attr.cst_value);
                          return (
                            <div
                              key={`inherited-${attr.qualified_name}`}
                              className={`properties-row ${value ? "" : "properties-row-empty"}`}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setAttributeContextMenu({
                                  x: event.clientX,
                                  y: event.clientY,
                                  symbol,
                                  attrQualifiedName: attr.qualified_name,
                                  attrName: attr.name,
                                });
                              }}
                            >
                              <div className="properties-key" />
                              <div className="properties-value">
                                ^{attr.name}
                                {value ? ` = ${value}` : ""}
                                {attr.declared_type ? `: ${attr.declared_type}` : ""}
                                {attr.multiplicity ? ` ${attr.multiplicity}` : ""}
                                {` (from ${attr.declared_on})`}
                              </div>
                            </div>
                          );
                        })}
                        {meta.data.diagnostics.map((line, i) => (
                          <div key={`meta-diag-${i}`} className="properties-row">
                            <div className="properties-key">Diagnostic</div>
                            <div className="properties-value">{line}</div>
                          </div>
                        ))}
                      </>
                    ) : null}
                  </div>
                </details>
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
                            {symbol.file == null ? "—" : String(symbol.file)}
                          </div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">File path</div>
                          <div className="properties-value">{symbol.file_path ?? "—"}</div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">Start line</div>
                          <div className="properties-value">{symbol.start_line ?? "—"}</div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">Start column</div>
                          <div className="properties-value">{symbol.start_col ?? "—"}</div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">End line</div>
                          <div className="properties-value">{symbol.end_line ?? "—"}</div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">End column</div>
                          <div className="properties-value">{symbol.end_col ?? "—"}</div>
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
      {attributeContextMenu ? (
        <div className="context-menu" style={{ left: attributeContextMenu.x, top: attributeContextMenu.y }}>
          <button
            type="button"
            onClick={() => {
              onOpenAttributeInProjectModel(
                attributeContextMenu.symbol,
                attributeContextMenu.attrQualifiedName,
                attributeContextMenu.attrName,
              );
              setAttributeContextMenu(null);
            }}
          >
            Open in Model Browser
          </button>
          <button
            type="button"
            onClick={() => {
              onOpenAttributeSourceText(
                attributeContextMenu.symbol,
                attributeContextMenu.attrQualifiedName,
                attributeContextMenu.attrName,
              );
              setAttributeContextMenu(null);
            }}
          >
            Open Source Text
          </button>
        </div>
      ) : null}
    </div>
  );
}
