import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type AiMessage = {
  role: "user" | "assistant";
  text: string;
  nextSteps?: Array<{ id: string; label: string; recommended: boolean; action: string }>;
  pendingId?: number;
  steps?: Array<{ kind: string; detail: string }>;
};

type AiViewProps = {
  aiMessages: AiMessage[];
  aiInput: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onRunStep: (step: { id: string; label: string; recommended: boolean; action: string }) => void;
  onCycleHistory: (direction: "up" | "down") => void;
  onClear: () => void;
};

export function AiView(props: AiViewProps) {
  const [inputHeight, setInputHeight] = useState(72);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startY - event.clientY;
      const next = Math.min(240, Math.max(56, dragRef.current.startHeight + delta));
      setInputHeight(next);
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  return (
    <div className="ai-view">
      <div className="view-header" />
      <div className="ai-pane" style={{ gridTemplateRows: `1fr 6px ${inputHeight}px` }}>
        <div
          className="ai-messages"
          onContextMenu={(event) => {
            event.preventDefault();
            props.onClear();
          }}
        >
          {props.aiMessages.length ? (
            props.aiMessages.map((msg, idx) => (
              <div key={idx} className={`ai-message ${msg.role}`}>
                <AiMarkdown content={msg.text} />
                {msg.role === "assistant" && msg.nextSteps?.length ? (
                  <details className="ai-next-steps">
                    <summary>Next steps ({msg.nextSteps.length})</summary>
                    <div className="ai-next-steps-list">
                      {msg.nextSteps.map((step) => (
                        <button
                          key={step.id}
                          type="button"
                          className={`ai-next-step ${step.recommended ? "recommended" : ""}`}
                          onClick={() => props.onRunStep(step)}
                          title={step.action}
                        >
                          <span className="ai-next-step-id">{step.id}.</span>
                          <span className="ai-next-step-label">{step.label}</span>
                          {step.recommended ? <span className="ai-next-step-tag">Recommended</span> : null}
                        </button>
                      ))}
                    </div>
                  </details>
                ) : null}
                {msg.role === "assistant" && msg.steps?.length ? (
                  <div className="ai-steps">
                    {msg.steps.map((step, stepIdx) => (
                      <div key={`${idx}-${stepIdx}`} className={`ai-step ${step.kind}`}>
                        {step.kind}: {step.detail}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))
          ) : (
            <div className="muted">Ask about your model.</div>
          )}
        </div>
        <div
          className="ai-splitter"
          onPointerDown={(event) => {
            dragRef.current = { startY: event.clientY, startHeight: inputHeight };
            (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
          }}
        />
        <div className="ai-input" style={{ height: inputHeight }}>
          <textarea
            value={props.aiInput}
            onChange={(e) => props.onInputChange(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.shiftKey) {
                event.preventDefault();
                props.onSend();
              }
              if ((event.ctrlKey || event.metaKey) && event.key === "ArrowUp") {
                event.preventDefault();
                props.onCycleHistory("up");
              }
              if ((event.ctrlKey || event.metaKey) && event.key === "ArrowDown") {
                event.preventDefault();
                props.onCycleHistory("down");
              }
            }}
            placeholder="Type a prompt..."
          />
          <button type="button" onClick={props.onSend}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function AiMarkdown({ content }: { content: string }) {
  return (
    <div className="ai-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
