import { formatFileDiagnostic } from "../compileShared";
import type { FileDiagnosticsBucket, FileDiagnosticView } from "../contracts";

type ModelErrorsPanelProps = {
  workspaceErrors: string[];
  fileDiagnostics: FileDiagnosticsBucket[];
  collapsedFiles: Record<string, boolean>;
  normalizePath: (path: string) => string;
  displayNameForPath: (path: string) => string;
  toggleFile: (path: string) => void;
  openDiagnostic: (path: string, diagnostic: FileDiagnosticView) => void;
  onMinimize: () => void;
};

export function ModelErrorsPanel({
  workspaceErrors,
  fileDiagnostics,
  collapsedFiles,
  normalizePath,
  displayNameForPath,
  toggleFile,
  openDiagnostic,
  onMinimize,
}: ModelErrorsPanelProps) {
  const hasWorkspaceErrors = workspaceErrors.length > 0;
  const hasFileDiagnostics = fileDiagnostics.length > 0;

  return (
    <div className="simple-right-section simple-right-tool-panel">
      <div className="panel-header">
        <strong>Model Errors</strong>
        <button type="button" className="ghost simple-panel-minimize" onClick={onMinimize} title="Minimize side panel">
          -
        </button>
      </div>
      <div className="simple-ui-scroll simple-error-list">
        {hasWorkspaceErrors ? (
          <div className="simple-error-section">
            <div className="simple-error-section-title">Workspace Issues ({workspaceErrors.length})</div>
            {workspaceErrors.map((message, index) => (
              <div key={`workspace:${index}`} className="simple-error-group">
                <div className="simple-error-message simple-error-static-message">{message}</div>
              </div>
            ))}
          </div>
        ) : null}
        {hasFileDiagnostics ? (
          <div className="simple-error-section">
            <div className="simple-error-section-title">Model Diagnostics ({fileDiagnostics.length})</div>
            {fileDiagnostics.map((entry) => {
              const normalizedPath = normalizePath(entry.path);
              const collapsed = !!collapsedFiles[normalizedPath];
              return (
                <div key={entry.path} className="simple-error-group">
                  <div className="simple-error-group-header">
                    <button type="button" className="ghost simple-error-toggle" onClick={() => toggleFile(entry.path)}>
                      {collapsed ? ">" : "v"}
                    </button>
                    <button
                      type="button"
                      className="ghost simple-error-path"
                      onClick={() => {
                        const first = entry.diagnostics[0];
                        if (first) openDiagnostic(entry.path, first);
                      }}
                      title={entry.path}
                    >
                      {displayNameForPath(entry.path)} ({entry.diagnostics.length})
                    </button>
                  </div>
                  {!collapsed ? entry.diagnostics.map((diagnostic, index) => (
                    <button
                      key={`${entry.path}:${index}`}
                      type="button"
                      className="ghost simple-error-message"
                      onClick={() => openDiagnostic(entry.path, diagnostic)}
                      title={formatFileDiagnostic(diagnostic)}
                    >
                      {formatFileDiagnostic(diagnostic)}
                    </button>
                  )) : null}
                </div>
              );
            })}
          </div>
        ) : null}
        {!hasWorkspaceErrors && !hasFileDiagnostics ? (
          <div className="muted">No model or workspace issues from latest compile.</div>
        ) : null}
      </div>
    </div>
  );
}
