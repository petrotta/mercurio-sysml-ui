import type { KeyboardEvent, PointerEvent, RefObject, ReactElement } from "react";
import { List, type ListImperativeAPI, type RowComponentProps } from "react-window";
import type { ModelRow, ProjectElementAttributesView, StdlibMetamodelView, SymbolView } from "../types";
import { PropertiesPane } from "./PropertiesPane";

type ModelPaneProps = {
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
  getDoc: (path: string) => { path: string; text: string; dirty: boolean } | null;
  readFile: (path: string) => Promise<string>;
  onOpenInProjectModel: (symbol: SymbolView) => void;
  onOpenMetatypeInProjectModel: (metatypeQname: string) => void;
  onOpenAttributeInProjectModel: (symbol: SymbolView, attrQualifiedName: string, attrName: string) => void;
  onOpenAttributeSourceText: (symbol: SymbolView, attrQualifiedName: string, attrName: string) => void;
  loadElementAttributes: (symbol: SymbolView) => Promise<ProjectElementAttributesView | null>;
  stdlibMetamodel: StdlibMetamodelView | null;
  stdlibMetamodelLoading: boolean;
  stdlibMetamodelError: string;
  onReloadStdlibMetamodel: () => void;
};

export function ModelPane({
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
  getDoc,
  readFile,
  onOpenInProjectModel,
  onOpenMetatypeInProjectModel,
  onOpenAttributeInProjectModel,
  onOpenAttributeSourceText,
  loadElementAttributes,
  stdlibMetamodel,
  stdlibMetamodelLoading,
  stdlibMetamodelError,
  onReloadStdlibMetamodel,
}: ModelPaneProps) {
  const dockRight = showPropertiesPane && propertiesDock === "right";
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
            selectedSymbols={selectedSymbols ?? (selectedSymbol ? [selectedSymbol] : null)}
            getDoc={getDoc}
            readFile={readFile}
            onOpenInProjectModel={onOpenInProjectModel}
            onOpenMetatypeInProjectModel={onOpenMetatypeInProjectModel}
            onOpenAttributeInProjectModel={onOpenAttributeInProjectModel}
            onOpenAttributeSourceText={onOpenAttributeSourceText}
            loadElementAttributes={loadElementAttributes}
            stdlibMetamodel={stdlibMetamodel}
            stdlibMetamodelLoading={stdlibMetamodelLoading}
            stdlibMetamodelError={stdlibMetamodelError}
            onReloadStdlibMetamodel={onReloadStdlibMetamodel}
          />
        </>
      ) : null}
    </div>
  );
}
