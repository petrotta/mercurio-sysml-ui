import { callTool } from "../agentClient";
import type {
  ExpressionsToolView,
  ProjectElementPropertySectionsView,
  ProjectModelView,
  WorkspaceStartupSnapshotResult,
  WorkspaceSymbolSnapshotResult,
  WorkspaceTreeSnapshotResult,
} from "../contracts";

const PROJECT_ELEMENT_PROPERTIES_TIMEOUT_MS = 20000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function getProjectElementPropertySections(
  root: string,
  elementQualifiedName: string,
  filePath?: string | null,
  symbolKind?: string | null,
  sourceScope?: "project" | "library" | null,
): Promise<ProjectElementPropertySectionsView> {
  return withTimeout(
    callTool<ProjectElementPropertySectionsView>("core.get_project_element_property_sections@v1", {
      root,
      element_qualified_name: elementQualifiedName,
      file_path: filePath || null,
      symbol_kind: symbolKind || null,
      source_scope: sourceScope || null,
    }),
    PROJECT_ELEMENT_PROPERTIES_TIMEOUT_MS,
    "Loading property sections",
  );
}

export async function getProjectModel(root: string): Promise<ProjectModelView> {
  return callTool<ProjectModelView>("core.get_project_model@v1", { root });
}

export async function getDefaultStdlib(): Promise<string | null> {
  return callTool<string | null>("stdlib.get_default@v1", {});
}

export async function getExpressionsView(root: string, expression?: string | null): Promise<ExpressionsToolView> {
  return callTool<ExpressionsToolView>("core.get_expressions_view@v1", {
    root,
    expression: expression || null,
  });
}

export async function getWorkspaceSymbolSnapshot(
  root: string,
  hydrateLibrary = true,
): Promise<WorkspaceSymbolSnapshotResult> {
  return callTool<WorkspaceSymbolSnapshotResult>("core.get_workspace_symbol_snapshot@v1", {
    root,
    hydrate_library: hydrateLibrary,
  });
}

export async function getWorkspaceStartupSnapshot(
  root: string,
  hydrateLibrary = true,
  preferCache = true,
): Promise<WorkspaceStartupSnapshotResult> {
  return callTool<WorkspaceStartupSnapshotResult>("core.get_workspace_startup_snapshot@v1", {
    root,
    hydrate_library: hydrateLibrary,
    prefer_cache: preferCache,
  });
}

export async function getWorkspaceTreeSnapshot(
  root: string,
): Promise<WorkspaceTreeSnapshotResult> {
  return callTool<WorkspaceTreeSnapshotResult>("core.get_workspace_tree_snapshot@v1", {
    root,
  });
}
