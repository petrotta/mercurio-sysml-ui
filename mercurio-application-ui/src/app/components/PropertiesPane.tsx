import { useEffect, useMemo, useState } from "react";
import type { MetamodelAttributeView, ProjectElementAttributesView, StdlibMetamodelView, SymbolView } from "../types";

type PropertiesPaneProps = {
  selectedSymbols: SymbolView[] | null;
  getDoc: (path: string) => { path: string; text: string; dirty: boolean } | null;
  readFile: (path: string) => Promise<string>;
  onOpenInProjectModel: (symbol: SymbolView) => void;
  onOpenMetatypeInProjectModel: (metatypeQname: string) => void;
  onOpenAttributeInProjectModel: (symbol: SymbolView, attrQualifiedName: string, attrName: string) => void;
  onOpenAttributeSourceText: (symbol: SymbolView, attrQualifiedName: string, attrName: string) => void;
  loadElementAttributes: (symbol: SymbolView) => Promise<ProjectElementAttributesView | null>;
  stdlibMetamodel: StdlibMetamodelView | null;
  stdlibMetamodelLoading: boolean;
  stdlibMetamodelError: string;
  onReloadStdlibMetamodel: () => void;
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

type DisplayAttributeRow = {
  source: "explicit" | "inherited";
  name: string;
  qualifiedName: string;
  declaredOn?: string;
  declaredType?: string | null;
  multiplicity?: string | null;
  direction?: string | null;
  documentation?: string | null;
  value: string | null;
  valueSource: "cst" | "symbol" | "none";
};

type MetatypeDisplayAttributeRow = {
  source: "explicit" | "inherited";
  name: string;
  qualifiedName: string;
  declaredOn: string;
  declaredType?: string | null;
  multiplicity?: string | null;
  direction?: string | null;
  documentation?: string | null;
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

const resolveAttributeValueDetailed = (
  symbol: SymbolView,
  attrName: string,
  cstValue: string | null | undefined,
): { value: string | null; source: "cst" | "symbol" | "none" } => {
  const cstRaw = cstValue != null ? cstValue.trim() : "";
  if (cstRaw.length) return { value: cstRaw, source: "cst" };
  const fallback = resolveFallbackAttrValue(symbol, attrName);
  const normalized = fallback?.trim() || "";
  if (normalized.length) return { value: normalized, source: "symbol" };
  return { value: null, source: "none" };
};

const buildDisplayAttributes = (
  symbol: SymbolView,
  metaData: ProjectElementAttributesView,
): DisplayAttributeRow[] => {
  const explicit = metaData.explicit_attributes.map((attr) => {
    const resolved = resolveAttributeValueDetailed(symbol, attr.name, attr.cst_value);
    return {
      source: "explicit" as const,
      name: attr.name,
      qualifiedName: attr.qualified_name,
      declaredType: attr.declared_type,
      multiplicity: attr.multiplicity,
      direction: attr.direction,
      documentation: attr.documentation,
      value: resolved.value,
      valueSource: resolved.source,
    };
  });
  const inherited = metaData.inherited_attributes.map((attr) => {
    const resolved = resolveAttributeValueDetailed(symbol, attr.name, attr.cst_value);
    return {
      source: "inherited" as const,
      name: attr.name,
      qualifiedName: attr.qualified_name,
      declaredOn: attr.declared_on,
      declaredType: attr.declared_type,
      multiplicity: attr.multiplicity,
      direction: attr.direction,
      documentation: attr.documentation,
      value: resolved.value,
      valueSource: resolved.source,
    };
  });
  return [...explicit, ...inherited].sort((a, b) => a.name.localeCompare(b.name));
};

const canonicalMetatypeKey = (qname: string | null | undefined): string =>
  (qname || "").trim().toLowerCase();

const tailName = (qname: string | null | undefined): string => {
  const raw = (qname || "").trim();
  if (!raw) return "";
  const ix = raw.lastIndexOf("::");
  return ix >= 0 ? raw.slice(ix + 2) : raw;
};

const normalizeMetatype = (
  qname: string | null | undefined,
  byQname: Map<string, string>,
  byTail: Map<string, string[]>,
): string | null => {
  const raw = (qname || "").trim();
  if (!raw) return null;
  const direct = byQname.get(canonicalMetatypeKey(raw));
  if (direct) return direct;
  const parts = raw.split("::").filter(Boolean);
  if (parts.length >= 2) {
    const collapsed = `${parts[0]}::${parts[parts.length - 1]}`;
    const collapsedDirect = byQname.get(canonicalMetatypeKey(collapsed));
    if (collapsedDirect) return collapsedDirect;
  }
  const candidates = byTail.get(canonicalMetatypeKey(tailName(raw))) || [];
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const rawParts = raw.split("::").filter(Boolean).map((part) => part.toLowerCase());
  const rawSet = new Set(rawParts);
  const hasNamespace = rawParts.length > 1;
  const ranked = candidates
    .map((candidate) => {
      const cParts = candidate.split("::").filter(Boolean).map((part) => part.toLowerCase());
      const overlap = cParts.filter((part) => rawSet.has(part)).length;
      const namespaceBonus = hasNamespace && cParts.length > 1 ? 2 : 0;
      const depthBonus = cParts.length;
      return { candidate, score: overlap * 10 + namespaceBonus + depthBonus };
    })
    .sort((a, b) => b.score - a.score || b.candidate.length - a.candidate.length);
  return ranked[0]?.candidate || null;
};

const collectInheritedMetatypeAttrs = (
  metatypeQname: string,
  typeByQname: Map<string, { qualified_name: string; declared_supertypes: string[]; attributes: MetamodelAttributeView[] }>,
  byQname: Map<string, string>,
  byTail: Map<string, string[]>,
): MetatypeDisplayAttributeRow[] => {
  const out: MetatypeDisplayAttributeRow[] = [];
  const visited = new Set<string>();
  const stack: string[] = [metatypeQname];
  visited.add(metatypeQname);

  while (stack.length) {
    const current = stack.pop()!;
    const typeItem = typeByQname.get(canonicalMetatypeKey(current));
    if (!typeItem) continue;
    for (const superRaw of typeItem.declared_supertypes || []) {
      const resolvedSuper = normalizeMetatype(superRaw, byQname, byTail);
      if (!resolvedSuper || visited.has(resolvedSuper)) continue;
      visited.add(resolvedSuper);
      stack.push(resolvedSuper);
      const superType = typeByQname.get(canonicalMetatypeKey(resolvedSuper));
      if (!superType) continue;
      for (const attr of superType.attributes || []) {
        out.push({
          source: "inherited",
          name: attr.name,
          qualifiedName: attr.qualified_name,
          declaredOn: resolvedSuper,
          declaredType: attr.declared_type,
          multiplicity: attr.multiplicity,
          direction: attr.direction,
          documentation: attr.documentation,
        });
      }
    }
  }
  return out;
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
  onOpenMetatypeInProjectModel,
  onOpenAttributeInProjectModel,
  onOpenAttributeSourceText,
  loadElementAttributes,
  stdlibMetamodel,
  stdlibMetamodelLoading,
  stdlibMetamodelError,
  onReloadStdlibMetamodel,
}: PropertiesPaneProps) {
  const [snippets, setSnippets] = useState<Record<string, SnippetState>>({});
  const [metatypeAttrs, setMetatypeAttrs] = useState<
    Record<string, { loading: boolean; error: string; data: ProjectElementAttributesView | null }>
  >({});
  const [attributeContextMenu, setAttributeContextMenu] = useState<AttributeContextMenuState | null>(null);
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
  const metamodelTypeByQname = useMemo(() => {
    const map = new Map<string, { qualified_name: string; declared_supertypes: string[]; attributes: MetamodelAttributeView[] }>();
    for (const t of stdlibMetamodel?.types || []) {
      map.set(canonicalMetatypeKey(t.qualified_name), {
        qualified_name: t.qualified_name,
        declared_supertypes: t.declared_supertypes || [],
        attributes: t.attributes || [],
      });
    }
    return map;
  }, [stdlibMetamodel]);
  const metamodelQnameByCanonical = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of stdlibMetamodel?.types || []) {
      map.set(canonicalMetatypeKey(t.qualified_name), t.qualified_name);
    }
    return map;
  }, [stdlibMetamodel]);
  const metamodelQnameByTail = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const t of stdlibMetamodel?.types || []) {
      const key = canonicalMetatypeKey(tailName(t.qualified_name));
      const existing = map.get(key) || [];
      existing.push(t.qualified_name);
      map.set(key, existing);
    }
    return map;
  }, [stdlibMetamodel]);

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
    if (!normalizedSymbols?.length) return;
    if (stdlibMetamodel || stdlibMetamodelLoading || stdlibMetamodelError) return;
    onReloadStdlibMetamodel();
  }, [
    normalizedSymbols,
    stdlibMetamodel,
    stdlibMetamodelLoading,
    stdlibMetamodelError,
    onReloadStdlibMetamodel,
  ]);

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
            const displayAttrs = meta?.data ? buildDisplayAttributes(symbol, meta.data) : [];
            const rawMetatypeQname = (meta?.data?.metatype_qname || "").trim();
            const resolvedMetatypeQname = normalizeMetatype(
              rawMetatypeQname || null,
              metamodelQnameByCanonical,
              metamodelQnameByTail,
            );
            const metatypeDisplayQname = resolvedMetatypeQname || rawMetatypeQname;
            const metatypeType = resolvedMetatypeQname
              ? metamodelTypeByQname.get(canonicalMetatypeKey(resolvedMetatypeQname))
              : null;
            const metatypeExplicitAttrs: MetatypeDisplayAttributeRow[] = (metatypeType?.attributes || []).map((attr) => ({
              source: "explicit",
              name: attr.name,
              qualifiedName: attr.qualified_name,
              declaredOn: metatypeType?.qualified_name || "",
              declaredType: attr.declared_type,
              multiplicity: attr.multiplicity,
              direction: attr.direction,
              documentation: attr.documentation,
            }));
            const metatypeInheritedAttrs = resolvedMetatypeQname
              ? collectInheritedMetatypeAttrs(
                  resolvedMetatypeQname,
                  metamodelTypeByQname,
                  metamodelQnameByCanonical,
                  metamodelQnameByTail,
                )
              : [];
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
                          <div className="properties-value">
                            {metatypeDisplayQname ? (
                              <button
                                type="button"
                                className="model-kind"
                                onClick={() => onOpenMetatypeInProjectModel(metatypeDisplayQname)}
                                title="Open metatype in Project Model"
                                style={linkButtonStyle}
                              >
                                {metatypeDisplayQname}
                              </button>
                            ) : (
                              "unresolved"
                            )}
                          </div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">Explicit attrs</div>
                          <div className="properties-value">{meta.data.explicit_attributes.length}</div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">Inherited attrs</div>
                          <div className="properties-value">{meta.data.inherited_attributes.length}</div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">Total attrs</div>
                          <div className="properties-value">{displayAttrs.length}</div>
                        </div>
                        <details className="properties-section" open>
                          <summary>Metatype definition attributes</summary>
                          <div className="properties-parse">
                            {stdlibMetamodelLoading ? <div className="muted">Loading stdlib metamodel...</div> : null}
                            {!stdlibMetamodelLoading && stdlibMetamodelError ? (
                              <div className="muted">
                                {stdlibMetamodelError}
                                {" "}
                                <button type="button" className="ghost" onClick={onReloadStdlibMetamodel}>
                                  Retry
                                </button>
                              </div>
                            ) : null}
                            {!stdlibMetamodelLoading && !stdlibMetamodelError && !stdlibMetamodel ? (
                              <div className="muted">
                                Stdlib metamodel is not loaded.
                                {" "}
                                <button type="button" className="ghost" onClick={onReloadStdlibMetamodel}>
                                  Load
                                </button>
                              </div>
                            ) : null}
                            <div className="properties-row">
                              <div className="properties-key">Explicit attrs</div>
                              <div className="properties-value">{metatypeExplicitAttrs.length}</div>
                            </div>
                            <div className="properties-row">
                              <div className="properties-key">Inherited attrs</div>
                              <div className="properties-value">{metatypeInheritedAttrs.length}</div>
                            </div>
                            {!stdlibMetamodelLoading &&
                            !stdlibMetamodelError &&
                            !!stdlibMetamodel &&
                            !metatypeExplicitAttrs.length &&
                            !metatypeInheritedAttrs.length ? (
                              <div className="muted">No metatype attribute data available.</div>
                            ) : null}
                            {[...metatypeExplicitAttrs, ...metatypeInheritedAttrs]
                              .sort((a, b) => a.name.localeCompare(b.name))
                              .map((attr) => (
                                <div key={`meta-def-${attr.source}-${attr.qualifiedName}`} className="properties-row">
                                  <div className="properties-key">{attr.source === "inherited" ? "Inherited" : "Explicit"}</div>
                                  <div className="properties-value">
                                    <div className="properties-attr-main">
                                      <button
                                        type="button"
                                        className="model-kind"
                                        style={linkButtonStyle}
                                        title="Open attribute in Project Model"
                                        onClick={() => onOpenMetatypeInProjectModel(attr.qualifiedName)}
                                      >
                                        <strong>{attr.source === "inherited" ? "^" : ""}{attr.name}</strong>
                                      </button>
                                    </div>
                                    <div className="properties-attr-meta">
                                      {attr.declaredOn ? (
                                        <>
                                          declared on{" "}
                                          <button
                                            type="button"
                                            className="model-kind"
                                            style={linkButtonStyle}
                                            onClick={() => onOpenMetatypeInProjectModel(attr.declaredOn)}
                                          >
                                            {attr.declaredOn}
                                          </button>
                                        </>
                                      ) : null}
                                      {attr.declaredType ? (
                                        <>
                                          {" | type "}
                                          <button
                                            type="button"
                                            className="model-kind"
                                            style={linkButtonStyle}
                                            onClick={() => onOpenMetatypeInProjectModel(attr.declaredType || "")}
                                          >
                                            {attr.declaredType}
                                          </button>
                                        </>
                                      ) : null}
                                      {attr.multiplicity ? ` | mult ${attr.multiplicity}` : ""}
                                      {attr.direction ? ` | dir ${attr.direction}` : ""}
                                    </div>
                                    <div className="properties-attr-meta">
                                      <button
                                        type="button"
                                        className="model-kind"
                                        style={linkButtonStyle}
                                        onClick={() => onOpenMetatypeInProjectModel(attr.qualifiedName)}
                                      >
                                        {attr.qualifiedName}
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              ))}
                          </div>
                        </details>
                        {displayAttrs.map((attr) => (
                          <div
                            key={`${attr.source}-${attr.qualifiedName}`}
                            className={`properties-row ${attr.value ? "" : "properties-row-empty"}`}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setAttributeContextMenu({
                                x: event.clientX,
                                y: event.clientY,
                                symbol,
                                attrQualifiedName: attr.qualifiedName,
                                attrName: attr.name,
                              });
                            }}
                          >
                            <div className="properties-key">{attr.source === "inherited" ? "Inherited" : "Explicit"}</div>
                            <div className="properties-value">
                              <div className="properties-attr-main">
                                <button
                                  type="button"
                                  className="model-kind"
                                  style={linkButtonStyle}
                                  title="Open attribute in Project Model"
                                  onClick={() => onOpenAttributeInProjectModel(symbol, attr.qualifiedName, attr.name)}
                                >
                                  <strong>{attr.source === "inherited" ? "^" : ""}{attr.name}</strong>
                                </button>
                                {attr.value ? ` = ${attr.value}` : " = <unresolved>"}
                              </div>
                              <div className="properties-attr-meta">
                                {attr.declaredOn ? (
                                  <>
                                    declared on{" "}
                                    <button
                                      type="button"
                                      className="model-kind"
                                      style={linkButtonStyle}
                                      onClick={() => onOpenMetatypeInProjectModel(attr.declaredOn || "")}
                                    >
                                      {attr.declaredOn}
                                    </button>
                                  </>
                                ) : (
                                  "declared on element"
                                )}
                                {attr.declaredType ? (
                                  <>
                                    {" | type "}
                                    <button
                                      type="button"
                                      className="model-kind"
                                      style={linkButtonStyle}
                                      onClick={() => onOpenMetatypeInProjectModel(attr.declaredType || "")}
                                    >
                                      {attr.declaredType}
                                    </button>
                                  </>
                                ) : null}
                                {attr.multiplicity ? ` | mult ${attr.multiplicity}` : ""}
                                {attr.direction ? ` | dir ${attr.direction}` : ""}
                                {attr.valueSource !== "none" ? ` | value source ${attr.valueSource}` : ""}
                              </div>
                              <div className="properties-attr-meta">
                                <button
                                  type="button"
                                  className="model-kind"
                                  style={linkButtonStyle}
                                  onClick={() => onOpenAttributeInProjectModel(symbol, attr.qualifiedName, attr.name)}
                                >
                                  {attr.qualifiedName}
                                </button>
                              </div>
                              {attr.documentation ? <div className="properties-attr-doc">{attr.documentation}</div> : null}
                            </div>
                          </div>
                        ))}
                        {meta.data.diagnostics
                          .filter((line) => line.startsWith("Metatype mapping source="))
                          .map((line, i) => (
                            <div key={`meta-map-${i}`} className="properties-row">
                              <div className="properties-key">Mapping</div>
                              <div className="properties-value">{line}</div>
                            </div>
                          ))}
                        {meta.data.diagnostics
                          .filter((line) => !line.startsWith("Metatype mapping source="))
                          .map((line, i) => (
                          <div key={`meta-diag-${i}`} className="properties-row">
                            <div className="properties-key">Diagnostic</div>
                            <div className="properties-value">{line}</div>
                          </div>
                        ))}
                      </>
                    ) : null}
                  </div>
                </details>
                <details className="properties-section" key={`element-${symbol.qualified_name}`} open>
                  <summary>Element details</summary>
                  <div className="properties-parse">
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
                            {symbol.file == null ? "-" : String(symbol.file)}
                          </div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">File path</div>
                          <div className="properties-value">{symbol.file_path ?? "-"}</div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">Start line</div>
                          <div className="properties-value">{symbol.start_line == null ? "-" : `${symbol.start_line + 1} (raw ${symbol.start_line})`}</div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">Start column</div>
                          <div className="properties-value">{symbol.start_col == null ? "-" : `${symbol.start_col + 1} (raw ${symbol.start_col})`}</div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">End line</div>
                          <div className="properties-value">{symbol.end_line == null ? "-" : `${symbol.end_line + 1} (raw ${symbol.end_line})`}</div>
                        </div>
                        <div className="properties-row">
                          <div className="properties-key">End column</div>
                          <div className="properties-value">{symbol.end_col == null ? "-" : `${symbol.end_col + 1} (raw ${symbol.end_col})`}</div>
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

