import type { DragEvent, MutableRefObject, ReactElement } from "react";
import { memo, useEffect, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  NodeResizeControl,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { DiagramLayout, DiagramViewport } from "../types";
import { DIAGRAM_TYPE_OPTIONS, type DiagramType } from "../diagrams/model";

type DiagramViewProps = {
  activeDiagramPath: string | null;
  diagramLayout: DiagramLayout | null;
  diagramScale: number;
  diagramOffset: { x: number; y: number };
  diagramViewport: DiagramViewport;
  paletteGhost: null | { x: number; y: number; type: string };
  palettePos: { x: number; y: number };
  flowNodes: Node[];
  flowEdges: Edge[];
  onFlowNodesChange: (changes: NodeChange[]) => void;
  onFlowNodeClick: (id: string) => void;
  onFlowNodeDoubleClick: (id: string) => void;
  onFlowNodeDragStop: (id: string, x: number, y: number) => void;
  onSelectInTree: (id: string) => void;
  onSelectInText: (id: string) => void;
  onExpandTypeFromSelection: () => void;
  canExpandTypeFromSelection: boolean;
  onDeleteSelectedFlowNode: () => void;
  canDeleteSelectedFlowNode: boolean;
  snapToGrid: boolean;
  onToggleSnapToGrid: () => void;
  diagramBodyRef: MutableRefObject<HTMLDivElement | null>;
  diagramPanRef: MutableRefObject<null | { x: number; y: number; startX: number; startY: number }>;
  diagramPanPendingRef: MutableRefObject<{ x: number; y: number } | null>;
  diagramPanRafRef: MutableRefObject<number | null>;
  diagramViewportRef: MutableRefObject<null | { startX: number; startY: number; baseX: number; baseY: number }>;
  paletteDragRef: MutableRefObject<null | { startX: number; startY: number; baseX: number; baseY: number }>;
  paletteCreateRef: MutableRefObject<null | { type: string; name: string; startX: number; startY: number }>;
  diagramDropActive: boolean;
  diagramType: DiagramType;
  onDiagramTypeChange: (value: DiagramType) => void;
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

const SemanticNode = memo(function SemanticNode({ data, selected }: NodeProps) {
  const typeText = String(data?.kind || "element");
  const labelText = String(data?.label || "(unnamed)");
  const isPackage = !!data?.isPackage;
  const kindKey = String(data?.kindKey || "");
  const isPartDef = kindKey === "part-def";
  return (
    <div
      className={`flow-semantic-node ${selected ? "selected" : ""} ${isPackage ? "flow-package-node" : ""} ${
        isPartDef ? "flow-partdef-node" : ""
      }`}
    >
      <NodeResizeControl
        className="flow-node-resize-corner"
        minWidth={isPackage ? 320 : 220}
        minHeight={isPackage ? 120 : 66}
        position="bottom-right"
        style={{ display: selected ? "block" : "none" }}
      />
      {isPackage ? <div className="flow-package-tab" /> : null}
      <div className="flow-semantic-header">
        <span className="flow-semantic-name">{labelText}</span>
        <span className="flow-semantic-type">{typeText}</span>
      </div>
      {isPartDef ? <div className="flow-partdef-divider" /> : null}
    </div>
  );
});

const nodeTypes = {
  semantic: SemanticNode,
};

export function DiagramView(props: DiagramViewProps) {
  const [nodeMenu, setNodeMenu] = useState<null | { id: string; x: number; y: number }>(null);
  const [localNodes, setLocalNodes] = useState<Node[]>(props.flowNodes);

  useEffect(() => {
    const onWindowClick = () => setNodeMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNodeMenu(null);
    };
    window.addEventListener("click", onWindowClick);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", onWindowClick);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    setLocalNodes(props.flowNodes);
  }, [props.flowNodes]);

  return (
    <div
      className="diagram-surface"
      onDragOver={props.onDiagramDragOver}
      onDragEnter={props.onDiagramDragOver}
      onDragLeave={props.onDiagramDragLeave}
      onDrop={props.onDiagramDrop}
    >
      <div className="diagram-header">
        <span>Diagram view</span>
        <div className="diagram-controls">
          <select
            value={props.diagramType}
            onChange={(event) => props.onDiagramTypeChange(event.target.value as DiagramType)}
            title="Diagram type"
          >
            {DIAGRAM_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="ghost toggle-btn"
            onClick={props.onSwitchToText}
            title="Switch to text"
          >
            Text
          </button>
          <button
            type="button"
            className="ghost"
            onClick={props.onExpandTypeFromSelection}
            disabled={!props.canExpandTypeFromSelection}
            title="Expand type relationship from selected element"
          >
            Expand Type
          </button>
          <button
            type="button"
            className="ghost"
            onClick={props.onDeleteSelectedFlowNode}
            disabled={!props.canDeleteSelectedFlowNode}
            title="Remove selected element from this view"
          >
            Delete
          </button>
          <button
            type="button"
            className="ghost"
            onClick={props.onToggleSnapToGrid}
            title={props.snapToGrid ? "Disable snap and hide grid" : "Enable snap and show grid"}
          >
            {props.snapToGrid ? "Snap: On" : "Snap: Off"}
          </button>
        </div>
      </div>
      <div
        className={`diagram-body ${props.diagramDropActive ? "drop-active" : ""}`}
        ref={props.diagramBodyRef}
        onDragOver={props.onDiagramDragOver}
        onDragEnter={props.onDiagramDragOver}
        onDragLeave={props.onDiagramDragLeave}
        onDrop={props.onDiagramDrop}
      >
        {props.diagramDropActive ? <div className="diagram-drop-indicator">Drop to add element</div> : null}
        <div
          className="diagram-reactflow"
          onDragOver={props.onDiagramDragOver}
          onDragEnter={props.onDiagramDragOver}
          onDragLeave={props.onDiagramDragLeave}
          onDrop={props.onDiagramDrop}
        >
          <ReactFlow
            nodes={localNodes}
            edges={props.flowEdges}
            nodeTypes={nodeTypes}
            onNodesChange={(changes) => {
              setLocalNodes((prev) => applyNodeChanges(changes, prev));
              props.onFlowNodesChange(changes);
            }}
            onNodeClick={(_, node) => props.onFlowNodeClick(node.id)}
            onNodeDoubleClick={(_, node) => props.onFlowNodeDoubleClick(node.id)}
            onNodeDragStop={(_, node) => props.onFlowNodeDragStop(node.id, node.position.x, node.position.y)}
            onNodeContextMenu={(event, node) => {
              event.preventDefault();
              event.stopPropagation();
              setNodeMenu({ id: node.id, x: event.clientX, y: event.clientY });
            }}
            onDragOver={props.onDiagramDragOver}
            onDrop={props.onDiagramDrop}
            minZoom={0.2}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable
            snapToGrid={props.snapToGrid}
            snapGrid={[20, 20]}
          >
            {props.snapToGrid ? <Background gap={20} /> : null}
            <MiniMap pannable zoomable />
            <Controls />
          </ReactFlow>
        </div>
        {props.paletteGhost ? (
          <div
            className="diagram-ghost"
            style={{ left: `${props.paletteGhost.x}px`, top: `${props.paletteGhost.y}px` }}
          >
            {props.renderTypeIcon(props.paletteGhost.type, "diagram")}
            <span className="diagram-ghost-label">{props.paletteGhost.type}</span>
          </div>
        ) : null}
        {nodeMenu ? (
          <div
            className="context-menu"
            style={{ left: nodeMenu.x, top: nodeMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                props.onSelectInTree(nodeMenu.id);
                setNodeMenu(null);
              }}
            >
              Select in Tree
            </button>
            <button
              type="button"
              onClick={() => {
                props.onSelectInText(nodeMenu.id);
                setNodeMenu(null);
              }}
            >
              Select in Text
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
