import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ProjectModelView, StdlibMetamodelView } from "../types";

type ProjectModelViewProps = {
  rootPath: string;
  model: ProjectModelView | null;
  library: StdlibMetamodelView | null;
  loading: boolean;
  libraryLoading: boolean;
  error: string;
  libraryError: string;
  focusQuery?: string;
  onRefresh: () => void;
};

function tailName(value: string): string {
  const parts = value.split("::");
  return parts[parts.length - 1] || value;
}

export function ProjectModelPaneView({
  rootPath,
  model,
  library,
  loading,
  libraryLoading,
  error,
  libraryError,
  focusQuery,
  onRefresh,
}: ProjectModelViewProps) {
  const [filter, setFilter] = useState("");
  const [section, setSection] = useState<"all" | "project" | "library">("all");
  const typeRefs = useRef<Record<string, HTMLElement | null>>({});
  const attrRefs = useRef<Record<string, HTMLElement | null>>({});

  const libraryTypes = useMemo(() => {
    const all = library?.types || [];
    return [...all].sort((a, b) => (a.qualified_name || "").localeCompare(b.qualified_name || ""));
  }, [library]);

  const libraryByQname = useMemo(() => {
    const map = new Map<string, number>();
    libraryTypes.forEach((t, i) => map.set(t.qualified_name, i));
    return map;
  }, [libraryTypes]);
  const libraryTypeByQname = useMemo(() => {
    const map = new Map<string, (typeof libraryTypes)[number]>();
    for (const item of libraryTypes) map.set(item.qualified_name, item);
    return map;
  }, [libraryTypes]);

  const libraryByTail = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const t of libraryTypes) {
      const key = tailName(t.qualified_name);
      const list = map.get(key) || [];
      list.push(t.qualified_name);
      map.set(key, list);
    }
    return map;
  }, [libraryTypes]);

  const libraryAttrByQname = useMemo(() => {
    const map = new Map<string, { typeQname: string; attrName: string }>();
    for (const t of libraryTypes) {
      for (const a of t.attributes) {
        map.set(a.qualified_name, { typeQname: t.qualified_name, attrName: a.name });
      }
    }
    return map;
  }, [libraryTypes]);

  const resolveLibraryType = (name: string): string | null => {
    if (!name) return null;
    if (libraryByQname.has(name)) return name;
    const byTail = libraryByTail.get(tailName(name));
    if (byTail && byTail.length === 1) return byTail[0];
    return null;
  };

  const jumpToType = (qname: string) => {
    const resolved = resolveLibraryType(qname);
    if (!resolved) return;
    typeRefs.current[resolved]?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const jumpToAttr = (qname: string) => {
    const resolved = libraryAttrByQname.get(qname);
    if (!resolved) return;
    typeRefs.current[resolved.typeQname]?.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => {
      attrRefs.current[qname]?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 50);
  };

  const filteredProject = useMemo(() => {
    const all = model?.elements || [];
    const q = filter.trim().toLowerCase();
    const sorted = [...all].sort((a, b) => (a.qualified_name || "").localeCompare(b.qualified_name || ""));
    if (!q) return sorted;
    return sorted.filter((item) => {
      if ((item.name || "").toLowerCase().includes(q)) return true;
      if ((item.qualified_name || "").toLowerCase().includes(q)) return true;
      if ((item.metatype_qname || "").toLowerCase().includes(q)) return true;
      if ((item.documentation || "").toLowerCase().includes(q)) return true;
      if ((item.declared_supertypes || []).some((s) => (s || "").toLowerCase().includes(q))) return true;
      if ((item.diagnostics || []).some((d) => (d || "").toLowerCase().includes(q))) return true;
      return item.attributes.some((attr) =>
        (attr.name || "").toLowerCase().includes(q) ||
        (attr.qualified_name || "").toLowerCase().includes(q) ||
        (attr.declared_type || "").toLowerCase().includes(q) ||
        (attr.documentation || "").toLowerCase().includes(q) ||
        (attr.metamodel_attribute_qname || "").toLowerCase().includes(q),
      );
    });
  }, [model, filter]);

  const filteredLibrary = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return libraryTypes;
    return libraryTypes.filter((item) => {
      if ((item.name || "").toLowerCase().includes(q)) return true;
      if ((item.qualified_name || "").toLowerCase().includes(q)) return true;
      if ((item.documentation || "").toLowerCase().includes(q)) return true;
      if ((item.declared_supertypes || []).some((s) => (s || "").toLowerCase().includes(q))) return true;
      return item.attributes.some((attr) =>
        (attr.name || "").toLowerCase().includes(q) ||
        (attr.qualified_name || "").toLowerCase().includes(q) ||
        (attr.declared_type || "").toLowerCase().includes(q) ||
        (attr.documentation || "").toLowerCase().includes(q),
      );
    });
  }, [libraryTypes, filter]);

  const linkStyle: CSSProperties = {
    border: "none",
    background: "transparent",
    color: "inherit",
    textDecoration: "underline",
    cursor: "pointer",
    padding: 0,
    font: "inherit",
  };

  useEffect(() => {
    if (!focusQuery) return;
    const trimmed = focusQuery.trim();
    if (!trimmed) return;
    setSection("project");
    setFilter(trimmed);
  }, [focusQuery]);

  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateRows: "auto auto auto 1fr",
        gap: 8,
        padding: 10,
        lineHeight: 1.35,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Project + Library Model</div>
          <div style={{ fontSize: 12, opacity: 0.85 }}>{rootPath || "No project selected"}</div>
        </div>
        <button type="button" className="ghost" onClick={onRefresh} disabled={!rootPath || loading || libraryLoading}>
          {loading || libraryLoading ? "Loading..." : "Refresh"}
        </button>
      </div>

      <div style={{ display: "grid", gap: 6 }}>
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter across project + library..."
          style={{
            width: "100%",
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid currentColor",
            background: "transparent",
            color: "inherit",
            fontFamily: "Consolas, monospace",
            fontSize: 12,
            opacity: 0.95,
          }}
        />
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" className="ghost" onClick={() => setSection("all")} disabled={section === "all"}>All</button>
          <button type="button" className="ghost" onClick={() => setSection("project")} disabled={section === "project"}>Project</button>
          <button type="button" className="ghost" onClick={() => setSection("library")} disabled={section === "library"}>Library</button>
        </div>
      </div>

      <div style={{ fontSize: 12 }}>
        {error ? <span style={{ color: "#d44949" }}>project: {error}</span> : null}
        {libraryError ? <span style={{ color: "#d44949", marginLeft: 12 }}>library: {libraryError}</span> : null}
        {!error && !libraryError && model ? (
          <span>
            project {filteredProject.length}/{model.element_count} | library {filteredLibrary.length}/{library?.type_count || 0} | project cache {model.project_cache_hit ? "hit" : "miss"} | stdlib cache {model.stdlib_cache_hit ? "hit" : "miss"}
          </span>
        ) : null}
      </div>

      <div
        style={{
          overflow: "auto",
          border: "1px solid currentColor",
          borderRadius: 8,
          padding: 8,
          fontFamily: "Consolas, monospace",
          fontSize: 12,
          background: "transparent",
          display: "grid",
          gap: 10,
        }}
      >
        {(section === "all" || section === "project") && (
          <section>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Project</div>
            {!loading && !model ? <div>Open a project and refresh to build a project model.</div> : null}

            {model?.diagnostics?.length ? (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Diagnostics</div>
                {model.diagnostics.map((line, idx) => (
                  <div key={`diag-${idx}`} style={{ whiteSpace: "pre-wrap" }}>- {line}</div>
                ))}
              </div>
            ) : null}

            {filteredProject.map((element, elementIndex) => {
              const elementKey = element.qualified_name?.trim() || `${element.file_path || "<no-file>"}:${element.start_line}:${element.start_col}:${elementIndex}`;
              const elementLabel = element.name?.trim() || "<anonymous type>";
              const elementQName = element.qualified_name?.trim() || `<unnamed type #${elementIndex + 1}>`;
              const metatype = element.metatype_qname || "";
              const resolvedMetatype = resolveLibraryType(metatype);
              const hasMetatypeLink = !!resolvedMetatype;
              const metatypeType = resolvedMetatype ? libraryTypeByQname.get(resolvedMetatype) : undefined;

              return (
                <details key={elementKey} style={{ marginBottom: 8 }}>
                  <summary style={{ cursor: "pointer", userSelect: "text" }}>
                    <strong>{elementLabel}</strong> :: {elementQName} ({element.attributes.length} attrs)
                  </summary>

                  <div style={{ padding: "6px 0 0 14px", display: "grid", gap: 4 }}>
                    <div>
                      metatype:{" "}
                      {hasMetatypeLink ? (
                        <button type="button" style={linkStyle} onClick={() => jumpToType(metatype)}>{metatype}</button>
                      ) : (
                        <span>{element.metatype_qname || "unresolved"}</span>
                      )}
                    </div>
                    <div>kind: {element.kind || "n/a"}</div>
                    <div>file: {element.file_path || "n/a"}</div>
                    <div>span: {element.start_line}:{element.start_col} - {element.end_line}:{element.end_col}</div>
                    <div>
                      metamodel supertypes:{" "}
                      {metatypeType?.declared_supertypes?.length
                        ? metatypeType.declared_supertypes.map((s, i) => {
                            const target = resolveLibraryType(s);
                            return (
                              <span key={`${elementKey}-meta-super-${i}`}>
                                {i > 0 ? ", " : ""}
                                {target ? (
                                  <button type="button" style={linkStyle} onClick={() => jumpToType(s)}>{s}</button>
                                ) : (
                                  s
                                )}
                              </span>
                            );
                          })
                        : "none"}
                    </div>
                    <div>
                      declared supertypes (source):{" "}
                      {element.declared_supertypes.length
                        ? element.declared_supertypes.map((s, i) => {
                            const target = resolveLibraryType(s);
                            return (
                              <span key={`${elementKey}-decl-super-${i}`}>
                                {i > 0 ? ", " : ""}
                                {target ? (
                                  <button type="button" style={linkStyle} onClick={() => jumpToType(s)}>{s}</button>
                                ) : (
                                  s
                                )}
                              </span>
                            );
                          })
                        : "none"}
                    </div>
                    <details>
                      <summary>
                        direct specializations ({element.direct_specializations.length || 0})
                      </summary>
                      <div style={{ paddingLeft: 12, paddingTop: 4 }}>
                        {element.direct_specializations.length
                          ? element.direct_specializations.map((s, i) => (
                              <div key={`${elementKey}-direct-spec-${i}`}>{s}</div>
                            ))
                          : "none"}
                      </div>
                    </details>
                    <details>
                      <summary>
                        indirect specializations ({element.indirect_specializations.length || 0})
                      </summary>
                      <div style={{ paddingLeft: 12, paddingTop: 4 }}>
                        {element.indirect_specializations.length
                          ? element.indirect_specializations.map((s, i) => (
                              <div key={`${elementKey}-indirect-spec-${i}`}>{s}</div>
                            ))
                          : "none"}
                      </div>
                    </details>
                    {element.documentation ? <div style={{ whiteSpace: "pre-wrap" }}>documentation: {element.documentation}</div> : null}

                    {element.diagnostics.length ? (
                      <div>
                        <div>diagnostics:</div>
                        {element.diagnostics.map((d, i) => (
                          <div key={`${elementKey}-d-${i}`} style={{ paddingLeft: 12, whiteSpace: "pre-wrap" }}>- {d}</div>
                        ))}
                      </div>
                    ) : null}

                    {!element.attributes.length ? <div>attributes: none</div> : null}

                    {element.attributes.map((attr, attrIndex) => {
                      const attrKey = attr.qualified_name?.trim() || `${elementKey}::attr:${attrIndex}`;
                      const attrLabel = attr.name?.trim() || "<anonymous attribute>";
                      const attrQName = attr.qualified_name?.trim() || `<unnamed attribute #${attrIndex + 1}>`;
                      const mmAttr = attr.metamodel_attribute_qname || "";
                      const hasAttrLink = !!libraryAttrByQname.get(mmAttr);
                      return (
                        <details key={attrKey} style={{ marginLeft: 8 }}>
                          <summary style={{ cursor: "pointer", userSelect: "text" }}>
                            attr <strong>{attrLabel}</strong> :: {attrQName}
                          </summary>
                          <div style={{ padding: "4px 0 0 14px", display: "grid", gap: 2 }}>
                            <div>
                              type:{" "}
                              {(() => {
                                const declaredType = attr.declared_type || "";
                                const target = resolveLibraryType(declaredType);
                                if (!target) return <span>{attr.declared_type || "n/a"}</span>;
                                return (
                                  <button type="button" style={linkStyle} onClick={() => jumpToType(declaredType)}>
                                    {declaredType}
                                  </button>
                                );
                              })()}
                            </div>
                            <div>multiplicity: {attr.multiplicity || "n/a"}</div>
                            <div>direction: {attr.direction || "n/a"}</div>
                            <div>
                              metamodel_attr:{" "}
                              {hasAttrLink ? (
                                <button type="button" style={linkStyle} onClick={() => jumpToAttr(mmAttr)}>{mmAttr}</button>
                              ) : (
                                <span>{attr.metamodel_attribute_qname || "unresolved"}</span>
                              )}
                            </div>
                            {attr.documentation ? <div style={{ whiteSpace: "pre-wrap" }}>documentation: {attr.documentation}</div> : null}
                            {attr.diagnostics.map((d, i) => (
                              <div key={`${attrKey}-d-${i}`} style={{ whiteSpace: "pre-wrap" }}>- {d}</div>
                            ))}
                          </div>
                        </details>
                      );
                    })}
                  </div>
                </details>
              );
            })}
          </section>
        )}

        {(section === "all" || section === "library") && (
          <section>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Library (Stdlib Metamodel)</div>
            {!libraryLoading && !library ? <div>Refresh to load the stdlib metamodel.</div> : null}

            {filteredLibrary.map((typeItem, index) => {
              const typeQname = typeItem.qualified_name || `<unnamed-lib-type-${index}>`;
              const typeName = typeItem.name || "<anonymous library type>";
              return (
                <details key={`${typeQname}-${index}`} ref={(node) => { typeRefs.current[typeQname] = node; }} style={{ marginBottom: 8 }}>
                  <summary style={{ cursor: "pointer", userSelect: "text" }}>
                    <strong>{typeName}</strong> :: {typeQname} ({typeItem.attributes.length} attrs)
                  </summary>

                  <div style={{ padding: "6px 0 0 14px", display: "grid", gap: 4 }}>
                    <div>
                      metamodel supertypes:{" "}
                      {typeItem.declared_supertypes.length
                        ? typeItem.declared_supertypes.map((s, i) => {
                            const target = resolveLibraryType(s);
                            return (
                              <span key={`${typeQname}-super-${i}`}>
                                {i > 0 ? ", " : ""}
                                {target ? (
                                  <button type="button" style={linkStyle} onClick={() => jumpToType(s)}>{s}</button>
                                ) : (
                                  s
                                )}
                              </span>
                            );
                          })
                        : "none"}
                    </div>
                    {typeItem.documentation ? <div style={{ whiteSpace: "pre-wrap" }}>documentation: {typeItem.documentation}</div> : null}

                    {!typeItem.attributes.length ? <div>attributes: none</div> : null}
                    {typeItem.attributes.map((attr, attrIndex) => {
                      const attrQname = attr.qualified_name || `${typeQname}::<unnamed-attr-${attrIndex}>`;
                      return (
                        <details key={attrQname} ref={(node) => { attrRefs.current[attrQname] = node; }} style={{ marginLeft: 8 }}>
                          <summary style={{ cursor: "pointer", userSelect: "text" }}>
                            attr <strong>{attr.name || "<anonymous attribute>"}</strong> :: {attrQname}
                          </summary>
                          <div style={{ padding: "4px 0 0 14px", display: "grid", gap: 2 }}>
                            <div>
                              type:{" "}
                              {(() => {
                                const declaredType = attr.declared_type || "";
                                const target = resolveLibraryType(declaredType);
                                if (!target) return <span>{attr.declared_type || "n/a"}</span>;
                                return (
                                  <button type="button" style={linkStyle} onClick={() => jumpToType(declaredType)}>
                                    {declaredType}
                                  </button>
                                );
                              })()}
                            </div>
                            <div>multiplicity: {attr.multiplicity || "n/a"}</div>
                            <div>direction: {attr.direction || "n/a"}</div>
                            {attr.documentation ? <div style={{ whiteSpace: "pre-wrap" }}>documentation: {attr.documentation}</div> : null}
                          </div>
                        </details>
                      );
                    })}
                  </div>
                </details>
              );
            })}
          </section>
        )}
      </div>
    </div>
  );
}
