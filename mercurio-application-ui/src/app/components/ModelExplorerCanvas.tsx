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
  type EdgeMouseHandler,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
  type OnMove,
  type OnNodeDrag,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import type { DiagramPoint, DiagramViewport } from "../diagrams/file.js";
import type { ExplorerGraph, ExplorerGraphEdge } from "../explorer/graph.js";

type ModelExplorerCanvasProps = {
  graph: ExplorerGraph;
  positions: Record<string, DiagramPoint>;
  viewport: DiagramViewport | null | undefined;
  dragHover: boolean;
  selectedNodeQualifiedName: string | null;
  selectedEdgeId: string | null;
  selectedEdge: ExplorerGraphEdge | null;
  canGoBack: boolean;
  canGoForward: boolean;
  canExpandSelected: boolean;
  canReRootSelected: boolean;
  onPositionsChange: (positions: Record<string, DiagramPoint>) => void;
  onViewportChange: (viewport: DiagramViewport) => void;
  onSelectNode: (qualifiedName: string) => void;
  onOpenNode: (qualifiedName: string) => void;
  onReRootNode: (qualifiedName: string) => void;
  onExpandNode: (qualifiedName: string) => void;
  onSelectEdge: (edgeId: string | null) => void;
  onFollowRelationshipTarget: (qualifiedName: string) => void;
  onBack: () => void;
  onForward: () => void;
  onToggleDirectedRelationships: () => void;
  onCanvasDragEnter: (event: ReactDragEvent<HTMLDivElement>) => void;
  onCanvasDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  onCanvasDragLeave: (event: ReactDragEvent<HTMLDivElement>) => void;
  onCanvasDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
};

type ExplorerNodeData = {
  qualifiedName: string;
  name: string;
  kind: string;
  attributes: string[];
  documentation: string | null;
  relationOnly: boolean;
};

function pointsEqual(a: DiagramPoint | null | undefined, b: DiagramPoint | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y;
}

function viewportsEqual(
  a: DiagramViewport | null | undefined,
  b: DiagramViewport | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}

