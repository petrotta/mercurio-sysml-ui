type DataViewProps = {
  dataExcludeStdlib: boolean;
  onToggleExcludeStdlib: (value: boolean) => void;
  projectCounts: { fileCount: number; symbolCount: number };
  libraryCounts: { fileCount: number; symbolCount: number };
  errorCounts: { fileCount: number; symbolCount: number };
  dataViewSymbolKindCounts: Array<[string, number]>;
};

export function DataView({
  dataExcludeStdlib,
  onToggleExcludeStdlib,
  projectCounts,
  libraryCounts,
  errorCounts,
  dataViewSymbolKindCounts,
}: DataViewProps) {
  return (
    <div className="data-view">
      <div className="view-header">
        <div className="view-title">Data Analysis</div>
        <label className="view-toggle">
          <input
            type="checkbox"
            checked={dataExcludeStdlib}
            onChange={(event) => onToggleExcludeStdlib(event.target.checked)}
          />
          <span>Exclude stdlib</span>
        </label>
      </div>
      <div className="data-grid">
        <div className="data-card">
          <div className="data-card-label">Project</div>
          <div className="data-card-value">{projectCounts.fileCount} files / {projectCounts.symbolCount} symbols</div>
        </div>
        <div className="data-card">
          <div className="data-card-label">Library</div>
          <div className="data-card-value">{libraryCounts.fileCount} files / {libraryCounts.symbolCount} symbols</div>
        </div>
        <div className="data-card">
          <div className="data-card-label">Errors</div>
          <div className="data-card-value">{errorCounts.fileCount} files / {errorCounts.symbolCount} issues</div>
        </div>
      </div>
      <div className="data-section">
        <div className="data-section-title">Top symbol kinds</div>
        {dataViewSymbolKindCounts.length ? (
          <div className="data-list">
            {dataViewSymbolKindCounts.slice(0, 12).map(([kind, count]) => (
              <div key={kind} className="data-row">
                <span className="data-row-label">{kind}</span>
                <span className="data-row-value">{count}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted">No symbols yet.</div>
        )}
      </div>
    </div>
  );
}
