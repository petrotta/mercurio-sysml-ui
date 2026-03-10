import { useEffect, useMemo, useRef, useState } from "react";
import { getProjectElementAttributes } from "../services/semanticApi";
import type {
  ProjectElementAttributesView,
  ProjectElementInheritedAttributeView,
  SemanticElementProjectionResult,
  SemanticFeatureView,
  SemanticValueView,
  SymbolView,
} from "../types";

type CombinedPropertiesPaneProps = {
  rootPath: string;
  selectedSymbols: SymbolView[] | null;
  selectedSemanticRow: SemanticElementProjectionResult | null;
  selectedSemanticLoading?: boolean;
  selectedSemanticError?: string;
  onSelectQualifiedName?: (qualifiedName: string) => void;
};

function valueToText(value: SemanticValueView): string {
  switch (value.kind) {
    case "null":
      return "-";
    case "text":
      return value.value;
    case "bool":
      return value.value ? "true" : "false";
    case "i64":
    case "u64":
    case "f64":
      return String(value.value);
    case "enum":
      return value.literal;
    case "ref":
      return value.qualified_name || value.proxy_text || "-";
    case "list":
      return value.items.map((item) => valueToText(item)).join(", ") || "-";
    default:
      return "-";
  }
}

function valueToQualifiedName(value: SemanticFeatureView["value"]): string | null {
  if (value.kind === "ref") {
    const qname = value.qualified_name || value.proxy_text;
    if (!qname || !qname.includes("::") || /\s/.test(qname)) {
      return null;
    }
    return qname;
  }

  if (value.kind === "list") {
    const refs = value.items.filter((item) => item.kind === "ref");
    if (refs.length !== 1) {
      return null;
    }
    const qname = refs[0]?.qualified_name || refs[0]?.proxy_text;
    if (!qname || !qname.includes("::") || /\s/.test(qname)) {
      return null;
    }
    return qname;
  }

  if (value.kind === "text") {
    const qname = value.value?.trim();
    if (!qname || !qname.includes("::") || /\s/.test(qname)) {
      return null;
    }
    return qname;
  }

  return null;
}

