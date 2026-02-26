import { useMemo } from "react";
import type { KeyboardEvent, PointerEvent, RefObject, ReactElement } from "react";
import { List, type ListImperativeAPI, type RowComponentProps } from "react-window";
import type { ModelRow, SymbolView } from "../types";
import { PropertiesPane } from "./PropertiesPane";

type ModelPaneProps = {
  rootPath: string;
  modelTreeHeight: number;
  showPropertiesPane: boolean;
  propertiesDock: "bottom" | "right";
  modelPropertiesWidth: number;
  modelTreeRef: RefObject<HTMLDivElement | null>;
  modelListRef: RefObject<ListImperativeAPI | null>;
  modelRows: ModelRow[];
  modelListHeight: number;
  getModelRowHeight: (row: ModelRow) => number;
  renderModelRow: (props: RowComponentProps<{ rows: ModelRow[] }>) => ReactElement | null;
  handleModelTreeKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onModelTreeFocus: () => void;
  startDrag: (side: "left" | "right" | "model" | "modelProps", event: PointerEvent) => void;
  selectedSymbol: SymbolView | null;
  selectedSymbols: SymbolView[] | null;
  onOpenInProjectModel: (symbol: SymbolView) => void;
  onOpenQualifiedNameInSource: (qualifiedName: string) => void;
};

export function ModelPane({
  rootPath,
  modelTreeHeight,
  showPropertiesPane,
  propertiesDock,
  modelPropertiesWidth,
  modelTreeRef,
  modelListRef,
  modelRows,
  modelListHeight,
  getModelRowHeight,
  renderModelRow,
  handleModelTreeKeyDown,
  onModelTreeFocus,
  startDrag,
  selectedSymbol,
  selectedSymbols,
  onOpenInProjectModel,
  onOpenQualifiedNameInSource,
}: ModelPaneProps) {
  const dockRight = showPropertiesPane && propertiesDock === "right";
  const effectiveSelectedSymbols = useMemo(
    () => selectedSymbols ?? (selectedSymbol ? [selectedSymbol] : null),
    [selectedSymbols, selectedSymbol],
  );
  return (
    <div
      className={`model-pane ${showPropertiesPane ? "" : "no-properties"} ${dockRight ? "dock-right" : "dock-bottom"}`}
      style={{
        ["--model-tree-height" as string]: `${modelTreeHeight}px`,
        ["--model-props-width" as string]: `${modelPropertiesWidth}px`,
      }}
    >
      <div
        className="model-tree"
        ref={modelTreeRef}
        tabIndex={0}
        onKeyDown={handleModelTreeKeyDown}
        onMouseDown={() => {
          if (document.activeElement !== modelTreeRef.current) {
            modelTreeRef.current?.focus();
          }
        }}
        onFocus={onModelTreeFocus}
      >
        <List
          listRef={modelListRef}
          rowCount={modelRows.length}
          rowHeight={(index) => getModelRowHeight(modelRows[index])}
          rowComponent={renderModelRow}
          rowProps={{ rows: modelRows }}
          overscanCount={6}
          style={{ height: modelListHeight, width: "100%" }}
        />
      </div>
      {showPropertiesPane ? (
        <>
          <div
            className={dockRight ? "v-splitter" : "h-splitter"}
            onPointerDown={(event) => startDrag(dockRight ? "modelProps" : "model", event)}
          />
          <PropertiesPane
            rootPath={rootPath}
            selectedSymbols={effectiveSelectedSymbols}
            onOpenInProjectModel={onOpenInProjectModel}
            onOpenQualifiedNameInSource={onOpenQualifiedNameInSource}
          />
        </>
      ) : null}
    </div>
  );
}
