import { CombinedPropertiesPane } from "./CombinedPropertiesPane";
import type { SemanticElementResult, SymbolView } from "../types";

type PropertiesPanelProps = {
  rootPath: string;
  selectedSymbol: SymbolView | null;
  selectedSemanticRow: SemanticElementResult | null;
  selectedSemanticLoading: boolean;
  selectedSemanticError: string;
  onSelectQualifiedName: (qualifiedName: string) => void;
};

export function PropertiesPanel({
  rootPath,
  selectedSymbol,
  selectedSemanticRow,
  selectedSemanticLoading,
  selectedSemanticError,
  onSelectQualifiedName,
}: PropertiesPanelProps) {
  return (
    <div className="simple-right-section simple-right-top-section">
      <div className="panel-header"><strong>Properties</strong></div>
      <div className="simple-ui-scroll simple-properties-host">
        <CombinedPropertiesPane
          rootPath={rootPath}
          selectedSymbols={selectedSymbol ? [selectedSymbol] : null}
          selectedSemanticRow={selectedSemanticRow}
          selectedSemanticLoading={selectedSemanticLoading}
          selectedSemanticError={selectedSemanticError}
          onSelectQualifiedName={onSelectQualifiedName}
        />
      </div>
    </div>
  );
}