function splitQualifiedName(value: string): string[] {
  return value
    .split("::")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function formatFeatureQName(value: string): string | null {
  const segments = splitQualifiedName(value);
  if (!segments.length) {
    return null;
  }
  if (segments.length === 1) {
    return segments[0] || null;
  }
  const owner = segments[segments.length - 2];
  const property = segments[segments.length - 1];
  if (!owner || !property) {
    return null;
  }
  return `${owner}.${property}`;
}

function formatSemanticFeatureLabel(feature: SemanticFeatureView): string {
  const metamodelFeatureQname = (feature.metamodel_feature_qname || "").trim();
  if (metamodelFeatureQname) {
    const formatted = formatFeatureQName(metamodelFeatureQname);
    if (formatted) {
      return formatted;
    }
  }

  const featureName = (feature.name || "").trim();
  const declaredTypeQname = (feature.declared_type_qname || "").trim();
  if (declaredTypeQname && featureName) {
    const typeSegments = splitQualifiedName(declaredTypeQname);
    const shortTypeName = typeSegments[typeSegments.length - 1];
    if (shortTypeName) {
      return `${shortTypeName}.${featureName}`;
    }
  }

  if (featureName) {
    const formatted = formatFeatureQName(featureName);
    if (formatted) {
      return formatted;
    }
    return featureName;
  }

  return "(unnamed)";
}

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
  selectedSemanticRow,
  selectedSemanticLoading = false,
  selectedSemanticError = "",
  onSelectQualifiedName,
}: CombinedPropertiesPaneProps) {
  const [propKeyColPercent, setPropKeyColPercent] = useState(38);
  const [metatypeAttributes, setMetatypeAttributes] = useState<ProjectElementAttributesView | null>(null);
  const [metatypeAttributesLoading, setMetatypeAttributesLoading] = useState(false);
  const [metatypeAttributesError, setMetatypeAttributesError] = useState("");
  const [metatypePopupOpen, setMetatypePopupOpen] = useState(false);
  const metatypeRequestSeqRef = useRef(0);
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
    const elementQname = (selectedSemanticRow?.qualified_name || symbol?.qualified_name || "").trim();
    const symbolKind = (symbol?.kind || "").trim();
    if (!rootPath || !elementQname) {
      metatypeRequestSeqRef.current += 1;
      setMetatypeAttributes(null);
      setMetatypeAttributesError("");
      setMetatypeAttributesLoading(false);
      setMetatypePopupOpen(false);
      return;
    }

    const seq = ++metatypeRequestSeqRef.current;
    setMetatypeAttributesLoading(true);
    setMetatypeAttributesError("");
    const timer = window.setTimeout(() => {
      void getProjectElementAttributes(rootPath, elementQname, symbolKind || null)
        .then((payload) => {
          if (metatypeRequestSeqRef.current !== seq) return;
          setMetatypeAttributes(payload || null);
          if (!payload?.metatype_qname) {
            const diagnostic = (payload?.diagnostics || []).find((item) =>
              item.toLowerCase().includes("metatype"),
            );
            setMetatypeAttributesError(diagnostic || "Metatype is unresolved for this element.");
          } else {
            setMetatypeAttributesError("");
          }
        })
        .catch((error) => {
          if (metatypeRequestSeqRef.current !== seq) return;
          setMetatypeAttributes(null);
          setMetatypeAttributesError(`Failed to load metatype attributes: ${String(error)}`);
        })
        .finally(() => {
          if (metatypeRequestSeqRef.current !== seq) return;
          setMetatypeAttributesLoading(false);
        });
    }, 120);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    rootPath,
    selectedSemanticRow?.qualified_name,
    symbol?.qualified_name,
    symbol?.kind,
  ]);

  const rows = useMemo(() => {
    const out: Array<{ key: string; label: string; value: string; qname: string | null }> = [];
    const section = (key: string, title: string) => {
      out.push({ key: `section-${key}`, label: `=== ${title} ===`, value: "", qname: null });
    };

    section("semantic", "Semantics");
    if (selectedSemanticRow) {
      if (!selectedSemanticRow.features.length) {
        out.push({ key: "s-empty", label: "semantic.type_attributes", value: "-", qname: null });
      } else {
        selectedSemanticRow.features.forEach((feature, index) => {
          const text = valueToText(feature.value);
          const qname = valueToQualifiedName(feature.value);
          const label = formatSemanticFeatureLabel(feature);
          out.push({
            key: `s-feature-${index}-${feature.name}`,
            label,
            value: text,
            qname,
          });
        });
      }
    } else {
      out.push({
        key: "s-loading",
        label: "semantic.status",
        value: selectedSemanticLoading
          ? "Loading semantic element..."
          : selectedSemanticError || (symbol ? "No semantic element loaded" : "Select an element"),
        qname: null,
      });
    }
    return out;
  }, [symbol, selectedSemanticRow, selectedSemanticLoading, selectedSemanticError]);

  const metatypeQname = (metatypeAttributes?.metatype_qname || "").trim();
  const directMetatypeAttributes = metatypeAttributes?.direct_metatype_attributes || [];
  const inheritedMetatypeAttributes =
    metatypeAttributes?.inherited_metatype_attributes
    || metatypeAttributes?.inherited_attributes
    || [];
  const metatypeAttributeCount = directMetatypeAttributes.length + inheritedMetatypeAttributes.length;

  if (!rows.length) {
    return <div className="muted">Select an element to view properties.</div>;
  }

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
                <div><strong>Element:</strong> {metatypeAttributes?.element_qualified_name || "-"}</div>
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
              {metatypeAttributesError
                || (metatypeAttributes?.diagnostics || []).join(" | ")
                || "Direct attributes are declared on the metatype; inherited attributes come from supertypes."}
            </div>
          </section>
        </div>
      ) : null}
      <div style={{ height: "100%", overflow: "auto", fontFamily: "Consolas, monospace", fontSize: 12 }}>
        <div style={{ display: "flex", justifyContent: "flex-end", paddingBottom: 6 }}>
          <button
            type="button"
            className="ghost"
            onClick={() => setMetatypePopupOpen(true)}
            disabled={!symbol || metatypeAttributesLoading || !metatypeQname}
            title={
              metatypeAttributesLoading
                ? "Loading metatype attributes..."
                : metatypeQname
                  ? `Show direct and inherited attributes for ${metatypeQname}`
                  : (metatypeAttributesError || "Metatype is unresolved for this element.")
            }
          >
            Metatype Attributes
            {metatypeAttributeCount ? ` (${metatypeAttributeCount})` : ""}
          </button>
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
              background: "rgba(127,127,127,0.12)",
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
          {rows.map((row) => (
            <div
              key={row.key}
              style={{ display: "grid", gridTemplateColumns: "var(--combined-prop-key-col) 6px minmax(0,1fr)", borderTop: "1px solid rgba(127,127,127,0.25)" }}
            >
              <div
                style={{
                  padding: "4px 6px",
                  whiteSpace: row.label.startsWith("===") ? "normal" : "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  fontWeight: row.label.startsWith("===") ? 700 : 400,
                }}
              >
                {row.label}
              </div>
              <div />
              <div style={{ padding: "4px 6px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {row.qname && onSelectQualifiedName ? (
                  <button
                    type="button"
                    className="ghost"
                    style={{ padding: 0, font: "inherit", textDecoration: "underline" }}
                    onClick={() => onSelectQualifiedName(row.qname as string)}
                    title={`Select ${row.qname} in project tree`}
                  >
                    {row.value || "-"}
                  </button>
                ) : (
                  row.value || "-"
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
