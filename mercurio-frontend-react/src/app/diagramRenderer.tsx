import type { MutableRefObject, ReactElement } from "react";
import type { DiagramLayout, DiagramManualNode, SymbolView } from "./types";

type DiagramNodeOffset = { x: number; y: number };
type DiagramNodeSize = { width: number; height: number };

type DiagramDragState = { node: string; startX: number; startY: number; base: DiagramNodeOffset };
type DiagramResizeState = { node: string; startX: number; startY: number; base: DiagramNodeSize };

type DiagramRendererOptions = {
  symbolByQualified: Map<string, SymbolView>;
  getKindKey: (kind: string) => string;
  renderTypeIcon: (kind: string, variant: "model" | "diagram") => ReactElement;
  selectedSymbol: SymbolView | null;
  setSelectedSymbol: (symbol: SymbolView | null) => void;
  selectSymbolInEditor: (symbol: SymbolView) => Promise<void> | void;
  syncModelTreeToSymbol: (symbol: SymbolView) => void;
  syncDiagramSelection: boolean;
  diagramNodeOffsets: Record<string, DiagramNodeOffset>;
  diagramNodeSizes: Record<string, DiagramNodeSize>;
  diagramDragRef: MutableRefObject<DiagramDragState | null>;
  diagramResizeRef: MutableRefObject<DiagramResizeState | null>;
};

export function createDiagramRenderer(options: DiagramRendererOptions) {
  const {
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
  } = options;

  const renderDiagramLayout = (layout: DiagramLayout) => {
    if (layout.node.name === "root") {
      return (
        <div className="diagram-content" style={{ width: `${layout.width}px`, height: `${layout.height}px` }}>
          {layout.children.map((child) => (
            <div
              key={child.layout.node.fullName}
              className="diagram-position"
              style={{ left: `${child.x}px`, top: `${child.y}px` }}
            >
              {renderDiagramLayout(child.layout)}
            </div>
          ))}
        </div>
      );
    }
    const symbol = symbolByQualified.get(layout.node.fullName);
    const kindLabel = symbol?.kind || layout.node.kind;
    const kindKey = getKindKey(kindLabel || "");
    const isSelected = selectedSymbol?.qualified_name === layout.node.fullName;
    const offset = diagramNodeOffsets[layout.node.fullName] || { x: 0, y: 0 };
    const sizeOverride = diagramNodeSizes[layout.node.fullName];
    return (
      <div
        className={`diagram-node ${isSelected ? "selected" : ""}`}
        style={{
          width: `${sizeOverride?.width ?? layout.width}px`,
          height: `${sizeOverride?.height ?? layout.height}px`,
          transform: `translate(${offset.x}px, ${offset.y}px)`,
        }}
        role="button"
        tabIndex={0}
        onPointerDown={(event) => {
          event.stopPropagation();
          diagramDragRef.current = {
            node: layout.node.fullName,
            startX: event.clientX,
            startY: event.clientY,
            base: offset,
          };
          (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (symbol) {
            setSelectedSymbol(symbol);
            void selectSymbolInEditor(symbol);
            if (syncDiagramSelection) {
              syncModelTreeToSymbol(symbol);
            }
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && symbol) {
            setSelectedSymbol(symbol);
            void selectSymbolInEditor(symbol);
          }
        }}
      >
        <div className="diagram-node-header">
          {renderTypeIcon(kindKey, "diagram")}
          <span className="diagram-node-name">{layout.node.name}</span>
          {kindLabel ? <span className="diagram-node-kind">{kindLabel}</span> : null}
        </div>
        {layout.children.map((child) => {
          const childOffset = diagramNodeOffsets[child.layout.node.fullName] || { x: 0, y: 0 };
          return (
            <div
              key={child.layout.node.fullName}
              className="diagram-position"
              style={{ left: `${child.x + childOffset.x}px`, top: `${child.y + childOffset.y}px` }}
            >
              {renderDiagramLayout(child.layout)}
            </div>
          );
        })}
        <div
          className="diagram-resize-handle"
          onPointerDown={(event) => {
            event.stopPropagation();
            diagramResizeRef.current = {
              node: layout.node.fullName,
              startX: event.clientX,
              startY: event.clientY,
              base: {
                width: sizeOverride?.width ?? layout.width,
                height: sizeOverride?.height ?? layout.height,
              },
            };
            (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
          }}
        />
      </div>
    );
  };

  const renderManualNode = (node: DiagramManualNode) => {
    const kindKey = getKindKey(node.type);
    return (
      <div
        key={node.id}
        className={`diagram-node manual ${node.pending ? "pending" : ""}`}
        style={{
          width: `${node.width}px`,
          height: `${node.height}px`,
          transform: `translate(${node.x}px, ${node.y}px)`,
        }}
      >
        <div className="diagram-node-header">
          {renderTypeIcon(kindKey, "diagram")}
          <span className="diagram-node-name">{node.name}</span>
        </div>
      </div>
    );
  };

  const renderMinimapLayout = (layout: DiagramLayout) => {
    if (layout.node.name === "root") {
      return (
        <div className="minimap-content" style={{ width: `${layout.width}px`, height: `${layout.height}px` }}>
          {layout.children.map((child) => (
            <div
              key={child.layout.node.fullName}
              className="diagram-position"
              style={{ left: `${child.x}px`, top: `${child.y}px` }}
            >
              {renderMinimapLayout(child.layout)}
            </div>
          ))}
        </div>
      );
    }
    return (
      <div className="minimap-node" style={{ width: `${layout.width}px`, height: `${layout.height}px` }}>
        {layout.children.map((child) => (
          <div
            key={child.layout.node.fullName}
            className="diagram-position"
            style={{ left: `${child.x}px`, top: `${child.y}px` }}
          >
            {renderMinimapLayout(child.layout)}
          </div>
        ))}
      </div>
    );
  };

  return { renderDiagramLayout, renderManualNode, renderMinimapLayout };
}
