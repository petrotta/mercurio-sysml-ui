import type { KeyboardEvent, PointerEvent, RefObject, ReactElement } from "react";
import { List, type ListImperativeAPI, type RowComponentProps } from "react-window";
import type { ModelRow, SymbolView } from "../types";
import { PropertiesPane } from "./PropertiesPane";

type ModelPaneProps = {
  modelTreeHeight: number;
  showPropertiesPane: boolean;
  modelTreeRef: RefObject<HTMLDivElement | null>;
  modelListRef: RefObject<ListImperativeAPI | null>;
  modelRows: ModelRow[];
  modelListHeight: number;
  getModelRowHeight: (row: ModelRow) => number;
  renderModelRow: (props: RowComponentProps<{ rows: ModelRow[] }>) => ReactElement | null;
  handleModelTreeKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onModelTreeFocus: () => void;
  startDrag: (side: "left" | "right" | "model", event: PointerEvent) => void;
  selectedSymbol: SymbolView | null;
  selectedSymbols: SymbolView[] | null;
  getDoc: (path: string) => { path: string; text: string; dirty: boolean } | null;
  readFile: (path: string) => Promise<string>;
};

export function ModelPane({
  modelTreeHeight,
  showPropertiesPane,
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
  getDoc,
  readFile,
}: ModelPaneProps) {
  return (
    <div
      className={`model-pane ${showPropertiesPane ? "" : "no-properties"}`}
      style={{ ["--model-tree-height" as string]: `${modelTreeHeight}px` }}
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
          <div className="h-splitter" onPointerDown={(event) => startDrag("model", event)} />
          <PropertiesPane selectedSymbols={selectedSymbols ?? (selectedSymbol ? [selectedSymbol] : null)} getDoc={getDoc} readFile={readFile} />
        </>
      ) : null}
    </div>
  );
}
