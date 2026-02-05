import type { MutableRefObject, ReactElement } from "react";
import type { DiagramLayout, DiagramManualNode, DiagramViewport } from "../types";

type DiagramViewProps = {
  activeDiagramPath: string | null;
  syncDiagramSelection: boolean;
  diagramLayout: DiagramLayout | null;
  diagramScale: number;
  diagramOffset: { x: number; y: number };
  diagramViewport: DiagramViewport;
  diagramManualNodes: DiagramManualNode[];
  paletteGhost: null | { x: number; y: number; type: string };
  palettePos: { x: number; y: number };
  diagramBodyRef: MutableRefObject<HTMLDivElement | null>;
  diagramPanRef: MutableRefObject<null | { x: number; y: number; startX: number; startY: number }>;
  diagramPanPendingRef: MutableRefObject<{ x: number; y: number } | null>;
  diagramPanRafRef: MutableRefObject<number | null>;
  diagramViewportRef: MutableRefObject<null | { startX: number; startY: number; baseX: number; baseY: number }>;
  paletteDragRef: MutableRefObject<null | { startX: number; startY: number; baseX: number; baseY: number }>;
  paletteCreateRef: MutableRefObject<null | { type: string; name: string; startX: number; startY: number }>;
  onSwitchToText: () => void;
  onToggleSync: () => void;
  onAutoLayout: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  setDiagramOffset: (value: { x: number; y: number }) => void;
  setPaletteGhost: (value: null | { x: number; y: number; type: string }) => void;
  renderDiagramLayout: (layout: DiagramLayout) => ReactElement;
  renderManualNode: (node: DiagramManualNode) => ReactElement;
  renderMinimapLayout: (layout: DiagramLayout) => ReactElement;
  renderTypeIcon: (kind: string, variant: "model" | "diagram") => ReactElement;
};

