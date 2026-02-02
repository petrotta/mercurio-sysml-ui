const diagramState = {
  toggleEl: null,
  paneEl: null,
  svgEl: null,
  statusEl: null,
  zoomInEl: null,
  zoomOutEl: null,
  zoomResetEl: null,
  autoLayoutEl: null,
  copyEl: null,
  canvasEl: null,
  scrollXEl: null,
  scrollYEl: null,
  scrollXThumbEl: null,
  scrollYThumbEl: null,
  scrollDrag: null,
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
  selectedId: null,
  collapsedNodes: new Set(),
  pointerState: {
    dragging: null,
    resizing: null,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    originW: 0,
    originH: 0,
    downNodeId: null,
    downCollapseId: null,
    moved: false,
  },
  layoutBounds: { width: 800, height: 600 },
  gridSize: 24,
  viewportFrame: null,
  viewportHandle: null,
  viewportResizing: null,
  elkLoadPromise: null,
  log: null,
};

export function initDiagram(options) {
  diagramState.toggleEl = options.toggleEl || null;
  diagramState.paneEl = options.paneEl || null;
  diagramState.svgEl = options.svgEl || null;
  diagramState.statusEl = options.statusEl || null;
  diagramState.zoomInEl = options.zoomInEl || null;
  diagramState.zoomOutEl = options.zoomOutEl || null;
  diagramState.zoomResetEl = options.zoomResetEl || null;
  diagramState.autoLayoutEl = options.autoLayoutEl || null;
  diagramState.copyEl = options.copyEl || null;
  diagramState.canvasEl = options.canvasEl || null;
  diagramState.scrollXEl = options.scrollXEl || null;
  diagramState.scrollYEl = options.scrollYEl || null;
  diagramState.scrollXThumbEl = diagramState.scrollXEl?.querySelector(".diagram-scroll-thumb") || null;
  diagramState.scrollYThumbEl = diagramState.scrollYEl?.querySelector(".diagram-scroll-thumb") || null;
  diagramState.editorPanelEl = options.editorPanelEl || null;
  diagramState.readFile = typeof options.readFile === "function" ? options.readFile : null;
  diagramState.writeFile = typeof options.writeFile === "function" ? options.writeFile : null;
  diagramState.onSelectInTree = typeof options.onSelectInTree === "function" ? options.onSelectInTree : null;
  diagramState.onSelectSymbol = typeof options.onSelectSymbol === "function" ? options.onSelectSymbol : null;
  diagramState.log = typeof options.log === "function" ? options.log : null;
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
  diagramState.autoLayoutEl?.addEventListener("click", () => {
    void relayoutDiagram(true);
  });
  diagramState.copyEl?.addEventListener("click", async () => {
    await copyDiagramToClipboard();
  });

  if (diagramState.scrollXEl) {
    diagramState.scrollXEl.addEventListener("pointerdown", (event) => {
      const thumb = event.target.closest(".diagram-scroll-thumb");
      if (!thumb) return;
      const state = getScrollState("x");
      if (!state) return;
      diagramState.scrollDrag = {
        axis: "x",
        startPos: event.clientX,
        startScroll: state.scroll,
        trackLen: state.trackLen,
        thumbLen: state.thumbLen,
        maxScroll: state.maxScroll,
      };
      diagramState.scrollXEl.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
  }
  if (diagramState.scrollYEl) {
    diagramState.scrollYEl.addEventListener("pointerdown", (event) => {
      const thumb = event.target.closest(".diagram-scroll-thumb");
      if (!thumb) return;
      const state = getScrollState("y");
      if (!state) return;
      diagramState.scrollDrag = {
        axis: "y",
        startPos: event.clientY,
        startScroll: state.scroll,
        trackLen: state.trackLen,
        thumbLen: state.thumbLen,
        maxScroll: state.maxScroll,
      };
      diagramState.scrollYEl.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
  }

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
    if (!diagramState.mode) return;
    const viewportHandle = event.target.closest(".diagram-viewport-handle");
    if (viewportHandle) {
      const bounds = getVisibleBounds();
      if (bounds) {
        diagramState.viewportResizing = {
          startX: event.clientX,
          startY: event.clientY,
          startW: bounds.width,
          startH: bounds.height,
          startMinX: bounds.minX,
          startMinY: bounds.minY,
        };
        diagramState.svgEl.setPointerCapture(event.pointerId);
        diagramState.pointerState.moved = true;
        event.preventDefault();
        return;
      }
    }
    const collapseTarget = event.target.closest(".diagram-collapse");
    if (collapseTarget) {
      diagramState.pointerState.downCollapseId = collapseTarget.dataset.nodeId || null;
      diagramState.pointerState.startX = event.clientX;
      diagramState.pointerState.startY = event.clientY;
      diagramState.pointerState.moved = false;
      event.preventDefault();
      return;
    }
    diagramState.pointerState.moved = false;
    const downTarget = event.target.closest("g[data-node-id]");
    diagramState.pointerState.downNodeId = downTarget ? downTarget.dataset.nodeId : null;
    const resizeHandle = event.target.closest(".diagram-resize-handle");
    if (resizeHandle) {
      const target = resizeHandle.closest("g[data-node-id]");
      if (!target) return;
      const nodeId = target.dataset.nodeId;
      const node = diagramState.nodePositions.get(nodeId);
      if (!node) return;
      diagramState.pointerState.resizing = nodeId;
      diagramState.pointerState.startX = event.clientX;
      diagramState.pointerState.startY = event.clientY;
      diagramState.pointerState.originW = node.width;
      diagramState.pointerState.originH = node.height;
      diagramState.svgEl.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
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
    if (diagramState.scrollDrag) {
      const drag = diagramState.scrollDrag;
      const delta = (drag.axis === "x" ? event.clientX : event.clientY) - drag.startPos;
      const travel = Math.max(1, drag.trackLen - drag.thumbLen);
      const scrollDelta = (delta / travel) * drag.maxScroll;
      const nextScroll = Math.min(Math.max(drag.startScroll + scrollDelta, 0), drag.maxScroll);
      if (drag.axis === "x") {
        diagramState.pan.x = -nextScroll;
      } else {
        diagramState.pan.y = -nextScroll;
      }
      updateDiagramViewportTransform();
      return;
    }
    if (diagramState.viewportResizing) {
      const dx = (event.clientX - diagramState.viewportResizing.startX) / diagramState.zoom;
      const dy = (event.clientY - diagramState.viewportResizing.startY) / diagramState.zoom;
      const svgRect = diagramState.svgEl.getBoundingClientRect();
      const minSize = 200;
      const maxW = Math.max(minSize, diagramState.layoutBounds.width);
      const maxH = Math.max(minSize, diagramState.layoutBounds.height);
      const nextW = Math.min(
        Math.max(diagramState.viewportResizing.startW + dx, minSize),
        maxW
      );
      const nextH = Math.min(
        Math.max(diagramState.viewportResizing.startH + dy, minSize),
        maxH
      );
      const zoomX = svgRect.width / nextW;
      const zoomY = svgRect.height / nextH;
      const nextZoom = Math.min(2.5, Math.max(0.4, Math.min(zoomX, zoomY)));
      diagramState.zoom = nextZoom;
      diagramState.pan = {
        x: -diagramState.viewportResizing.startMinX,
        y: -diagramState.viewportResizing.startMinY,
      };
      updateDiagramViewportTransform();
      return;
    }
    const resizingId = diagramState.pointerState.resizing;
    if (resizingId) {
      const dx = event.clientX - diagramState.pointerState.startX;
      const dy = event.clientY - diagramState.pointerState.startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        diagramState.pointerState.moved = true;
      }
      const node = diagramState.nodePositions.get(resizingId);
      if (!node) return;
      const dxScaled = dx / diagramState.zoom;
      const dyScaled = dy / diagramState.zoom;
      const size = clampNodeSize(
        node,
        snapValue(diagramState.pointerState.originW + dxScaled),
        snapValue(diagramState.pointerState.originH + dyScaled)
      );
      node.width = size.width;
      node.height = size.height;
      updateNodeSize(resizingId);
      updateEdgePaths(resizingId);
      return;
    }
    const nodeId = diagramState.pointerState.dragging;
    if (!nodeId) return;
    const dx = event.clientX - diagramState.pointerState.startX;
    const dy = event.clientY - diagramState.pointerState.startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      diagramState.pointerState.moved = true;
    }
    const node = diagramState.nodePositions.get(nodeId);
    if (!node) return;
    const dxScaled = dx / diagramState.zoom;
    const dyScaled = dy / diagramState.zoom;
    const parentId = node.parentId;
    const parent = parentId ? diagramState.nodePositions.get(parentId) : null;
    const padding = 12;
    const minX = parent ? parent.x + padding : 20;
    const minY = parent ? parent.y + padding + 18 : 20;
    const dragBounds = getDragBounds();
    const maxX = parent
      ? parent.x + parent.width - node.width - padding
      : dragBounds.width - node.width - 20;
    const maxY = parent
      ? parent.y + parent.height - node.height - padding
      : dragBounds.height - node.height - 20;
    const snapped = snapPoint({
      x: diagramState.pointerState.originX + dxScaled,
      y: diagramState.pointerState.originY + dyScaled,
    });
    node.x = Math.min(Math.max(snapped.x, minX), maxX);
    node.y = Math.min(Math.max(snapped.y, minY), maxY);
    const group = diagramState.svgEl.querySelector(`g[data-node-id="${CSS.escape(nodeId)}"]`);
    if (group) {
      group.setAttribute("transform", `translate(${node.x} ${node.y})`);
    }
    if (diagramState.pointerState.childOffsets) {
      diagramState.pointerState.childOffsets.forEach((offset, childId) => {
        const child = diagramState.nodePositions.get(childId);
        if (!child) return;
        const snappedChild = snapPoint({ x: node.x + offset.dx, y: node.y + offset.dy });
        child.x = snappedChild.x;
        child.y = snappedChild.y;
        const childGroup = diagramState.svgEl.querySelector(`g[data-node-id="${CSS.escape(childId)}"]`);
        if (childGroup) {
          childGroup.setAttribute("transform", `translate(${child.x} ${child.y})`);
        }
      });
    }
    updateEdgePaths(nodeId);
  });

  diagramState.svgEl?.addEventListener("pointerup", (event) => {
    if (diagramState.scrollDrag) {
      if (diagramState.scrollDrag.axis === "x") {
        diagramState.scrollXEl?.releasePointerCapture(event.pointerId);
      } else {
        diagramState.scrollYEl?.releasePointerCapture(event.pointerId);
      }
      diagramState.scrollDrag = null;
    }
    if (diagramState.viewportResizing) {
      diagramState.viewportResizing = null;
      diagramState.svgEl.releasePointerCapture(event.pointerId);
    }
    const hadDrag = diagramState.pointerState.dragging || diagramState.pointerState.resizing;
    if (hadDrag) {
      diagramState.svgEl.releasePointerCapture(event.pointerId);
      diagramState.pointerState.dragging = null;
      diagramState.pointerState.resizing = null;
      diagramState.pointerState.childOffsets = null;
      void saveDiagramLayout();
    }
    if (diagramState.pointerState.downCollapseId) {
      const dx = event.clientX - diagramState.pointerState.startX;
      const dy = event.clientY - diagramState.pointerState.startY;
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) {
        toggleCollapse(diagramState.pointerState.downCollapseId);
      }
      diagramState.pointerState.downCollapseId = null;
      diagramState.pointerState.moved = false;
      diagramState.pointerState.downNodeId = null;
      return;
    }
    if (!diagramState.pointerState.moved) {
      if (event.target.closest(".diagram-collapse")) {
        diagramState.pointerState.moved = false;
        diagramState.pointerState.downNodeId = null;
        return;
      }
      const nodeId = diagramState.pointerState.downNodeId;
      if (nodeId) {
        setDiagramSelection(nodeId);
        const symbol = diagramState.symbolById.get(nodeId);
        const payload = {
          qualifiedName: symbol?.qualified_name || "",
          name: symbol?.name || "",
        };
        diagramState.onSelectSymbol?.(payload);
      } else {
        setDiagramSelection(null);
      }
    }
    diagramState.pointerState.moved = false;
    diagramState.pointerState.downNodeId = null;
    diagramState.pointerState.downCollapseId = null;
  });

  diagramState.svgEl?.addEventListener("pointerleave", () => {
    diagramState.pointerState.dragging = null;
    diagramState.pointerState.resizing = null;
    diagramState.pointerState.childOffsets = null;
    diagramState.pointerState.moved = false;
    diagramState.pointerState.downNodeId = null;
    diagramState.pointerState.downCollapseId = null;
    diagramState.viewportResizing = null;
    diagramState.scrollDrag = null;
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

  diagramState.svgEl?.addEventListener("click", (event) => {
    if (!diagramState.mode) return;
    const collapseButton = event.target.closest(".diagram-collapse");
    if (!collapseButton) return;
    const nodeId = collapseButton.dataset.nodeId;
    if (!nodeId) return;
    toggleCollapse(nodeId);
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

export function relayoutDiagram(persist = false) {
  return renderDiagramForCurrentFile({ skipSaved: true, persist });
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

function setDiagramSelection(nodeId) {
  if (diagramState.selectedId === nodeId) return;
  if (diagramState.selectedId && diagramState.svgEl) {
    const prev = diagramState.svgEl.querySelector(
      `g[data-node-id="${CSS.escape(diagramState.selectedId)}"] rect.diagram-node`
    );
    if (prev) prev.classList.remove("selected");
    const prevHandle = diagramState.svgEl.querySelector(
      `g[data-node-id="${CSS.escape(diagramState.selectedId)}"] .diagram-resize-handle`
    );
    if (prevHandle) prevHandle.classList.add("hidden");
  }
  diagramState.selectedId = nodeId || null;
  if (diagramState.selectedId && diagramState.svgEl) {
    const next = diagramState.svgEl.querySelector(
      `g[data-node-id="${CSS.escape(diagramState.selectedId)}"] rect.diagram-node`
    );
    if (next) next.classList.add("selected");
    const nextHandle = diagramState.svgEl.querySelector(
      `g[data-node-id="${CSS.escape(diagramState.selectedId)}"] .diagram-resize-handle`
    );
    if (nextHandle) nextHandle.classList.remove("hidden");
  }
}

function setCollapsedState(nodeId, collapsed) {
  if (!diagramState.svgEl) return;
  const group = diagramState.svgEl.querySelector(`g[data-node-id="${CSS.escape(nodeId)}"]`);
  if (!group) return;
  group.classList.toggle("collapsed", collapsed);
  const collapseLabel = group.querySelector(".diagram-collapse-label");
  if (collapseLabel) {
    collapseLabel.textContent = collapsed ? "+" : "-";
  }
  const hideDescendants = (parentId) => {
    const children = diagramState.svgEl.querySelectorAll(
      `g[data-parent-id="${CSS.escape(parentId)}"]`
    );
    children.forEach((child) => {
      child.classList.toggle("diagram-hidden", collapsed);
      if (collapsed) {
        hideDescendants(child.dataset.nodeId);
      }
    });
  };
  hideDescendants(nodeId);
  updateEdgeVisibility();
}

function toggleCollapse(nodeId) {
  if (!nodeId) return;
  const next = !diagramState.collapsedNodes.has(nodeId);
  if (next) {
    diagramState.collapsedNodes.add(nodeId);
  } else {
    diagramState.collapsedNodes.delete(nodeId);
  }
  setCollapsedState(nodeId, next);
}

function setDiagramZoom(value) {
  const next = Math.min(Math.max(value, 0.4), 2.5);
  diagramState.zoom = next;
  if (diagramState.zoomResetEl) {
    diagramState.zoomResetEl.textContent = `${Math.round(next * 100)}%`;
  }
  updateDiagramViewportTransform();
}

function snapValue(value) {
  const size = diagramState.gridSize || 1;
  return Math.round(value / size) * size;
}

function snapPoint(point) {
  return {
    x: snapValue(point.x),
    y: snapValue(point.y),
  };
}

function getScrollState(axis) {
  const canvas = diagramState.canvasEl;
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const visibleWidth = rect.width / diagramState.zoom;
  const visibleHeight = rect.height / diagramState.zoom;
  const contentWidth = Math.max(diagramState.layoutBounds.width, visibleWidth);
  const contentHeight = Math.max(diagramState.layoutBounds.height, visibleHeight);
  if (axis === "x") {
    const maxScroll = Math.max(0, contentWidth - visibleWidth);
    const scroll = Math.min(Math.max(-diagramState.pan.x, 0), maxScroll);
    return { visible: visibleWidth, content: contentWidth, scroll, maxScroll, trackLen: rect.width };
  }
  const maxScroll = Math.max(0, contentHeight - visibleHeight);
  const scroll = Math.min(Math.max(-diagramState.pan.y, 0), maxScroll);
  return { visible: visibleHeight, content: contentHeight, scroll, maxScroll, trackLen: rect.height };
}

function updateScrollbars() {
  const xState = getScrollState("x");
  if (diagramState.scrollXEl && diagramState.scrollXThumbEl && xState) {
    if (xState.maxScroll <= 1) {
      diagramState.scrollXEl.style.opacity = "0";
    } else {
      diagramState.scrollXEl.style.opacity = "1";
      const trackLen = xState.trackLen - 20;
      const thumbLen = Math.max(18, Math.round((xState.visible / xState.content) * trackLen));
      const travel = Math.max(1, trackLen - thumbLen);
      const left = Math.round((xState.scroll / xState.maxScroll) * travel);
      diagramState.scrollXThumbEl.style.width = `${thumbLen}px`;
      diagramState.scrollXThumbEl.style.height = "8px";
      diagramState.scrollXThumbEl.style.left = `${left + 1}px`;
      diagramState.scrollXThumbEl.style.top = "1px";
    }
  }
  const yState = getScrollState("y");
  if (diagramState.scrollYEl && diagramState.scrollYThumbEl && yState) {
    if (yState.maxScroll <= 1) {
      diagramState.scrollYEl.style.opacity = "0";
    } else {
      diagramState.scrollYEl.style.opacity = "1";
      const trackLen = yState.trackLen - 20;
      const thumbLen = Math.max(18, Math.round((yState.visible / yState.content) * trackLen));
      const travel = Math.max(1, trackLen - thumbLen);
      const top = Math.round((yState.scroll / yState.maxScroll) * travel);
      diagramState.scrollYThumbEl.style.height = `${thumbLen}px`;
      diagramState.scrollYThumbEl.style.width = "8px";
      diagramState.scrollYThumbEl.style.top = `${top + 1}px`;
      diagramState.scrollYThumbEl.style.left = "1px";
    }
  }
}

function updateDiagramViewportTransform() {
  if (!diagramState.svgEl) return;
  const viewport = diagramState.svgEl.querySelector("#diagram-viewport");
  if (!viewport) return;
  viewport.setAttribute(
    "transform",
    `translate(${diagramState.pan.x} ${diagramState.pan.y}) scale(${diagramState.zoom})`
  );
  updateViewportFrame();
  updateScrollbars();
}

function getVisibleBounds() {
  if (!diagramState.svgEl) return null;
  const rect = diagramState.svgEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const minX = -diagramState.pan.x;
  const minY = -diagramState.pan.y;
  const width = rect.width / diagramState.zoom;
  const height = rect.height / diagramState.zoom;
  return { minX, minY, width, height };
}

function updateViewportFrame() {
  if (!diagramState.viewportFrame || !diagramState.viewportHandle) return;
  const bounds = getVisibleBounds();
  if (!bounds) return;
  diagramState.viewportFrame.setAttribute("x", bounds.minX);
  diagramState.viewportFrame.setAttribute("y", bounds.minY);
  diagramState.viewportFrame.setAttribute("width", bounds.width);
  diagramState.viewportFrame.setAttribute("height", bounds.height);
  diagramState.viewportHandle.setAttribute("x", bounds.minX + bounds.width - 10);
  diagramState.viewportHandle.setAttribute("y", bounds.minY + bounds.height - 10);
}

function getElkInstance() {
  if (!window.ELK) return null;
  if (!getElkInstance.instance) {
    getElkInstance.instance = new window.ELK();
  }
  return getElkInstance.instance;
}

function logDiagram(level, kind, message) {
  if (diagramState.log) {
    diagramState.log(level, kind, message);
  }
}

function ensureElkLoaded() {
  if (window.ELK) return Promise.resolve(true);
  if (diagramState.elkLoadPromise) return diagramState.elkLoadPromise;
  const base = document.baseURI || window.location?.href || "";
  const candidates = [
    "/assets/elk/elk.bundled.js",
    "./assets/elk/elk.bundled.js",
    new URL("assets/elk/elk.bundled.js", base).toString(),
    "https://unpkg.com/elkjs@0.9.1/lib/elk.bundled.js",
  ];
  const evalElkScript = async (src) => {
    const response = await fetch(src, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`fetch failed ${response.status}`);
    }
    const code = await response.text();
    const prevDefine = window.define;
    const prevRequire = window.require;
    try {
      window.define = undefined;
      window.require = undefined;
      const fn = new Function(code);
      fn();
    } finally {
      window.define = prevDefine;
      window.require = prevRequire;
    }
  };
  diagramState.elkLoadPromise = new Promise((resolve) => {
    const tryNext = (index) => {
      if (index >= candidates.length) {
        diagramState.elkLoadPromise = null;
        logDiagram("ERROR", "diagram", "ELK bundle failed to load");
        resolve(false);
        return;
      }
      const src = candidates[index];
      evalElkScript(src)
        .then(() => {
          if (window.ELK) {
            logDiagram("INFO", "diagram", `ELK loaded from ${src}`);
            resolve(true);
            return;
          }
          logDiagram("WARN", "diagram", `ELK script did not register from ${src}`);
          tryNext(index + 1);
        })
        .catch((error) => {
          logDiagram("WARN", "diagram", `Failed to load ELK from ${src}: ${error}`);
          tryNext(index + 1);
        });
    };
    tryNext(0);
  });
  return diagramState.elkLoadPromise;
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

function measureDiagramAttr(text) {
  if (!measureDiagramAttr.canvas) {
    measureDiagramAttr.canvas = document.createElement("canvas");
  }
  const ctx = measureDiagramAttr.canvas.getContext("2d");
  if (!ctx) return { width: 80, height: 18 };
  ctx.font = '11px "IBM Plex Sans", "Segoe UI", sans-serif';
  const metrics = ctx.measureText(text);
  const width = Math.ceil(metrics.width);
  return { width: width + 20, height: 18 };
}

function isPartUsageKind(kind) {
  return /part(?! def)/i.test(kind || "");
}

function isPortKind(kind) {
  return /port/i.test(kind || "");
}

function isAttributeKind(kind) {
  return /attribute/i.test(kind || "");
}

function isRequirementKind(kind) {
  return /requirement/i.test(kind || "");
}

function isRequirementRefKind(kind) {
  const text = (kind || "").toLowerCase();
  return text.includes("ref");
}

function isRequirementRefSymbol(symbol, parentSymbol) {
  if (!symbol || !parentSymbol) return false;
  if (!isRequirementKind(parentSymbol.kind)) return false;
  return isRequirementRefKind(symbol.kind);
}

function isCompartmentItemSymbol(symbol, parentSymbol) {
  if (!symbol) return false;
  if (isAttributeKind(symbol.kind)) return true;
  return isRequirementRefSymbol(symbol, parentSymbol);
}

function buildCompartmentSections(data) {
  if (!data) return [];
  const sections = [];
  if (Array.isArray(data.attrs) && data.attrs.length) {
    sections.push({
      title: "Attributes",
      lines: data.attrs.map((item) => item.line || item),
    });
  }
  if (Array.isArray(data.refs) && data.refs.length) {
    sections.push({
      title: "Refs",
      lines: data.refs.map((item) => item.line || item),
    });
  }
  return sections;
}

function measureCompartmentHeight(sections) {
  if (!sections.length) return 0;
  let height = 24;
  sections.forEach((section, index) => {
    const lines = section.lines || [];
    if (!lines.length) return;
    if (index > 0) {
      height += 8;
    }
    height += 30 + Math.max(0, lines.length - 1) * 14;
  });
  height += 8;
  return height;
}

function measureCompartmentWidth(sections) {
  let maxWidth = 0;
  sections.forEach((section) => {
    (section.lines || []).forEach((line) => {
      const size = measureDiagramAttr(line);
      if (size.width > maxWidth) {
        maxWidth = size.width;
      }
    });
  });
  return maxWidth;
}

function appendTypeIcon(group, kindText) {
  const ns = "http://www.w3.org/2000/svg";
  const iconGroup = document.createElementNS(ns, "g");
  iconGroup.setAttribute("class", "diagram-type-icon");
  iconGroup.setAttribute("transform", "translate(6 6)");
  let path = null;
  if (kindText.includes("part def")) {
    path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M 2 4 H 10 V 12 H 2 Z M 4 2 H 12 V 10");
    iconGroup.classList.add("type-part-def");
  } else if (isPartUsageKind(kindText)) {
    path = document.createElementNS(ns, "rect");
    path.setAttribute("x", "2");
    path.setAttribute("y", "3");
    path.setAttribute("width", "9");
    path.setAttribute("height", "7");
    iconGroup.classList.add("type-part");
  } else if (isRequirementKind(kindText)) {
    path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M 2 2 H 10 L 12 4 V 12 H 2 Z M 10 2 V 4 H 12");
    iconGroup.classList.add("type-requirement");
  }
  if (!path) return;
  iconGroup.appendChild(path);
  group.appendChild(iconGroup);
}

function findNearestParent(symbol, nodeMap) {
  if (!symbol || !symbol.qualified_name) return null;
  const parts = symbol.qualified_name.split("::").filter(Boolean);
  if (parts.length < 2) return null;
  parts.pop();
  while (parts.length) {
    const candidate = parts.join("::");
    if (nodeMap.has(candidate)) {
      return nodeMap.get(candidate) || null;
    }
    parts.pop();
  }
  return null;
}

async function renderDiagramForCurrentFile(options = {}) {
  const { skipSaved, persist } = options;
  if (!diagramState.paneEl || !diagramState.svgEl) return;
  const renderId = ++diagramState.renderId;
  diagramState.svgEl.innerHTML = "";

  if (!isDiagramSupportedFile(diagramState.currentFile)) {
    setDiagramStatus("Diagram view available for SysML files.");
    return;
  }
  const elk = getElkInstance();
  if (!elk) {
    setDiagramStatus("Loading diagram engine...");
    ensureElkLoaded().then((loaded) => {
      if (!loaded) {
        setDiagramStatus("Diagram layout engine unavailable.");
        return;
      }
      if (!diagramState.mode || renderId !== diagramState.renderId) return;
      void renderDiagramForCurrentFile();
    });
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
    const size = isPartUsageKind(symbol.kind) || isPortKind(symbol.kind)
      ? measureDiagramAttr(label)
      : measureDiagramLabel(label);
    return {
      id,
      width: Math.max(isPartUsageKind(symbol.kind) || isPortKind(symbol.kind) ? 64 : 80, size.width),
      height: Math.max(isPartUsageKind(symbol.kind) || isPortKind(symbol.kind) ? 26 : 32, size.height),
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
    const parent = findNearestParent(symbol, nodeMap);
    if (parent) {
      parentMap.set(node.id, parent.id);
    }
  });

  const compartmentLinesByParentId = new Map();
  const ensureCompartment = (parentId) => {
    if (!compartmentLinesByParentId.has(parentId)) {
      compartmentLinesByParentId.set(parentId, { attrs: [], refs: [] });
    }
    return compartmentLinesByParentId.get(parentId);
  };
  rawNodes.forEach((node) => {
    const symbol = symbolById.get(node.id);
    const parentId = parentMap.get(node.id);
    if (!symbol || !parentId) return;
    const parentSymbol = symbolById.get(parentId);
    if (!parentSymbol) return;
    if (!isCompartmentItemSymbol(symbol, parentSymbol)) return;
    const line = formatAttributeLine(symbol);
    const entry = ensureCompartment(parentId);
    const target = isRequirementRefSymbol(symbol, parentSymbol) ? entry.refs : entry.attrs;
    target.push({
      line,
      start: typeof symbol.start_line === "number" ? symbol.start_line : 0,
    });
  });
  compartmentLinesByParentId.forEach((entry, parentId) => {
    const parent = nodeMap.get(parentId);
    if (!parent) return;
    if (entry.attrs?.length) {
      entry.attrs.sort((a, b) => a.start - b.start);
    }
    if (entry.refs?.length) {
      entry.refs.sort((a, b) => a.start - b.start);
    }
    const sections = buildCompartmentSections(entry);
    if (!sections.length) return;
    const minHeight = measureCompartmentHeight(sections);
    parent.height = Math.max(parent.height || 0, minHeight);
    const maxWidth = Math.max(parent.width || 0, measureCompartmentWidth(sections));
    parent.width = Math.max(parent.width || 0, maxWidth, 120);
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
    const parentSymbol = symbol ? symbolById.get(parentMap.get(sourceId)) : null;
    if (isCompartmentItemSymbol(symbol, parentSymbol)) return;
    const relationships = Array.isArray(symbol.relationships) ? symbol.relationships : [];
    relationships.forEach((rel, relIndex) => {
      const target = rel.resolved_target || rel.target;
      const targetId = resolveTargetId(target);
      if (!targetId) return;
      const targetSymbol = symbolById.get(targetId);
      if (targetSymbol) {
        const targetParent = symbolById.get(parentMap.get(targetId));
        if (isCompartmentItemSymbol(targetSymbol, targetParent)) return;
      }
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
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
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
    if (!skipSaved) {
      await applySavedLayout();
    } else if (persist) {
      await saveDiagramLayout();
    }
  } catch (error) {
    if (renderId !== diagramState.renderId) return;
    setDiagramStatus(`Diagram layout failed: ${error}`);
  }
}

function drawDiagram(layout) {
  if (!diagramState.svgEl) return;
  diagramState.svgEl.innerHTML = "";
  diagramState.selectedId = null;
  const width = (layout.width || 800) + 40;
  const height = (layout.height || 600) + 40;
  diagramState.layoutBounds = { width, height };
  diagramState.svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
  updateScrollbars();

  diagramState.nodePositions = new Map();
  diagramState.edges = [];
  diagramState.collapsedNodes.clear();

  const viewport = document.createElementNS("http://www.w3.org/2000/svg", "g");
  viewport.setAttribute("id", "diagram-viewport");
  const edgeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  edgeGroup.classList.add("diagram-edges");
  const nodeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  nodeGroup.classList.add("diagram-nodes");

  const viewportFrame = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  viewportFrame.setAttribute("class", "diagram-viewport-frame");
  const viewportHandle = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  viewportHandle.setAttribute("class", "diagram-viewport-handle");
  viewportHandle.setAttribute("width", "10");
  viewportHandle.setAttribute("height", "10");
  diagramState.viewportFrame = viewportFrame;
  diagramState.viewportHandle = viewportHandle;

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
    const parentSymbol = node.parentId ? diagramState.symbolById.get(node.parentId) : null;
    const isCompartmentItem = symbol && node.parentId && isCompartmentItemSymbol(symbol, parentSymbol);
    if (isCompartmentItem) {
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
    const kindText = (symbol?.kind || node._kind || "").toLowerCase();
    const isMiniChild = (isPartUsageKind(kindText) || isPortKind(kindText)) && node.parentId;
    if (isMiniChild) {
      rect.classList.add("mini");
    }
    group.appendChild(rect);

    const compartments = node.compartmentSections || [];
    const hasCompartments = compartments.some((section) => (section.lines || []).length);
    const headerHeight = hasCompartments ? 24 : node.height;

    const isPackage = kindText.includes("package");
    const isPartDef = kindText.includes("part def");
    const isRequirement = isRequirementKind(kindText);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    if (isPackage || isPartDef || isRequirement) {
      label.setAttribute("x", "28");
      label.setAttribute("y", "18");
      label.setAttribute("text-anchor", "start");
      label.setAttribute("class", "diagram-node-label diagram-node-label-package");
    } else {
      label.setAttribute("x", node.width / 2);
      label.setAttribute("y", hasCompartments ? 16 : node.height / 2 + 4);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute(
        "class",
        isMiniChild ? "diagram-node-label diagram-node-label-mini" : "diagram-node-label"
      );
    }
    label.textContent = node.label;
    group.appendChild(label);

    if (isPartDef || isPartUsageKind(kindText) || isRequirementKind(kindText)) {
      appendTypeIcon(group, kindText);
    }

    if (isPackage) {
      const headerLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
      headerLine.setAttribute("x1", "6");
      headerLine.setAttribute("x2", `${node.width - 6}`);
      headerLine.setAttribute("y1", "24");
      headerLine.setAttribute("y2", "24");
      headerLine.setAttribute("class", "diagram-package-header");
      group.appendChild(headerLine);

      const folder = document.createElementNS("http://www.w3.org/2000/svg", "path");
      folder.setAttribute(
        "d",
        "M 6 6 H 14 L 16 9 H 24 V 20 H 6 Z"
      );
      folder.setAttribute("class", "diagram-package-icon");
      group.appendChild(folder);
    }

    if (nodePositionsHasChildren(node.id)) {
      const collapseGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
      collapseGroup.setAttribute("class", "diagram-collapse");
      collapseGroup.dataset.nodeId = node.id;
      collapseGroup.setAttribute("transform", `translate(${node.width - 20} 8)`);
      const collapseRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      collapseRect.setAttribute("width", "14");
      collapseRect.setAttribute("height", "14");
      collapseRect.setAttribute("rx", "3");
      collapseRect.setAttribute("class", "diagram-collapse-btn");
      const collapseLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
      collapseLabel.setAttribute("x", "7");
      collapseLabel.setAttribute("y", "11");
      collapseLabel.setAttribute("text-anchor", "middle");
      collapseLabel.setAttribute("class", "diagram-collapse-label");
      collapseLabel.textContent = diagramState.collapsedNodes.has(node.id) ? "+" : "-";
      collapseGroup.appendChild(collapseRect);
      collapseGroup.appendChild(collapseLabel);
      group.appendChild(collapseGroup);
    }

    if (hasCompartments) {
      renderCompartments(group, node, compartments, headerHeight);
    }

    if (!isMiniChild) {
      const handle = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      handle.setAttribute("x", `${node.width - 10}`);
      handle.setAttribute("y", `${node.height - 10}`);
      handle.setAttribute("width", "10");
      handle.setAttribute("height", "10");
      handle.setAttribute("rx", "2");
      handle.setAttribute("class", "diagram-resize-handle hidden");
      group.appendChild(handle);
    }

    nodeGroup.appendChild(group);
  };

  const compartmentLinesByParent = new Map();
  const ensureCompartment = (parentId) => {
    if (!compartmentLinesByParent.has(parentId)) {
      compartmentLinesByParent.set(parentId, { attrs: [], refs: [] });
    }
    return compartmentLinesByParent.get(parentId);
  };
  diagramState.nodePositions.forEach((node) => {
    const symbol = diagramState.symbolById.get(node.id);
    if (!symbol || !node.parentId) return;
    const parentSymbol = diagramState.symbolById.get(node.parentId);
    if (!parentSymbol) return;
    if (!isCompartmentItemSymbol(symbol, parentSymbol)) return;
    const line = formatAttributeLine(symbol);
    const entry = ensureCompartment(node.parentId);
    const target = isRequirementRefSymbol(symbol, parentSymbol) ? entry.refs : entry.attrs;
    target.push({
      line,
      start: typeof symbol.start_line === "number" ? symbol.start_line : 0,
    });
  });
  compartmentLinesByParent.forEach((entry, parentId) => {
    if (entry.attrs?.length) {
      entry.attrs.sort((a, b) => a.start - b.start);
    }
    if (entry.refs?.length) {
      entry.refs.sort((a, b) => a.start - b.start);
    }
    compartmentLinesByParent.set(parentId, entry);
  });
  diagramState.nodePositions.forEach((node) => {
    node.compartmentSections = buildCompartmentSections(compartmentLinesByParent.get(node.id));
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

  const updateEdgesHidden = () => {
    diagramState.edges.forEach((edge) => {
      const sourceHidden = diagramState.svgEl
        .querySelector(`g[data-node-id="${CSS.escape(edge.source)}"]`)
        ?.classList.contains("diagram-hidden");
      const targetHidden = diagramState.svgEl
        .querySelector(`g[data-node-id="${CSS.escape(edge.target)}"]`)
        ?.classList.contains("diagram-hidden");
      const path = diagramState.svgEl.querySelector(
        `.diagram-edge[data-edge-id="${CSS.escape(edge.id)}"]`
      );
      if (path) {
        path.classList.toggle("diagram-hidden", sourceHidden || targetHidden);
      }
    });
  };

  viewport.appendChild(defs);
  viewport.appendChild(edgeGroup);
  viewport.appendChild(nodeGroup);
  viewport.appendChild(viewportFrame);
  viewport.appendChild(viewportHandle);
  diagramState.svgEl.appendChild(viewport);
  updateEdgePaths();
  updateEdgesHidden();
  fitDiagramToView();
}

function renderCompartments(group, node, sections, headerHeight = 24) {
  const ns = "http://www.w3.org/2000/svg";
  let currentY = headerHeight;
  let first = true;
  sections.forEach((section) => {
    const lines = section.lines || [];
    if (!lines.length) return;
    if (!first) {
      currentY += 8;
    }
    const divider = document.createElementNS(ns, "line");
    divider.setAttribute("x1", "6");
    divider.setAttribute("x2", `${node.width - 6}`);
    divider.setAttribute("y1", `${currentY}`);
    divider.setAttribute("y2", `${currentY}`);
    divider.setAttribute("class", "diagram-compartment");
    group.appendChild(divider);

    const title = document.createElementNS(ns, "text");
    title.setAttribute("x", "10");
    title.setAttribute("y", `${currentY + 14}`);
    title.setAttribute("class", "diagram-attr-title");
    title.textContent = section.title;
    group.appendChild(title);

    lines.forEach((lineText, index) => {
      const text = document.createElementNS(ns, "text");
      text.setAttribute("x", "10");
      text.setAttribute("y", `${currentY + 30 + index * 14}`);
      text.setAttribute("class", "diagram-attr-text");
      text.textContent = lineText;
      group.appendChild(text);
    });

    currentY += 30 + Math.max(0, lines.length - 1) * 14;
    first = false;
  });
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

function updateEdgeVisibility() {
  if (!diagramState.svgEl) return;
  diagramState.edges.forEach((edge) => {
    const sourceHidden = diagramState.svgEl
      .querySelector(`g[data-node-id="${CSS.escape(edge.source)}"]`)
      ?.classList.contains("diagram-hidden");
    const targetHidden = diagramState.svgEl
      .querySelector(`g[data-node-id="${CSS.escape(edge.target)}"]`)
      ?.classList.contains("diagram-hidden");
    const path = diagramState.svgEl.querySelector(
      `.diagram-edge[data-edge-id="${CSS.escape(edge.id)}"]`
    );
    if (path) {
      path.classList.toggle("diagram-hidden", sourceHidden || targetHidden);
    }
  });
}

function clampNodeSize(node, width, height) {
  const parentId = node.parentId;
  const parent = parentId ? diagramState.nodePositions.get(parentId) : null;
  const padding = 12;
  const sections = Array.isArray(node.compartmentSections) ? node.compartmentSections : [];
  const minWidth = 80;
  const minHeight = sections.length ? measureCompartmentHeight(sections) : 32;
  const dragBounds = getDragBounds();
  const maxWidth = parent
    ? parent.x + parent.width - node.x - padding
    : dragBounds.width - node.x - 20;
  const maxHeight = parent
    ? parent.y + parent.height - node.y - padding
    : dragBounds.height - node.y - 20;
  return {
    width: Math.min(Math.max(width, minWidth), maxWidth),
    height: Math.min(Math.max(height, minHeight), maxHeight),
  };
}

function updateNodeSize(nodeId) {
  if (!diagramState.svgEl) return;
  const node = diagramState.nodePositions.get(nodeId);
  if (!node) return;
  const group = diagramState.svgEl.querySelector(`g[data-node-id="${CSS.escape(nodeId)}"]`);
  if (!group) return;
  const rect = group.querySelector("rect.diagram-node");
  if (rect) {
    rect.setAttribute("width", node.width);
    rect.setAttribute("height", node.height);
  }
  const label = group.querySelector("text.diagram-node-label");
  const sections = Array.isArray(node.compartmentSections) ? node.compartmentSections : [];
  const headerHeight = sections.length ? 24 : node.height;
  if (label) {
    if (label.classList.contains("diagram-node-label-package")) {
      const kindText = (node._kind || "").toLowerCase();
      const useHeaderX = kindText.includes("package")
        || kindText.includes("part def")
        || isRequirementKind(kindText);
      label.setAttribute("x", useHeaderX ? "28" : "10");
      label.setAttribute("y", "18");
    } else {
      label.setAttribute("x", node.width / 2);
      label.setAttribute("y", sections.length ? 16 : node.height / 2 + 4);
    }
  }
  group
    .querySelectorAll(".diagram-compartment, .diagram-attr-title, .diagram-attr-text")
    .forEach((el) => el.remove());
  if (sections.length) {
    renderCompartments(group, node, sections, headerHeight);
  }
  const handle = group.querySelector(".diagram-resize-handle");
  if (handle) {
    handle.setAttribute("x", `${node.width - 10}`);
    handle.setAttribute("y", `${node.height - 10}`);
  }
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
    const parentId = diagramState.nodePositions.get(id)?.parentId || "";
    const parentSymbol = parentId ? diagramState.symbolById.get(parentId) : null;
    if (symbol && isCompartmentItemSymbol(symbol, parentSymbol)) return;
    const x = Number(node.x);
    const y = Number(node.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const width = Number(node.width);
    const height = Number(node.height);
    if (Number.isFinite(width)) {
      const size = clampNodeSize(target, width, target.height);
      target.width = size.width;
      target.height = size.height;
      updateNodeSize(id);
    }
    if (Number.isFinite(height)) {
      const size = clampNodeSize(target, target.width, height);
      target.width = size.width;
      target.height = size.height;
      updateNodeSize(id);
    }
    const clampParentId = target.parentId;
    const parent = clampParentId ? diagramState.nodePositions.get(clampParentId) : null;
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
      width: node.width,
      height: node.height,
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
  const visit = (currentId) => {
    diagramState.nodePositions.forEach((node) => {
      if (node.parentId === currentId) {
        offsets.set(node.id, { dx: node.x - parent.x, dy: node.y - parent.y });
        visit(node.id);
      }
    });
  };
  visit(nodeId);
  return offsets;
}

function getDragBounds() {
  const visible = getVisibleBounds();
  const width = Math.max(diagramState.layoutBounds.width, visible?.width || 0);
  const height = Math.max(diagramState.layoutBounds.height, visible?.height || 0);
  return { width, height };
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
  updateViewportFrame();
}
