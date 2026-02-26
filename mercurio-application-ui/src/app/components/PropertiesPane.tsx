import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { callTool } from "../agentClient";
import type { ProjectElementAttributesView, SymbolView } from "../types";

type PropertiesPaneProps = {
  rootPath: string;
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

const symbolMetatype = (symbol: SymbolView): string | null => {
  for (const prop of symbol.properties || []) {
    const name = (prop.name || "").toLowerCase();
    if (name !== "metatype_qname" && name !== "emf::metatype" && name !== "element::metatype") {
      continue;
    }
    const text = propertyValueToText(prop.value)?.trim() || "";
    if (text) return text;
  }
  return null;
};

type SemanticAttributeLoadState = {
  loading: boolean;
  error?: string;
  data?: ProjectElementAttributesView;
};

const summarizeSemanticAttribute = (attr: {
  declared_type?: string | null;
  multiplicity?: string | null;
  direction?: string | null;
  cst_value?: string | null;
  documentation?: string | null;
}): string => {
  const parts = [
    attr.cst_value?.trim() ? `value=${attr.cst_value.trim()}` : "",
    attr.declared_type?.trim() ? `type=${attr.declared_type.trim()}` : "",
    attr.multiplicity?.trim() ? `mult=${attr.multiplicity.trim()}` : "",
    attr.direction?.trim() ? `dir=${attr.direction.trim()}` : "",
  ].filter(Boolean);
  if (parts.length) return parts.join(" | ");
  const doc = attr.documentation?.trim();
  return doc || "inherited semantic attribute";
};

export function PropertiesPane({
  rootPath,
  selectedSymbols,
  onOpenInProjectModel,
  onOpenQualifiedNameInSource,
}: PropertiesPaneProps) {
  const [keyColumnPercent, setKeyColumnPercent] = useState(32);
  const [semanticAttrsBySymbol, setSemanticAttrsBySymbol] = useState<Record<string, SemanticAttributeLoadState>>({});
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

  useEffect(() => {
    let cancelled = false;
    if (!normalizedSymbols?.length || !rootPath) {
      setSemanticAttrsBySymbol({});
      return () => {
        cancelled = true;
      };
    }
    const nextState = normalizedSymbols.reduce<Record<string, SemanticAttributeLoadState>>((acc, symbol) => {
      acc[symbolKey(symbol)] = { loading: true };
      return acc;
    }, {});
    setSemanticAttrsBySymbol(nextState);

    void Promise.all(
      normalizedSymbols.map(async (symbol) => {
        const key = symbolKey(symbol);
        if (!symbol.qualified_name || symbol.source_scope === "library") {
          return [key, { loading: false }] as const;
        }
        try {
          const data = await callTool<ProjectElementAttributesView>("core.get_project_element_attributes@v1", {
            root: rootPath,
            element_qualified_name: symbol.qualified_name,
            symbol_kind: symbol.kind,
          });
          return [key, { loading: false, data }] as const;
        } catch (error) {
          return [key, { loading: false, error: String(error) }] as const;
        }
      }),
    ).then((rows) => {
      if (cancelled) return;
      const merged = rows.reduce<Record<string, SemanticAttributeLoadState>>((acc, [key, state]) => {
        acc[key] = state;
        return acc;
      }, {});
      setSemanticAttrsBySymbol(merged);
    });

    return () => {
      cancelled = true;
    };
  }, [normalizedSymbols, rootPath]);

  return (
    <div ref={paneRef} className="properties-pane" style={{ ["--properties-key-col" as string]: `${keyColumnPercent}%` }}>
      {normalizedSymbols ? (
        <div className="properties-body">
          {normalizedSymbols.map((symbol, idx) => {
            const key = symbolKey(symbol);
            const topDocumentation = resolveTopDocumentation(symbol);
            const semanticState = semanticAttrsBySymbol[key];
            const semantic = semanticState?.data;
            const metatypeDiagnostic =
              semantic?.diagnostics?.find((line) => line.toLowerCase().includes("metatype")) || null;
            const resolvedMetatype = semantic?.metatype_qname || symbolMetatype(symbol) || "unresolved";
            const baseProperties = [
              { label: "Kind", value: symbol.kind || "n/a" },
              { label: "Qualified name", value: symbol.qualified_name || "n/a" },
              { label: "File", value: symbol.file_path || "n/a" },
              { label: "Metatype", value: resolvedMetatype },
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
                    {metatypeDiagnostic ? (
                      <div className="properties-row">
                        <div className="properties-key">Metatype diagnostic</div>
                        <div className="properties-value">{metatypeDiagnostic}</div>
                      </div>
                    ) : null}
                    {semanticState?.loading ? <div className="muted">Loading semantic attributes...</div> : null}
                    {semanticState?.error ? <div className="muted">{semanticState.error}</div> : null}
                    {semantic?.explicit_attributes?.map((attr) => (
                      <div key={`explicit-${attr.qualified_name}`} className="properties-row">
                        <div className="properties-key">{`explicit::${attr.name}`}</div>
                        <div className="properties-value">{renderPropertyValue(summarizeSemanticAttribute(attr))}</div>
                      </div>
                    ))}
                    {semantic?.inherited_attributes?.map((attr) => (
                      <div key={`inherited-${attr.declared_on}-${attr.name}`} className="properties-row">
                        <div className="properties-key">{`inherited::${attr.name} (${attr.declared_on})`}</div>
                        <div className="properties-value">{renderPropertyValue(summarizeSemanticAttribute(attr))}</div>
                      </div>
                    ))}
                    {!semanticState?.loading &&
                    !semanticState?.error &&
                    (!semantic || (!semantic.explicit_attributes.length && !semantic.inherited_attributes.length)) ? (
                      <div className="muted">No semantic attributes available.</div>
                    ) : null}
                    {semantic?.diagnostics?.map((line, index) => (
                      <div key={`diag-${index}`} className="properties-row">
                        <div className="properties-key">diagnostic</div>
                        <div className="properties-value">{line}</div>
                      </div>
                    ))}
                  </div>
                </details>
                <details className="properties-section" key={`raw-${symbol.qualified_name}`}>
                  <summary>Raw semantic properties</summary>
                  <div className="properties-parse">
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
