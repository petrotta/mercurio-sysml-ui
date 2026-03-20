import { useEffect, useMemo, useRef, useState } from "react";
import { getProjectElementPropertySections } from "../services/semanticApi";
import type {
  ProjectElementInheritedAttributeView,
  ProjectElementPropertyRowView,
  ProjectElementPropertySectionView,
  ProjectElementPropertySectionsView,
  SymbolView,
} from "../contracts";

type CombinedPropertiesPaneProps = {
  rootPath: string;
  selectedSymbols: SymbolView[] | null;
  semanticRefreshVersion: number;
  onSelectQualifiedName?: (qualifiedName: string) => void;
};

function formatAttributeSignature(attribute: ProjectElementInheritedAttributeView): string {
  const name = attribute.name?.trim() || "(unnamed)";
  const declaredType = attribute.declared_type?.trim() || "";
  const multiplicity = attribute.multiplicity?.trim() || "";
  if (!declaredType) {
    return name;
  }
  if (!multiplicity) {
    return `${name} : ${declaredType}`;
  }
  const multiplicityText = multiplicity.startsWith("[") ? multiplicity : `[${multiplicity}]`;
  return `${name} : ${declaredType}${multiplicityText}`;
}

function MetatypeAttributeTable({
  title,
  rows,
}: {
  title: string;
  rows: ProjectElementInheritedAttributeView[];
}) {
  if (!rows.length) {
    return (
      <section style={{ display: "grid", gap: 4 }}>
        <strong>{title}</strong>
        <div className="muted">None</div>
      </section>
    );
  }

  return (
    <section style={{ display: "grid", gap: 6 }}>
      <strong>{title}</strong>
      <div
        style={{
          display: "grid",
          gap: 0,
          border: "1px solid currentColor",
          borderRadius: 6,
          overflow: "hidden",
          fontFamily: "Consolas, monospace",
          fontSize: 12,
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.7fr) minmax(0, 1fr)",
            fontWeight: 700,
            borderBottom: "1px solid currentColor",
            background: "rgba(127,127,127,0.12)",
          }}
        >
          <div style={{ padding: "4px 6px" }}>Attribute</div>
          <div style={{ padding: "4px 6px" }}>Declared On</div>
        </div>
        {rows.map((attribute) => (
          <div
            key={`${attribute.qualified_name}|${attribute.declared_on}`}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1.7fr) minmax(0, 1fr)",
              borderTop: "1px solid rgba(127,127,127,0.25)",
            }}
          >
            <div style={{ padding: "4px 6px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {formatAttributeSignature(attribute)}
            </div>
            <div style={{ padding: "4px 6px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {attribute.declared_on || "-"}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function CombinedPropertiesPane({
  rootPath,
  selectedSymbols,
  semanticRefreshVersion,
  onSelectQualifiedName,
}: CombinedPropertiesPaneProps) {
  const [propKeyColPercent, setPropKeyColPercent] = useState(38);
  const [propertySectionsView, setPropertySectionsView] = useState<ProjectElementPropertySectionsView | null>(null);
  const [propertySectionsLoading, setPropertySectionsLoading] = useState(false);
  const [propertySectionsError, setPropertySectionsError] = useState("");
  const [metatypePopupOpen, setMetatypePopupOpen] = useState(false);
  const [hideEmptyAttributes, setHideEmptyAttributes] = useState(false);
  const requestSeqRef = useRef(0);
  const propColDragActiveRef = useRef(false);
  const propTableRef = useRef<HTMLDivElement | null>(null);
  const symbol = selectedSymbols?.[0] || null;

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (!propColDragActiveRef.current) return;
      const rect = propTableRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      const nextPercent = Math.round(((event.clientX - rect.left) / rect.width) * 100);
      setPropKeyColPercent(Math.max(20, Math.min(70, nextPercent)));
    };
    const onPointerUp = () => {
      propColDragActiveRef.current = false;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  useEffect(() => {
    const elementQname = (symbol?.qualified_name || "").trim();
    const filePath = symbol?.file_path || null;
    const symbolKind = (symbol?.kind || "").trim();
    const sourceScope = symbol?.source_scope || null;
    if (!rootPath || !elementQname) {
      requestSeqRef.current += 1;
      setPropertySectionsView(null);
      setPropertySectionsError("");
      setPropertySectionsLoading(false);
      setMetatypePopupOpen(false);
      return;
    }

    const seq = ++requestSeqRef.current;
    setPropertySectionsLoading(true);
    setPropertySectionsError("");
    void getProjectElementPropertySections(
      rootPath,
      elementQname,
      filePath,
      symbolKind || null,
      sourceScope,
    )
      .then((payload) => {
        if (requestSeqRef.current !== seq) return;
        setPropertySectionsView(payload || null);
        setPropertySectionsError("");
      })
      .catch((error) => {
        if (requestSeqRef.current !== seq) return;
        setPropertySectionsView(null);
        setPropertySectionsError(`Failed to load properties: ${String(error)}`);
      })
      .finally(() => {
        if (requestSeqRef.current !== seq) return;
        setPropertySectionsLoading(false);
      });
  }, [
    rootPath,
    symbol?.qualified_name,
    symbol?.file_path,
    symbol?.kind,
    symbol?.source_scope,
    semanticRefreshVersion,
  ]);

  const sections = propertySectionsView?.sections || [];
  const visibleSections = useMemo(() => {
    if (!hideEmptyAttributes) {
      return sections;
    }
    return sections
      .map((section) => ({
        ...section,
        rows: section.rows.filter((row) => !row.is_empty),
      }))
      .filter((section) => section.rows.length > 0 || !section.label);
  }, [hideEmptyAttributes, sections]);
  const metatypeQname = (propertySectionsView?.metatype_qname || "").trim();
  const directMetatypeAttributes = propertySectionsView?.direct_metatype_attributes || [];
  const inheritedMetatypeAttributes = propertySectionsView?.inherited_metatype_attributes || [];
  const metatypeAttributeCount = directMetatypeAttributes.length + inheritedMetatypeAttributes.length;
  const propertyDiagnostics = propertySectionsView?.diagnostics || [];

  if (!symbol) {
    return <div className="muted">Select an element to view properties.</div>;
  }

  const renderPropertyRow = (row: ProjectElementPropertyRowView) => (
    <div
      key={row.key}
      style={{
        display: "grid",
        gridTemplateColumns: "var(--combined-prop-key-col) 6px minmax(0,1fr)",
        borderTop: "1px solid rgba(127,127,127,0.25)",
      }}
    >
      <div
        style={{
          padding: "4px 6px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {row.label}
      </div>
      <div />
      <div style={{ padding: "4px 6px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {row.qualified_name && onSelectQualifiedName ? (
          <button
            type="button"
            className="ghost"
            style={{ padding: 0, font: "inherit", textDecoration: "underline" }}
            onClick={() => onSelectQualifiedName(row.qualified_name as string)}
            title={`Select ${row.qualified_name} in project tree`}
          >
            {row.value || "-"}
          </button>
        ) : (
          row.value || "-"
        )}
      </div>
    </div>
  );

  return (
    <>
      {metatypePopupOpen ? (
        <div
          className="simple-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setMetatypePopupOpen(false);
            }
          }}
        >
          <section
            className="simple-modal simple-metatype-attributes-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Metatype attributes"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="simple-modal-header">
              <strong>Metatype Attributes</strong>
              <div className="simple-modal-header-actions">
                <button type="button" className="ghost" onClick={() => setMetatypePopupOpen(false)}>
                  Close
                </button>
              </div>
            </div>
            <div className="simple-modal-body">
              <div className="simple-metatype-attributes-meta">
                <div><strong>Element:</strong> {propertySectionsView?.element_qualified_name || "-"}</div>
                <div><strong>Metatype:</strong> {metatypeQname || "-"}</div>
              </div>
              <MetatypeAttributeTable
                title={`Direct Attributes (${directMetatypeAttributes.length})`}
                rows={directMetatypeAttributes}
              />
              <MetatypeAttributeTable
                title={`Inherited Attributes (${inheritedMetatypeAttributes.length})`}
                rows={inheritedMetatypeAttributes}
              />
            </div>
            <div className="simple-modal-footer muted">
              {propertySectionsError
                || propertyDiagnostics.join(" | ")
                || "Direct attributes are declared on the metatype; inherited attributes come from supertypes."}
            </div>
          </section>
        </div>
      ) : null}
      <div
        className="simple-properties-scroll-region"
        style={{ height: "100%", overflow: "auto", fontFamily: "Consolas, monospace", fontSize: 12 }}
      >
        <div style={{ display: "grid", gap: 6, paddingBottom: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              className="ghost"
              onClick={() => setHideEmptyAttributes((value) => !value)}
              title={hideEmptyAttributes ? "Show attributes with no value" : "Hide attributes with no value"}
            >
              {hideEmptyAttributes ? "Show Empty Attributes" : "Hide Empty Attributes"}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => setMetatypePopupOpen(true)}
              disabled={!symbol || propertySectionsLoading || !metatypeQname}
              title={
                propertySectionsLoading
                  ? "Loading metatype attributes..."
                  : metatypeQname
                    ? `Show direct and inherited attributes for ${metatypeQname}`
                    : (propertySectionsError || "Metatype is unresolved for this element.")
              }
            >
              Metatype Attributes
              {metatypeAttributeCount ? ` (${metatypeAttributeCount})` : ""}
            </button>
          </div>
          {metatypeQname ? (
            <div style={{ display: "grid", gap: 2 }}>
              <strong>semantic.metatype</strong>
              <div>
                {onSelectQualifiedName && metatypeQname.includes("::") && !/\s/.test(metatypeQname) ? (
                  <button
                    type="button"
                    className="ghost"
                    style={{ padding: 0, font: "inherit", textDecoration: "underline" }}
                    onClick={() => onSelectQualifiedName(metatypeQname)}
                    title={`Select ${metatypeQname} in project tree`}
                  >
                    {metatypeQname}
                  </button>
                ) : (
                  metatypeQname
                )}
              </div>
            </div>
          ) : null}
          {propertySectionsError ? <div className="error">{propertySectionsError}</div> : null}
        </div>
        <div
          ref={propTableRef}
          style={{
            display: "grid",
            gap: 0,
            border: "1px solid currentColor",
            borderRadius: 6,
            overflow: "hidden",
            ["--combined-prop-key-col" as string]: `${propKeyColPercent}%`,
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "var(--combined-prop-key-col) 6px minmax(0,1fr)",
              fontWeight: 700,
              borderBottom: "1px solid currentColor",
              background: "var(--simple-properties-header-bg)",
              position: "sticky",
              top: 0,
              zIndex: 2,
            }}
          >
            <div style={{ padding: "4px 6px" }}>Property</div>
            <div
              title="Drag to resize property/value columns"
              onPointerDown={(event) => {
                event.preventDefault();
                propColDragActiveRef.current = true;
              }}
              style={{ cursor: "col-resize", borderLeft: "1px solid currentColor", borderRight: "1px solid currentColor" }}
            />
            <div style={{ padding: "4px 6px" }}>Value</div>
          </div>
          {visibleSections.map((section: ProjectElementPropertySectionView) => {
            if (section.collapsible) {
              return (
                <details key={section.key} style={{ borderTop: "1px solid rgba(127,127,127,0.25)" }}>
                  <summary
                    style={{
                      cursor: "pointer",
                      padding: "4px 6px",
                      fontWeight: 700,
                      listStyle: "none",
                      userSelect: "none",
                    }}
                  >
                    === {section.label} ===
                  </summary>
                  {section.rows.map(renderPropertyRow)}
                </details>
              );
            }

            return (
              <div key={section.key}>
                {section.label ? (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "var(--combined-prop-key-col) 6px minmax(0,1fr)",
                      borderTop: "1px solid rgba(127,127,127,0.25)",
                    }}
                  >
                    <div
                      style={{
                        padding: "4px 6px",
                        fontWeight: 700,
                        whiteSpace: "normal",
                      }}
                    >
                      === {section.label} ===
                    </div>
                    <div />
                    <div />
                  </div>
                ) : null}
                {section.rows.map(renderPropertyRow)}
              </div>
            );
          })}
          {!visibleSections.length && !propertySectionsLoading ? (
            <div className="muted" style={{ padding: "6px 8px" }}>
              No properties available.
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
