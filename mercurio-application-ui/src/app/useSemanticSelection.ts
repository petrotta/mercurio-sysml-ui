import { useEffect, useRef, useState } from "react";
import { clearSemanticElementCache, querySemanticElementByQualifiedName } from "./services/semanticApi";
import type { SemanticElementResult, SymbolView } from "./types";

type UseSemanticSelectionArgs = {
  rootPath: string;
  semanticSelectedQname: string;
  selectedSymbol: SymbolView | null;
};

type UseSemanticSelectionResult = {
  selectedSemanticRow: SemanticElementResult | null;
  selectedSemanticLoading: boolean;
  selectedSemanticError: string;
};

export function useSemanticSelection({
  rootPath,
  semanticSelectedQname,
  selectedSymbol,
}: UseSemanticSelectionArgs): UseSemanticSelectionResult {
  const [selectedSemanticRow, setSelectedSemanticRow] = useState<SemanticElementResult | null>(null);
  const [selectedSemanticLoading, setSelectedSemanticLoading] = useState(false);
  const [selectedSemanticError, setSelectedSemanticError] = useState("");
  const requestKeyRef = useRef("");

  useEffect(() => {
    requestKeyRef.current = "";
    clearSemanticElementCache(rootPath || undefined);
  }, [rootPath]);

  useEffect(() => {
    const qname = (semanticSelectedQname || selectedSymbol?.qualified_name || "").trim();
    const filePath = selectedSymbol?.file_path || null;
    if (!rootPath || !qname) {
      requestKeyRef.current = "";
      setSelectedSemanticRow(null);
      setSelectedSemanticError("");
      setSelectedSemanticLoading(false);
      return;
    }
    const requestKey = `${rootPath}\u0000${qname}\u0000${(filePath || "").toLowerCase()}`;
    if (requestKeyRef.current === requestKey) {
      return;
    }
    requestKeyRef.current = requestKey;
    let active = true;
    setSelectedSemanticLoading(true);
    setSelectedSemanticError("");
    const timer = window.setTimeout(() => {
      void querySemanticElementByQualifiedName(rootPath, qname, filePath)
        .then((payload) => {
          if (!active) return;
          setSelectedSemanticRow(payload || null);
        })
        .catch((error) => {
          if (!active) return;
          setSelectedSemanticRow(null);
          setSelectedSemanticError(`Failed to load semantic element: ${String(error)}`);
        })
        .finally(() => {
          if (!active) return;
          setSelectedSemanticLoading(false);
        });
    }, 50);
    
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [rootPath, semanticSelectedQname, selectedSymbol?.qualified_name, selectedSymbol?.file_path]);

  return {
    selectedSemanticRow,
    selectedSemanticLoading,
    selectedSemanticError,
  };
}
