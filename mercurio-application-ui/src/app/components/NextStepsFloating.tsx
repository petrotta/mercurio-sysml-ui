type NextStep = { id: string; label: string; recommended: boolean; action: string };

type NextStepsFloatingProps = {
  steps: NextStep[];
  pos: { x: number; y: number };
  onStartDrag: (event: React.PointerEvent<HTMLDivElement>) => void;
  onClose: () => void;
  onRunStep: (step: NextStep) => void;
};

export function NextStepsFloating({ steps, pos, onStartDrag, onClose, onRunStep }: NextStepsFloatingProps) {
  if (!steps.length) return null;
  return (
    <div className="ai-floating" style={{ left: pos.x, top: pos.y }}>
      <div className="ai-floating-header" onPointerDown={onStartDrag}>
        <span>Next steps</span>
        <button
          type="button"
          className="ghost"
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          x
        </button>
      </div>
      <div className="ai-floating-list">
        {steps.map((step) => (
          <button
            key={step.id}
            type="button"
            className={`ai-floating-item ${step.recommended ? "recommended" : ""}`}
            onClick={() => onRunStep(step)}
          >
            <span className="ai-floating-id">{step.id}.</span>
            <span className="ai-floating-label">{step.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
