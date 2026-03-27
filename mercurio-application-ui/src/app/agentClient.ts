import { invoke } from "@tauri-apps/api/core";

type AgentMessage = { role: "user" | "assistant"; content: string };
export type AgentPlanStepStatus = "pending" | "in_progress" | "completed" | "blocked";
export type AgentPlanStep = { id: string; label: string; status: AgentPlanStepStatus };
export type AgentPlan = { goal: string; steps: AgentPlanStep[] };
export type AgentNextStep = { id: string; label: string; recommended: boolean; action: string };

export type AgentRequest = {
  session_id?: string | null;
  url: string;
  provider: "openai" | "azure" | "anthropic";
  model: string | null;
  token: string | null;
  root: string | null;
  messages: AgentMessage[];
  max_tokens?: number;
  enable_tools?: boolean;
};

export type AgentResponse = {
  session_id: string;
  message: string;
  steps?: Array<{ kind: string; detail: string }>;
  plan?: AgentPlan | null;
  final_response?: { summary: string; next_steps: AgentNextStep[]; plan?: AgentPlan | null };
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

export type AiEndpointTestRequest = {
  url: string;
  type: "chat" | "embeddings";
  provider: "openai" | "azure" | "anthropic";
  model: string | null;
  token: string | null;
};

export type AiEndpointTestResponse = {
  ok: boolean;
  status?: number;
  detail?: string;
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
      session_id: request.session_id,
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

export const testAiEndpoint = async (request: AiEndpointTestRequest) => {
  return invoke<AiEndpointTestResponse>("ai_test_endpoint", {
    payload: {
      url: request.url,
      type: request.type,
      provider: request.provider,
      model: request.model,
      token: request.token,
    },
  });
};
