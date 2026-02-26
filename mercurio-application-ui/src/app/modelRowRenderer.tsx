import type { KeyboardEvent, MouseEvent, RefObject, ReactElement } from "react";
import type { RowComponentProps } from "react-window";
import type { ModelRow, SymbolNode, SymbolView } from "./types";
import { setPendingDiagramDragPayload } from "./diagramDragPayload";

type NavigateTarget = {
  path: string;
  name?: string;
  selection?: { startLine: number; startCol: number; endLine: number; endCol: number };
};

type ModelContextPayload = {
  filePath: string | null;
  label: string;
  section: "project" | "library";
  loadError?: string;
};

type ModelRowRendererOptions = {
  modelCursorIndex: number | null;
  modelSectionOpen: { project: boolean; library: boolean; errors: boolean };
  modelSectionIndent: number;
  modelTreeRef: RefObject<HTMLDivElement | null>;
  handleModelTreeKeyDown: (event: KeyboardEvent<HTMLDivElement>, indexOverride?: number) => void;
  onModelContextMenu: (event: MouseEvent, payload: ModelContextPayload) => void;
  setModelCursorIndex: (index: number | null) => void;
  setModelSectionOpen: (updater: (prev: { project: boolean; library: boolean; errors: boolean }) => { project: boolean; library: boolean; errors: boolean }) => void;
  setModelExpanded: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
  selectedSymbol: SymbolView | null;
  setSelectedSymbol: (symbol: SymbolView | null) => void;
  setSelectedNodeSymbols: (symbols: SymbolView[] | null) => void;
  selectSymbolInEditor: (symbol: SymbolView) => Promise<void> | void;
  navigateTo: (target: NavigateTarget) => Promise<void> | void;
  renderTypeIcon: (kind: string, variant: "model" | "diagram") => ReactElement;
  onRequestLibraryFileSymbols: (filePath: string) => void;
  onRetryLibraryFileSymbols: (filePath: string) => void;
  onDragStartSymbol?: (symbol: SymbolView) => void;
  onDropSymbolOnSymbol?: (
    source: SymbolView,
    target: SymbolView,
    position: "before" | "after",
  ) => void;
  openOnClick?: boolean;
  getDraggedSymbol?: () => SymbolView | null;
  setDropIndicator?: (rowKey: string | null, position?: "before" | "after") => void;
  isDropIndicator?: (rowKey: string, position: "before" | "after") => boolean;
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
    onRequestLibraryFileSymbols,
    onRetryLibraryFileSymbols,
    onDragStartSymbol,
    onDropSymbolOnSymbol,
    openOnClick,
    getDraggedSymbol,
    setDropIndicator,
    isDropIndicator,
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
    const directSymbol = row.node.symbols[0] || null;
    const symbol = directSymbol || findFirstSymbol(row.node);
    const dragSymbol = directSymbol || (onDropSymbolOnSymbol ? null : symbol);
    const useNativeDrag = !!dragSymbol;
    const displayName = row.name && row.name.trim() ? row.name : "(unnamed)";
    const isUnnamed = displayName === "(unnamed)";
    const isSelected =
      !!symbol &&
      (selectedSymbol?.qualified_name
        ? selectedSymbol.qualified_name === symbol.qualified_name
        : selectedSymbol?.file_path === symbol.file_path && selectedSymbol?.name === symbol.name);
    return (
      <div
        style={{ ...style, paddingLeft: `${modelSectionIndent + 8 + row.depth * 14}px` }}
        className={`model-virtual-row ${isSelected ? "selected" : ""} ${isFocused ? "model-row-focused" : ""} ${
          isDropIndicator?.(row.key, "before") ? "drop-before" : ""
        } ${isDropIndicator?.(row.key, "after") ? "drop-after" : ""}`}
        role="button"
        tabIndex={-1}
        draggable={useNativeDrag}
        onDragStart={(event) => {
          if (!useNativeDrag || !dragSymbol) return;
          const payloadQualified =
            dragSymbol?.qualified_name || row.node.fullName || row.name || "(unnamed)";
          const payloadName = dragSymbol?.name || row.name || payloadQualified;
          const payloadKind = dragSymbol?.kind || row.kindKey || "";
          setPendingDiagramDragPayload({
            qualified: payloadQualified,
            name: payloadName,
            kind: payloadKind,
          });
          if (dragSymbol) {
            onDragStartSymbol?.(dragSymbol);
          }
          try {
            event.dataTransfer.effectAllowed = onDropSymbolOnSymbol ? "move" : "copy";
            event.dataTransfer.setData(
              "application/x-mercurio-diagram-node",
              JSON.stringify({
                qualified: payloadQualified,
                name: payloadName,
                kind: payloadKind,
              }),
            );
            event.dataTransfer.setData("text/plain", payloadQualified);
          } catch {
            // Some embedded webviews can block/strip drag data; use in-memory fallback.
          }
        }}
        onDragEnd={() => {
          setPendingDiagramDragPayload(null);
          setDropIndicator?.(null);
        }}
        onDragOver={(event) => {
          if (!directSymbol || !onDropSymbolOnSymbol) return;
          event.preventDefault();
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          const midpoint = rect.top + rect.height / 2;
          const pos: "before" | "after" = event.clientY < midpoint ? "before" : "after";
          setDropIndicator?.(row.key, pos);
          event.dataTransfer.dropEffect = "move";
        }}
        onDragLeave={() => {
          setDropIndicator?.(null);
        }}
        onDrop={(event) => {
          if (!directSymbol || !onDropSymbolOnSymbol || !getDraggedSymbol) return;
          event.preventDefault();
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          const midpoint = rect.top + rect.height / 2;
          const pos: "before" | "after" = event.clientY < midpoint ? "before" : "after";
          const source = getDraggedSymbol();
          if (!source) return;
          onDropSymbolOnSymbol(source, directSymbol, pos);
          setDropIndicator?.(null);
        }}
        onKeyDown={(event) => handleModelTreeKeyDown(event, index)}
        onMouseDown={() => {
          modelTreeRef.current?.focus();
        }}
        onClick={(event) => {
          event.stopPropagation();
          setModelCursorIndex(index);
          if (row.section === "library" && row.isFileRoot && row.filePath && row.node.symbols.length === 0) {
            onRequestLibraryFileSymbols(row.filePath);
          }
          if (symbol) {
            setSelectedSymbol(symbol);
            if (openOnClick) {
              void selectSymbolInEditor(symbol);
            }
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
          const filePath = row.filePath ?? symbol?.file_path ?? null;
          onModelContextMenu(event, {
            filePath,
            label: row.name,
            section: row.section,
            loadError: row.loadError,
          });
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          setModelCursorIndex(index);
          if (row.hasChildren) {
            if (row.section === "library" && row.isFileRoot && row.filePath) {
              onRequestLibraryFileSymbols(row.filePath);
            }
            setModelExpanded((prev) => ({ ...prev, [row.key]: !row.expanded }));
            return;
          }
          if (symbol) {
            void selectSymbolInEditor(symbol);
          }
        }}
      >
        <span
          className="model-caret"
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            if (row.hasChildren) {
              if (row.section === "library" && row.isFileRoot && row.filePath) {
                onRequestLibraryFileSymbols(row.filePath);
              }
              setModelExpanded((prev) => ({ ...prev, [row.key]: !row.expanded }));
            }
          }}
        >
          {row.hasChildren ? (row.expanded ? "-" : "+") : ""}
        </span>
        {renderTypeIcon(row.kindKey, "model")}
        <span className={`model-name ${isUnnamed ? "model-name-unnamed" : ""}`}>{displayName}</span>
        {row.isLoading ? <span className="model-kind">loading...</span> : null}
        {!row.isLoading && row.loadError ? <span className="model-kind">load failed</span> : null}
        {!row.isLoading && row.loadError && row.section === "library" && row.isFileRoot && row.filePath ? (
          <button
            type="button"
            className="model-inline-retry"
            onClick={(event) => {
              event.stopPropagation();
              onRetryLibraryFileSymbols(row.filePath!);
            }}
            title={`Retry library file load${row.loadError ? `: ${row.loadError}` : ""}`}
            aria-label="Retry library file load"
          >
            Retry
          </button>
        ) : null}
        {row.kindLabel ? <span className="model-kind">{row.kindLabel}</span> : null}
      </div>
    );
  };
}
