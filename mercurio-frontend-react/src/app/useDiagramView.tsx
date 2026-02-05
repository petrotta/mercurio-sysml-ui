import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { DiagramLayout, DiagramManualNode, DiagramViewport, SymbolView } from "./types";
import { createDiagramRenderer } from "./diagramRenderer";
import { useDiagramLayout } from "./useDiagramLayout";

type DiagramNodeOffset = { x: number; y: number };
type DiagramNodeSize = { width: number; height: number };

type UseDiagramViewOptions = {
  activeDiagramPath: string | null;
  activeTabPath: string | null;
  deferredSymbols: SymbolView[];
  selectedSymbol: SymbolView | null;
  setSelectedSymbol: (symbol: SymbolView | null) => void;
  selectSymbolInEditor: (symbol: SymbolView) => Promise<void> | void;
  syncModelTreeToSymbol: (symbol: SymbolView) => void;
  syncDiagramSelection: boolean;
  getKindKey: (kind: string) => string;
  renderTypeIcon: (kind: string, variant: "model" | "diagram") => ReactElement;
  rootPath: string;
  runBackgroundCompile: (root: string) => Promise<void> | void;
  setCompileStatus: (status: string) => void;
};

export function useDiagramView({
  activeDiagramPath,
  activeTabPath,
  deferredSymbols,
  selectedSymbol,
  setSelectedSymbol,
  selectSymbolInEditor,
  syncModelTreeToSymbol,
  syncDiagramSelection,
  getKindKey,
  renderTypeIcon,
  rootPath,
  runBackgroundCompile,
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
  const [diagramManualNodes, setDiagramManualNodes] = useState<DiagramManualNode[]>([]);
  const paletteCreateRef = useRef<null | { type: string; name: string; startX: number; startY: number }>(null);
  const [paletteGhost, setPaletteGhost] = useState<null | { x: number; y: number; type: string }>(null);

  const { diagramLayout, requestDiagramLayout, symbolByQualified } = useDiagramLayout({
    activeDiagramPath,
    deferredSymbols,
  });

  const { renderDiagramLayout, renderManualNode, renderMinimapLayout } = useMemo(
    () =>
      createDiagramRenderer({
        symbolByQualified,
        getKindKey,
        renderTypeIcon,
        selectedSymbol,
        setSelectedSymbol,
        selectSymbolInEditor,
        syncModelTreeToSymbol,
        syncDiagramSelection,
        diagramNodeOffsets,
        diagramNodeSizes,
        diagramDragRef,
        diagramResizeRef,
      }),
    [
      symbolByQualified,
      getKindKey,
      renderTypeIcon,
      selectedSymbol,
      setSelectedSymbol,
      selectSymbolInEditor,
      syncModelTreeToSymbol,
      syncDiagramSelection,
      diagramNodeOffsets,
      diagramNodeSizes,
    ],
  );

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
          const tempId = crypto.randomUUID();
          const tempName = `temp-${paletteCreateRef.current!.name.toLowerCase()}`;
          setDiagramManualNodes((prev) => [
            ...prev,
            {
              id: tempId,
              type: paletteCreateRef.current!.type,
              name: tempName,
              x,
              y,
              width: 180,
              height: 120,
              pending: true,
            },
          ]);
          if (!rootPath || !activeTabPath) {
            setCompileStatus("Select a file before creating a package");
            setDiagramManualNodes((prev) => prev.filter((node) => node.id !== tempId));
          } else {
            invoke("create_package", {
              payload: {
                root: rootPath,
                file: activeTabPath,
                name: `Package_${Date.now()}`,
              },
            })
              .then(() => {
                setDiagramManualNodes((prev) => prev.filter((node) => node.id !== tempId));
                void runBackgroundCompile(rootPath);
              })
              .catch((error) => {
                setCompileStatus(`Create package failed: ${error}`);
                setDiagramManualNodes((prev) =>
                  prev.map((node) => (node.id === tempId ? { ...node, pending: false } : node)),
                );
              });
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
  }, [activeTabPath, diagramOffset, diagramScale, paletteGhost, rootPath, runBackgroundCompile, setCompileStatus]);

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
    diagramManualNodes,
    palettePos,
    paletteGhost,
    paletteDragRef,
    paletteCreateRef,
    renderDiagramLayout,
    renderManualNode,
    renderMinimapLayout,
    requestDiagramLayout,
    setPaletteGhost,
  };
}
