import { CombinedPropertiesPane } from "./CombinedPropertiesPane";
import type { SymbolView } from "../contracts";

type PropertiesPanelProps = {
  rootPath: string;
  selectedSymbol: SymbolView | null;
  semanticRefreshVersion: number;
  onSelectQualifiedName: (qualifiedName: string) => void;
  onOpenExplorer: () => void;
};

export function PropertiesPanel({
  rootPath,
  selectedSymbol,
  semanticRefreshVersion,
  onSelectQualifiedName,
  onOpenExplorer,
}: PropertiesPanelProps) {
  return (
    <div className="simple-right-section simple-right-top-section">
      <div className="panel-header simple-properties-panel-header">
        <strong>Properties</strong>
        <button type="button" className="ghost" onClick={onOpenExplorer} disabled={!selectedSymbol}>
          Model Explorer
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
