import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from "react";
import type { Edge, Node as FlowNode, NodeChange } from "@xyflow/react";
import type {
  DiagramFile,
  DiagramLayout,
  DiagramNode,
  DiagramNodeOffset,
  DiagramNodeSize,
  SymbolView,
  DiagramViewport,
} from "./types";
import { createDiagramRenderer } from "./diagramRenderer";
import { useDiagramLayout } from "./useDiagramLayout";
import { DEFAULT_DIAGRAM_TYPE, normalizeDiagramType, type DiagramType } from "./diagrams/model";
import { getPendingDiagramDragPayload, setPendingDiagramDragPayload } from "./diagramDragPayload";

type UseDiagramViewOptions = {
  activeDiagramPath: string | null;
  symbols: SymbolView[];
  getKindKey: (kind: string) => string;
  renderTypeIcon: (kind: string, variant: "model" | "diagram") => ReactElement;
  rootPath: string;
  setCompileStatus: (status: string) => void;
};

export function useDiagramView({
  activeDiagramPath,
  symbols,
  getKindKey,
  renderTypeIcon,
  rootPath,
  setCompileStatus,
}: UseDiagramViewOptions) {
  const [diagramScale, setDiagramScale] = useState(1);
  const [diagramOffset, setDiagramOffset] = useState({ x: 0, y: 0 });
  const [diagramType, setDiagramType] = useState<DiagramType>(DEFAULT_DIAGRAM_TYPE);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const diagramPanRef = useRef<null | { x: number; y: number; startX: number; startY: number }>(null);
  const diagramBodyRef = useRef<HTMLDivElement | null>(null);
  const diagramViewportRef = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);
  const [diagramViewport, setDiagramViewport] = useState<DiagramViewport>({ x: 0, y: 0, width: 80, height: 60 });
  const [diagramNodeOffsets, setDiagramNodeOffsets] = useState<Record<string, DiagramNodeOffset>>({});
  const [diagramNodeSizes, setDiagramNodeSizes] = useState<Record<string, DiagramNodeSize>>({});
  const diagramNodeOffsetsRef = useRef<Record<string, DiagramNodeOffset>>({});
  const diagramNodeSizesRef = useRef<Record<string, DiagramNodeSize>>({});
  const diagramDragRef = useRef<null | { node: string; startX: number; startY: number; base: DiagramNodeOffset }>(null);
  const diagramResizeRef = useRef<null | { node: string; startX: number; startY: number; base: DiagramNodeSize }>(null);
  const diagramBoundsRef = useRef<Record<string, { minX: number; maxX: number; minY: number; maxY: number }>>({});
  const diagramRafRef = useRef<number | null>(null);
  const diagramPendingRef = useRef<{ offsets?: Record<string, DiagramNodeOffset>; sizes?: Record<string, DiagramNodeSize> }>({});
  const diagramPanRafRef = useRef<number | null>(null);
  const diagramPanPendingRef = useRef<{ x: number; y: number } | null>(null);
  const [palettePos, setPalettePos] = useState({ x: 16, y: 16 });
  const paletteDragRef = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);
  const paletteCreateRef = useRef<null | { type: string; name: string; startX: number; startY: number }>(null);
  const [paletteGhost, setPaletteGhost] = useState<null | { x: number; y: number; type: string }>(null);
  const [diagramNodes, setDiagramNodes] = useState<DiagramNode[]>([]);
  const diagramNodesRef = useRef<DiagramNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<DiagramNode | null>(null);
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const [expandedPackages, setExpandedPackages] = useState<Set<string>>(new Set());
  const [expandedTypeSources, setExpandedTypeSources] = useState<Set<string>>(new Set());
  const [hiddenFlowIds, setHiddenFlowIds] = useState<Set<string>>(new Set());
  const [diagramDropActive, setDiagramDropActive] = useState(false);
  const diagramLoadReqRef = useRef(0);
  const diagramSaveTimerRef = useRef<number | null>(null);
  const diagramLastSavedRef = useRef<Record<string, string>>({});
  const diagramLoadingRef = useRef(false);
  const pendingDropRef = useRef<null | { qualified: string; x: number; y: number }>(null);

  useEffect(() => {
    diagramNodeOffsetsRef.current = diagramNodeOffsets;
  }, [diagramNodeOffsets]);

  useEffect(() => {
    diagramNodeSizesRef.current = diagramNodeSizes;
  }, [diagramNodeSizes]);

  const projectSymbols = useMemo(() => {
    const out = new Map<string, SymbolView>();
    for (const symbol of symbols) {
      if (!symbol?.qualified_name) continue;
      if (symbol.source_scope === "library") continue;
      if (!out.has(symbol.qualified_name)) {
        out.set(symbol.qualified_name, symbol);
      }
    }
    return out;
  }, [symbols]);

  const packageSet = useMemo(() => {
    const out = new Set<string>();
    for (const [qn, symbol] of projectSymbols.entries()) {
      if (getKindKey(symbol.kind || "") === "package") {
        out.add(qn);
      }
    }
    return out;
  }, [projectSymbols, getKindKey]);

  const parentByQn = useMemo(() => {
    const out = new Map<string, string>();
    for (const qn of projectSymbols.keys()) {
      const parts = qn.split("::").filter(Boolean);
      if (parts.length < 2) continue;
      out.set(qn, parts.slice(0, -1).join("::"));
    }
    return out;
  }, [projectSymbols]);

  const childrenByParent = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const [qn, parent] of parentByQn.entries()) {
      const list = out.get(parent) || [];
      list.push(qn);
      out.set(parent, list);
    }
    for (const list of out.values()) {
      list.sort((a, b) => a.localeCompare(b));
    }
    return out;
  }, [parentByQn]);

  const resolvedTypeTargetBySource = useMemo(() => {
    const out = new Map<string, string>();
    const resolveToProjectQn = (candidate: string): string | null => {
      if (projectSymbols.has(candidate)) return candidate;
      const matches = Array.from(projectSymbols.keys()).filter(
        (qn) => qn === candidate || qn.endsWith(`::${candidate}`),
      );
      return matches.length === 1 ? matches[0] : null;
    };
    for (const [qn, symbol] of projectSymbols.entries()) {
      for (const prop of symbol.properties || []) {
        const key = (prop.name || "").toLowerCase();
        if (
          !key.includes("type") &&
          key !== "emf::declaredtype" &&
          key !== "typedelement::type"
        ) {
          continue;
        }
        const values =
          prop.value.type === "text"
            ? [prop.value.value]
            : prop.value.type === "list"
              ? prop.value.items
              : [];
        for (const raw of values) {
          const value = (raw || "").trim();
          if (!value || !value.includes("::")) continue;
          const resolved = resolveToProjectQn(value);
          if (resolved) {
            out.set(qn, resolved);
            break;
          }
        }
        if (out.has(qn)) break;
      }
    }
    return out;
  }, [projectSymbols]);

  const topPackages = useMemo(() => {
    const roots: string[] = [];
    for (const qn of packageSet) {
      const parent = parentByQn.get(qn);
      if (!parent || !packageSet.has(parent)) {
        roots.push(qn);
      }
    }
    roots.sort((a, b) => a.localeCompare(b));
    return roots;
  }, [packageSet, parentByQn]);

  const visibleQns = useMemo(() => {
    const visible = new Set<string>(topPackages);
    const queue = [...topPackages];
    while (queue.length) {
      const current = queue.shift()!;
      if (!expandedPackages.has(current)) continue;
      const children = childrenByParent.get(current) || [];
      for (const child of children) {
        if (!visible.has(child)) visible.add(child);
        if (packageSet.has(child)) {
          queue.push(child);
        }
      }
    }
    for (const source of expandedTypeSources) {
      if (!visible.has(source)) continue;
      const target = resolvedTypeTargetBySource.get(source);
      if (target) {
        visible.add(target);
      }
    }
    for (const hidden of hiddenFlowIds) {
      visible.delete(hidden);
    }
    return visible;
  }, [topPackages, expandedPackages, childrenByParent, packageSet, expandedTypeSources, resolvedTypeTargetBySource, hiddenFlowIds]);

  const flowNodes = useMemo<FlowNode[]>(() => {
    let y = 0;
    const positions = new Map<string, { x: number; y: number }>();
    const walk = (qn: string, depth: number) => {
      if (!visibleQns.has(qn) || positions.has(qn)) return;
      positions.set(qn, { x: depth * 280, y: y * 96 });
      y += 1;
      if (!packageSet.has(qn) || !expandedPackages.has(qn)) return;
      const children = childrenByParent.get(qn) || [];
      for (const child of children) {
        walk(child, depth + 1);
      }
    };
    for (const root of topPackages) {
      walk(root, 0);
    }
    for (const qn of visibleQns) {
      if (!positions.has(qn)) {
        positions.set(qn, { x: 0, y: y * 96 });
        y += 1;
      }
    }
    const packageChildLists = new Map<string, string[]>();
    for (const qn of visibleQns) {
      if (packageSet.has(qn)) continue;
      const parent = parentByQn.get(qn);
      if (!parent || !packageSet.has(parent) || !visibleQns.has(parent)) continue;
      const list = packageChildLists.get(parent) || [];
      list.push(qn);
      packageChildLists.set(parent, list);
    }
    for (const list of packageChildLists.values()) {
      list.sort((a, b) => a.localeCompare(b));
    }
    const nodes: FlowNode[] = [];
    const packageQns = Array.from(visibleQns).filter((qn) => packageSet.has(qn)).sort((a, b) => a.localeCompare(b));
    for (const qn of packageQns) {
      const symbol = projectSymbols.get(qn);
      if (!symbol) continue;
      const pos = diagramNodeOffsets[qn] || positions.get(qn) || { x: 0, y: 0 };
      const isPackage = packageSet.has(qn);
      const expanded = isPackage && expandedPackages.has(qn);
      const baseLabel = symbol.name || qn.split("::").pop() || qn;
      const typeLabel = (symbol.kind || (isPackage ? "package" : "element")).trim();
      const childCount = (packageChildLists.get(qn) || []).length;
      const packageHeight = 56 + Math.max(1, childCount) * 84;
      const sizeOverride = diagramNodeSizes[qn];
      const width = Math.max(320, sizeOverride?.width ?? 320);
      const height = Math.max(packageHeight, sizeOverride?.height ?? packageHeight);
      nodes.push({
        id: qn,
        type: "semantic",
        position: pos,
        data: {
          label: isPackage ? `${baseLabel} ${expanded ? "▾" : "▸"}` : baseLabel,
          kind: typeLabel,
          kindKey: getKindKey(symbol.kind || ""),
          isPackage,
          expanded,
        },
        selected: selectedFlowId === qn,
        style: {
          minWidth: 320,
          minHeight: packageHeight,
          width,
          height,
          borderColor: isPackage ? "#5f87c6" : "#2f3b4a",
          boxShadow: isPackage ? "0 0 0 1px rgba(95,135,198,0.45)" : undefined,
        },
      });
    }
    const nonPackageQns = Array.from(visibleQns).filter((qn) => !packageSet.has(qn)).sort((a, b) => a.localeCompare(b));
    for (const qn of nonPackageQns) {
      const symbol = projectSymbols.get(qn);
      if (!symbol) continue;
      const parent = parentByQn.get(qn);
      const parentIsVisiblePackage = !!(parent && packageSet.has(parent) && visibleQns.has(parent));
      const siblings = parentIsVisiblePackage ? packageChildLists.get(parent!) || [] : [];
      const siblingIndex = parentIsVisiblePackage ? Math.max(0, siblings.indexOf(qn)) : -1;
      const fallbackPos = positions.get(qn) || { x: 0, y: 0 };
      const defaultInParentPos = { x: 14, y: 46 + siblingIndex * 84 };
      const pos = diagramNodeOffsets[qn] || (parentIsVisiblePackage ? defaultInParentPos : fallbackPos);
      const baseLabel = symbol.name || qn.split("::").pop() || qn;
      const typeLabel = (symbol.kind || "element").trim();
      const kindKey = getKindKey(symbol.kind || "");
      const sizeOverride = diagramNodeSizes[qn];
      const width = Math.max(220, sizeOverride?.width ?? 280);
      const height = Math.max(66, sizeOverride?.height ?? 66);
      nodes.push({
        id: qn,
        type: "semantic",
        parentId: parentIsVisiblePackage ? parent! : undefined,
        extent: parentIsVisiblePackage ? "parent" : undefined,
        draggable: true,
        position: pos,
        data: {
          label: baseLabel,
          kind: typeLabel,
          kindKey,
          isPackage: false,
          expanded: false,
        },
        selected: selectedFlowId === qn,
        style: {
          minWidth: 220,
          width,
          minHeight: 66,
          height,
        },
      });
    }
    return nodes;
  }, [visibleQns, projectSymbols, packageSet, expandedPackages, childrenByParent, topPackages, diagramNodeOffsets, diagramNodeSizes, selectedFlowId, parentByQn, getKindKey]);

  const flowEdges = useMemo<Edge[]>(() => {
    const edges: Edge[] = [];
    for (const qn of visibleQns) {
      const parent = parentByQn.get(qn);
      if (!parent) continue;
      if (!visibleQns.has(parent)) continue;
      edges.push({
        id: `owner:${parent}->${qn}`,
        source: parent,
        target: qn,
        label: "owner",
        style: { stroke: "#5a6d86" },
        labelStyle: { fill: "#91a5be", fontSize: 10 },
      });
    }
    for (const [source, target] of resolvedTypeTargetBySource.entries()) {
      if (!expandedTypeSources.has(source)) continue;
      if (!visibleQns.has(source) || !visibleQns.has(target)) continue;
      edges.push({
        id: `type:${source}->${target}`,
        source,
        target,
        label: "type",
        style: { stroke: "#6aa2ff", strokeDasharray: "4 3" },
        labelStyle: { fill: "#9fc0ff", fontSize: 10 },
      });
    }
    return edges;
  }, [visibleQns, parentByQn, expandedTypeSources, resolvedTypeTargetBySource]);

  const handleFlowNodesChange = useCallback((changes: NodeChange[]) => {
    if (!changes.length) return;
    const selected = changes.find(
      (change): change is Extract<NodeChange, { type: "select"; id: string }> =>
        change.type === "select" && "id" in change && !!change.selected,
    );
    if (selected) {
      const hit = diagramNodesRef.current.find((node) => node.qualified === selected.id) || null;
      setSelectedNode(hit);
      setSelectedFlowId(selected.id);
    }
    const sizes: Record<string, DiagramNodeSize> = {};
    for (const change of changes) {
      if (change.type === "dimensions" && "id" in change && change.dimensions) {
        if (!("resizing" in change) || !change.resizing) {
          continue;
        }
        const nextWidth = Math.max(120, change.dimensions.width);
        const nextHeight = Math.max(60, change.dimensions.height);
        const pending = diagramPendingRef.current.sizes?.[change.id];
        const current = pending || diagramNodeSizesRef.current[change.id];
        if (!current || current.width !== nextWidth || current.height !== nextHeight) {
          sizes[change.id] = {
            width: nextWidth,
            height: nextHeight,
          };
        }
      }
    }
    if (Object.keys(sizes).length) {
      diagramPendingRef.current.sizes = {
        ...(diagramPendingRef.current.sizes || {}),
        ...sizes,
      };
    }
    if (Object.keys(sizes).length && diagramRafRef.current == null) {
      diagramRafRef.current = window.requestAnimationFrame(() => {
        const pending = diagramPendingRef.current;
        if (pending.offsets) {
          setDiagramNodeOffsets((prev) => ({ ...prev, ...pending.offsets }));
        }
        if (pending.sizes) {
          setDiagramNodeSizes((prev) => ({ ...prev, ...pending.sizes }));
        }
        diagramPendingRef.current = {};
        diagramRafRef.current = null;
      });
    }
  }, []);

  const handleFlowNodeDragStop = useCallback((id: string, x: number, y: number) => {
    const current = diagramNodeOffsetsRef.current[id];
    if (current && current.x === x && current.y === y) return;
    setDiagramNodeOffsets((prev) => ({
      ...prev,
      [id]: { x, y },
    }));
  }, []);

  const handleFlowNodeClick = useCallback((id: string) => {
    setSelectedFlowId(id);
    setSelectedNode(null);
  }, []);

  const handleFlowNodeDoubleClick = useCallback((id: string) => {
    if (!packageSet.has(id)) return;
    setExpandedPackages((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, [packageSet]);

  const handleExpandTypeFromSelection = useCallback(() => {
    if (!selectedFlowId) return;
    if (!resolvedTypeTargetBySource.has(selectedFlowId)) return;
    setExpandedTypeSources((prev) => {
      const next = new Set(prev);
      next.add(selectedFlowId);
      return next;
    });
  }, [selectedFlowId, resolvedTypeTargetBySource]);

  const revealQualifiedInExplorer = useCallback((qualified: string) => {
    if (!qualified) return;
    const toExpand: string[] = [];
    let cursor = qualified;
    while (true) {
      const parent = parentByQn.get(cursor);
      if (!parent) break;
      if (packageSet.has(parent)) {
        toExpand.push(parent);
      }
      cursor = parent;
    }
    if (packageSet.has(qualified)) {
      toExpand.push(qualified);
    }
    if (!toExpand.length) return;
    setExpandedPackages((prev) => {
      const next = new Set(prev);
      toExpand.forEach((qn) => next.add(qn));
      return next;
    });
    setHiddenFlowIds((prev) => {
      const next = new Set(prev);
      next.delete(qualified);
      return next;
    });
    setSelectedFlowId(qualified);
  }, [parentByQn, packageSet]);

  const { diagramLayout, requestDiagramLayout, nodeByQualified } = useDiagramLayout({
    activeDiagramPath,
    diagramNodes,
  });

  const { renderDiagramLayout, renderMinimapLayout } = useMemo(
    () =>
      createDiagramRenderer({
        nodeByQualified,
        getKindKey,
        renderTypeIcon,
        selectedNode,
        setSelectedNode,
        diagramNodeOffsets,
        diagramNodeSizes,
        diagramDragRef,
        diagramResizeRef,
      }),
    [
      nodeByQualified,
      getKindKey,
      renderTypeIcon,
      selectedNode,
      setSelectedNode,
      diagramNodeOffsets,
      diagramNodeSizes,
    ],
  );

  useEffect(() => {
    diagramNodesRef.current = diagramNodes;
  }, [diagramNodes]);

  useEffect(() => {
    if (!activeDiagramPath || !rootPath) {
      setDiagramNodes([]);
      setDiagramNodeOffsets({});
      setDiagramNodeSizes({});
      setDiagramType(DEFAULT_DIAGRAM_TYPE);
      setSelectedNode(null);
      setSelectedFlowId(null);
      setHiddenFlowIds(new Set());
      setExpandedTypeSources(new Set());
      return;
    }
    const reqId = ++diagramLoadReqRef.current;
    diagramLoadingRef.current = true;
    const clearLoading = window.setTimeout(() => {
      diagramLoadingRef.current = false;
    }, 0);
    invoke<DiagramFile>("read_diagram", { root: rootPath, path: activeDiagramPath })
      .then((payload) => {
        if (reqId !== diagramLoadReqRef.current) return;
        const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
        setDiagramNodes(nodes);
        setDiagramNodeOffsets(payload?.offsets || {});
        setDiagramNodeSizes(payload?.sizes || {});
        setDiagramType(normalizeDiagramType(payload?.diagram_type));
        setSelectedNode(null);
        setSelectedFlowId(null);
        setHiddenFlowIds(new Set());
        setExpandedTypeSources(new Set());
        setDiagramScale(1);
        setDiagramOffset({ x: 0, y: 0 });
        diagramLastSavedRef.current[activeDiagramPath] = JSON.stringify({
          version: payload?.version ?? 1,
          diagram_type: normalizeDiagramType(payload?.diagram_type),
          nodes,
          offsets: payload?.offsets || {},
          sizes: payload?.sizes || {},
        });
      })
      .catch((error) => {
        if (reqId !== diagramLoadReqRef.current) return;
        setCompileStatus(`Failed to load diagram: ${String(error)}`);
        setDiagramNodes([]);
        setDiagramNodeOffsets({});
        setDiagramNodeSizes({});
        setDiagramType(DEFAULT_DIAGRAM_TYPE);
        setSelectedFlowId(null);
        setHiddenFlowIds(new Set());
        setExpandedTypeSources(new Set());
      })
      .finally(() => {
        window.clearTimeout(clearLoading);
        diagramLoadingRef.current = false;
      });
    return () => window.clearTimeout(clearLoading);
  }, [activeDiagramPath, rootPath, setCompileStatus]);

  useEffect(() => {
    if (!rootPath || !activeDiagramPath) return;
    if (diagramLoadingRef.current) return;
    const payload: DiagramFile = {
      version: 1,
      diagram_type: diagramType,
      nodes: diagramNodes,
      offsets: diagramNodeOffsets,
      sizes: diagramNodeSizes,
    };
    const serialized = JSON.stringify(payload);
    if (diagramLastSavedRef.current[activeDiagramPath] === serialized) return;
    if (diagramSaveTimerRef.current) {
      window.clearTimeout(diagramSaveTimerRef.current);
    }
    diagramSaveTimerRef.current = window.setTimeout(() => {
      void invoke("write_diagram", { root: rootPath, path: activeDiagramPath, diagram: payload })
        .then(() => {
          diagramLastSavedRef.current[activeDiagramPath] = serialized;
        })
        .catch((error) => {
          setCompileStatus(`Failed to save diagram: ${String(error)}`);
        });
    }, 500);
    return () => {
      if (diagramSaveTimerRef.current) {
        window.clearTimeout(diagramSaveTimerRef.current);
      }
    };
  }, [diagramNodes, diagramNodeOffsets, diagramNodeSizes, diagramType, activeDiagramPath, rootPath, setCompileStatus]);

  useEffect(() => {
    if (!diagramLayout || !diagramBodyRef.current) return;
    const body = diagramBodyRef.current.getBoundingClientRect();
    const canvasWidth = diagramLayout.width * diagramScale;
    const canvasHeight = diagramLayout.height * diagramScale;
    const viewWidth = Math.min(140, Math.max(60, (body.width / Math.max(canvasWidth, 1)) * 140));
    const viewHeight = Math.min(100, Math.max(40, (body.height / Math.max(canvasHeight, 1)) * 100));
    const miniScaleX = 140 / Math.max(canvasWidth, 1);
    const miniScaleY = 100 / Math.max(canvasHeight, 1);
    const viewX = Math.min(140 - viewWidth, Math.max(0, -diagramOffset.x * miniScaleX));
    const viewY = Math.min(100 - viewHeight, Math.max(0, -diagramOffset.y * miniScaleY));
    setDiagramViewport({ x: viewX, y: viewY, width: viewWidth, height: viewHeight });
  }, [diagramLayout, diagramScale, diagramOffset]);

  const diagramBounds = useMemo(() => {
    if (!diagramLayout) return {};
    const bounds: Record<string, { minX: number; maxX: number; minY: number; maxY: number }> = {};
    const walk = (layout: DiagramLayout) => {
      const sizeOverride = diagramNodeSizes[layout.node.fullName];
      const width = sizeOverride?.width ?? layout.width;
      const height = sizeOverride?.height ?? layout.height;
      layout.children.forEach((child) => {
        const childSizeOverride = diagramNodeSizes[child.layout.node.fullName];
        const childWidth = childSizeOverride?.width ?? child.layout.width;
        const childHeight = childSizeOverride?.height ?? child.layout.height;
        bounds[child.layout.node.fullName] = {
          minX: -child.x,
          maxX: width - childWidth - child.x,
          minY: -child.y,
          maxY: height - childHeight - child.y,
        };
        walk(child.layout);
      });
    };
    walk(diagramLayout);
    return bounds;
  }, [diagramLayout, diagramNodeSizes]);

  useEffect(() => {
    diagramBoundsRef.current = diagramBounds;
  }, [diagramBounds]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (diagramDragRef.current) {
        const { node, startX, startY, base } = diagramDragRef.current;
        const deltaX = event.clientX - startX;
        const deltaY = event.clientY - startY;
        const bounds = diagramBoundsRef.current[node];
        const nextX = base.x + deltaX;
        const nextY = base.y + deltaY;
        const clampedX = bounds ? Math.min(bounds.maxX, Math.max(bounds.minX, nextX)) : nextX;
        const clampedY = bounds ? Math.min(bounds.maxY, Math.max(bounds.minY, nextY)) : nextY;
        diagramPendingRef.current.offsets = {
          ...(diagramPendingRef.current.offsets || {}),
          [node]: { x: clampedX, y: clampedY },
        };
      }
      if (diagramResizeRef.current) {
        const { node, startX, startY, base } = diagramResizeRef.current;
        const deltaX = event.clientX - startX;
        const deltaY = event.clientY - startY;
        diagramPendingRef.current.sizes = {
          ...(diagramPendingRef.current.sizes || {}),
          [node]: {
            width: Math.max(120, base.width + deltaX),
            height: Math.max(60, base.height + deltaY),
          },
        };
      }
      if (diagramDragRef.current || diagramResizeRef.current) {
        if (diagramRafRef.current == null) {
          diagramRafRef.current = window.requestAnimationFrame(() => {
            const pending = diagramPendingRef.current;
            if (pending.offsets) {
              setDiagramNodeOffsets((prev) => ({ ...prev, ...pending.offsets }));
            }
            if (pending.sizes) {
              setDiagramNodeSizes((prev) => ({ ...prev, ...pending.sizes }));
            }
            diagramPendingRef.current = {};
            diagramRafRef.current = null;
          });
        }
      }
      if (paletteDragRef.current) {
        const deltaX = event.clientX - paletteDragRef.current.startX;
        const deltaY = event.clientY - paletteDragRef.current.startY;
        setPalettePos({
          x: paletteDragRef.current.baseX + deltaX,
          y: paletteDragRef.current.baseY + deltaY,
        });
      }
      if (paletteCreateRef.current) {
        setPaletteGhost({ x: event.clientX, y: event.clientY, type: paletteCreateRef.current.type });
      }
    };
    const onUp = () => {
      diagramDragRef.current = null;
      diagramResizeRef.current = null;
      diagramViewportRef.current = null;
      paletteDragRef.current = null;
      if (paletteCreateRef.current && diagramBodyRef.current) {
        const body = diagramBodyRef.current.getBoundingClientRect();
        const within =
          paletteGhost &&
          paletteGhost.x >= body.left &&
          paletteGhost.x <= body.right &&
          paletteGhost.y >= body.top &&
          paletteGhost.y <= body.bottom;
        if (within) {
          const x = (paletteGhost!.x - body.left - diagramOffset.x) / diagramScale;
          const y = (paletteGhost!.y - body.top - diagramOffset.y) / diagramScale;
          if (!rootPath || !activeDiagramPath) {
            setCompileStatus("Open a diagram file before creating a node");
          } else {
            const baseName = paletteCreateRef.current!.name || "Node";
            const existing = diagramNodesRef.current.map((node) => node.qualified);
            let nextName = baseName;
            let index = 1;
            while (existing.includes(nextName)) {
              index += 1;
              nextName = `${baseName}_${index}`;
            }
            const qualified = nextName;
            const kind = paletteCreateRef.current!.type;
            pendingDropRef.current = { qualified, x, y };
            setDiagramNodes((prev) => [...prev, { qualified, name: nextName, kind }]);
            setDiagramNodeSizes((prev) => ({
              ...prev,
              [qualified]: { width: 180, height: 120 },
            }));
          }
        }
      }
      paletteCreateRef.current = null;
      setPaletteGhost(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [activeDiagramPath, diagramOffset, diagramScale, paletteGhost, rootPath, setCompileStatus]);

  useEffect(() => {
    if (!diagramLayout || !pendingDropRef.current) return;
    const pending = pendingDropRef.current;
    const findPosition = (layout: DiagramLayout, target: string, baseX: number, baseY: number): { x: number; y: number } | null => {
      if (layout.node.fullName === target) {
        return { x: baseX, y: baseY };
      }
      for (const child of layout.children) {
        const found = findPosition(child.layout, target, baseX + child.x, baseY + child.y);
        if (found) return found;
      }
      return null;
    };
    const position = findPosition(diagramLayout, pending.qualified, 0, 0);
    if (position) {
      setDiagramNodeOffsets((prev) => ({
        ...prev,
        [pending.qualified]: { x: pending.x - position.x, y: pending.y - position.y },
      }));
      pendingDropRef.current = null;
    }
  }, [diagramLayout]);

  const addDiagramNodeFromPayload = useCallback(
    (payload: { qualified: string; name?: string; kind?: string }, clientX: number, clientY: number) => {
      if (!rootPath || !activeDiagramPath) return;
      if (!diagramBodyRef.current) return;
      if (!payload?.qualified) return;
      setDiagramDropActive(false);
      const body = diagramBodyRef.current.getBoundingClientRect();
      const clampedClientX = Math.min(body.right, Math.max(body.left, clientX));
      const clampedClientY = Math.min(body.bottom, Math.max(body.top, clientY));
      const x = (clampedClientX - body.left - diagramOffset.x) / diagramScale;
      const y = (clampedClientY - body.top - diagramOffset.y) / diagramScale;
      const qualified = payload.qualified;
      const exists = diagramNodesRef.current.some((node) => node.qualified === qualified);
      if (!exists) {
        setDiagramNodes((prev) => [
          ...prev,
          {
            qualified,
            name: payload?.name || qualified.split("::").pop() || qualified,
            kind: payload?.kind || "",
          },
        ]);
      }
      pendingDropRef.current = { qualified, x, y };
      setDiagramNodeSizes((prev) => ({
        ...prev,
        [qualified]: prev[qualified] || { width: 180, height: 120 },
      }));
    },
    [rootPath, activeDiagramPath, diagramOffset, diagramScale],
  );

  const handleDiagramDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!rootPath || !activeDiagramPath) return;
      if (!diagramBodyRef.current) return;
      const raw = (() => {
        try {
          return event.dataTransfer.getData("application/x-mercurio-diagram-node");
        } catch {
          return "";
        }
      })();
      const fallbackText = (() => {
        try {
          return event.dataTransfer.getData("text/plain");
        } catch {
          return "";
        }
      })();
      let payload: { qualified: string; name?: string; kind?: string } | null = null;
      if (raw) {
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = null;
        }
      }
      if (!payload && fallbackText) {
        payload = {
          qualified: fallbackText.trim(),
          name: fallbackText.trim().split("::").pop(),
          kind: "package",
        };
      }
      if (!payload) {
        payload = getPendingDiagramDragPayload();
      }
      if (!payload?.qualified) return;
      event.preventDefault();
      if (projectSymbols.has(payload.qualified)) {
        revealQualifiedInExplorer(payload.qualified);
        setDiagramDropActive(false);
        setPendingDiagramDragPayload(null);
        return;
      }
      addDiagramNodeFromPayload(payload, event.clientX, event.clientY);
      setPendingDiagramDragPayload(null);
    },
    [rootPath, activeDiagramPath, addDiagramNodeFromPayload, projectSymbols, revealQualifiedInExplorer],
  );

  const handleDiagramDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDiagramDropActive(true);
  }, []);

  const handleDiagramDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    const current = event.currentTarget;
    const related = event.relatedTarget as globalThis.Node | null;
    if (related && current.contains(related)) return;
    setDiagramDropActive(false);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!activeDiagramPath) return;
      if (!selectedFlowId) return;
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, select") ||
        target?.isContentEditable
      ) {
        return;
      }
      event.preventDefault();
      const qualified = selectedFlowId;
      setHiddenFlowIds((prev) => {
        const next = new Set(prev);
        next.add(qualified);
        return next;
      });
      setExpandedTypeSources((prev) => {
        const next = new Set(prev);
        next.delete(qualified);
        return next;
      });
      setSelectedFlowId(null);
      setSelectedNode(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeDiagramPath, selectedFlowId]);

  const handleDeleteSelectedFlowNode = useCallback(() => {
    if (!selectedFlowId) return;
    const qualified = selectedFlowId;
    setHiddenFlowIds((prev) => {
      const next = new Set(prev);
      next.add(qualified);
      return next;
    });
    setExpandedTypeSources((prev) => {
      const next = new Set(prev);
      next.delete(qualified);
      return next;
    });
    setSelectedFlowId(null);
  }, [selectedFlowId]);

  return {
    diagramType,
    setDiagramType,
    snapToGrid,
    setSnapToGrid,
    diagramScale,
    setDiagramScale,
    diagramOffset,
    setDiagramOffset,
    diagramPanRef,
    diagramBodyRef,
    diagramViewportRef,
    diagramViewport,
    diagramNodeOffsets,
    setDiagramNodeOffsets,
    diagramNodeSizes,
    setDiagramNodeSizes,
    diagramPanRafRef,
    diagramPanPendingRef,
    diagramLayout,
    diagramDropActive,
    flowNodes,
    flowEdges,
    handleFlowNodesChange,
    handleFlowNodeClick,
    handleFlowNodeDoubleClick,
    handleFlowNodeDragStop,
    handleExpandTypeFromSelection,
    canExpandTypeFromSelection: !!(selectedFlowId && resolvedTypeTargetBySource.has(selectedFlowId)),
    canDeleteSelectedFlowNode: !!selectedFlowId,
    handleDeleteSelectedFlowNode,
    palettePos,
    paletteGhost,
    paletteDragRef,
    paletteCreateRef,
    renderDiagramLayout,
    renderMinimapLayout,
    requestDiagramLayout,
    setPaletteGhost,
    setDiagramDropActive,
    addDiagramNodeFromPayload,
    handleDiagramDrop,
    handleDiagramDragOver,
    handleDiagramDragLeave,
  };
}

