import type { DragEvent, MutableRefObject, ReactElement } from "react";
import type { DiagramLayout, DiagramViewport } from "../types";

type DiagramViewProps = {
  activeDiagramPath: string | null;
  diagramLayout: DiagramLayout | null;
  diagramScale: number;
  diagramOffset: { x: number; y: number };
  diagramViewport: DiagramViewport;
  paletteGhost: null | { x: number; y: number; type: string };
  palettePos: { x: number; y: number };
  diagramBodyRef: MutableRefObject<HTMLDivElement | null>;
  diagramPanRef: MutableRefObject<null | { x: number; y: number; startX: number; startY: number }>;
  diagramPanPendingRef: MutableRefObject<{ x: number; y: number } | null>;
  diagramPanRafRef: MutableRefObject<number | null>;
  diagramViewportRef: MutableRefObject<null | { startX: number; startY: number; baseX: number; baseY: number }>;
  paletteDragRef: MutableRefObject<null | { startX: number; startY: number; baseX: number; baseY: number }>;
  paletteCreateRef: MutableRefObject<null | { type: string; name: string; startX: number; startY: number }>;
  diagramDropActive: boolean;
  onSwitchToText: () => void;
  onAutoLayout: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onDiagramDrop: (event: DragEvent<HTMLDivElement>) => void;
  onDiagramDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDiagramDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  setDiagramOffset: (value: { x: number; y: number }) => void;
  setPaletteGhost: (value: null | { x: number; y: number; type: string }) => void;
  renderDiagramLayout: (layout: DiagramLayout) => ReactElement;
  renderMinimapLayout: (layout: DiagramLayout) => ReactElement;
  renderTypeIcon: (kind: string, variant: "model" | "diagram") => ReactElement;
};

export function DiagramView({
  activeDiagramPath,
  diagramLayout,
  diagramScale,
  diagramOffset,
  diagramViewport,
  paletteGhost,
  palettePos,
  diagramBodyRef,
  diagramPanRef,
  diagramPanPendingRef,
  diagramPanRafRef,
  diagramViewportRef,
  paletteDragRef,
  paletteCreateRef,
  diagramDropActive,
  onSwitchToText,
  onAutoLayout,
  onZoomIn,
  onZoomOut,
  onReset,
  onDiagramDrop,
  onDiagramDragOver,
  onDiagramDragLeave,
  setDiagramOffset,
  setPaletteGhost,
  renderDiagramLayout,
  renderMinimapLayout,
  renderTypeIcon,
}: DiagramViewProps) {
  return (
    <div
      className="diagram-surface"
      onDragOver={onDiagramDragOver}
      onDragEnter={onDiagramDragOver}
      onDragLeave={onDiagramDragLeave}
      onDrop={onDiagramDrop}
    >
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
        className={`diagram-body ${diagramDropActive ? "drop-active" : ""}`}
        ref={diagramBodyRef}
        onDragOver={onDiagramDragOver}
        onDragEnter={onDiagramDragOver}
        onDragLeave={onDiagramDragLeave}
        onDrop={onDiagramDrop}
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
            {diagramDropActive ? <div className="diagram-drop-indicator">Drop to add package</div> : null}
            <div
              className="diagram-canvas"
              onDragOver={onDiagramDragOver}
              onDragEnter={onDiagramDragOver}
              onDragLeave={onDiagramDragLeave}
              onDrop={onDiagramDrop}
              style={{
                transform: `translate(${diagramOffset.x}px, ${diagramOffset.y}px) scale(${diagramScale})`,
              }}
            >
              {renderDiagramLayout(diagramLayout)}
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
            No diagram content for {activeDiagramPath ? activeDiagramPath.split(/[\\/]/).pop() : "file"}.
          </div>
        )}
      </div>
    </div>
  );
}
