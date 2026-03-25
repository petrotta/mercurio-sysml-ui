import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import {
  Background,
  Controls,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
  type OnMove,
  type OnNodeDrag,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import type { DiagramGraph } from "../diagrams/graph";
import type { DiagramPoint, DiagramViewport } from "../diagrams/file";

function diagramPointsEqual(a: DiagramPoint | null | undefined, b: DiagramPoint | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y;
}

function diagramViewportsEqual(
  a: DiagramViewport | null | undefined,
  b: DiagramViewport | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}

function diagramNodeArraysEqual(
  left: Node<DiagramNodeData>[],
  right: Node<DiagramNodeData>[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (
      a.id !== b.id
      || a.type !== b.type
      || a.className !== b.className
      || !diagramPointsEqual(a.position, b.position)
      || a.data.qualifiedName !== b.data.qualifiedName
      || a.data.name !== b.data.name
      || a.data.kind !== b.data.kind
      || a.data.documentation !== b.data.documentation
      || a.data.attributes.length !== b.data.attributes.length
    ) {
      return false;
    }
    for (let attributeIndex = 0; attributeIndex < a.data.attributes.length; attributeIndex += 1) {
      if (a.data.attributes[attributeIndex] !== b.data.attributes[attributeIndex]) {
        return false;
      }
    }
  }
  return true;
}

type DiagramCanvasProps = {
  graph: DiagramGraph;
  positions: Record<string, DiagramPoint>;
  viewport: DiagramViewport | null | undefined;
  dirty: boolean;
  dragHover: boolean;
  onPositionsChange: (positions: Record<string, DiagramPoint>) => void;
  onViewportChange: (viewport: DiagramViewport) => void;
  onSelectNode: (qualifiedName: string) => void;
  onOpenNode: (qualifiedName: string) => void;
  onSave: () => void;
  onCanvasDragEnter: (event: ReactDragEvent<HTMLDivElement>) => void;
  onCanvasDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  onCanvasDragLeave: (event: ReactDragEvent<HTMLDivElement>) => void;
  onCanvasDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
  onRebind?: () => void;
  canRebind?: boolean;
};

type DiagramNodeData = {
  qualifiedName: string;
  name: string;
  kind: string;
  attributes: string[];
  documentation: string | null;
};

function DiagramNodeView({ data, selected }: NodeProps<Node<DiagramNodeData>>) {
  return (
    <div className={`diagram-node-card ${selected ? "selected" : ""}`}>
      <div className="diagram-node-kind">{data.kind || "Element"}</div>
      <div className="diagram-node-name">{data.name || "<anonymous>"}</div>
      {data.attributes.length ? (
        <div className="diagram-node-attributes">
          {data.attributes.map((attribute) => (
            <div key={attribute} className="diagram-node-attribute">
              {attribute}
            </div>
          ))}
        </div>
      ) : null}
      {data.documentation ? (
        <div className="diagram-node-doc" title={data.documentation}>
          {data.documentation}
        </div>
      ) : null}
    </div>
  );
}

const nodeTypes = {
  diagramNode: DiagramNodeView,
};

function DiagramCanvasInner({
  graph,
  positions,
  viewport,
  dirty,
  dragHover,
  onPositionsChange,
  onViewportChange,
  onSelectNode,
  onOpenNode,
  onSave,
  onCanvasDragEnter,
  onCanvasDragOver,
  onCanvasDragLeave,
  onCanvasDrop,
  onRebind,
  canRebind,
}: DiagramCanvasProps) {
  const flow = useReactFlow();
  const appliedViewportRef = useRef<DiagramViewport | null>(null);
  const lastExternalNodesRef = useRef<Node<DiagramNodeData>[]>([]);
  const flowNodes = useMemo<Node<DiagramNodeData>[]>(
    () => graph.nodes.map((node) => ({
      id: node.id,
      type: "diagramNode",
      position: positions[node.id] || { x: 0, y: 0 },
      data: {
        qualifiedName: node.qualifiedName,
        name: node.name,
        kind: node.kind,
        attributes: node.attributes,
        documentation: node.documentation,
      },
      className: node.isRoot ? "diagram-flow-node root" : "diagram-flow-node",
      draggable: true,
    })),
    [graph.nodes, positions],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(flowNodes);
  const edges = useMemo<Edge[]>(() => graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
    className: `diagram-edge ${edge.kind}`,
  })), [graph.edges]);

  useEffect(() => {
    if (diagramNodeArraysEqual(lastExternalNodesRef.current, flowNodes)) {
      return;
    }
    lastExternalNodesRef.current = flowNodes;
    setNodes(flowNodes);
  }, [flowNodes, setNodes]);

  useEffect(() => {
    if (!viewport || !flow.viewportInitialized) return;
    const currentViewport = flow.toObject().viewport;
    if (
      diagramViewportsEqual(appliedViewportRef.current, viewport)
      || diagramViewportsEqual(currentViewport, viewport)
    ) {
      appliedViewportRef.current = viewport;
      return;
    }
    appliedViewportRef.current = viewport;
    void flow.setViewport(viewport, { duration: 0 });
  }, [flow, viewport]);

  const handleNodeClick = useMemo<NodeMouseHandler<Node<DiagramNodeData>>>(
    () => (_event, node) => {
      onSelectNode(node.data.qualifiedName);
    },
    [onSelectNode],
  );

  const handleNodeDoubleClick = useMemo<NodeMouseHandler<Node<DiagramNodeData>>>(
    () => (_event, node) => {
      onOpenNode(node.data.qualifiedName);
    },
    [onOpenNode],
  );

  const handleNodeDragStop = useMemo<OnNodeDrag<Node<DiagramNodeData>>>(
    () => (_event, node) => {
      const nextPositions: Record<string, DiagramPoint> = {};
      for (const current of nodes) {
        nextPositions[current.id] = current.id === node.id
          ? { x: node.position.x, y: node.position.y }
          : { x: current.position.x, y: current.position.y };
      }
      onPositionsChange(nextPositions);
      onSelectNode(node.data.qualifiedName);
    },
    [nodes, onPositionsChange, onSelectNode],
  );

  const handleMoveEnd = useMemo<OnMove>(
    () => (_event, nextViewport) => {
      const next = {
        x: nextViewport.x,
        y: nextViewport.y,
        zoom: nextViewport.zoom,
      };
      if (diagramViewportsEqual(appliedViewportRef.current, next)) {
        return;
      }
      appliedViewportRef.current = next;
      onViewportChange(next);
    },
    [onViewportChange],
  );

  return (
    <div className={`simple-diagram-host ${dragHover ? "drag-hover" : ""}`}>
      <div className="panel-header simple-editor-header simple-diagram-toolbar">
        <div className="simple-editor-title">
          {graph.unresolvedRoot ? "Diagram root unresolved" : "Diagram"}
          {dirty ? " *" : ""}
        </div>
        <div className="simple-editor-meta">
          <span>Nodes: {graph.nodes.length}</span>
          <span>Edges: {graph.edges.length}</span>
          <span>Type: {graph.diagramType.toUpperCase()}</span>
        </div>
        <div className="simple-diagram-toolbar-actions">
          <button type="button" className="ghost" onClick={() => void flow.fitView({ duration: 200, padding: 0.18 })}>
            Fit View
          </button>
          <button type="button" className="ghost" onClick={() => void flow.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 200 })}>
            Re-center
          </button>
          <button type="button" onClick={onSave} disabled={!dirty}>
            Save Layout
          </button>
        </div>
      </div>
      <div
        className="diagram-flow-shell"
        onDragEnter={onCanvasDragEnter}
        onDragOver={onCanvasDragOver}
        onDragLeave={onCanvasDragLeave}
        onDrop={onCanvasDrop}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
          onNodeDragStop={handleNodeDragStop}
          onMoveEnd={handleMoveEnd}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          nodeTypes={nodeTypes}
          minZoom={0.2}
          maxZoom={1.8}
          nodesConnectable={false}
          elementsSelectable
          deleteKeyCode={null}
        >
          <Background gap={16} size={1} />
          <Controls showInteractive={false} />
          {graph.unresolvedRoot ? (
            <Panel position="top-left" className="diagram-overlay-card">
              <div className="diagram-overlay-title">Root element not found</div>
              <div className="diagram-overlay-text">
                The bound root no longer resolves in the current semantic model.
              </div>
              {canRebind ? (
                <button type="button" onClick={onRebind}>
                  Rebind To Selected
                </button>
              ) : (
                <div className="muted">Select a symbol in the tree to rebind this diagram.</div>
              )}
            </Panel>
          ) : null}
          {graph.diagnostics.length ? (
            <Panel position="top-left" className="diagram-overlay-card">
              {graph.diagnostics.map((diagnostic) => (
                <div key={diagnostic} className="muted">
                  {diagnostic}
                </div>
              ))}
            </Panel>
          ) : null}
        </ReactFlow>
      </div>
    </div>
  );
}

export function DiagramCanvas(props: DiagramCanvasProps) {
  return (
    <ReactFlowProvider>
      <DiagramCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
