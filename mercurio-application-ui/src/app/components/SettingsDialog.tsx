type ThemeMode = "dark" | "light";
type SettingsTab = "theme" | "ai" | "stdlib";

type Endpoint = {
  id: string;
  name: string;
  url: string;
  type: "chat" | "embeddings";
  provider: "openai" | "anthropic";
  model: string;
  token: string;
};

type EndpointDraft = {
  id?: string;
  name: string;
  url: string;
  type: "chat" | "embeddings";
  provider: "openai" | "anthropic";
  model: string;
  token: string;
};

type SettingsDialogProps = {
  open: boolean;
  onClose: () => void;
  appTheme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  settingsTab: SettingsTab;
  onSettingsTabChange: (tab: SettingsTab) => void;
  aiEndpoints: Endpoint[];
  endpointTestStatus: Record<string, string>;
  onEditEndpoint: (endpointId: string) => void;
  onDeleteEndpoint: (endpointId: string) => void;
  selectedChatEndpoint: string | null;
  onSelectedChatEndpointChange: (endpointId: string | null) => void;
  onTestEndpoint: (endpointId: string) => void;
  endpointDraft: EndpointDraft;
  onEndpointDraftChange: (draft: EndpointDraft) => void;
  onResetEndpointDraft: () => void;
  onSaveEndpointDraft: () => void;
  settingsDefaultStdlib: string;
  onSettingsDefaultStdlibChange: (stdlib: string) => void;
  settingsStdlibVersions: string[];
  settingsStdlibStatus: string;
  settingsStdlibBusy: boolean;
  onSaveDefaultStdlibSelection: () => void;
};

