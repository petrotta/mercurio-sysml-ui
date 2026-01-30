const diagramState = {
  toggleEl: null,
  paneEl: null,
  svgEl: null,
  statusEl: null,
  zoomInEl: null,
  zoomOutEl: null,
  zoomResetEl: null,
  copyEl: null,
  editorPanelEl: null,
  normalizePath: (value) => value || "",
  readFile: null,
  writeFile: null,
  currentFile: "",
  symbols: [],
  mode: false,
  zoom: 1,
  pan: { x: 0, y: 0 },
  renderId: 0,
  nodePositions: new Map(),
  edges: [],
  symbolById: new Map(),
  pointerState: { dragging: null, startX: 0, startY: 0, originX: 0, originY: 0 },
  layoutBounds: { width: 800, height: 600 },
};

export function initDiagram(options) {
  diagramState.toggleEl = options.toggleEl || null;
  diagramState.paneEl = options.paneEl || null;
  diagramState.svgEl = options.svgEl || null;
  diagramState.statusEl = options.statusEl || null;
  diagramState.zoomInEl = options.zoomInEl || null;
  diagramState.zoomOutEl = options.zoomOutEl || null;
  diagramState.zoomResetEl = options.zoomResetEl || null;
  diagramState.copyEl = options.copyEl || null;
  diagramState.editorPanelEl = options.editorPanelEl || null;
  diagramState.readFile = typeof options.readFile === "function" ? options.readFile : null;
  diagramState.writeFile = typeof options.writeFile === "function" ? options.writeFile : null;
  diagramState.onSelectInTree = typeof options.onSelectInTree === "function" ? options.onSelectInTree : null;
  if (typeof options.normalizePath === "function") {
    diagramState.normalizePath = options.normalizePath;
  }

  diagramState.toggleEl?.addEventListener("click", () => {
    setDiagramMode(!diagramState.mode);
  });
  diagramState.zoomInEl?.addEventListener("click", () => {
    setDiagramZoom(diagramState.zoom + 0.1);
  });
  diagramState.zoomOutEl?.addEventListener("click", () => {
    setDiagramZoom(diagramState.zoom - 0.1);
  });
  diagramState.zoomResetEl?.addEventListener("click", () => {
    fitDiagramToView();
  });
  diagramState.copyEl?.addEventListener("click", async () => {
    await copyDiagramToClipboard();
  });

  diagramState.svgEl?.addEventListener(
    "wheel",
    (event) => {
      if (!diagramState.mode) return;
      event.preventDefault();
      const delta = event.deltaY < 0 ? 0.1 : -0.1;
      setDiagramZoom(diagramState.zoom + delta);
    },
    { passive: false }
  );

  diagramState.svgEl?.addEventListener("pointerdown", (event) => {
    const target = event.target.closest("g[data-node-id]");
    if (!target) return;
    const nodeId = target.dataset.nodeId;
    const node = diagramState.nodePositions.get(nodeId);
    if (!node) return;
    diagramState.pointerState.dragging = nodeId;
    diagramState.pointerState.startX = event.clientX;
    diagramState.pointerState.startY = event.clientY;
    diagramState.pointerState.originX = node.x;
    diagramState.pointerState.originY = node.y;
    diagramState.pointerState.childOffsets = captureChildOffsets(nodeId);
    diagramState.svgEl.setPointerCapture(event.pointerId);
  });

  diagramState.svgEl?.addEventListener("pointermove", (event) => {
    const nodeId = diagramState.pointerState.dragging;
    if (!nodeId) return;
    const node = diagramState.nodePositions.get(nodeId);
    if (!node) return;
    const dx = (event.clientX - diagramState.pointerState.startX) / diagramState.zoom;
    const dy = (event.clientY - diagramState.pointerState.startY) / diagramState.zoom;
    const parentId = node.parentId;
    const parent = parentId ? diagramState.nodePositions.get(parentId) : null;
    const padding = 12;
    const minX = parent ? parent.x + padding : 20;
    const minY = parent ? parent.y + padding + 18 : 20;
    const maxX = parent
      ? parent.x + parent.width - node.width - padding
      : diagramState.layoutBounds.width - node.width - 20;
    const maxY = parent
      ? parent.y + parent.height - node.height - padding
      : diagramState.layoutBounds.height - node.height - 20;
    node.x = Math.min(Math.max(diagramState.pointerState.originX + dx, minX), maxX);
    node.y = Math.min(Math.max(diagramState.pointerState.originY + dy, minY), maxY);
    const group = diagramState.svgEl.querySelector(`g[data-node-id="${CSS.escape(nodeId)}"]`);
    if (group) {
      group.setAttribute("transform", `translate(${node.x} ${node.y})`);
    }
    if (diagramState.pointerState.childOffsets) {
      diagramState.pointerState.childOffsets.forEach((offset, childId) => {
        const child = diagramState.nodePositions.get(childId);
        if (!child) return;
        child.x = node.x + offset.dx;
        child.y = node.y + offset.dy;
        const childGroup = diagramState.svgEl.querySelector(`g[data-node-id="${CSS.escape(childId)}"]`);
        if (childGroup) {
          childGroup.setAttribute("transform", `translate(${child.x} ${child.y})`);
        }
      });
    }
    updateEdgePaths(nodeId);
  });

  diagramState.svgEl?.addEventListener("pointerup", (event) => {
    if (!diagramState.pointerState.dragging) return;
    diagramState.svgEl.releasePointerCapture(event.pointerId);
    diagramState.pointerState.dragging = null;
    diagramState.pointerState.childOffsets = null;
    void saveDiagramLayout();
  });

  diagramState.svgEl?.addEventListener("pointerleave", () => {
    diagramState.pointerState.dragging = null;
    diagramState.pointerState.childOffsets = null;
  });

  diagramState.svgEl?.addEventListener("contextmenu", (event) => {
    if (!diagramState.mode) return;
    const target = event.target.closest("g[data-node-id]");
    if (!target) return;
    event.preventDefault();
    const nodeId = target.dataset.nodeId;
    const symbol = diagramState.symbolById.get(nodeId);
    const payload = {
      qualifiedName: symbol?.qualified_name || "",
      name: symbol?.name || "",
    };
    diagramState.onSelectInTree?.(payload, { x: event.clientX, y: event.clientY });
  });

  updateDiagramToggle();
}

