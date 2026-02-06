type ModelHeaderProps = {
  collapseAll: boolean;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onToggleProperties: () => void;
  showProperties: boolean;
};

export function ModelHeader({
  collapseAll,
  onCollapseAll,
  onExpandAll,
  onToggleProperties,
  showProperties,
}: ModelHeaderProps) {
  return (
    <>
      <button
        type="button"
        className="ghost collapse-btn"
        onClick={onCollapseAll}
        title="Collapse all"
        aria-label="Collapse all"
        disabled={collapseAll}
      >
        -
      </button>
      <button
        type="button"
        className="ghost collapse-btn"
        onClick={onExpandAll}
        title="Expand all"
        aria-label="Expand all"
        disabled={!collapseAll}
      >
        +
      </button>
      <button
        type="button"
        className={`ghost icon-properties ${showProperties ? "active" : ""}`}
        onClick={onToggleProperties}
        aria-label="Toggle properties"
        title={showProperties ? "Hide properties" : "Show properties"}
      />
    </>
  );
}
