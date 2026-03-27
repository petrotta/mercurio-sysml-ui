import type { GitRepoInfo, GitStatus } from "../types";

type CommitManagerPanelProps = {
  rootPath: string;
  repoInfo: GitRepoInfo | null;
  status: GitStatus | null;
  loading: boolean;
  error: string;
  commitMessage: string;
  actionBusy: boolean;
  commitBusy: boolean;
  pushBusy: boolean;
  generateBusy: boolean;
  canGenerate: boolean;
  generateDisabledReason: string;
  onCommitMessageChange: (value: string) => void;
  onRefresh: () => void;
  onStagePaths: (paths: string[]) => void;
  onUnstagePaths: (paths: string[]) => void;
  onOpenPath: (path: string) => void;
  onCommit: () => void;
  onGenerateMessage: () => void;
  onPush: () => void;
  onMinimize: () => void;
};

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const path of paths) {
    const value = `${path || ""}`.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    next.push(value);
  }
  return next;
}

type CommitFileSectionProps = {
  title: string;
  paths: string[];
  emptyText: string;
  actionLabel: string;
  actionDisabled: boolean;
  onAction: (paths: string[]) => void;
  onOpenPath: (path: string) => void;
};

function CommitFileSection({
  title,
  paths,
  emptyText,
  actionLabel,
  actionDisabled,
  onAction,
  onOpenPath,
}: CommitFileSectionProps) {
  return (
    <section className="simple-cm-section">
      <div className="simple-cm-section-header">
        <strong>{title}</strong>
        <span className="muted">{paths.length}</span>
      </div>
      {paths.length ? (
        <div className="simple-cm-file-list">
          {paths.map((path) => (
            <div key={`${title}:${path}`} className="simple-cm-file-row">
              <button
                type="button"
                className="ghost simple-cm-file-open"
                onClick={() => onOpenPath(path)}
                title={path}
              >
                {path}
              </button>
              <button
                type="button"
                className="ghost"
                disabled={actionDisabled}
                onClick={() => onAction([path])}
              >
                {actionLabel}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="muted simple-cm-empty">{emptyText}</div>
      )}
    </section>
  );
}

export function CommitManagerPanel({
  rootPath,
  repoInfo,
  status,
  loading,
  error,
  commitMessage,
  actionBusy,
  commitBusy,
  pushBusy,
  generateBusy,
  canGenerate,
  generateDisabledReason,
  onCommitMessageChange,
  onRefresh,
  onStagePaths,
  onUnstagePaths,
  onOpenPath,
  onCommit,
  onGenerateMessage,
  onPush,
  onMinimize,
}: CommitManagerPanelProps) {
  const stagedPaths = uniquePaths(status?.staged || []);
  const unstagedPaths = uniquePaths(status?.unstaged || []);
  const untrackedPaths = uniquePaths(status?.untracked || []);
  const stageAllPaths = uniquePaths([...unstagedPaths, ...untrackedPaths]);
  const hasRepo = !!repoInfo;
  const canPush = !!repoInfo && repoInfo.branch !== "DETACHED" && !!repoInfo.remote_url && !pushBusy && !actionBusy;
  const canCommit = stagedPaths.length > 0 && !!commitMessage.trim() && !commitBusy && !actionBusy;

  return (
    <div className="simple-right-section simple-right-tool-panel">
      <div className="panel-header simple-properties-panel-header">
        <strong>Commit Manager</strong>
        <button type="button" className="ghost simple-panel-minimize" onClick={onMinimize} title="Minimize side panel">
          -
        </button>
      </div>
      <div className="simple-ui-scroll simple-cm-body">
        {!rootPath.trim() ? (
          <div className="muted">Select a project root to inspect git changes.</div>
        ) : loading ? (
          <div className="muted">Loading git status...</div>
        ) : !hasRepo ? (
          <div className="muted">No git repository detected for the current workspace.</div>
        ) : (
          <>
            <section className="simple-cm-summary-card">
              <div className="simple-cm-summary-row">
                <span className="muted">Branch</span>
                <strong>{repoInfo.branch}</strong>
              </div>
              <div className="simple-cm-summary-row">
                <span className="muted">Ahead / Behind</span>
                <span>{repoInfo.ahead} / {repoInfo.behind}</span>
              </div>
              <div className="simple-cm-summary-row">
                <span className="muted">Remote</span>
                <span title={repoInfo.remote_url || "No origin remote configured"}>
                  {repoInfo.remote_url || "No origin remote"}
                </span>
              </div>
              <div className="simple-cm-summary-row">
                <span className="muted">Repo</span>
                <span title={repoInfo.repo_root}>{repoInfo.repo_root}</span>
              </div>
            </section>

            <div className="simple-cm-actions">
              <button type="button" className="ghost" onClick={onRefresh} disabled={actionBusy || loading}>
                Refresh
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => onStagePaths(stageAllPaths)}
                disabled={!stageAllPaths.length || actionBusy}
              >
                Stage All
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => onUnstagePaths(stagedPaths)}
                disabled={!stagedPaths.length || actionBusy}
              >
                Unstage All
              </button>
            </div>

            <CommitFileSection
              title="Staged"
              paths={stagedPaths}
              emptyText="No staged files."
              actionLabel="Unstage"
              actionDisabled={actionBusy}
              onAction={onUnstagePaths}
              onOpenPath={onOpenPath}
            />
            <CommitFileSection
              title="Unstaged"
              paths={unstagedPaths}
              emptyText="No unstaged tracked files."
              actionLabel="Stage"
              actionDisabled={actionBusy}
              onAction={onStagePaths}
              onOpenPath={onOpenPath}
            />
            <CommitFileSection
              title="Untracked"
              paths={untrackedPaths}
              emptyText="No untracked files."
              actionLabel="Stage"
              actionDisabled={actionBusy}
              onAction={onStagePaths}
              onOpenPath={onOpenPath}
            />

            <section className="simple-cm-compose">
              <label className="simple-chat-composer">
                <span className="muted">Commit Message</span>
                <textarea
                  value={commitMessage}
                  onChange={(event) => onCommitMessageChange(event.target.value)}
                  placeholder="Enter a commit message."
                />
              </label>
              <div className="simple-cm-actions simple-cm-commit-actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={onGenerateMessage}
                  disabled={!canGenerate || generateBusy || !stagedPaths.length}
                  title={!canGenerate ? generateDisabledReason : "Generate a commit message from staged files"}
                >
                  {generateBusy ? "Generating..." : "Generate"}
                </button>
                <button type="button" onClick={onCommit} disabled={!canCommit}>
                  {commitBusy ? "Committing..." : "Commit"}
                </button>
                <button type="button" className="ghost" onClick={onPush} disabled={!canPush}>
                  {pushBusy ? "Pushing..." : "Push"}
                </button>
              </div>
              {!canGenerate ? <div className="muted simple-cm-help">{generateDisabledReason}</div> : null}
              {repoInfo.remote_url ? null : (
                <div className="muted simple-cm-help">Push requires an `origin` remote.</div>
              )}
            </section>
          </>
        )}
        {error ? <div className="simple-cm-error">{error}</div> : null}
      </div>
    </div>
  );
}
