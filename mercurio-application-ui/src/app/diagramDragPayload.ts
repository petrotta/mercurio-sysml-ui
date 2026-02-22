export type DiagramDragPayload = {
  qualified: string;
  name?: string;
  kind?: string;
};

let pendingPayload: DiagramDragPayload | null = null;

export const setPendingDiagramDragPayload = (payload: DiagramDragPayload | null) => {
  pendingPayload = payload;
};

export const getPendingDiagramDragPayload = (): DiagramDragPayload | null => pendingPayload;
