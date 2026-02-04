type AiMessage = {
  role: "user" | "assistant";
  text: string;
  pendingId?: number;
  steps?: Array<{ kind: string; detail: string }>;
};

type AiViewProps = {
  aiMessages: AiMessage[];
  aiInput: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onOpenSettings: () => void;
};

export function AiView(props: AiViewProps) {
  return (
    <div className="ai-view">
      <div className="view-header">
        <div className="view-title">AI</div>
        <button type="button" className="ghost" onClick={props.onOpenSettings}>
          Settings
        </button>
      </div>
      <div className="ai-pane">
        <div className="ai-messages">
          {props.aiMessages.length ? (
            props.aiMessages.map((msg, idx) => (
              <div key={idx} className={`ai-message ${msg.role}`}>
                <div>{msg.text}</div>
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
        <div className="ai-input">
          <textarea
            value={props.aiInput}
            onChange={(e) => props.onInputChange(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.shiftKey) {
                event.preventDefault();
                props.onSend();
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
