import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { SymbolView } from "../types";

type PropertiesPaneProps = {
  selectedSymbols: SymbolView[] | null;
  onOpenInProjectModel: (symbol: SymbolView) => void;
  onOpenQualifiedNameInSource: (qualifiedName: string) => void;
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

export function PropertiesPane({
  selectedSymbols,
  onOpenInProjectModel,
  onOpenQualifiedNameInSource,
}: PropertiesPaneProps) {
  const [keyColumnPercent, setKeyColumnPercent] = useState(32);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const splitDragActiveRef = useRef(false);
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
  const updateKeySplitFromClientX = useCallback((clientX: number) => {
    const rect = paneRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const nextPercent = Math.round(((clientX - rect.left) / rect.width) * 100);
    setKeyColumnPercent(Math.max(20, Math.min(60, nextPercent)));
  }, []);
  const startKeySplitDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      splitDragActiveRef.current = true;
      updateKeySplitFromClientX(event.clientX);
    },
    [updateKeySplitFromClientX],
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
    const onPointerMove = (event: PointerEvent) => {
      if (!splitDragActiveRef.current) return;
      updateKeySplitFromClientX(event.clientX);
    };
    const onPointerUp = () => {
      splitDragActiveRef.current = false;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [updateKeySplitFromClientX]);

  return (
    <div ref={paneRef} className="properties-pane" style={{ ["--properties-key-col" as string]: `${keyColumnPercent}%` }}>
      {normalizedSymbols ? (
        <div className="properties-body">
          {normalizedSymbols.map((symbol, idx) => {
            const key = symbolKey(symbol);
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
                  <summary>Semantic properties</summary>
                  <div className="properties-parse">
                    <div className="properties-row properties-row-header">
                      <div className="properties-key properties-key-header">
                        Key
                        <div
                          className="properties-header-divider"
                          onPointerDown={startKeySplitDrag}
                          title="Drag to resize key/value split"
                        />
                      </div>
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