function nodeArraysEqual(
  left: Node<ExplorerNodeData>[],
  right: Node<ExplorerNodeData>[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (
      a.id !== b.id
      || a.type !== b.type
      || a.className !== b.className
      || !pointsEqual(a.position, b.position)
      || a.data.qualifiedName !== b.data.qualifiedName
      || a.data.name !== b.data.name
      || a.data.kind !== b.data.kind
      || a.data.documentation !== b.data.documentation
      || a.data.relationOnly !== b.data.relationOnly
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

function ExplorerNodeView({ data, selected }: NodeProps<Node<ExplorerNodeData>>) {
  return (
    <div className={`diagram-node-card ${selected ? "selected" : ""} ${data.relationOnly ? "relation-only" : ""}`}>
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
  explorerNode: ExplorerNodeView,
};

function ModelExplorerCanvasInner({
  graph,
  positions,
  viewport,
  dragHover,
  selectedNodeQualifiedName,
  selectedEdgeId,
  selectedEdge,
  canGoBack,
  canGoForward,
  canExpandSelected,
  canReRootSelected,
  onPositionsChange,
  onViewportChange,
  onSelectNode,
  onOpenNode,
  onReRootNode,
  onExpandNode,
  onSelectEdge,
  onFollowRelationshipTarget,
  onBack,
  onForward,
  onToggleDirectedRelationships,
  onCanvasDragEnter,
  onCanvasDragOver,
  onCanvasDragLeave,
  onCanvasDrop,
}: ModelExplorerCanvasProps) {
  const flow = useReactFlow();
  const appliedViewportRef = useRef<DiagramViewport | null>(null);
  const lastExternalNodesRef = useRef<Node<ExplorerNodeData>[]>([]);
  const graphNodesById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node] as const)),
    [graph.nodes],
  );
  const flowNodes = useMemo<Node<ExplorerNodeData>[]>(() => graph.nodes.map((node) => ({
    id: node.id,
    type: "explorerNode",
    position: positions[node.id] || { x: 0, y: 0 },
    data: {
      qualifiedName: node.qualifiedName,
      name: node.name,
      kind: node.kind,
      attributes: node.attributes,
      documentation: node.documentation,
      relationOnly: node.relationOnly,
    },
    className: [
      "diagram-flow-node",
      node.isRoot ? "root" : "",
      node.relationOnly ? "relation-only" : "",
      selectedNodeQualifiedName === node.qualifiedName ? "selected" : "",
    ].filter(Boolean).join(" "),
    draggable: true,
    selected: selectedNodeQualifiedName === node.qualifiedName,
  })), [graph.nodes, positions, selectedNodeQualifiedName]);
  const [nodes, setNodes, onNodesChange] = useNodesState(flowNodes);
  const edges = useMemo<Edge[]>(() => graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
    className: [
      "diagram-edge",
      "explorer-edge",
      edge.kind,
      edge.canonicalKind ? `canonical-${edge.canonicalKind}` : "",
      selectedEdgeId === edge.id ? "selected" : "",
    ].filter(Boolean).join(" "),
    selected: selectedEdgeId === edge.id,
  })), [graph.edges, selectedEdgeId]);

  useEffect(() => {
    if (nodeArraysEqual(lastExternalNodesRef.current, flowNodes)) {
      return;
    }
    lastExternalNodesRef.current = flowNodes;
    setNodes(flowNodes);
  }, [flowNodes, setNodes]);

  useEffect(() => {
    if (!viewport || !flow.viewportInitialized) return;
    const currentViewport = flow.toObject().viewport;
    if (
      viewportsEqual(appliedViewportRef.current, viewport)
      || viewportsEqual(currentViewport, viewport)
    ) {
      appliedViewportRef.current = viewport;
      return;
    }
    appliedViewportRef.current = viewport;
    void flow.setViewport(viewport, { duration: 0 });
  }, [flow, viewport]);

  const handleNodeClick = useMemo<NodeMouseHandler<Node<ExplorerNodeData>>>(
    () => (_event, node) => {
      onSelectEdge(null);
      onSelectNode(node.data.qualifiedName);
    },
    [onSelectEdge, onSelectNode],
  );

  const handleNodeDoubleClick = useMemo<NodeMouseHandler<Node<ExplorerNodeData>>>(
    () => (_event, node) => {
      onReRootNode(node.data.qualifiedName);
    },
    [onReRootNode],
  );

  const handleEdgeClick = useMemo<EdgeMouseHandler>(
    () => (_event, edge) => {
      onSelectEdge(edge.id);
    },
    [onSelectEdge],
  );

  const handlePaneClick = useMemo(
    () => () => {
      onSelectEdge(null);
    },
    [onSelectEdge],
  );

  const handleNodeDragStop = useMemo<OnNodeDrag<Node<ExplorerNodeData>>>(
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
      if (viewportsEqual(appliedViewportRef.current, next)) {
        return;
      }
      appliedViewportRef.current = next;
      onViewportChange(next);
    },
    [onViewportChange],
  );

  return (
    <div className={`simple-diagram-host model-explorer-host ${dragHover ? "drag-hover" : ""}`}>
      <div className="panel-header simple-editor-header simple-diagram-toolbar">
        <div className="simple-editor-title">
          {graph.unresolvedRoot ? "Explorer root unresolved" : "Model Explorer"}
        </div>
        <div className="simple-editor-meta">
          <span>Nodes: {graph.nodes.length}</span>
          <span>Edges: {graph.edges.length}</span>
          <span>Directed: {graph.showDirectedRelationships ? "On" : "Off"}</span>
        </div>
        <div className="simple-diagram-toolbar-actions">
          <button type="button" className="ghost" onClick={onBack} disabled={!canGoBack}>Back</button>
          <button type="button" className="ghost" onClick={onForward} disabled={!canGoForward}>Forward</button>
          <button type="button" className="ghost" onClick={onToggleDirectedRelationships}>
            {graph.showDirectedRelationships ? "Hide Relations" : "Show Relations"}
          </button>
          <button type="button" className="ghost" onClick={() => selectedNodeQualifiedName && onExpandNode(selectedNodeQualifiedName)} disabled={!canExpandSelected}>
            Expand One Hop
          </button>
          <button type="button" className="ghost" onClick={() => selectedNodeQualifiedName && onReRootNode(selectedNodeQualifiedName)} disabled={!canReRootSelected}>
            Re-root
          </button>
          <button type="button" className="ghost" onClick={() => selectedNodeQualifiedName && onOpenNode(selectedNodeQualifiedName)} disabled={!selectedNodeQualifiedName}>
            Open Source
          </button>
          <button type="button" className="ghost" onClick={() => void flow.fitView({ duration: 200, padding: 0.18 })}>
            Fit View
          </button>
          <button type="button" className="ghost" onClick={() => void flow.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 200 })}>
            Re-center
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
          onEdgeClick={handleEdgeClick}
          onPaneClick={handlePaneClick}
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
                The selected explorer root no longer resolves in the current semantic model.
              </div>
            </Panel>
          ) : null}
          {graph.diagnostics.length ? (
            <Panel position="top-left" className="diagram-overlay-card">
              {graph.diagnostics.slice(0, 5).map((diagnostic) => (
                <div key={diagnostic} className="muted">
                  {diagnostic}
                </div>
              ))}
            </Panel>
          ) : null}
          {selectedEdge ? (
            <Panel position="top-right" className="diagram-overlay-card explorer-edge-card">
              <div className="diagram-overlay-title">{selectedEdge.label || selectedEdge.canonicalKind || "Relationship"}</div>
              <div className="diagram-overlay-text">
                {(graphNodesById.get(selectedEdge.source)?.name || selectedEdge.sourceQualifiedName || selectedEdge.source)}
                {" -> "}
                {(graphNodesById.get(selectedEdge.target)?.name || selectedEdge.targetQualifiedName || selectedEdge.target)}
              </div>
              {selectedEdge.viaQualifiedName ? (
                <div className="muted">Via: {selectedEdge.viaQualifiedName}</div>
              ) : null}
              <button type="button" onClick={() => onFollowRelationshipTarget(selectedEdge.targetQualifiedName || selectedEdge.target)}>
                Follow Target
              </button>
            </Panel>
          ) : null}
        </ReactFlow>
      </div>
    </div>
  );
}

export function ModelExplorerCanvas(props: ModelExplorerCanvasProps) {
  return (
    <ReactFlowProvider>
      <ModelExplorerCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
