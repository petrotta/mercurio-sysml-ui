import { CombinedPropertiesPane } from "./CombinedPropertiesPane";
import type { SemanticElementResult, SymbolView } from "../types";

type PropertiesPanelProps = {
  selectedSymbol: SymbolView | null;
  selectedSemanticRow: SemanticElementResult | null;
  selectedSemanticLoading: boolean;
  selectedSemanticError: string;
  onSelectQualifiedName: (qualifiedName: string) => void;
};

export function PropertiesPanel({
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
