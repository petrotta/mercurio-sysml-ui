import type { CompileToast } from "../useCompileRunner";

type ParseErrorsPanelProps = {
  compileToast: CompileToast;
  workspaceErrors: string[];
  collapsedParseErrorFiles: Record<string, boolean>;
  normalizePath: (path: string) => string;
  displayNameForPath: (path: string) => string;
  toggleParseErrorFile: (path: string) => void;
  openParseError: (path: string, message: string) => void;
};

export function ParseErrorsPanel({
  compileToast,
  workspaceErrors,
  collapsedParseErrorFiles,
  normalizePath,
  displayNameForPath,
  toggleParseErrorFile,
  openParseError,
}: ParseErrorsPanelProps) {
  const hasParseErrors = compileToast.parseErrors.length > 0;
  const hasWorkspaceErrors = workspaceErrors.length > 0;

  return (
    <div className="simple-right-section simple-right-bottom-section">
      <div className="panel-header"><strong>Diagnostics</strong></div>
      <div className="simple-ui-scroll simple-error-list">
        {hasWorkspaceErrors ? (
          <div className="simple-error-section">
            <div className="simple-error-section-title">Workspace Issues ({workspaceErrors.length})</div>
            {workspaceErrors.map((message, idx) => (
              <div key={`workspace:${idx}`} className="simple-error-group">
                <div className="simple-error-message simple-error-static-message">{message}</div>
              </div>
            ))}
          </div>
        ) : null}
        {hasParseErrors ? (
          <div className="simple-error-section">
            <div className="simple-error-section-title">Parse Errors ({compileToast.parseErrors.length})</div>
            {compileToast.parseErrors.slice(0, 30).map((entry) => {
              const normalizedPath = normalizePath(entry.path);
              const isCollapsed = !!collapsedParseErrorFiles[normalizedPath];
              const errors = entry.errors || [];
              const errorFile = displayNameForPath(entry.path);
              const displayPath = `${errorFile} (${errors.length})`;
              return (
                <div key={entry.path} className="simple-error-group">
                  <div className="simple-error-group-header">
                    <button
                      type="button"
                      className="ghost simple-error-toggle"
                      onClick={() => {
                        toggleParseErrorFile(entry.path);
                      }}
                      title={isCollapsed ? "Expand errors" : "Collapse errors"}
                      aria-label={isCollapsed ? "Expand errors" : "Collapse errors"}
                    >
                      {isCollapsed ? ">" : "v"}
                    </button>
                    <button
                      type="button"
                      className="ghost simple-error-path"
                      onClick={() => {
                        const first = errors[0] || "";
                        openParseError(entry.path, first);
                      }}
                      title={entry.path}
                    >
                      {displayPath}
                    </button>
                  </div>
                  {!isCollapsed ? errors.map((message, idx) => (
                    <button
                      key={`${entry.path}:${idx}`}
                      type="button"
                      className="ghost simple-error-message"
                      onClick={() => openParseError(entry.path, message)}
                      title={message}
                    >
                      {message}
                    </button>
                  )) : null}
                </div>
              );
            })}
          </div>
        ) : null}
        {!hasParseErrors && !hasWorkspaceErrors ? (
          <div className="muted">No parse or workspace errors from latest compile.</div>
        ) : null}
      </div>
    </div>
  );
}
