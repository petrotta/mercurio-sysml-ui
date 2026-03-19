import { CombinedPropertiesPane } from "./CombinedPropertiesPane";
import type { SymbolView } from "../contracts";

type PropertiesPanelProps = {
  rootPath: string;
  selectedSymbol: SymbolView | null;
  semanticRefreshVersion: number;
  onSelectQualifiedName: (qualifiedName: string) => void;
};

export function PropertiesPanel({
  rootPath,
  selectedSymbol,
  semanticRefreshVersion,
  onSelectQualifiedName,
}: PropertiesPanelProps) {
  return (
    <div className="simple-right-section simple-right-top-section">
      <div className="panel-header"><strong>Properties</strong></div>
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
