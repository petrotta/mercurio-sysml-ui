type DiagramInput = {
  qualified: string;
  name: string;
  kind: string;
};

type Node = {
  name: string;
  fullName: string;
  kind: string;
  children: Map<string, Node>;
};

type LayoutNode = {
  node: { name: string; fullName: string; kind: string };
  width: number;
  height: number;
  children: Array<{ layout: LayoutNode; x: number; y: number }>;
};

const measureNodeWidth = (node: Node) => {
  const name = node.name || "";
  const kindLabel = node.kind || "";
  const estimate = name.length * 7 + kindLabel.length * 5 + 40;
  return Math.max(140, Math.min(320, estimate));
};

const buildTree = (nodes: DiagramInput[]) => {
  const root: Node = { name: "root", fullName: "root", kind: "", children: new Map() };
  nodes.forEach((symbol) => {
    const qualified = symbol.qualified || symbol.name;
    const segments = qualified.split("::").filter(Boolean);
    let cursor = root;
    segments.forEach((segment, index) => {
      if (!cursor.children.has(segment)) {
        cursor.children.set(segment, {
          name: segment,
          fullName: cursor.fullName === "root" ? segment : `${cursor.fullName}::${segment}`,
          kind: "",
          children: new Map(),
        });
      }
      cursor = cursor.children.get(segment)!;
      if (index === segments.length - 1) {
        cursor.kind = symbol.kind || cursor.kind;
      }
    });
  });
  return root;
};

const layoutTree = (node: Node): LayoutNode => {
  const headerHeight = 34;
  const paddingX = 12;
  const paddingY = 10;
  const gapX = 14;
  const gapY = 16;
  const ownWidth = measureNodeWidth(node);
  const children = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));
  if (!children.length) {
    return {
      node: { name: node.name, fullName: node.fullName, kind: node.kind },
      width: ownWidth,
      height: headerHeight + paddingY,
      children: [],
    };
  }
  const childLayouts = children.map((child) => layoutTree(child));
  const childrenWidth =
    childLayouts.reduce((sum, layout) => sum + layout.width, 0) + gapX * Math.max(0, childLayouts.length - 1);
  const childrenHeight = Math.max(...childLayouts.map((layout) => layout.height));
  const innerWidth = Math.max(ownWidth, childrenWidth) + paddingX * 2;
  const innerHeight = headerHeight + gapY + childrenHeight + paddingY;
  let cursorX = paddingX + (innerWidth - paddingX * 2 - childrenWidth) / 2;
  const positionedChildren = childLayouts.map((layout) => {
    const entry = {
      layout,
      x: cursorX,
      y: headerHeight + gapY,
    };
    cursorX += layout.width + gapX;
    return entry;
  });
  return {
    node: { name: node.name, fullName: node.fullName, kind: node.kind },
    width: innerWidth,
    height: innerHeight,
    children: positionedChildren,
  };
};

self.onmessage = (event: MessageEvent) => {
  const data = event.data as { type: string; reqId: number; nodes?: DiagramInput[] };
  if (data.type !== "layout" || !data.nodes) return;
  const tree = buildTree(data.nodes);
  const layout = layoutTree(tree);
  (self as typeof self).postMessage({ type: "layout", reqId: data.reqId, layout });
};
