import { useEffect, useRef, useState } from "react";
import {
  clearSemanticProjectionCache,
  querySemanticElementProjectionByQualifiedName,
} from "./services/semanticApi";
import type { SemanticElementProjectionResult, SymbolView } from "./types";

type UseSemanticSelectionArgs = {
  rootPath: string;
  semanticSelectedQname: string;
  selectedSymbol: SymbolView | null;
  semanticRefreshVersion: number;
};

type UseSemanticSelectionResult = {
  selectedSemanticRow: SemanticElementProjectionResult | null;
  selectedSemanticLoading: boolean;
  selectedSemanticError: string;
};

export function useSemanticSelection({
  rootPath,
  semanticSelectedQname,
  selectedSymbol,
  semanticRefreshVersion,
}: UseSemanticSelectionArgs): UseSemanticSelectionResult {
  const [selectedSemanticRow, setSelectedSemanticRow] = useState<SemanticElementProjectionResult | null>(
    null,
  );
  const [selectedSemanticLoading, setSelectedSemanticLoading] = useState(false);
  const [selectedSemanticError, setSelectedSemanticError] = useState("");
  const requestSeqRef = useRef(0);
  const lastRequestKeyRef = useRef("");

  useEffect(() => {
    clearSemanticProjectionCache(rootPath || undefined);
  }, [rootPath]);

  useEffect(() => {
    const qname = (semanticSelectedQname || selectedSymbol?.qualified_name || "").trim();
    const filePath = selectedSymbol?.file_path || null;
    const requestKey = `${(rootPath || "").toLowerCase()}\u0000${(filePath || "").toLowerCase()}\u0000${qname.toLowerCase()}\u0000${semanticRefreshVersion}`;
    if (!rootPath || !qname) {
      requestSeqRef.current += 1;
      lastRequestKeyRef.current = "";
      setSelectedSemanticRow(null);
      setSelectedSemanticError("");
      setSelectedSemanticLoading(false);
      return;
    }
    if (requestKey === lastRequestKeyRef.current) {
      return;
    }
    lastRequestKeyRef.current = requestKey;
    const requestSeq = ++requestSeqRef.current;
    setSelectedSemanticLoading(true);
    setSelectedSemanticError("");
    void querySemanticElementProjectionByQualifiedName(rootPath, qname, filePath)
      .then((payload) => {
        if (requestSeqRef.current !== requestSeq) return;
        setSelectedSemanticRow(payload || null);
        if (!payload) {
          setSelectedSemanticError("No semantic row in EMF cache. Run Compile to refresh.");
        } else {
          setSelectedSemanticError("");
        }
      })
      .catch((error) => {
        if (requestSeqRef.current !== requestSeq) return;
        setSelectedSemanticRow(null);
        setSelectedSemanticError(`Failed to load semantic element: ${String(error)}`);
      })
      .finally(() => {
        if (requestSeqRef.current !== requestSeq) return;
        setSelectedSemanticLoading(false);
      });
  }, [
    rootPath,
    semanticSelectedQname,
    selectedSymbol?.qualified_name,
    selectedSymbol?.file_path,
    semanticRefreshVersion,
  ]);

  return {
    selectedSemanticRow,
    selectedSemanticLoading,
    selectedSemanticError,
  };
}