export function updateDiagramData({ currentFile, symbols }) {
  if (typeof currentFile === "string") {
    diagramState.currentFile = currentFile;
  }
  if (Array.isArray(symbols)) {
    diagramState.symbols = symbols;
  }
  updateDiagramToggle();
  if (diagramState.mode) {
    void renderDiagramForCurrentFile();
  }
}

export function setDiagramMode(enabled) {
  if (!diagramState.toggleEl || !diagramState.editorPanelEl) return;
  const supported = isDiagramSupportedFile(diagramState.currentFile);
  const next = Boolean(enabled && supported);
  diagramState.mode = next;
  diagramState.editorPanelEl.classList.toggle("diagram-mode", next);
  diagramState.toggleEl.classList.toggle("active", next);
  if (next) {
    fitDiagramToView();
    void renderDiagramForCurrentFile();
  }
}

export function isDiagramMode() {
  return diagramState.mode;
}

export function updateDiagramToggle() {
  if (!diagramState.toggleEl) return;
  const supported = isDiagramSupportedFile(diagramState.currentFile);
  diagramState.toggleEl.hidden = !supported;
  if (!supported && diagramState.mode) {
    setDiagramMode(false);
  }
}

function isDiagramSupportedFile(path) {
  return Boolean(path && path.toLowerCase().endsWith(".sysml"));
}

function setDiagramStatus(text) {
  if (!diagramState.statusEl) return;
  diagramState.statusEl.textContent = text || "";
  diagramState.statusEl.hidden = !text;
}

