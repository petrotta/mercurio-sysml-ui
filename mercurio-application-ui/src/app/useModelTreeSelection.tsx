import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ListImperativeAPI } from "react-window";
import type { ModelRow, SymbolView } from "./types";

type NavigateTarget = {
  path: string;
  name?: string;
  selection?: { startLine: number; startCol: number; endLine: number; endCol: number };
};

type UseModelTreeSelectionOptions = {
  modelRows: ModelRow[];
  modelTreeHeight: number;
  setModelSectionOpen: (updater: (prev: { project: boolean; library: boolean; errors: boolean }) => { project: boolean; library: boolean; errors: boolean }) => void;
  setModelExpanded: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
  selectedSymbol: SymbolView | null;
  setSelectedSymbol: (symbol: SymbolView | null) => void;
  setSelectedNodeSymbols: (symbols: SymbolView[] | null) => void;
  selectSymbolInEditor: (symbol: SymbolView) => Promise<void> | void;
  navigateTo: (target: NavigateTarget) => Promise<void> | void;
  projectGroups: Array<{ path: string; list: SymbolView[] }>;
  libraryGroups: Array<{ path: string; list: SymbolView[] }>;
};

export function useModelTreeSelection({
  modelRows,
  modelTreeHeight,
  setModelSectionOpen,
  setModelExpanded,
  selectedSymbol,
  setSelectedSymbol,
  setSelectedNodeSymbols,
  selectSymbolInEditor,
  navigateTo,
  projectGroups,
  libraryGroups,
}: UseModelTreeSelectionOptions) {
  const modelListRef = useRef<ListImperativeAPI | null>(null);
  const pendingScrollSymbolRef = useRef<string | null>(null);
  const modelCursorRowKeyRef = useRef<string | null>(null);
  const [modelCursorIndex, setModelCursorIndex] = useState<number | null>(null);
  const modelSectionIndent = 12;
  const modelListHeight = Math.max(120, modelTreeHeight - 16);

  const findSelectedSymbolIndex = () => {
    if (!selectedSymbol) return -1;
    return modelRows.findIndex((row) => {
      if (row.type !== "symbol") return false;
      if (selectedSymbol.qualified_name) {
        return row.node.symbols.some((sym) => sym.qualified_name === selectedSymbol.qualified_name);
      }
      return row.node.symbols.some((sym) => sym.file_path === selectedSymbol.file_path && sym.name === selectedSymbol.name);
    });
  };

  const syncModelTreeToSymbol = (symbol: SymbolView) => {
    if (!symbol?.file_path) return;
    const qualified = symbol.qualified_name || symbol.name;
    const projectGroup = projectGroups.find((group) => group.path === symbol.file_path);
    const libraryGroup = projectGroup ? null : libraryGroups.find((group) => group.path === symbol.file_path);
    const section = projectGroup ? "project" : libraryGroup ? "library" : null;
    if (!section) return;
    const group = projectGroup || libraryGroup;
    if (!group) return;
    const rootKey = `${section}::${group.path}`;
    const nextExpanded: Record<string, boolean> = {};
    nextExpanded[`${rootKey}::${rootKey}`] = true;
    if (qualified) {
      const segments = qualified.split("::").filter(Boolean);
      let prefix = "";
      segments.forEach((segment) => {
        prefix = prefix ? `${prefix}::${segment}` : segment;
        nextExpanded[`${rootKey}::${prefix}`] = true;
      });
    }
    setModelSectionOpen((prev) => ({ ...prev, [section]: true }));
    setModelExpanded((prev) => ({ ...prev, ...nextExpanded }));
    pendingScrollSymbolRef.current = qualified;
  };

  useEffect(() => {
    if (!pendingScrollSymbolRef.current) return;
    const target = pendingScrollSymbolRef.current;
    const index = modelRows.findIndex((row) => {
      if (row.type !== "symbol") return false;
      if (row.node.fullName === target) return true;
      return row.node.symbols.some((sym) => (sym.qualified_name || sym.name) === target);
    });
    if (index >= 0) {
      modelListRef.current?.scrollToRow({ index, align: "center" });
      setModelCursorIndex(index);
      pendingScrollSymbolRef.current = null;
    }
  }, [modelRows]);

  useEffect(() => {
    if (modelCursorIndex == null) return;
    if (modelCursorIndex < 0 || modelCursorIndex >= modelRows.length) {
      setModelCursorIndex(modelRows.length ? 0 : null);
      return;
    }
    const row = modelRows[modelCursorIndex];
    modelCursorRowKeyRef.current = row?.key ?? null;
    modelListRef.current?.scrollToRow({ index: modelCursorIndex, align: "smart" });
  }, [modelCursorIndex, modelRows.length]);

  useEffect(() => {
    if (!modelRows.length) {
      modelCursorRowKeyRef.current = null;
      if (modelCursorIndex != null) {
        setModelCursorIndex(null);
      }
      return;
    }
    const key = modelCursorRowKeyRef.current;
    if (!key) return;
    const index = modelRows.findIndex((row) => row.key === key);
    if (index >= 0 && index !== modelCursorIndex) {
      setModelCursorIndex(index);
    }
  }, [modelRows, modelCursorIndex]);

  const activateModelRow = (row: ModelRow, index: number) => {
    if (row.type === "section") {
      setModelSectionOpen((prev) => ({ ...prev, [row.section]: !prev[row.section] }));
      return;
    }
    if (row.type === "symbol") {
      const symbol = row.node.symbols[0];
      if (symbol) {
        setSelectedSymbol(symbol);
        setSelectedNodeSymbols(row.node.symbols.length ? row.node.symbols : [symbol]);
        void selectSymbolInEditor(symbol);
      }
      return;
    }
    if (row.type === "error") {
      const issue = row.issue;
      const path = issue.file_path;
      if (!path) return;
      void navigateTo({
        path,
        name: path.split(/[\\/]/).pop() || "Untitled",
        selection: {
          startLine: issue.line || 1,
          startCol: issue.column || 1,
          endLine: issue.line || 1,
          endCol: (issue.column || 1) + 1,
        },
      });
      return;
    }
    if (row.type === "empty") {
      setModelCursorIndex(index);
    }
  };

  const handleModelTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>, indexOverride?: number) => {
    if (!modelRows.length) return;
    const key = event.key;
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(key)) return;
    event.preventDefault();
    event.stopPropagation();

    const currentIndex = modelCursorIndex ?? indexOverride ?? 0;
    if (modelCursorIndex == null) {
      setModelCursorIndex(currentIndex);
    }
    if (key === "ArrowUp") {
      setModelCursorIndex(Math.max(0, currentIndex - 1));
      return;
    }
    if (key === "ArrowDown") {
      setModelCursorIndex(Math.min(modelRows.length - 1, currentIndex + 1));
      return;
    }

    const row = modelRows[currentIndex];
    if (!row) return;
    if (key === "Enter") {
      activateModelRow(row, currentIndex);
      return;
    }
    if (key === "ArrowRight") {
      if (row.type === "section") {
        setModelSectionOpen((prev) => ({ ...prev, [row.section]: true }));
      } else if (row.type === "symbol" && row.hasChildren && !row.expanded) {
        setModelExpanded((prev) => ({ ...prev, [row.key]: true }));
      }
      return;
    }
    if (key === "ArrowLeft") {
      if (row.type === "section") {
        setModelSectionOpen((prev) => ({ ...prev, [row.section]: false }));
      } else if (row.type === "symbol" && row.hasChildren && row.expanded) {
        setModelExpanded((prev) => ({ ...prev, [row.key]: false }));
      }
    }
  };

  const getModelRowHeight = (row: ModelRow) => {
    if (row.type === "section") return 28;
    if (row.type === "error") return 64;
    if (row.type === "empty") return 24;
    return 24;
  };

  return {
    modelListRef,
    modelSectionIndent,
    modelListHeight,
    modelCursorIndex,
    setModelCursorIndex,
    findSelectedSymbolIndex,
    syncModelTreeToSymbol,
    handleModelTreeKeyDown,
    getModelRowHeight,
    activateModelRow,
  };
}
