import { CombinedPropertiesPane } from "./CombinedPropertiesPane";
import type { SymbolView } from "../contracts";

type PropertiesPanelProps = {
  rootPath: string;
  selectedSymbol: SymbolView | null;
  semanticRefreshVersion: number;
  onSelectQualifiedName: (qualifiedName: string) => void;
  onMinimize: () => void;
};

export function PropertiesPanel({
  rootPath,
  selectedSymbol,
  semanticRefreshVersion,
  onSelectQualifiedName,
  onMinimize,
}: PropertiesPanelProps) {
  return (
    <div className="simple-right-section simple-right-top-section simple-right-tool-panel">
      <div className="panel-header simple-properties-panel-header">
        <strong>Properties</strong>
        <button type="button" className="ghost simple-panel-minimize" onClick={onMinimize} title="Minimize side panel">
          -
        </button>
      </div>
      <div className="simple-ui-scroll simple-properties-host">
        <CombinedPropertiesPane
          rootPath={rootPath}
          selectedSymbols={selectedSymbol ? [selectedSymbol] : null}
          semanticRefreshVersion={semanticRefreshVersion}
          onSelectQualifiedName={onSelectQualifiedName}
        />
      </div>
    </div>
  );
}