export function DiagramView({
  activeDiagramPath,
  syncDiagramSelection,
  diagramLayout,
  diagramScale,
  diagramOffset,
  diagramViewport,
  diagramManualNodes,
  paletteGhost,
  palettePos,
  diagramBodyRef,
  diagramPanRef,
  diagramPanPendingRef,
  diagramPanRafRef,
  diagramViewportRef,
  paletteDragRef,
  paletteCreateRef,
  onSwitchToText,
  onToggleSync,
  onAutoLayout,
  onZoomIn,
  onZoomOut,
  onReset,
  setDiagramOffset,
  setPaletteGhost,
  renderDiagramLayout,
  renderManualNode,
  renderMinimapLayout,
  renderTypeIcon,
}: DiagramViewProps) {
  return (
    <div className="diagram-surface">
      <div className="diagram-header">
        <span>Diagram view</span>
        <div className="diagram-controls">
          <button
            type="button"
            className="ghost toggle-btn"
            onClick={onSwitchToText}
            title="Switch to text"
          >
            Text
          </button>
          <button
            type="button"
            className={`ghost ${syncDiagramSelection ? "active" : ""}`}
            onClick={onToggleSync}
            title="Sync diagram selection to model tree"
          >
            Sync
          </button>
          <button
            type="button"
            className="ghost"
            onClick={onAutoLayout}
          >
            Auto-layout
          </button>
          <button type="button" className="ghost" onClick={onZoomIn}>+</button>
          <button type="button" className="ghost" onClick={onZoomOut}>-</button>
          <button
            type="button"
            className="ghost"
            onClick={onReset}
          >
            Reset
          </button>
        </div>
      </div>
      <div
        className="diagram-body"
        ref={diagramBodyRef}
        onPointerDown={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest(".diagram-node") || target?.closest(".diagram-viewport")) return;
          diagramPanRef.current = {
            x: diagramOffset.x,
            y: diagramOffset.y,
            startX: event.clientX,
            startY: event.clientY,
          };
          (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!diagramPanRef.current) return;
          const deltaX = event.clientX - diagramPanRef.current.startX;
          const deltaY = event.clientY - diagramPanRef.current.startY;
          diagramPanPendingRef.current = {
            x: diagramPanRef.current.x + deltaX,
            y: diagramPanRef.current.y + deltaY,
          };
          if (diagramPanRafRef.current == null) {
            diagramPanRafRef.current = window.requestAnimationFrame(() => {
              if (diagramPanPendingRef.current) {
                setDiagramOffset(diagramPanPendingRef.current);
              }
              diagramPanPendingRef.current = null;
              diagramPanRafRef.current = null;
            });
          }
        }}
        onPointerUp={() => {
          diagramPanRef.current = null;
        }}
      >
        {diagramLayout ? (
          <>
            <div
              className="diagram-canvas"
              style={{
                transform: `translate(${diagramOffset.x}px, ${diagramOffset.y}px) scale(${diagramScale})`,
              }}
            >
              {renderDiagramLayout(diagramLayout)}
              {diagramManualNodes.map((node) => renderManualNode(node))}
            </div>
            {paletteGhost ? (
              <div
                className="diagram-ghost"
                style={{ left: `${paletteGhost.x}px`, top: `${paletteGhost.y}px` }}
              >
                {renderTypeIcon(paletteGhost.type, "diagram")}
              </div>
            ) : null}
            <div
              className="diagram-palette"
              style={{ left: `${palettePos.x}px`, top: `${palettePos.y}px` }}
            >
              <div
                className="diagram-palette-header"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  paletteDragRef.current = {
                    startX: event.clientX,
                    startY: event.clientY,
                    baseX: palettePos.x,
                    baseY: palettePos.y,
                  };
                  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
                }}
              >
                Palette
              </div>
              <button
                type="button"
                className="diagram-palette-item"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  paletteCreateRef.current = { type: "package", name: "Package", startX: event.clientX, startY: event.clientY };
                  setPaletteGhost({ x: event.clientX, y: event.clientY, type: "package" });
                  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
                }}
              >
                {renderTypeIcon("package", "diagram")}
                <span>Package</span>
              </button>
            </div>
            <div className="diagram-minimap">
              {diagramLayout ? (
                <div className="diagram-minimap-canvas">
                  <div
                    className="diagram-minimap-scale"
                    style={{
                      transform: `scale(${140 / Math.max(diagramLayout.width * diagramScale, 1)}, ${100 / Math.max(diagramLayout.height * diagramScale, 1)})`,
                    }}
                  >
                    {renderMinimapLayout(diagramLayout)}
                  </div>
                </div>
              ) : null}
              <div
                className="diagram-viewport"
                style={{
                  left: `${diagramViewport.x}px`,
                  top: `${diagramViewport.y}px`,
                  width: `${diagramViewport.width}px`,
                  height: `${diagramViewport.height}px`,
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  diagramViewportRef.current = {
                    startX: event.clientX,
                    startY: event.clientY,
                    baseX: diagramViewport.x,
                    baseY: diagramViewport.y,
                  };
                  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (!diagramViewportRef.current || !diagramLayout || !diagramBodyRef.current) return;
                  const deltaX = event.clientX - diagramViewportRef.current.startX;
                  const deltaY = event.clientY - diagramViewportRef.current.startY;
                  const nextX = Math.min(140 - diagramViewport.width, Math.max(0, diagramViewportRef.current.baseX + deltaX));
                  const nextY = Math.min(100 - diagramViewport.height, Math.max(0, diagramViewportRef.current.baseY + deltaY));
                  const canvasWidth = diagramLayout.width * diagramScale;
                  const canvasHeight = diagramLayout.height * diagramScale;
                  const miniScaleX = 140 / Math.max(canvasWidth, 1);
                  const miniScaleY = 100 / Math.max(canvasHeight, 1);
                  setDiagramOffset({
                    x: -nextX / miniScaleX,
                    y: -nextY / miniScaleY,
                  });
                }}
                onPointerUp={() => {
                  diagramViewportRef.current = null;
                }}
              />
            </div>
          </>
        ) : (
          <div className="diagram-placeholder">
            No symbols found for {activeDiagramPath ? activeDiagramPath.split(/[\\/]/).pop() : "file"}.
          </div>
        )}
      </div>
    </div>
  );
}
