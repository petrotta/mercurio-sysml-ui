import { useEffect, useMemo, useRef, useState } from "react";
import type { DiagramLayout, SymbolView } from "./types";

type UseDiagramLayoutOptions = {
  activeDiagramPath: string | null;
  deferredSymbols: SymbolView[];
};

export function useDiagramLayout({ activeDiagramPath, deferredSymbols }: UseDiagramLayoutOptions) {
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

  const fileSymbols = useMemo(() => {
    if (!activeDiagramPath) return [];
    return deferredSymbols.filter((symbol) => symbol.file_path === activeDiagramPath);
  }, [deferredSymbols, activeDiagramPath]);

  const symbolByQualified = useMemo(() => {
    const map = new Map<string, SymbolView>();
    fileSymbols.forEach((symbol) => map.set(symbol.qualified_name, symbol));
    return map;
  }, [fileSymbols]);

  const requestDiagramLayout = () => {
    if (!diagramWorkerRef.current) return;
    if (!fileSymbols.length) {
      setDiagramLayout(null);
      return;
    }
    const worker = diagramWorkerRef.current;
    const reqId = ++diagramLayoutReqRef.current;
    worker.postMessage({
      type: "layout",
      reqId,
      nodes: fileSymbols.map((symbol) => ({
        qualified: symbol.qualified_name,
        name: symbol.name,
        kind: symbol.kind,
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
  }, [fileSymbols]);

  return { diagramLayout, requestDiagramLayout, symbolByQualified };
}
