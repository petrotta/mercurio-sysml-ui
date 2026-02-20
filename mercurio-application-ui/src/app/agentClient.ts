import { invoke } from "@tauri-apps/api/core";

type AgentMessage = { role: "user" | "assistant"; content: string };

export type AgentRequest = {
  url: string;
  provider: "openai" | "anthropic";
  model: string | null;
  token: string | null;
  root: string | null;
  messages: AgentMessage[];
  max_tokens?: number;
  enable_tools?: boolean;
};

export type AgentResponse = {
  message: string;
  steps?: Array<{ kind: string; detail: string }>;
  final_response?: { summary: string; next_steps: Array<{ id: string; label: string; recommended: boolean; action: string }> };
  final_error?: string | null;
};

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: unknown;
  read_only: boolean;
};

export type ToolCallResponse = {
  ok: boolean;
  result?: unknown;
  error?: string | null;
};

export const listTools = async () => {
  return invoke<ToolDefinition[]>("list_tools");
};

export const callTool = async <T = unknown>(tool: string, args: Record<string, unknown>) => {
  const response = await invoke<ToolCallResponse>("call_tool", {
    payload: { tool, args },
  });
  if (!response?.ok) {
    throw new Error(response?.error || `Tool call failed: ${tool}`);
  }
  return (response.result as T) ?? (null as T);
};

export const runAgent = async (request: AgentRequest) => {
  return invoke<AgentResponse>("ai_agent_run", {
    payload: {
      url: request.url,
      provider: request.provider,
      model: request.model,
      token: request.token,
      max_tokens: request.max_tokens ?? 512,
      root: request.root,
      enable_tools: request.enable_tools ?? true,
      messages: request.messages,
    },
  });
};
