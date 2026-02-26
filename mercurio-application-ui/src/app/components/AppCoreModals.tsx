import { AstStatus } from "./AstStatus";
import { Modal } from "./Modal";
import { SettingsDialog } from "./SettingsDialog";

type AppCoreModalsProps = any;

export function AppCoreModals(props: AppCoreModalsProps) {
  return (
    <>
      <Modal open={props.showGotoDialog} onClose={() => props.setShowGotoDialog(false)} ariaLabelledBy="goto-qn-title">
        <div className="modal-header">
          <h3 id="goto-qn-title">Go to Qualified Name</h3>
        </div>
        <div className="modal-body goto-qn-body">
          <label className="field">
            <span className="field-label">Qualified name</span>
            <input
              ref={props.gotoInputRef}
              value={props.gotoQuery}
              onChange={(event) => props.setGotoQuery(event.target.value)}
              onKeyDown={props.handleGotoInputKeyDown}
              placeholder="Type a qualified name, e.g. Parts::Part"
              autoComplete="off"
            />
          </label>
          {props.gotoLoading ? <div className="muted">Loading semantic symbols...</div> : null}
          {!props.gotoLoading && props.gotoError ? <div className="field-hint error">{props.gotoError}</div> : null}
          {!props.gotoLoading && !props.gotoError ? (
            <div className="goto-qn-list" role="listbox" aria-label="Qualified name matches">
              {props.filteredGotoCandidates.length ? (
                props.filteredGotoCandidates.map((candidate: any, index: number) => {
                  const selected = index === props.gotoSelectedIndex;
                  return (
                    <button
                      key={`${candidate.qualified_name}|${candidate.file_path}`}
                      type="button"
                      className={`goto-qn-item ${selected ? "selected" : ""}`}
                      onClick={() => {
                        props.setGotoSelectedIndex(index);
                        void props.openGotoCandidate(candidate);
                      }}
                      onMouseEnter={() => props.setGotoSelectedIndex(index)}
                      title={candidate.file_path}
                    >
                      <span className="goto-qn-qualified">{candidate.qualified_name}</span>
                      <span className="goto-qn-path">{candidate.file_path}</span>
                    </button>
                  );
                })
              ) : (
                <div className="muted">No matching qualified names.</div>
              )}
            </div>
          ) : null}
        </div>
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={() => props.setShowGotoDialog(false)}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              void props.openGotoCandidate(props.selectedGotoCandidate);
            }}
            disabled={!props.selectedGotoCandidate}
          >
            Open
          </button>
        </div>
      </Modal>
      {props.showNewFile ? (
        <Modal open={props.showNewFile} onClose={() => props.setShowNewFile(false)}>
          <div className="modal-header">
            <span>New File</span>
            <button type="button" onClick={() => props.setShowNewFile(false)}>Close</button>
          </div>
          <div className="modal-body">
            <label className="field">
              <span>Name</span>
              <input value={props.newFileName} onChange={(e) => props.setNewFileName(e.target.value)} />
            </label>
            <label className="field">
              <span>Type</span>
              <select value={props.newFileType} onChange={(e) => props.setNewFileType(e.target.value)}>
                <option value="sysml">.sysml</option>
                <option value="kerml">.kerml</option>
                <option value="diagram">.diagram</option>
              </select>
            </label>
            <div className="field">
              <span>Parent</span>
              <div className="field-value">{props.newFileParent || props.rootPath || "-"}</div>
            </div>
          </div>
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={() => props.setShowNewFile(false)}>Cancel</button>
            <button type="button" onClick={props.createNewFile}>Create</button>
          </div>
        </Modal>
      ) : null}
      {props.showNewProject ? (
        <Modal open={props.showNewProject} onClose={() => props.setShowNewProject(false)}>
          <div className="modal-header">
            <span>New Project</span>
          </div>
          <div className="modal-body">
            <label className="field">
              <span>Location</span>
              <div className="field-inline">
                <input
                  value={props.newProjectLocation}
                  onChange={(event) => {
                    props.setNewProjectLocation(event.target.value);
                    void props.updateNewProjectFolderStatus();
                  }}
                />
                <button type="button" className="ghost" onClick={props.onBrowseNewProjectLocation}>
                  Browse
                </button>
              </div>
            </label>
            <label className="field">
              <span>Project Name</span>
              <input
                id="new-project-name"
                value={props.newProjectName}
                onChange={(event) => {
                  const value = event.target.value;
                  props.setNewProjectName(value);
                  const slug = props.slugifyProjectName(value);
                  props.setNewProjectFolder(slug);
                  void props.updateNewProjectFolderStatus();
                }}
                placeholder="My SysML Project"
              />
            </label>
            <label className="field">
              <span>Author</span>
              <input
                value={props.newProjectAuthor}
                onChange={(event) => props.setNewProjectAuthor(event.target.value)}
                placeholder="Your name"
              />
            </label>
            <label className="field">
              <span>Organization</span>
              <input
                value={props.newProjectOrganization}
                onChange={(event) => props.setNewProjectOrganization(event.target.value)}
                placeholder="Company or team"
              />
            </label>
            <label className="field">
              <span>Description</span>
              <input
                value={props.newProjectDescription}
                onChange={(event) => props.setNewProjectDescription(event.target.value)}
                placeholder="Short project summary"
              />
            </label>
            <label className="field">
              <span>Folder Name</span>
              <div className="field-value">{props.newProjectFolder}</div>
              <span className={`field-hint ${props.newProjectFolderStatus.includes("exists") ? "error" : ""}`}>{props.newProjectFolderStatus}</span>
            </label>
            <label className="field checkbox">
              <input
                type="checkbox"
                checked={props.newProjectDefaultLib}
                onChange={(event) => props.setNewProjectDefaultLib(event.target.checked)}
              />
              <span>Use default library</span>
            </label>
            {props.newProjectError ? <div className="field-hint error">{props.newProjectError}</div> : null}
          </div>
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={() => props.setShowNewProject(false)}>Cancel</button>
            <button type="button" onClick={props.createNewProject} disabled={props.newProjectBusy || !props.newProjectFolderAvailable}>Create Project</button>
          </div>
        </Modal>
      ) : null}
      {props.showOpenProject ? (
        <Modal open={props.showOpenProject} onClose={() => props.setShowOpenProject(false)}>
          <div className="modal-header">
            <span>Open Project</span>
          </div>
          <div className="modal-body">
            <label className="field">
              <span>Project folder</span>
              <div className="field-inline">
                <input
                  value={props.openProjectPath}
                  onChange={(event) => props.setOpenProjectPath(event.target.value)}
                  placeholder="Select a project directory"
                />
                <button type="button" className="ghost" onClick={props.browseOpenProject}>Browse</button>
              </div>
            </label>
            <label className="field">
              <span>Recent</span>
              {props.recentProjects.length ? (
                <>
                  <div className="open-project-recent-quick">
                    {props.recentProjects.slice(0, 3).map((path: string) => (
                      <button
                        key={path}
                        type="button"
                        className="ghost open-project-recent-btn"
                        onClick={() => props.setOpenProjectPath(path)}
                        title={path}
                      >
                        {path}
                      </button>
                    ))}
                  </div>
                  {props.recentProjects.length > 3 ? (
                    <select
                      className="open-project-recent-select"
                      value=""
                      onChange={(event) => {
                        const value = event.target.value;
                        if (value) props.setOpenProjectPath(value);
                      }}
                    >
                      <option value="">More recent...</option>
                      {props.recentProjects.slice(3).map((path: string) => (
                        <option key={path} value={path}>{path}</option>
                      ))}
                    </select>
                  ) : null}
                </>
              ) : (
                <div className="muted">No recent projects.</div>
              )}
            </label>
          </div>
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={() => props.setShowOpenProject(false)}>Cancel</button>
            <button type="button" onClick={props.confirmOpenProject} disabled={!props.openProjectPath.trim()}>Open</button>
          </div>
        </Modal>
      ) : null}
      {props.showExport ? (
        <Modal open={props.showExport} onClose={() => props.setShowExport(false)}>
          <div
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void props.runBuildWithOptions();
              }
            }}
          >
            <div className="modal-header">
              <span>Build Options</span>
              <button type="button" onClick={() => props.setShowExport(false)}>Close</button>
            </div>
            <div className="modal-body">
              <label className="field checkbox">
                <input
                  type="checkbox"
                  checked={props.exportAfterBuild}
                  onChange={(event) => props.setExportAfterBuild(event.target.checked)}
                />
                <span>Export model after build</span>
              </label>
              <label className="field">
                <span>Format</span>
                <select
                  value={props.exportFormat}
                  onChange={(event) => {
                    const next = event.target.value as "jsonld" | "kpar" | "xmi";
                    props.setExportFormat(next);
                    if (!props.exportPath || props.exportPath.includes("\\build\\")) {
                      props.setExportPath(props.getDefaultBuildPath(next));
                    }
                  }}
                  disabled={!props.exportAfterBuild}
                >
                  <option value="jsonld">JSON-LD</option>
                  <option value="kpar">KPAR</option>
                  <option value="xmi">XMI</option>
                </select>
              </label>
              <label className="field">
                <span>Output</span>
                <div className="field-inline">
                  <input
                    value={props.exportPath}
                    onChange={(event) => props.setExportPath(event.target.value)}
                    placeholder="Select output file"
                    disabled={!props.exportAfterBuild}
                  />
                  <button type="button" className="ghost" disabled={!props.exportAfterBuild} onClick={props.onBrowseExportPath}>
                    Browse
                  </button>
                </div>
              </label>
              <label className="field checkbox">
                <input
                  type="checkbox"
                  checked={props.exportIncludeStdlib}
                  onChange={(event) => props.setExportIncludeStdlib(event.target.checked)}
                  disabled={!props.exportAfterBuild}
                />
                <span>Include standard library</span>
              </label>
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => props.setShowExport(false)}>Cancel</button>
              <button type="button" onClick={props.runBuildWithOptions} disabled={props.exportBusy}>Build</button>
            </div>
          </div>
        </Modal>
      ) : null}
      <SettingsDialog
        open={props.showSettings}
        onClose={() => props.setShowSettings(false)}
        appTheme={props.appTheme}
        onThemeChange={props.setAppTheme}
        settingsTab={props.settingsTab}
        onSettingsTabChange={props.setSettingsTab}
        aiEndpoints={props.aiEndpoints}
        endpointTestStatus={props.endpointTestStatus}
        onEditEndpoint={props.editEndpoint}
        onDeleteEndpoint={props.deleteEndpoint}
        selectedChatEndpoint={props.selectedChatEndpoint}
        onSelectedChatEndpointChange={props.setSelectedChatEndpoint}
        onTestEndpoint={(endpointId) => {
          void props.testEndpoint(endpointId);
        }}
        endpointDraft={props.endpointDraft}
        onEndpointDraftChange={props.setEndpointDraft}
        onResetEndpointDraft={props.resetEndpointDraft}
        onSaveEndpointDraft={props.saveEndpointDraft}
        settingsDefaultStdlib={props.settingsDefaultStdlib}
        onSettingsDefaultStdlibChange={props.setSettingsDefaultStdlib}
        settingsStdlibVersions={props.settingsStdlibVersions}
        settingsStdlibStatus={props.settingsStdlibStatus}
        settingsStdlibBusy={props.settingsStdlibBusy}
        onSaveDefaultStdlibSelection={() => {
          void props.saveDefaultStdlibSelection();
        }}
      />
      <Modal open={props.showAbout} onClose={() => props.setShowAbout(false)} ariaLabelledBy="about-title">
        <div className="modal-header">
          <h3 id="about-title">About Mercurio</h3>
        </div>
        <div className="modal-body">
          <p className="about-text">
            Mercurio is a SysML/KerML workbench for editing, compiling, and exploring models with integrated analysis tools.
          </p>
          {props.aboutVersion ? <p className="about-text">Version: {props.aboutVersion}</p> : null}
          {props.aboutBuild ? <p className="about-text">Build: {props.aboutBuild}</p> : null}
          <p className="about-text">
            GitHub:{" "}
            <a className="about-link" href="https://github.com/petrotta/mercurio" target="_blank" rel="noreferrer">
              https://github.com/petrotta/mercurio
            </a>
          </p>
        </div>
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={() => props.setShowAbout(false)}>
            Close
          </button>
        </div>
      </Modal>
      <Modal open={props.astViewOpen} onClose={() => props.setAstViewOpen(false)} cardClassName="modal-wide ast-modal" ariaLabelledBy="ast-title">
        <div className="modal-header">
          <h3 id="ast-title">AST: {props.astViewTitle || "Untitled"}</h3>
          <button type="button" className="icon-button" onClick={() => props.setAstViewOpen(false)} aria-label="Close AST view" />
        </div>
        <div className="modal-body">
          <AstStatus state={props.astViewState} emptyFallback={<pre className="ast-content">(empty)</pre>}>
            <pre className="ast-content">{props.astViewState.content}</pre>
          </AstStatus>
        </div>
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={() => props.setAstViewOpen(false)}>
            Close
          </button>
        </div>
      </Modal>
    </>
  );
}
