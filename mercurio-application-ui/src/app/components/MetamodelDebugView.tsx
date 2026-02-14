import { useMemo, useRef, useState } from "react";
import type { StdlibMetamodelView } from "../types";

type MetamodelDebugViewProps = {
  rootPath: string;
  loading: boolean;
  error: string;
  metamodel: StdlibMetamodelView | null;
  expandedTypes: Record<string, boolean>;
  onRefresh: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onToggleType: (qualifiedName: string) => void;
};

const renderModifiers = (mods: {
  is_public: boolean;
  is_abstract: boolean;
  is_variation: boolean;
  is_readonly: boolean;
  is_derived: boolean;
  is_parallel: boolean;
}) => {
  const enabled: string[] = [];
  if (mods.is_public) enabled.push("public");
  if (mods.is_abstract) enabled.push("abstract");
  if (mods.is_variation) enabled.push("variation");
  if (mods.is_readonly) enabled.push("readonly");
  if (mods.is_derived) enabled.push("derived");
  if (mods.is_parallel) enabled.push("parallel");
  return enabled.length ? enabled.join(", ") : "none";
};

export function MetamodelDebugView({
  rootPath,
  loading,
  error,
  metamodel,
  expandedTypes,
  onRefresh,
  onExpandAll,
  onCollapseAll,
  onToggleType,
}: MetamodelDebugViewProps) {
  const [filter, setFilter] = useState("");
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const sortedTypes = useMemo(
    () => (metamodel?.types ? [...metamodel.types].sort((a, b) => a.qualified_name.localeCompare(b.qualified_name)) : []),
    [metamodel],
  );
  const typeByQname = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const typeItem of sortedTypes) {
      map[typeItem.qualified_name] = true;
    }
    return map;
  }, [sortedTypes]);
  const resolveSupertypeTarget = (name: string) => {
    if (typeByQname[name]) return name;
    const exactName = sortedTypes.filter((item) => item.name === name);
    if (exactName.length === 1) return exactName[0].qualified_name;
    const suffix = sortedTypes.filter((item) => item.qualified_name.endsWith(`::${name}`));
    if (suffix.length === 1) return suffix[0].qualified_name;
    return null;
  };
  const filteredTypes = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sortedTypes;
    return sortedTypes.filter((item) => {
      if (item.name.toLowerCase().includes(q) || item.qualified_name.toLowerCase().includes(q)) return true;
      if ((item.documentation || "").toLowerCase().includes(q)) return true;
      if (item.supertypes.some((s) => s.toLowerCase().includes(q))) return true;
      if (
        item.attributes.some((a) => {
          if (a.name.toLowerCase().includes(q) || a.qualified_name.toLowerCase().includes(q)) return true;
          if ((a.declared_type || "").toLowerCase().includes(q)) return true;
          if ((a.multiplicity || "").toLowerCase().includes(q)) return true;
          if ((a.direction || "").toLowerCase().includes(q)) return true;
          if ((a.documentation || "").toLowerCase().includes(q)) return true;
          return false;
        })
      ) {
        return true;
      }
      return false;
    });
  }, [sortedTypes, filter]);

  return (
    <div
      style={{
        display: "grid",
        gap: 10,
        gridTemplateRows: "auto auto auto 1fr",
        height: "72vh",
        minHeight: 420,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "grid", gap: 2 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#ffffff" }}>Stdlib Metamodel Debug</div>
          <div style={{ fontSize: 12, color: "#d0d7e2" }}>{rootPath || "No project root selected"}</div>
        </div>
        <div style={{ display: "inline-flex", gap: 6 }}>
          <button type="button" className="ghost" onClick={onRefresh} disabled={loading || !rootPath}>
            {loading ? "Loading..." : "Refresh"}
          </button>
          <button type="button" className="ghost" onClick={onExpandAll} disabled={!sortedTypes.length}>
            Expand all
          </button>
          <button type="button" className="ghost" onClick={onCollapseAll} disabled={!sortedTypes.length}>
            Collapse all
          </button>
        </div>
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter types, qualified names, supertypes, attributes..."
          style={{
            width: "100%",
            border: "1px solid #666",
            borderRadius: 6,
            padding: "6px 8px",
            background: "#0f1114",
            color: "#ffffff",
            fontFamily: "Consolas, monospace",
            fontSize: 12,
          }}
        />
        {filter.trim() ? (
          <div style={{ color: "#cfd7e4", fontSize: 12 }}>
            {filteredTypes.length} of {sortedTypes.length} types
          </div>
        ) : null}
      </div>
      {error ? <div style={{ color: "#ffb0b0", fontSize: 12 }}>{error}</div> : null}
      {metamodel ? (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, color: "#e7ecf4" }}>
          <span>Types: {metamodel.type_count}</span>
          <span>Cache: {metamodel.stdlib_cache_hit ? "hit" : "miss"}</span>
          <span>Path: {metamodel.stdlib_path || "n/a"}</span>
        </div>
      ) : null}
      <div
        style={{
          border: "1px solid #777",
          borderRadius: 6,
          padding: 8,
          background: "#111",
          color: "#fff",
          fontFamily: "Consolas, monospace",
          fontSize: 12,
          lineHeight: 1.4,
          minHeight: 0,
          overflow: "auto",
          display: "grid",
          gap: 6,
        }}
      >
        {!loading && !metamodel ? <div>Load the metamodel to inspect stdlib elements.</div> : null}
        {metamodel && !sortedTypes.length ? <div>No stdlib model types were found.</div> : null}
        {metamodel && sortedTypes.length > 0 && filteredTypes.length === 0 ? <div>No types match the filter.</div> : null}
        {filteredTypes.map((typeItem, index) => {
          const isOpen = expandedTypes[typeItem.qualified_name] ?? true;
          const displayName = typeItem.name?.trim() || "(unnamed type)";
          const displayQname = typeItem.qualified_name?.trim() || "(no qualified name)";
          return (
            <div
              key={`${typeItem.qualified_name}-${index}`}
              ref={(node) => {
                itemRefs.current[typeItem.qualified_name] = node;
              }}
              style={{ border: "1px solid #444", borderRadius: 4 }}
            >
              <div style={{ display: "grid", gridTemplateColumns: "24px 1fr auto", gap: 8, padding: 8, background: "#1c1f24" }}>
                <button
                  type="button"
                  onClick={() => onToggleType(typeItem.qualified_name)}
                  aria-expanded={isOpen}
                  style={{
                    width: 20,
                    height: 20,
                    border: "1px solid #777",
                    borderRadius: 4,
                    background: "#0f1114",
                    color: "#fff",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  {isOpen ? "v" : ">"}
                </button>
                <div>
                  <div style={{ color: "#fff", fontWeight: 700 }}>{displayName}</div>
                  <div style={{ color: "#c8d0dc" }}>{displayQname}</div>
                </div>
                <div style={{ color: "#d7e0eb" }}>{typeItem.attributes.length} attrs</div>
              </div>
              {isOpen ? (
                <div style={{ padding: 8, display: "grid", gap: 6 }}>
                  <div>
                    Supertypes:{" "}
                    {typeItem.supertypes.length
                      ? typeItem.supertypes.map((superName, superIndex) => {
                          const target = resolveSupertypeTarget(superName);
                          return (
                            <span key={`${typeItem.qualified_name}-super-${superIndex}`}>
                              {superIndex > 0 ? ", " : ""}
                              {target ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (!(expandedTypes[target] ?? true)) {
                                      onToggleType(target);
                                    }
                                    window.setTimeout(() => {
                                      itemRefs.current[target]?.scrollIntoView({ block: "center", behavior: "smooth" });
                                    }, 0);
                                  }}
                                  style={{
                                    border: "none",
                                    background: "transparent",
                                    color: "#8ec5ff",
                                    textDecoration: "underline",
                                    cursor: "pointer",
                                    fontFamily: "inherit",
                                    fontSize: "inherit",
                                    padding: 0,
                                  }}
                                  title={`Jump to ${target}`}
                                >
                                  {superName}
                                </button>
                              ) : (
                                <span>{superName}</span>
                              )}
                            </span>
                          );
                        })
                      : "none"}
                  </div>
                  <div>Modifiers: {renderModifiers(typeItem.modifiers)}</div>
                  {typeItem.documentation ? (
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", border: "1px solid #555", borderRadius: 4, padding: 6, background: "#0f1114", color: "#eef3fb" }}>
                      {typeItem.documentation}
                    </pre>
                  ) : null}
                  {typeItem.attributes.length ? (
                    <div style={{ display: "grid", gap: 6 }}>
                      {typeItem.attributes.map((attr) => (
                        <div key={attr.qualified_name} style={{ border: "1px solid #555", borderRadius: 4, padding: 6, background: "#171a1f" }}>
                          <div style={{ color: "#fff", fontWeight: 700 }}>{attr.name}</div>
                          <div>Qualified: {attr.qualified_name}</div>
                          <div>Type: {attr.declared_type || "n/a"}</div>
                          <div>Multiplicity: {attr.multiplicity || "n/a"}</div>
                          <div>Direction: {attr.direction || "n/a"}</div>
                          <div>Modifiers: {renderModifiers(attr.modifiers)}</div>
                          {attr.documentation ? (
                            <pre style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", border: "1px solid #666", borderRadius: 4, padding: 6, background: "#0f1114", color: "#eef3fb" }}>
                              {attr.documentation}
                            </pre>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
