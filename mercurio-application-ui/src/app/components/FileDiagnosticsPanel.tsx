import { formatFileDiagnostic } from "../compileShared";
import type { FileDiagnosticView } from "../contracts";

type FileDiagnosticsPanelProps = {
  filePath: string;
  diagnostics: FileDiagnosticView[];
  collapsed: boolean;
  displayNameForPath: (path: string) => string;
  onToggleCollapsed: () => void;
  openDiagnostic: (diagnostic: FileDiagnosticView) => void;
};

export function FileDiagnosticsPanel({
  filePath,
  diagnostics,
  collapsed,
  displayNameForPath,
  onToggleCollapsed,
  openDiagnostic,
}: FileDiagnosticsPanelProps) {
  if (!diagnostics.length) return null;

  return (
    <div className="simple-file-diagnostics">
      <div className="panel-header simple-file-diagnostics-header">
        <strong>Parse Errors</strong>
        <div className="simple-editor-meta">
          <span>{displayNameForPath(filePath)}</span>
          <span>{diagnostics.length}</span>
        </div>
        <button type="button" className="ghost" onClick={onToggleCollapsed}>
          {collapsed ? "Show" : "Hide"}
        </button>
      </div>
      {!collapsed ? (
        <div className="simple-ui-scroll simple-error-list">
          {diagnostics.map((diagnostic, index) => (
            <button
              key={`${filePath}:${index}`}
              type="button"
              className="ghost simple-error-message"
              onClick={() => openDiagnostic(diagnostic)}
              title={formatFileDiagnostic(diagnostic)}
            >
              {formatFileDiagnostic(diagnostic)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
