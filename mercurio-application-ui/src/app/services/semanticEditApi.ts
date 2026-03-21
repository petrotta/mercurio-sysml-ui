import { invoke } from "@tauri-apps/api/core";
import type {
  SemanticEditAction,
  SemanticEditApplyResult,
  SemanticEditInputValues,
  SemanticEditPreviewResult,
  SemanticEditTargetWithLineage,
} from "../semanticEditTypes";

type ListActionsPayload = {
  target: SemanticEditTargetWithLineage;
};

type SemanticEditPayload = {
  root: string;
  target: SemanticEditTargetWithLineage;
  action_id: string;
  input: SemanticEditInputValues;
  current_text: string;
  conflict_policy?: "abort" | "skip" | "rebind_then_skip";
};

export async function listSemanticEditActions(target: SemanticEditTargetWithLineage): Promise<SemanticEditAction[]> {
  const actions = await invoke<SemanticEditAction[]>("list_semantic_edit_actions", {
    payload: { target } satisfies ListActionsPayload,
  });
  return actions || [];
}

export async function previewSemanticEdit(payload: SemanticEditPayload): Promise<SemanticEditPreviewResult> {
  return invoke<SemanticEditPreviewResult>("preview_semantic_edit", {
    payload,
  });
}

export async function applySemanticEdit(payload: SemanticEditPayload): Promise<SemanticEditApplyResult> {
  return invoke<SemanticEditApplyResult>("apply_semantic_edit", {
    payload,
  });
}
