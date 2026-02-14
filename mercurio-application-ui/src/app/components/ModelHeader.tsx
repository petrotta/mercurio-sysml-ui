import type { MouseEvent } from "react";

type ModelHeaderProps = {
  collapseAll: boolean;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onOpenOptions: (event: MouseEvent<HTMLButtonElement>) => void;
};

export function ModelHeader({
  collapseAll,
  onCollapseAll,
  onExpandAll,
  onOpenOptions,
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
        className="ghost icon-gear"
        onClick={onOpenOptions}
        aria-label="Model options"
        title="Model options"
      />
    </>
  );
}