function setDiagramZoom(value) {
  const next = Math.min(Math.max(value, 0.4), 2.5);
  diagramState.zoom = next;
  if (diagramState.zoomResetEl) {
    diagramState.zoomResetEl.textContent = `${Math.round(next * 100)}%`;
  }
  updateDiagramViewportTransform();
}

function updateDiagramViewportTransform() {
  if (!diagramState.svgEl) return;
  const viewport = diagramState.svgEl.querySelector("#diagram-viewport");
  if (!viewport) return;
  viewport.setAttribute(
    "transform",
    `translate(${diagramState.pan.x} ${diagramState.pan.y}) scale(${diagramState.zoom})`
  );
}

function getElkInstance() {
  if (!window.ELK) return null;
  if (!getElkInstance.instance) {
    getElkInstance.instance = new window.ELK();
  }
  return getElkInstance.instance;
}

function measureDiagramLabel(text) {
  if (!measureDiagramLabel.canvas) {
    measureDiagramLabel.canvas = document.createElement("canvas");
  }
  const ctx = measureDiagramLabel.canvas.getContext("2d");
  if (!ctx) return { width: 80, height: 24 };
  ctx.font = '12px "IBM Plex Sans", "Segoe UI", sans-serif';
  const metrics = ctx.measureText(text);
  const width = Math.ceil(metrics.width);
  return { width: width + 20, height: 28 };
}

function isBlockKind(kind) {
  return /part def|block/i.test(kind || "");
}

function isBlockChildKind(kind) {
  return /part(?! def)|attribute/i.test(kind || "");
}

function isStateKind(kind) {
  return /state/i.test(kind || "");
}

function isAttributeKind(kind) {
  return /attribute/i.test(kind || "");
}

function findParentBlock(symbol, nodeMap) {
  if (!symbol || !symbol.qualified_name) return null;
  const parts = symbol.qualified_name.split("::").filter(Boolean);
  if (parts.length < 2) return null;
  parts.pop();
  while (parts.length) {
    const candidate = parts.join("::");
    const parent = nodeMap.get(candidate);
    if (parent && isBlockKind(parent._kind)) {
      return parent;
    }
    parts.pop();
  }
  return null;
}

function findParentState(symbol, nodeMap) {
  if (!symbol || !symbol.qualified_name) return null;
  const parts = symbol.qualified_name.split("::").filter(Boolean);
  if (parts.length < 2) return null;
  parts.pop();
  while (parts.length) {
    const candidate = parts.join("::");
    const parent = nodeMap.get(candidate);
    if (parent && isStateKind(parent._kind)) {
      return parent;
    }
    parts.pop();
  }
  return null;
}

