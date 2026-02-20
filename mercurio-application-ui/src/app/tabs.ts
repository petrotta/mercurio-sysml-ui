import { DIAGRAM_TAB_PREFIX } from "./constants";
import type { OpenTab } from "./types";

export function makeDiagramTabId(filePath: string): string {
  return `${DIAGRAM_TAB_PREFIX}${filePath}`;
}

export function makeDiagramTabName(filePath: string): string {
  return `Diagram: ${filePath.split(/[\\/]/).pop() || "file"}`;
}

export function getTabIcon(tab: OpenTab): string {
  if (tab.kind === "ai") return "AI";
  if (tab.kind === "data") return "DT";
  if (tab.kind === "project-model") return "PM";
  if (tab.kind === "diagram") return "DG";
  if (tab.kind === "descriptor") return "PD";
  const ext = tab.path.split(".").pop()?.toLowerCase() || "";
  if (ext === "sysml") return "S";
  if (ext === "kerml") return "K";
  if (ext === "diagram") return "DG";
  if (ext === "json" || ext === "jsonld") return "{}";
  return "F";
}

export function getTabKindClass(tab: OpenTab): string {
  if (
    tab.kind === "ai" ||
    tab.kind === "data" ||
    tab.kind === "project-model" ||
    tab.kind === "diagram" ||
    tab.kind === "descriptor"
  ) {
    return tab.kind;
  }
  const ext = tab.path.split(".").pop()?.toLowerCase() || "";
  if (ext === "sysml") return "sysml";
  if (ext === "kerml") return "kerml";
  if (ext === "diagram") return "diagram";
  if (ext === "json" || ext === "jsonld") return "json";
  return "file";
}
