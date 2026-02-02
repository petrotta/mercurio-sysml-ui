import {
  loadEndpoints,
  saveEndpoints,
  ensureDefaultEndpoint,
  resolveActiveEndpoint,
  setActiveEndpointId,
  testEndpoint,
} from "./ai.js";

export function initAiEndpoints(options) {
  const {
    elements,
    setStatus,
  } = options;
  const {
    listEl,
    nameEl,
    typeEl,
    baseEl,
    modelEl,
    tokenEl,
    saveBtn,
    deleteBtn,
    testBtn,
    newBtn,
  } = elements;

  let editId = "";
  const endpointStatus = new Map();

  const fillEditor = (id) => {
    const endpoints = loadEndpoints();
    const endpoint = endpoints.find((item) => item.id === id);
    if (!endpoint) {
      if (nameEl) nameEl.value = "";
      if (typeEl) typeEl.value = "chat";
      if (baseEl) baseEl.value = "https://api.openai.com/v1";
      if (modelEl) modelEl.value = "";
      if (tokenEl) tokenEl.value = "";
      return;
    }
    if (nameEl) nameEl.value = endpoint.name || "";
    if (typeEl) typeEl.value = endpoint.type || "chat";
    if (baseEl) baseEl.value = endpoint.baseUrl || "";
    if (modelEl) modelEl.value = endpoint.model || "";
    if (tokenEl) tokenEl.value = endpoint.apiKey || "";
  };

  const renderList = () => {
    if (!listEl) return;
    const endpoints = loadEndpoints();
    listEl.innerHTML = "";
    if (!endpoints.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "No endpoints configured.";
      listEl.appendChild(empty);
      return;
    }
    const activeChat = resolveActiveEndpoint("chat");
    const activeEmbed = resolveActiveEndpoint("embeddings");
    endpoints.forEach((endpoint) => {
      const row = document.createElement("div");
      row.className = `ai-endpoint-row${editId === endpoint.id ? " active" : ""}`;
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = endpoint.type === "embeddings" ? "ai-embed-selected" : "ai-chat-selected";
      radio.checked =
        (endpoint.type === "chat" && activeChat?.id === endpoint.id) ||
        (endpoint.type === "embeddings" && activeEmbed?.id === endpoint.id);
      radio.addEventListener("change", () => {
        setActiveEndpointId(endpoint.type, endpoint.id);
        renderList();
      });
      const info = document.createElement("div");
      info.innerHTML = `<div>${endpoint.name}</div><div class="ai-endpoint-url">${endpoint.baseUrl || ""}</div>`;
      const type = document.createElement("div");
      type.className = "ai-endpoint-type";
      type.textContent = endpoint.type;
      const status = document.createElement("div");
      const statusValue = endpointStatus.get(endpoint.id);
      status.className = `ai-endpoint-status ${statusValue === "pass" ? "pass" : statusValue === "fail" ? "fail" : ""}`;
      status.textContent = statusValue ? statusValue : "";
      row.appendChild(radio);
      row.appendChild(info);
      row.appendChild(type);
      row.appendChild(status);
      row.addEventListener("click", (event) => {
        if (event.target === radio) return;
        editId = endpoint.id;
        fillEditor(editId);
        renderList();
      });
      listEl.appendChild(row);
    });
  };

  const refresh = () => {
    const endpoints = ensureDefaultEndpoint();
    const activeChat = resolveActiveEndpoint("chat");
    editId = editId || activeChat?.id || endpoints[0]?.id || "";
    fillEditor(editId);
    renderList();
  };

  const upsert = () => {
    if (!nameEl || !typeEl || !baseEl || !modelEl) return;
    const endpoints = loadEndpoints();
    const nextId = editId && endpoints.some((item) => item.id === editId)
      ? editId
      : `endpoint-${Date.now()}`;
    const payload = {
      id: nextId,
      name: nameEl.value.trim() || "Endpoint",
      type: typeEl.value,
      baseUrl: baseEl.value.trim(),
      model: modelEl.value.trim(),
      apiKey: tokenEl?.value.trim() || "",
    };
    const updated = endpoints.filter((item) => item.id !== payload.id);
    updated.push(payload);
    saveEndpoints(updated);
    if (payload.type === "chat") {
      setActiveEndpointId("chat", payload.id);
    }
    if (payload.type === "embeddings") {
      setActiveEndpointId("embeddings", payload.id);
    }
    editId = payload.id;
    refresh();
    setStatus?.("Endpoint saved.");
  };

  const testCurrent = async () => {
    const endpoints = loadEndpoints();
    const endpoint = endpoints.find((item) => item.id === editId);
    if (!endpoint) return;
    setStatus?.("Testing endpoint...");
    try {
      await testEndpoint(endpoint);
      endpointStatus.set(editId, "pass");
      renderList();
      setStatus?.("Endpoint OK.");
    } catch (error) {
      endpointStatus.set(editId, "fail");
      renderList();
      setStatus?.(`Endpoint failed: ${error}`);
    }
  };

  const deleteCurrent = () => {
    if (!editId) return;
    const endpoints = loadEndpoints().filter((item) => item.id !== editId);
    saveEndpoints(endpoints);
    endpointStatus.delete(editId);
    editId = "";
    refresh();
    setStatus?.("Endpoint deleted.");
  };

  const bind = () => {
    saveBtn?.addEventListener("click", upsert);
    deleteBtn?.addEventListener("click", deleteCurrent);
    testBtn?.addEventListener("click", testCurrent);
    newBtn?.addEventListener("click", () => {
      editId = "";
      fillEditor("");
      renderList();
    });
  };

  return {
    refresh,
    bind,
  };
}
