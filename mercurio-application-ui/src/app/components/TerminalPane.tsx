import type { KeyboardEvent } from "react";
import type * as React from "react";

type TerminalPaneProps = {
  open: boolean;
  height: number;
  tabs: Array<{ id: string; title: string }>;
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onNewTab: () => void;
  onCloseTab: (id: string) => void;
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  lines: string[];
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  onAutocompleteEval: () => void;
  onHistoryUp: () => void;
  onHistoryDown: () => void;
  onClear: () => void;
};

export function TerminalPane({
  open,
  height,
  tabs,
  activeTabId,
  onSelectTab,
  onNewTab,
  onCloseTab,
  onResizeStart,
  lines,
  input,
  onInputChange,
  onSubmit,
  onClose,
  onAutocompleteEval,
  onHistoryUp,
  onHistoryDown,
  onClear,
}: TerminalPaneProps) {
  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") {
      event.preventDefault();
      onAutocompleteEval();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onSubmit();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onHistoryUp();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      onHistoryDown();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <section
      className="terminal-pane"
      aria-label="Terminal"
      style={{ height: `${height}px` }}
      onContextMenu={(event) => {
        event.preventDefault();
        onClear();
      }}
      title="Right-click to clear terminal"
    >
      <div className="terminal-resize-handle" onPointerDown={onResizeStart} />
      <div className="terminal-header">
        <div className="terminal-tabs">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`terminal-tab ${tab.id === activeTabId ? "active" : ""}`}
              onClick={() => onSelectTab(tab.id)}
            >
              <span className="terminal-tab-title">{tab.title}</span>
              <button
                type="button"
                className="terminal-tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
                title="Close terminal tab"
              >
                x
              </button>
            </div>
          ))}
          <button type="button" className="ghost terminal-new-tab" onClick={onNewTab} title="New terminal tab">
            +
          </button>
        </div>
        <button type="button" className="ghost terminal-hide" onClick={onClose}>
          Hide
        </button>
      </div>
      <div className="terminal-output">
        {lines.length ? (
          lines.map((line, index) => (
            <div key={`${line}-${index}`} className="terminal-line">
              {line}
            </div>
          ))
        ) : (
          <div className="terminal-line muted">Type `eval A.x` and press Enter.</div>
        )}
      </div>
      <div className="terminal-input-row">
        <span className="terminal-prompt">&gt;</span>
        <input
          type="text"
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="eval A.x"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
    </section>
  );
}
