import { useEffect, useMemo, useRef } from "react";
import type { SymbolView } from "./types";

type TrackingOptions = {
  symbols: SymbolView[];
  activeEditorPath: string | null;
  cursorPos: { line: number; col: number } | null;
  enabled: boolean;
  onTrack: (symbol: SymbolView) => void;
};

const distanceToSymbol = (line: number, col: number, sym: SymbolView) => {
  if (line < sym.start_line) {
    return { line: sym.start_line - line, col: 0 };
  }
  if (line > sym.end_line) {
    return { line: line - sym.end_line, col: 0 };
  }
  if (line === sym.start_line && col < sym.start_col) {
    return { line: 0, col: sym.start_col - col };
  }
  if (line === sym.end_line && col > sym.end_col) {
    return { line: 0, col: col - sym.end_col };
  }
  return { line: 0, col: 0 };
};

const spanSize = (sym: SymbolView) => {
  const lineSpan = Math.max(0, (sym.end_line ?? 0) - (sym.start_line ?? 0));
  const colSpan = Math.max(0, (sym.end_col ?? 0) - (sym.start_col ?? 0));
  return lineSpan * 1_000_000 + colSpan;
};

const findNearestSymbol = (
  symbols: SymbolView[],
  activeEditorPath: string | null,
  cursorPos: { line: number; col: number } | null,
) => {
  if (!cursorPos || !activeEditorPath) return null;
  // Monaco positions are 1-based, and compile symbol spans are also 1-based.
  const line = cursorPos.line;
  const col = cursorPos.col;
  const candidates = symbols.filter((sym) => {
    if (sym.file_path !== activeEditorPath) return false;
    if (sym.start_line == null || sym.start_col == null || sym.end_line == null || sym.end_col == null) return false;
    return true;
  });
  if (!candidates.length) return null;
  return candidates.reduce((best, sym) => {
    const db = distanceToSymbol(line, col, best);
    const ds = distanceToSymbol(line, col, sym);
    if (ds.line !== db.line) return ds.line < db.line ? sym : best;
    if (ds.col !== db.col) return ds.col < db.col ? sym : best;
    return spanSize(sym) < spanSize(best) ? sym : best;
  });
};

export function useModelTracking({
  symbols,
  activeEditorPath,
  cursorPos,
  enabled,
  onTrack,
}: TrackingOptions) {
  const lastTrackedRef = useRef<string | null>(null);
  const trackCandidate = useMemo(
    () => findNearestSymbol(symbols, activeEditorPath, cursorPos),
    [symbols, activeEditorPath, cursorPos],
  );

  const trackNow = () => {
    if (!trackCandidate) return;
    const key = trackCandidate.qualified_name || trackCandidate.name;
    if (key && lastTrackedRef.current === key) return;
    lastTrackedRef.current = key;
    onTrack(trackCandidate);
  };

  useEffect(() => {
    if (!enabled || !trackCandidate) return;
    const schedule = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 0));
    const cancel = window.cancelIdleCallback ?? ((id: number) => window.clearTimeout(id));
    const id = schedule(() => trackNow());
    return () => cancel(id as number);
  }, [enabled, trackCandidate]);

  return { trackCandidate, trackNow };
}
