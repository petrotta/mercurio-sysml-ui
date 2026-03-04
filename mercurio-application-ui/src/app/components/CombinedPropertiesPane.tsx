import { useEffect, useMemo, useRef, useState } from "react";
import type { SemanticElementResult, SymbolView } from "../types";

type CombinedPropertiesPaneProps = {
  selectedSymbols: SymbolView[] | null;
  selectedSemanticRow: SemanticElementResult | null;
  selectedSemanticLoading?: boolean;
  selectedSemanticError?: string;
  onSelectQualifiedName?: (qualifiedName: string) => void;
};

function rawText(value: unknown): string {
  if (value == null) return "-";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "-";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function asQualifiedName(value: unknown): string | null {
  const input =
    typeof value === "string"
      ? value.trim()
      : Array.isArray(value) && value.length === 1 && typeof value[0] === "string"
        ? value[0].trim()
        : "";
  if (!input) return null;
  if (!input.includes("::")) return null;
  if (/\s/.test(input)) return null;
  return input;
}

export function CombinedPropertiesPane({
  selectedSymbols,
  selectedSemanticRow,
  selectedSemanticLoading = false,
  selectedSemanticError = "",
  onSelectQualifiedName,
}: CombinedPropertiesPaneProps) {
  const [propKeyColPercent, setPropKeyColPercent] = useState(38);
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

  const rows = useMemo(() => {
    const out: Array<{ key: string; label: string; value: string; qname: string | null }> = [];
    const section = (key: string, title: string) => {
      out.push({ key: `section-${key}`, label: `=== ${title} ===`, value: "", qname: null });
    };

    section("semantic", "Semantics");
    if (selectedSemanticRow) {
      const attrs = selectedSemanticRow.attributes || {};
      const keys = Object.keys(attrs).sort((a, b) => a.localeCompare(b));
      if (!keys.length) {
        out.push({ key: "s-empty", label: "semantic.type_attributes", value: "-", qname: null });
      } else {
        for (const key of keys) {
          out.push({
            key: `s-attr-${key}`,
            label: `semantic.${key}`,
            value: rawText(attrs[key]),
            qname: asQualifiedName(attrs[key]),
          });
        }
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

  if (!rows.length) {
    return <div className="muted">Select an element to view properties.</div>;
  }

  return (
    <div style={{ height: "100%", overflow: "auto", fontFamily: "Consolas, monospace", fontSize: 12 }}>
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
  );
}
