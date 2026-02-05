import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from "react";
import type {
  DiagramFile,
  DiagramLayout,
  DiagramNode,
  DiagramNodeOffset,
  DiagramNodeSize,
  DiagramViewport,
} from "./types";
import { createDiagramRenderer } from "./diagramRenderer";
import { useDiagramLayout } from "./useDiagramLayout";

type UseDiagramViewOptions = {
  activeDiagramPath: string | null;
  getKindKey: (kind: string) => string;
  renderTypeIcon: (kind: string, variant: "model" | "diagram") => ReactElement;
  rootPath: string;
  setCompileStatus: (status: string) => void;
};

export function useDiagramView({
  activeDiagramPath,
  getKindKey,
  renderTypeIcon,
  rootPath,
  setCompileStatus,
}: UseDiagramViewOptions) {
  const [diagramScale, setDiagramScale] = useState(1);
  const [diagramOffset, setDiagramOffset] = useState({ x: 0, y: 0 });
  const diagramPanRef = useRef<null | { x: number; y: number; startX: number; startY: number }>(null);
  const diagramBodyRef = useRef<HTMLDivElement | null>(null);
  const diagramViewportRef = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);
  const [diagramViewport, setDiagramViewport] = useState<DiagramViewport>({ x: 0, y: 0, width: 80, height: 60 });
  const [diagramNodeOffsets, setDiagramNodeOffsets] = useState<Record<string, DiagramNodeOffset>>({});
  const [diagramNodeSizes, setDiagramNodeSizes] = useState<Record<string, DiagramNodeSize>>({});
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
  const [diagramDropActive, setDiagramDropActive] = useState(false);
  const diagramLoadReqRef = useRef(0);
  const diagramSaveTimerRef = useRef<number | null>(null);
  const diagramLastSavedRef = useRef<Record<string, string>>({});
  const diagramLoadingRef = useRef(false);
  const pendingDropRef = useRef<null | { qualified: string; x: number; y: number }>(null);

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
      setSelectedNode(null);
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
        setSelectedNode(null);
        setDiagramScale(1);
        setDiagramOffset({ x: 0, y: 0 });
        diagramLastSavedRef.current[activeDiagramPath] = JSON.stringify({
          version: payload?.version ?? 1,
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
  }, [diagramNodes, diagramNodeOffsets, diagramNodeSizes, activeDiagramPath, rootPath, setCompileStatus]);

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

  const handleDiagramDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!rootPath || !activeDiagramPath) return;
      if (!diagramBodyRef.current) return;
      const raw = event.dataTransfer.getData("application/x-mercurio-diagram-node");
      const fallbackText = event.dataTransfer.getData("text/plain");
      if (!raw && !fallbackText) return;
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
      if (!payload?.qualified) return;
      if (!payload?.kind || payload.kind.toLowerCase() !== "package") return;
      event.preventDefault();
      setDiagramDropActive(false);
      const body = diagramBodyRef.current.getBoundingClientRect();
      const x = (event.clientX - body.left - diagramOffset.x) / diagramScale;
      const y = (event.clientY - body.top - diagramOffset.y) / diagramScale;
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

  const handleDiagramDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDiagramDropActive(true);
  }, []);

  const handleDiagramDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    const current = event.currentTarget;
    const related = event.relatedTarget as Node | null;
    if (related && current.contains(related)) return;
    setDiagramDropActive(false);
  }, []);

  return {
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
    palettePos,
    paletteGhost,
    paletteDragRef,
    paletteCreateRef,
    renderDiagramLayout,
    renderMinimapLayout,
    requestDiagramLayout,
    setPaletteGhost,
    setDiagramDropActive,
    handleDiagramDrop,
    handleDiagramDragOver,
    handleDiagramDragLeave,
  };
}