async function renderDiagramForCurrentFile() {
  if (!diagramState.paneEl || !diagramState.svgEl) return;
  const renderId = ++diagramState.renderId;
  diagramState.svgEl.innerHTML = "";

  if (!isDiagramSupportedFile(diagramState.currentFile)) {
    setDiagramStatus("Diagram view available for SysML files.");
    return;
  }
  const elk = getElkInstance();
  if (!elk) {
    setDiagramStatus("Diagram layout engine unavailable.");
    return;
  }

  const symbols = Array.isArray(diagramState.symbols) ? diagramState.symbols : [];
  const currentPath = diagramState.currentFile
    ? diagramState.normalizePath(diagramState.currentFile)
    : "";
  const nodes = symbols.filter((symbol) => {
    if (!symbol?.file_path) return false;
    return diagramState.normalizePath(symbol.file_path) === currentPath;
  });

  if (!nodes.length) {
    setDiagramStatus("No symbols to render. Compile to refresh.");
    return;
  }

  const nodeMap = new Map();
  const rawNodes = nodes.map((symbol, index) => {
    const id = symbol.qualified_name || `${symbol.name || "symbol"}:${symbol.start_line}:${index}`;
    const label = symbol.name || id;
    const size = measureDiagramLabel(label);
    return {
      id,
      width: Math.max(80, size.width),
      height: Math.max(32, size.height),
      labels: [{ text: label }],
      _kind: symbol.kind || "",
    };
  });
  rawNodes.forEach((node) => nodeMap.set(node.id, node));

  const symbolById = new Map();
  const nameToId = new Map();
  const nameCounts = new Map();
  nodes.forEach((symbol, index) => {
    const id = symbol.qualified_name || `${symbol.name || "symbol"}:${symbol.start_line}:${index}`;
    symbolById.set(id, symbol);
    const simpleName = symbol.name || "";
    if (simpleName) {
      nameCounts.set(simpleName, (nameCounts.get(simpleName) || 0) + 1);
      if (!nameToId.has(simpleName)) {
        nameToId.set(simpleName, id);
      }
    }
  });
  diagramState.symbolById = symbolById;
  nameCounts.forEach((count, name) => {
    if (count > 1) {
      nameToId.delete(name);
    }
  });
  diagramState.symbolById = symbolById;

  const parentMap = new Map();
  rawNodes.forEach((node) => {
    const symbol = symbolById.get(node.id);
    if (!symbol) return;
    if (isBlockChildKind(symbol.kind)) {
      const parent = findParentBlock(symbol, nodeMap);
      if (parent) {
        parentMap.set(node.id, parent.id);
      }
      return;
    }
    if (isStateKind(symbol.kind)) {
      const parent = findParentState(symbol, nodeMap);
      if (parent) {
        parentMap.set(node.id, parent.id);
      }
    }
  });

  const rootChildren = [];
  const childrenByParent = new Map();
  rawNodes.forEach((node) => {
    const parentId = parentMap.get(node.id);
    if (!parentId) {
      rootChildren.push(node);
      return;
    }
    if (!childrenByParent.has(parentId)) {
      childrenByParent.set(parentId, []);
    }
    childrenByParent.get(parentId).push(node);
  });
  childrenByParent.forEach((children, parentId) => {
    const parent = nodeMap.get(parentId);
    if (parent) {
      parent.children = children;
      parent.layoutOptions = {
        "elk.padding": "[top=30,left=20,bottom=20,right=20]",
      };
    }
  });

  const elkEdges = [];
  const edgeKeys = new Set();
  const resolveTargetId = (target) => {
    if (!target) return "";
    if (nodeMap.has(target)) return target;
    const simple = target.split("::").pop();
    if (simple && nameToId.has(simple)) return nameToId.get(simple);
    return "";
  };
  const addEdge = (sourceId, targetId, label, suffix, kind) => {
    if (!sourceId || !targetId) return;
    const key = `${sourceId}=>${targetId}:${label || ""}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    elkEdges.push({
      id: `e-${sourceId}-${targetId}-${suffix}`,
      sources: [sourceId],
      targets: [targetId],
      labels: label ? [{ text: label }] : [],
      _edgeKind: kind || "",
    });
  };
  nodes.forEach((symbol, index) => {
    const sourceId = symbol.qualified_name || `${symbol.name || "symbol"}:${symbol.start_line}:${index}`;
    if (isAttributeKind(symbol.kind)) return;
    const relationships = Array.isArray(symbol.relationships) ? symbol.relationships : [];
    relationships.forEach((rel, relIndex) => {
      const target = rel.resolved_target || rel.target;
      const targetId = resolveTargetId(target);
      if (!targetId) return;
      const targetSymbol = symbolById.get(targetId);
      if (targetSymbol && isAttributeKind(targetSymbol.kind)) return;
      addEdge(sourceId, targetId, rel.kind || "", relIndex, rel.kind || "");
    });
    const supertypes = Array.isArray(symbol.supertypes) ? symbol.supertypes : [];
    supertypes.forEach((supertype, superIndex) => {
      const targetId = resolveTargetId(supertype);
      if (!targetId) return;
      addEdge(sourceId, targetId, "specializes", `super-${superIndex}`, "specialization");
    });
  });

  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "40",
      "elk.spacing.nodeNode": "30",
    },
    children: rootChildren,
    edges: elkEdges,
  };

  try {
    const layout = await elk.layout(graph);
    if (renderId !== diagramState.renderId) return;
    setDiagramStatus("");
    drawDiagram(layout);
    await applySavedLayout();
  } catch (error) {
    if (renderId !== diagramState.renderId) return;
    setDiagramStatus(`Diagram layout failed: ${error}`);
  }
}

function drawDiagram(layout) {
  if (!diagramState.svgEl) return;
  diagramState.svgEl.innerHTML = "";
  const width = (layout.width || 800) + 40;
  const height = (layout.height || 600) + 40;
  diagramState.layoutBounds = { width, height };
  diagramState.svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");

  diagramState.nodePositions = new Map();
  diagramState.edges = [];

  const viewport = document.createElementNS("http://www.w3.org/2000/svg", "g");
  viewport.setAttribute("id", "diagram-viewport");
  const edgeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  edgeGroup.classList.add("diagram-edges");
  const nodeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  nodeGroup.classList.add("diagram-nodes");

  const flattenNodes = (node, offsetX, offsetY, parentId) => {
    const x = (node.x || 0) + offsetX;
    const y = (node.y || 0) + offsetY;
    diagramState.nodePositions.set(node.id, {
      id: node.id,
      x,
      y,
      width: node.width || 120,
      height: node.height || 32,
      parentId,
      _kind: node._kind || "",
      label: node.labels?.[0]?.text || node.id,
    });
    (node.children || []).forEach((child) => {
      flattenNodes(child, x, y, node.id);
    });
  };
  (layout.children || []).forEach((node) => {
    flattenNodes(node, 20, 20, null);
  });

  const renderNode = (nodeId) => {
    const node = diagramState.nodePositions.get(nodeId);
    if (!node) return;
    const symbol = diagramState.symbolById.get(node.id);
    const isAttribute = symbol && isAttributeKind(symbol.kind) && node.parentId;
    if (isAttribute) {
      return;
    }
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("transform", `translate(${node.x} ${node.y})`);
    group.dataset.nodeId = node.id;
    if (node.parentId) {
      group.dataset.parentId = node.parentId;
    }

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("width", node.width);
    rect.setAttribute("height", node.height);
    rect.setAttribute("rx", "6");
    rect.setAttribute("class", "diagram-node");
    if (/def/i.test(node._kind || "")) {
      rect.classList.add("def");
    }
    if (nodePositionsHasChildren(node.id)) {
      rect.classList.add("container");
    }
    group.appendChild(rect);

    const attributeLines = attributeLinesByParent.get(node.id) || [];
    const headerHeight = attributeLines.length ? 24 : node.height;

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", node.width / 2);
    label.setAttribute("y", attributeLines.length ? 16 : node.height / 2 + 4);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "diagram-node-label");
    label.textContent = node.label;
    group.appendChild(label);

    if (attributeLines.length) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", "6");
      line.setAttribute("x2", `${node.width - 6}`);
      line.setAttribute("y1", `${headerHeight}`);
      line.setAttribute("y2", `${headerHeight}`);
      line.setAttribute("class", "diagram-compartment");
      group.appendChild(line);

      const title = document.createElementNS("http://www.w3.org/2000/svg", "text");
      title.setAttribute("x", "10");
      title.setAttribute("y", `${headerHeight + 14}`);
      title.setAttribute("class", "diagram-attr-title");
      title.textContent = "Attributes";
      group.appendChild(title);

      attributeLines.forEach((lineText, index) => {
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", "10");
        text.setAttribute("y", `${headerHeight + 30 + index * 14}`);
        text.setAttribute("class", "diagram-attr-text");
        text.textContent = lineText;
        group.appendChild(text);
      });
    }

    nodeGroup.appendChild(group);
  };

  const attributeLinesByParent = new Map();
  diagramState.nodePositions.forEach((node) => {
    const symbol = diagramState.symbolById.get(node.id);
    if (!symbol || !node.parentId) return;
    if (!isAttributeKind(symbol.kind)) return;
    const line = formatAttributeLine(symbol);
    if (!attributeLinesByParent.has(node.parentId)) {
      attributeLinesByParent.set(node.parentId, []);
    }
    attributeLinesByParent.get(node.parentId).push({
      line,
      start: typeof symbol.start_line === "number" ? symbol.start_line : 0,
    });
  });
  attributeLinesByParent.forEach((list, parentId) => {
    list.sort((a, b) => a.start - b.start);
    attributeLinesByParent.set(
      parentId,
      list.map((item) => item.line)
    );
  });

  diagramState.nodePositions.forEach((_node, nodeId) => renderNode(nodeId));

  (layout.edges || []).forEach((edge) => {
    const source = edge.sources?.[0];
    const target = edge.targets?.[0];
    if (!source || !target) return;
    diagramState.edges.push({
      id: edge.id,
      source,
      target,
      label: edge.labels?.[0]?.text || "",
      edgeKind: edge._edgeKind || "",
    });
  });

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const openArrow = document.createElementNS("http://www.w3.org/2000/svg", "marker");
  openArrow.setAttribute("id", "marker-open-arrow");
  openArrow.setAttribute("viewBox", "0 0 14 14");
  openArrow.setAttribute("refX", "12");
  openArrow.setAttribute("refY", "7");
  openArrow.setAttribute("markerWidth", "12");
  openArrow.setAttribute("markerHeight", "12");
  openArrow.setAttribute("orient", "auto");
  openArrow.setAttribute("markerUnits", "strokeWidth");
  const openPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  openPath.setAttribute("d", "M 0 0 L 14 7 L 0 14");
  openPath.setAttribute("fill", "none");
  openPath.setAttribute("stroke", "#8a8f96");
  openPath.setAttribute("stroke-width", "1.4");
  openPath.setAttribute("stroke-linejoin", "miter");
  openArrow.appendChild(openPath);
  defs.appendChild(openArrow);

  const filledArrow = document.createElementNS("http://www.w3.org/2000/svg", "marker");
  filledArrow.setAttribute("id", "marker-filled-arrow");
  filledArrow.setAttribute("viewBox", "0 0 10 10");
  filledArrow.setAttribute("refX", "9");
  filledArrow.setAttribute("refY", "5");
  filledArrow.setAttribute("markerWidth", "10");
  filledArrow.setAttribute("markerHeight", "10");
  filledArrow.setAttribute("orient", "auto");
  filledArrow.setAttribute("markerUnits", "strokeWidth");
  const filledPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  filledPath.setAttribute("d", "M 0 0 L 10 5 L 0 10 Z");
  filledPath.setAttribute("fill", "#8a8f96");
  filledArrow.appendChild(filledPath);
  defs.appendChild(filledArrow);

  const edgeEls = new Map();
  diagramState.edges.forEach((edge) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "diagram-edge");
    path.dataset.source = edge.source;
    path.dataset.target = edge.target;
    path.dataset.edgeId = edge.id;
    if (isSpecializeEdge(edge)) {
      path.classList.add("diagram-edge-specialize");
      path.setAttribute("marker-end", "url(#marker-open-arrow)");
    } else if (isTransitionEdge(edge)) {
      path.classList.add("diagram-edge-transition");
      path.setAttribute("marker-end", "url(#marker-filled-arrow)");
    }
    edgeGroup.appendChild(path);
    edgeEls.set(edge.id, path);
  });

  viewport.appendChild(defs);
  viewport.appendChild(edgeGroup);
  viewport.appendChild(nodeGroup);
  diagramState.svgEl.appendChild(viewport);
  updateEdgePaths();
  fitDiagramToView();
}

function updateEdgePaths(onlyNodeId) {
  diagramState.edges.forEach((edge) => {
    if (onlyNodeId) {
      const hasDesc = diagramState.pointerState?.childOffsets?.has(edge.source)
        || diagramState.pointerState?.childOffsets?.has(edge.target);
      if (edge.source !== onlyNodeId && edge.target !== onlyNodeId && !hasDesc) return;
    }
    const source = diagramState.nodePositions.get(edge.source);
    const target = diagramState.nodePositions.get(edge.target);
    if (!source || !target) return;
    const sourceCenter = {
      x: source.x + source.width / 2,
      y: source.y + source.height / 2,
    };
    const targetCenter = {
      x: target.x + target.width / 2,
      y: target.y + target.height / 2,
    };
    const sourceEdge = getRectEdgePoint(source, targetCenter);
    const targetEdge = getRectEdgePoint(target, sourceCenter);
    const path = diagramState.svgEl.querySelector(
      `.diagram-edge[data-edge-id="${CSS.escape(edge.id)}"]`
    );
    if (!path) return;
    path.setAttribute("d", `M ${sourceEdge.x} ${sourceEdge.y} L ${targetEdge.x} ${targetEdge.y}`);
  });
}

function nodePositionsHasChildren(nodeId) {
  for (const node of diagramState.nodePositions.values()) {
    if (node.parentId === nodeId) return true;
  }
  return false;
}

function getDiagramPath() {
  if (!diagramState.currentFile) return "";
  const path = diagramState.currentFile;
  const dot = path.lastIndexOf(".");
  if (dot > -1) {
    return `${path.slice(0, dot)}.diagram`;
  }
  return `${path}.diagram`;
}

async function applySavedLayout() {
  if (!diagramState.readFile) return;
  const filePath = getDiagramPath();
  if (!filePath) return;
  let raw = "";
  try {
    raw = await diagramState.readFile(filePath);
  } catch {
    return;
  }
  if (!raw) return;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  if (!data || !Array.isArray(data.nodes)) return;

  const byQualified = new Map();
  const byNameKind = new Map();
  const nameKindCounts = new Map();
  diagramState.symbolById.forEach((symbol, id) => {
    if (symbol?.qualified_name) {
      byQualified.set(symbol.qualified_name, id);
    }
    const name = symbol?.name || "";
    const kind = symbol?.kind || "";
    if (!name) return;
    const key = `${name}::${kind}`;
    nameKindCounts.set(key, (nameKindCounts.get(key) || 0) + 1);
    if (!byNameKind.has(key)) {
      byNameKind.set(key, id);
    }
  });
  nameKindCounts.forEach((count, key) => {
    if (count > 1) {
      byNameKind.delete(key);
    }
  });

  data.nodes.forEach((node) => {
    const qualified = node.qualified_name || "";
    let id = qualified ? byQualified.get(qualified) : "";
    if (!id) {
      const name = node.name || "";
      const kind = node.kind || "";
      const key = `${name}::${kind}`;
      id = byNameKind.get(key);
    }
    if (!id) return;
    const target = diagramState.nodePositions.get(id);
    if (!target) return;
    const symbol = diagramState.symbolById.get(id);
    if (symbol && isAttributeKind(symbol.kind)) return;
    const x = Number(node.x);
    const y = Number(node.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const parentId = target.parentId;
    const parent = parentId ? diagramState.nodePositions.get(parentId) : null;
    const padding = 12;
    const minX = parent ? parent.x + padding : 20;
    const minY = parent ? parent.y + padding + 18 : 20;
    const maxX = parent
      ? parent.x + parent.width - target.width - padding
      : diagramState.layoutBounds.width - target.width - 20;
    const maxY = parent
      ? parent.y + parent.height - target.height - padding
      : diagramState.layoutBounds.height - target.height - 20;
    target.x = Math.min(Math.max(x, minX), maxX);
    target.y = Math.min(Math.max(y, minY), maxY);
    const group = diagramState.svgEl.querySelector(`g[data-node-id="${CSS.escape(id)}"]`);
    if (group) {
      group.setAttribute("transform", `translate(${target.x} ${target.y})`);
    }
  });

  updateEdgePaths();
}

async function saveDiagramLayout() {
  if (!diagramState.writeFile) return;
  const filePath = getDiagramPath();
  if (!filePath) return;
  const nodes = [];
  diagramState.nodePositions.forEach((node, id) => {
    const symbol = diagramState.symbolById.get(id);
    if (!symbol || isAttributeKind(symbol.kind)) return;
    nodes.push({
      qualified_name: symbol.qualified_name || "",
      name: symbol.name || "",
      kind: symbol.kind || "",
      x: node.x,
      y: node.y,
    });
  });
  const payload = {
    version: 1,
    source: diagramState.currentFile,
    nodes,
  };
  try {
    await diagramState.writeFile(filePath, JSON.stringify(payload, null, 2));
  } catch {
    // ignore save errors
  }
}

async function copyDiagramToClipboard() {
  if (!diagramState.svgEl || !navigator?.clipboard) {
    setDiagramStatus("Clipboard unavailable.");
    return;
  }
  const svg = diagramState.svgEl.cloneNode(true);
  svg.querySelectorAll("g").forEach((node) => node.removeAttribute("data-node-id"));
  const serializer = new XMLSerializer();
  const svgText = serializer.serializeToString(svg);
  const svgBlob = new Blob([svgText], { type: "image/svg+xml" });
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ "image/svg+xml": svgBlob }),
    ]);
    setDiagramStatus("Diagram copied to clipboard.");
    setTimeout(() => setDiagramStatus(""), 1200);
  } catch (error) {
    setDiagramStatus(`Copy failed: ${error}`);
  }
}

function getRectEdgePoint(rect, toward) {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) {
    return { x: cx, y: cy };
  }
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  let scale;
  if (absDx / rect.width > absDy / rect.height) {
    scale = (rect.width / 2) / absDx;
  } else {
    scale = (rect.height / 2) / absDy;
  }
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function captureChildOffsets(nodeId) {
  const offsets = new Map();
  const parent = diagramState.nodePositions.get(nodeId);
  if (!parent) return offsets;
  diagramState.nodePositions.forEach((node) => {
    if (node.parentId === nodeId) {
      offsets.set(node.id, { dx: node.x - parent.x, dy: node.y - parent.y });
    }
  });
  return offsets;
}

function isSpecializeEdge(edge) {
  const label = (edge.label || "").toLowerCase();
  return label.includes("specialize") || label.includes("specialization");
}

function isTransitionEdge(edge) {
  const label = (edge.label || "").toLowerCase();
  const kind = (edge.edgeKind || "").toLowerCase();
  return label.includes("transition") || kind.includes("transition");
}

function formatAttributeLine(symbol) {
  if (!symbol) return "";
  const name = symbol.name || "";
  const typeName = resolveSymbolType(symbol);
  if (typeName) {
    return `${name} : ${typeName}`;
  }
  return name;
}

function resolveSymbolType(symbol) {
  const refs = Array.isArray(symbol.type_refs) ? symbol.type_refs : [];
  if (!refs.length) return "";
  const ref = refs[0];
  if (ref.type === "simple" && ref.part) {
    return ref.part.resolved_target || ref.part.target || "";
  }
  if (ref.type === "chain" && Array.isArray(ref.parts) && ref.parts.length) {
    const last = ref.parts[ref.parts.length - 1];
    return last?.resolved_target || last?.target || "";
  }
  return "";
}

function fitDiagramToView() {
  if (!diagramState.svgEl) return;
  const rect = diagramState.svgEl.getBoundingClientRect();
  const svgWidth = rect.width || diagramState.layoutBounds.width;
  const svgHeight = rect.height || diagramState.layoutBounds.height;
  diagramState.svgEl.setAttribute("viewBox", `0 0 ${svgWidth} ${svgHeight}`);
  const scale = Math.min(
    svgWidth / diagramState.layoutBounds.width,
    svgHeight / diagramState.layoutBounds.height
  );
  const zoom = Math.max(0.4, Math.min(2.5, scale * 0.95));
  const offsetX = (svgWidth - diagramState.layoutBounds.width * zoom) / 2;
  const offsetY = (svgHeight - diagramState.layoutBounds.height * zoom) / 2;
  diagramState.pan = {
    x: offsetX / zoom,
    y: offsetY / zoom,
  };
  setDiagramZoom(zoom);
}
