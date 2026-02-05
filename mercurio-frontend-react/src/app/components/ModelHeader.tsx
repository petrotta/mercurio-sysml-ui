type ModelHeaderProps = {
  canTrack: boolean;
  trackText: boolean;
  collapseAll: boolean;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onToggleTrack: () => void;
  onToggleProperties: () => void;
  showProperties: boolean;
};

export function ModelHeader({
  canTrack,
  trackText,
  collapseAll,
  onCollapseAll,
  onExpandAll,
  onToggleTrack,
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
        className={`ghost icon-track ${trackText ? "active" : ""}`}
        onClick={onToggleTrack}
        disabled={!canTrack}
        title={trackText ? "Stop tracking text" : "Track text"}
        aria-label={trackText ? "Stop tracking text" : "Track text"}
      />
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
