import type { MutableRefObject, ReactElement } from "react";
import type { DiagramLayout, DiagramNode, DiagramNodeOffset, DiagramNodeSize } from "./types";

type DiagramDragState = { node: string; startX: number; startY: number; base: DiagramNodeOffset };
type DiagramResizeState = { node: string; startX: number; startY: number; base: DiagramNodeSize };

type DiagramRendererOptions = {
  nodeByQualified: Map<string, DiagramNode>;
  getKindKey: (kind: string) => string;
  renderTypeIcon: (kind: string, variant: "model" | "diagram") => ReactElement;
  selectedNode: DiagramNode | null;
  setSelectedNode: (node: DiagramNode | null) => void;
  diagramNodeOffsets: Record<string, DiagramNodeOffset>;
  diagramNodeSizes: Record<string, DiagramNodeSize>;
  diagramDragRef: MutableRefObject<DiagramDragState | null>;
  diagramResizeRef: MutableRefObject<DiagramResizeState | null>;
};

export function createDiagramRenderer(options: DiagramRendererOptions) {
  const {
    nodeByQualified,
    getKindKey,
    renderTypeIcon,
    selectedNode,
    setSelectedNode,
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
    const node = nodeByQualified.get(layout.node.fullName);
    const kindLabel = node?.kind || layout.node.kind;
    const kindKey = getKindKey(kindLabel || "");
    const isPartDefShape = kindKey === "part-def";
    const isSelected = selectedNode?.qualified === layout.node.fullName;
    const offset = diagramNodeOffsets[layout.node.fullName] || { x: 0, y: 0 };
    const sizeOverride = diagramNodeSizes[layout.node.fullName];
    return (
      <div
        className={`diagram-node ${isSelected ? "selected" : ""} ${isPartDefShape ? "part-def-shape" : ""}`}
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
          if (node) {
            setSelectedNode(node);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && node) {
            setSelectedNode(node);
          }
        }}
      >
        <div className="diagram-node-header">
          {isPartDefShape ? null : renderTypeIcon(kindKey, "diagram")}
          <span className="diagram-node-name">{layout.node.name}</span>
          {!isPartDefShape && kindLabel ? <span className="diagram-node-kind">{kindLabel}</span> : null}
        </div>
        {isPartDefShape ? <div className="diagram-node-title-underline" /> : null}
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

  return { renderDiagramLayout, renderMinimapLayout };
}