export function SettingsDialog(props: SettingsDialogProps) {
  return (
    <Modal open={props.open} onClose={props.onClose} ariaLabelledBy="settings-title">
        <div className="modal-header">
          <h3 id="settings-title">Settings</h3>
        </div>
        <div className="modal-body">
          <div className="settings-tabs">
            <button
              type="button"
              className={`settings-tab ${props.settingsTab === "theme" ? "active" : ""}`}
              onClick={() => props.onSettingsTabChange("theme")}
            >
              Theme
            </button>
            <button
              type="button"
              className={`settings-tab ${props.settingsTab === "ai" ? "active" : ""}`}
              onClick={() => props.onSettingsTabChange("ai")}
            >
              AI
            </button>
            <button
              type="button"
              className={`settings-tab ${props.settingsTab === "stdlib" ? "active" : ""}`}
              onClick={() => props.onSettingsTabChange("stdlib")}
            >
              Stdlib
            </button>
          </div>
          {props.settingsTab === "theme" ? (
            <div className="settings-panel">
              <div className="field">
                <span className="field-label">Theme</span>
                <div className="theme-toggle">
                  <button
                    type="button"
                    className={`theme-option ${props.appTheme === "dark" ? "active" : ""}`}
                    onClick={() => props.onThemeChange("dark")}
                  >
                    Dark
                  </button>
                  <button
                    type="button"
                    className={`theme-option ${props.appTheme === "light" ? "active" : ""}`}
                    onClick={() => props.onThemeChange("light")}
                  >
                    Light
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {props.settingsTab === "ai" ? (
            <div className="settings-panel project-properties-section">
              <div className="project-properties-title">AI Settings</div>
              <div className="endpoint-list">
                {props.aiEndpoints.length ? (
                  props.aiEndpoints.map((endpoint) => (
                    <div key={endpoint.id} className="endpoint-row">
                      <div className="endpoint-main">
                        <div className="endpoint-title">{endpoint.name}</div>
                        <div className="endpoint-meta">
                          {endpoint.provider.toUpperCase()} / {endpoint.type.toUpperCase()} / {endpoint.url}
                        </div>
                        {endpoint.model ? <div className="endpoint-meta">Model: {endpoint.model}</div> : null}
                        {props.endpointTestStatus[endpoint.id] ? (
                          <div
                            className={`endpoint-status ${
                              props.endpointTestStatus[endpoint.id].startsWith("pass")
                                ? "ok"
                                : props.endpointTestStatus[endpoint.id].startsWith("fail")
                                  ? "fail"
                                  : ""
                            }`}
                          >
                            {props.endpointTestStatus[endpoint.id]}
                          </div>
                        ) : null}
                      </div>
                      <div className="endpoint-actions">
                        <button type="button" className="ghost" onClick={() => props.onEditEndpoint(endpoint.id)}>
                          Edit
                        </button>
                        <button type="button" className="ghost" onClick={() => props.onDeleteEndpoint(endpoint.id)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="muted">No endpoints configured.</div>
                )}
              </div>
              <div className="endpoint-selectors">
                <label className="field">
                  <span className="field-label">Chat endpoint</span>
                  <div className="field-inline">
                    <select
                      value={props.selectedChatEndpoint || ""}
                      onChange={(event) => props.onSelectedChatEndpointChange(event.target.value || null)}
                    >
                      <option value="">None</option>
                      {props.aiEndpoints
                        .filter((endpoint) => endpoint.type === "chat")
                        .map((endpoint) => (
                          <option key={endpoint.id} value={endpoint.id}>
                            {endpoint.name}
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      className="ghost"
                      disabled={!props.selectedChatEndpoint}
                      onClick={() => props.selectedChatEndpoint && props.onTestEndpoint(props.selectedChatEndpoint)}
                    >
                      Test
                    </button>
                  </div>
                </label>
              </div>
              <div className="endpoint-form">
                <div className="endpoint-form-title">{props.endpointDraft.id ? "Edit endpoint" : "Add endpoint"}</div>
                <label className="field">
                  <span className="field-label">Name</span>
                  <input
                    value={props.endpointDraft.name}
                    onChange={(event) => props.onEndpointDraftChange({ ...props.endpointDraft, name: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">URL</span>
                  <input
                    value={props.endpointDraft.url}
                    onChange={(event) => props.onEndpointDraftChange({ ...props.endpointDraft, url: event.target.value })}
                    placeholder={
                      props.endpointDraft.provider === "anthropic"
                        ? "https://api.anthropic.com"
                        : "https://api.openai.com"
                    }
                  />
                </label>
                <label className="field">
                  <span className="field-label">Type</span>
                  <select
                    value={props.endpointDraft.type}
                    onChange={(event) =>
                      props.onEndpointDraftChange({
                        ...props.endpointDraft,
                        type: event.target.value as "chat" | "embeddings",
                      })
                    }
                  >
                    <option value="chat">Chat</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Provider</span>
                  <select
                    value={props.endpointDraft.provider}
                    onChange={(event) =>
                      props.onEndpointDraftChange({
                        ...props.endpointDraft,
                        provider: event.target.value as "openai" | "anthropic",
                      })
                    }
                  >
                    <option value="openai">OpenAI-compatible</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Model</span>
                  <input
                    value={props.endpointDraft.model}
                    onChange={(event) => props.onEndpointDraftChange({ ...props.endpointDraft, model: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Token</span>
                  <input
                    type="password"
                    value={props.endpointDraft.token}
                    onChange={(event) => props.onEndpointDraftChange({ ...props.endpointDraft, token: event.target.value })}
                  />
                </label>
                <div className="modal-actions">
                  <button type="button" className="ghost" onClick={props.onResetEndpointDraft}>
                    Clear
                  </button>
                  <button type="button" onClick={props.onSaveEndpointDraft}>
                    {props.endpointDraft.id ? "Update" : "Add"}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {props.settingsTab === "stdlib" ? (
            <div className="settings-panel project-properties-section">
              <div className="project-properties-title">Default Standard Library</div>
              <label className="field">
                <span className="field-label">Version</span>
                <select
                  value={props.settingsDefaultStdlib}
                  onChange={(event) => props.onSettingsDefaultStdlibChange(event.target.value)}
                >
                  <option value="">Auto (first installed)</option>
                  {props.settingsStdlibVersions.map((version) => (
                    <option key={version} value={version}>
                      {version}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field-hint">Used when project library mode is `default`.</div>
              {props.settingsStdlibStatus ? (
                <div className={`field-hint ${props.settingsStdlibStatus.startsWith("Failed") ? "error" : ""}`}>
                  {props.settingsStdlibStatus}
                </div>
              ) : null}
              <div className="modal-actions">
                <button type="button" onClick={props.onSaveDefaultStdlibSelection} disabled={props.settingsStdlibBusy}>
                  {props.settingsStdlibBusy ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={props.onClose}>
            Close
          </button>
        </div>
    </Modal>
  );
}
import { Modal } from "./Modal";
