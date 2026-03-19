import { formatFileDiagnostic } from "../compileShared";
import type { CompileToast } from "../useCompileRunner";
import type { FileDiagnosticView } from "../contracts";

type ParseErrorsPanelProps = {
  compileToast: CompileToast;
  workspaceErrors: string[];
  collapsedParseErrorFiles: Record<string, boolean>;
  normalizePath: (path: string) => string;
  displayNameForPath: (path: string) => string;
  toggleParseErrorFile: (path: string) => void;
  openDiagnostic: (path: string, diagnostic: FileDiagnosticView) => void;
};

export function ParseErrorsPanel({
  compileToast,
  workspaceErrors,
  collapsedParseErrorFiles,
  normalizePath,
  displayNameForPath,
  toggleParseErrorFile,
  openDiagnostic,
}: ParseErrorsPanelProps) {
  const hasFileDiagnostics = compileToast.fileDiagnostics.length > 0;
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
        {hasFileDiagnostics ? (
          <div className="simple-error-section">
            <div className="simple-error-section-title">File Diagnostics ({compileToast.fileDiagnostics.length})</div>
            {compileToast.fileDiagnostics.slice(0, 30).map((entry) => {
              const normalizedPath = normalizePath(entry.path);
              const isCollapsed = !!collapsedParseErrorFiles[normalizedPath];
              const diagnostics = entry.diagnostics || [];
              const parseCount = diagnostics.filter((diagnostic) => diagnostic.source === "parse").length;
              const semanticCount = diagnostics.length - parseCount;
              const errorFile = displayNameForPath(entry.path);
              const parts: string[] = [];
              if (parseCount) parts.push(`${parseCount} parse`);
              if (semanticCount) parts.push(`${semanticCount} semantic`);
              const displayPath = `${errorFile} (${parts.join(", ") || diagnostics.length})`;
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
                        const first = diagnostics[0];
                        if (first) {
                          openDiagnostic(entry.path, first);
                        }
                      }}
                      title={entry.path}
                    >
                      {displayPath}
                    </button>
                  </div>
                  {!isCollapsed ? diagnostics.map((diagnostic, idx) => (
                    <button
                      key={`${entry.path}:${idx}`}
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
        {!hasFileDiagnostics && !hasWorkspaceErrors ? (
          <div className="muted">No file or workspace diagnostics from latest compile.</div>
        ) : null}
      </div>
    </div>
  );
}
