import { useEffect, useMemo, useRef, useState } from "react";
import type { DiagramLayout, DiagramNode } from "./types";

type UseDiagramLayoutOptions = {
  activeDiagramPath: string | null;
  diagramNodes: DiagramNode[];
};

export function useDiagramLayout({ activeDiagramPath, diagramNodes }: UseDiagramLayoutOptions) {
  const diagramWorkerRef = useRef<Worker | null>(null);
  const diagramLayoutReqRef = useRef(0);
  const [diagramLayout, setDiagramLayout] = useState<DiagramLayout | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL("../diagramWorker.ts", import.meta.url), { type: "module" });
    diagramWorkerRef.current = worker;
    return () => {
      worker.terminate();
      diagramWorkerRef.current = null;
    };
  }, []);

  const fileNodes = useMemo(() => {
    if (!activeDiagramPath) return [];
    return diagramNodes;
  }, [diagramNodes, activeDiagramPath]);

  const nodeByQualified = useMemo(() => {
    const map = new Map<string, DiagramNode>();
    fileNodes.forEach((node) => map.set(node.qualified, node));
    return map;
  }, [fileNodes]);

  const requestDiagramLayout = () => {
    if (!diagramWorkerRef.current) return;
    if (!fileNodes.length) {
      setDiagramLayout(null);
      return;
    }
    const worker = diagramWorkerRef.current;
    const reqId = ++diagramLayoutReqRef.current;
    worker.postMessage({
      type: "layout",
      reqId,
      nodes: fileNodes.map((node) => ({
        qualified: node.qualified,
        name: node.name,
        kind: node.kind,
      })),
    });
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type: string; reqId: number; layout?: DiagramLayout };
      if (data?.type !== "layout" || data.reqId !== reqId) return;
      setDiagramLayout(data.layout || null);
      worker.removeEventListener("message", onMessage);
    };
    worker.addEventListener("message", onMessage);
  };

  useEffect(() => {
    requestDiagramLayout();
  }, [fileNodes]);

  return { diagramLayout, requestDiagramLayout, nodeByQualified };
}
