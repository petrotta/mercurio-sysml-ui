const AI_STORAGE_KEY = "mercurio.ai.endpoints";
const AI_CHAT_ENDPOINT_KEY = "mercurio.ai.chatEndpoint";
const AI_EMBED_ENDPOINT_KEY = "mercurio.ai.embedEndpoint";

function normalizeBaseUrl(url) {
  return (url || "").trim().replace(/\/+$/, "");
}

function loadEndpoints() {
  try {
    const raw = window.localStorage?.getItem(AI_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return [];
}

function saveEndpoints(endpoints) {
  window.localStorage?.setItem(AI_STORAGE_KEY, JSON.stringify(endpoints || []));
}

function ensureDefaultEndpoint() {
  const endpoints = loadEndpoints();
  if (endpoints.length) return endpoints;
  const defaultEndpoint = {
    id: `openai-${Date.now()}`,
    name: "OpenAI",
    type: "chat",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.1",
    apiKey: "",
  };
  const defaultEmbeddings = {
    id: `openai-embeddings-${Date.now() + 1}`,
    name: "OpenAI Embeddings",
    type: "embeddings",
    baseUrl: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    apiKey: "",
  };
  const list = [defaultEndpoint, defaultEmbeddings];
  saveEndpoints(list);
  return list;
}

function getActiveEndpointId(type) {
  const key = type === "embeddings" ? AI_EMBED_ENDPOINT_KEY : AI_CHAT_ENDPOINT_KEY;
  return window.localStorage?.getItem(key) || "";
}

function setActiveEndpointId(type, id) {
  const key = type === "embeddings" ? AI_EMBED_ENDPOINT_KEY : AI_CHAT_ENDPOINT_KEY;
  if (id) {
    window.localStorage?.setItem(key, id);
  } else {
    window.localStorage?.removeItem(key);
  }
}

function resolveActiveEndpoint(type) {
  const endpoints = loadEndpoints();
  if (!endpoints.length) return null;
  const activeId = getActiveEndpointId(type);
  if (activeId) {
    const match = endpoints.find((e) => e.id === activeId);
    if (match) return match;
  }
  return endpoints.find((e) => e.type === type) || endpoints[0];
}

async function testEndpoint(endpoint) {
  const baseUrl = normalizeBaseUrl(endpoint.baseUrl);
  if (!baseUrl) {
    throw new Error("Base URL is required");
  }
  if (!endpoint.model) {
    throw new Error("Model is required");
  }
  const headers = {
    "Content-Type": "application/json",
  };
  if (endpoint.apiKey) {
    headers.Authorization = `Bearer ${endpoint.apiKey}`;
  }
  if (endpoint.type === "embeddings") {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: endpoint.model,
        input: "ping",
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || response.statusText);
    }
    return true;
  }
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: endpoint.model,
      messages: [{ role: "user", content: "ping" }],
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return true;
}

async function sendChatMessage(endpoint, messages) {
  const baseUrl = normalizeBaseUrl(endpoint.baseUrl);
  const headers = {
    "Content-Type": "application/json",
  };
  if (endpoint.apiKey) {
    headers.Authorization = `Bearer ${endpoint.apiKey}`;
  }
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: endpoint.model,
      messages,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content ?? "";
  return content;
}

async function sendEmbeddings(endpoint, input) {
  const baseUrl = normalizeBaseUrl(endpoint.baseUrl);
  const headers = {
    "Content-Type": "application/json",
  };
  if (endpoint.apiKey) {
    headers.Authorization = `Bearer ${endpoint.apiKey}`;
  }
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: endpoint.model,
      input,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  const payload = await response.json();
  const data = payload?.data;
  if (!Array.isArray(data)) {
    throw new Error("Invalid embedding response");
  }
  return data.map((item) => item.embedding).filter(Boolean);
}

export {
  loadEndpoints,
  saveEndpoints,
  ensureDefaultEndpoint,
  resolveActiveEndpoint,
  setActiveEndpointId,
  getActiveEndpointId,
  testEndpoint,
  sendChatMessage,
  sendEmbeddings,
};
