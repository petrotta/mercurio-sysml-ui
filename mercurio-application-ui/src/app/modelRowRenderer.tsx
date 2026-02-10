import type { KeyboardEvent, MouseEvent, RefObject, ReactElement } from "react";
import type { RowComponentProps } from "react-window";
import type { ModelRow, SymbolNode, SymbolView } from "./types";

type NavigateTarget = {
  path: string;
  name?: string;
  selection?: { startLine: number; startCol: number; endLine: number; endCol: number };
};

type ModelRowRendererOptions = {
  modelCursorIndex: number | null;
  modelSectionOpen: { project: boolean; library: boolean; errors: boolean };
  modelSectionIndent: number;
  modelTreeRef: RefObject<HTMLDivElement | null>;
  handleModelTreeKeyDown: (event: KeyboardEvent<HTMLDivElement>, indexOverride?: number) => void;
  onModelContextMenu: (event: MouseEvent, payload: { filePath: string | null; label: string }) => void;
  setModelCursorIndex: (index: number | null) => void;
  setModelSectionOpen: (updater: (prev: { project: boolean; library: boolean; errors: boolean }) => { project: boolean; library: boolean; errors: boolean }) => void;
  setModelExpanded: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
  selectedSymbol: SymbolView | null;
  setSelectedSymbol: (symbol: SymbolView | null) => void;
  setSelectedNodeSymbols: (symbols: SymbolView[] | null) => void;
  selectSymbolInEditor: (symbol: SymbolView) => Promise<void> | void;
  navigateTo: (target: NavigateTarget) => Promise<void> | void;
  renderTypeIcon: (kind: string, variant: "model" | "diagram") => ReactElement;
};

export function createModelRowRenderer(options: ModelRowRendererOptions) {
  const {
    modelCursorIndex,
    modelSectionOpen,
    modelSectionIndent,
    modelTreeRef,
    handleModelTreeKeyDown,
    onModelContextMenu,
    setModelCursorIndex,
    setModelSectionOpen,
    setModelExpanded,
    selectedSymbol,
    setSelectedSymbol,
    setSelectedNodeSymbols,
    selectSymbolInEditor,
    navigateTo,
    renderTypeIcon,
  } = options;

  const findFirstSymbol = (node: SymbolNode): SymbolView | null => {
    if (node.symbols.length) return node.symbols[0];
    for (const child of node.children.values()) {
      const found = findFirstSymbol(child);
      if (found) return found;
    }
    return null;
  };

  return ({ index, style, rows }: RowComponentProps<{ rows: ModelRow[] }>) => {
    const row = rows[index];
    if (!row) return null;
    const isFocused = modelCursorIndex === index;
    if (row.type === "section") {
      const isOpen = modelSectionOpen[row.section];
      return (
        <div
          style={style}
          className={`model-section-row ${isFocused ? "model-row-focused" : ""}`}
          role="button"
          tabIndex={-1}
          onKeyDown={(event) => handleModelTreeKeyDown(event, index)}
          onMouseDown={(event) => {
            event.preventDefault();
            modelTreeRef.current?.focus();
          }}
          onClick={() => {
            setModelCursorIndex(index);
            setModelSectionOpen((prev) => ({ ...prev, [row.section]: !isOpen }));
          }}
        >
          <span className="model-section-toggle">{isOpen ? "-" : "+"}</span>
          <span className="model-section-label">{row.label}</span>
          <span className="model-section-count">{row.countLabel}</span>
        </div>
      );
    }
    if (row.type === "empty") {
      return (
        <div
          style={{ ...style, paddingLeft: `${modelSectionIndent}px` }}
          className={`model-empty-row ${isFocused ? "model-row-focused" : ""}`}
          onClick={() => setModelCursorIndex(index)}
          role="button"
          tabIndex={-1}
          onKeyDown={(event) => handleModelTreeKeyDown(event, index)}
          onMouseDown={(event) => {
            event.preventDefault();
            modelTreeRef.current?.focus();
          }}
        >
          {row.text}
        </div>
      );
    }
    if (row.type === "error") {
      const issue = row.issue;
      return (
        <div
          style={{ ...style, paddingLeft: `${modelSectionIndent + 8}px` }}
          className={`error-row ${isFocused ? "model-row-focused" : ""}`}
          role="button"
          tabIndex={-1}
          onKeyDown={(event) => handleModelTreeKeyDown(event, index)}
          onMouseDown={(event) => {
            event.preventDefault();
            modelTreeRef.current?.focus();
          }}
          onClick={() => {
            setModelCursorIndex(index);
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
          }}
        >
          <span className="error-icon" aria-hidden="true" />
          <div className="error-text">
            <div className="error-message">{issue.message}</div>
            <div className="error-title">{issue.file_path}:{issue.line}:{issue.column}</div>
          </div>
        </div>
      );
    }
    const symbol = row.node.symbols[0] || findFirstSymbol(row.node);
    const isSelected =
      !!symbol &&
      (selectedSymbol?.qualified_name
        ? selectedSymbol.qualified_name === symbol.qualified_name
        : selectedSymbol?.file_path === symbol.file_path && selectedSymbol?.name === symbol.name);
    return (
      <div
        style={{ ...style, paddingLeft: `${modelSectionIndent + 8 + row.depth * 14}px` }}
        className={`model-virtual-row ${isSelected ? "selected" : ""} ${isFocused ? "model-row-focused" : ""}`}
        role="button"
        tabIndex={-1}
        onKeyDown={(event) => handleModelTreeKeyDown(event, index)}
        onMouseDown={() => {
          modelTreeRef.current?.focus();
        }}
        onClick={(event) => {
          event.stopPropagation();
          setModelCursorIndex(index);
          if (symbol) {
            setSelectedSymbol(symbol);
          }
          if (row.node.symbols.length) {
            setSelectedNodeSymbols(row.node.symbols);
          } else {
            setSelectedNodeSymbols(symbol ? [symbol] : null);
          }
        }}
        onContextMenu={(event) => {
          if (row.depth !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          setModelCursorIndex(index);
          if (symbol) {
            setSelectedSymbol(symbol);
          }
          if (row.node.symbols.length) {
            setSelectedNodeSymbols(row.node.symbols);
          } else {
            setSelectedNodeSymbols(symbol ? [symbol] : null);
          }
          const filePath = symbol?.file_path ?? null;
          onModelContextMenu(event, { filePath, label: row.name });
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (symbol) {
            void selectSymbolInEditor(symbol);
          }
        }}
      >
        <span
          className="model-caret"
          onClick={(event) => {
            event.stopPropagation();
            if (row.hasChildren) {
              setModelExpanded((prev) => ({ ...prev, [row.key]: !row.expanded }));
            }
          }}
        >
          {row.hasChildren ? (row.expanded ? "-" : "+") : ""}
        </span>
        {renderTypeIcon(row.kindKey, "model")}
        <span className="model-name">{row.name}</span>
        {row.kindLabel ? <span className="model-kind">{row.kindLabel}</span> : null}
      </div>
    );
  };
}
