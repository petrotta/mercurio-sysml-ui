import { invoke } from "@tauri-apps/api/core";
import type { AiEndpoint, SymbolView } from "./types";

type EmbeddingsEndpoint = AiEndpoint;

export const resetRagIndex = () => {
  // no-op: backend owns cache now
};

export const updateRagIndexFromCompile = async (params: {
  rootPath: string;
  symbols: SymbolView[];
  parsedFiles: string[];
  endpoint: EmbeddingsEndpoint;
  setInfo?: (value: { count: number; indexing: boolean }) => void;
}) => {
  const { rootPath, symbols, parsedFiles, endpoint, setInfo } = params;
  if (!rootPath || !endpoint) return;
  setInfo?.({ count: 0, indexing: true });
  const result = await invoke<number>("rag_index_update", {
    payload: {
      root: rootPath,
      parsed_files: parsedFiles || [],
      symbols: symbols.map((symbol) => ({
        kind: symbol.kind,
        qualified_name: symbol.qualified_name || "",
        name: symbol.name,
        file_path: symbol.file_path,
        doc: symbol.doc || null,
        properties: (symbol.properties || []).map((prop: { label: string; value: any }) => ({
          label: prop.label,
          value: prop.value,
        })),
      })),
      endpoint: {
        url: endpoint.url,
        provider: endpoint.provider,
        model: endpoint.model || null,
        token: endpoint.token || null,
      },
    },
  });
  setInfo?.({ count: result || 0, indexing: false });
};

export const getRagContext = async (params: {
  rootPath: string;
  endpoint: EmbeddingsEndpoint;
  query: string;
}) => {
  const { rootPath, endpoint, query } = params;
  if (!rootPath || !endpoint) return "";
  const response = await invoke<{ context: string; count: number }>("rag_query", {
    payload: {
      root: rootPath,
      query,
      endpoint: {
        url: endpoint.url,
        provider: endpoint.provider,
        model: endpoint.model || null,
        token: endpoint.token || null,
      },
    },
  });
  return response?.context || "";
};
