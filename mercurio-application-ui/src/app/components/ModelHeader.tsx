import type { MouseEvent } from "react";

type ModelHeaderProps = {
  collapseAll: boolean;
  libraryStatus: string;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onOpenOptions: (event: MouseEvent<HTMLButtonElement>) => void;
};

export function ModelHeader({
  collapseAll,
  libraryStatus,
  onCollapseAll,
  onExpandAll,
  onOpenOptions,
}: ModelHeaderProps) {
  return (
    <>
      <span className="model-header-status">{libraryStatus}</span>
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
