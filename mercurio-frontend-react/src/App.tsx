import "./style.css";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import MonacoEditor, { loader, type OnMount } from "@monaco-editor/react";
import { listen } from "@tauri-apps/api/event";
import { List, type ListImperativeAPI, type RowComponentProps } from "react-window";

loader.config({ paths: { vs: "/monaco/vs" } });

type FileEntry = {
  path: string;
  name: string;
  is_dir: boolean;
  is_parent?: boolean;
  is_action?: boolean;
};

const ROOT_STORAGE_KEY = "mercurio.rootPath";
const RECENTS_KEY = "mercurio.recentProjects";
const AI_ENDPOINTS_KEY = "mercurio.ai.endpoints";
const AI_CHAT_KEY = "mercurio.ai.chatEndpoint";
const AI_EMBEDDINGS_KEY = "mercurio.ai.embeddingsEndpoint";
const PROJECT_LOCATION_KEY = "mercurio.projectLocation";
const THEME_KEY = "mercurio.theme";
const PROJECT_DESCRIPTOR_TAB = "__project_descriptor__";
const AI_VIEW_TAB = "__view_ai__";
const DATA_VIEW_TAB = "__view_data__";
const DIAGRAM_TAB_PREFIX = "__diagram__::";

function loadRecents(): string[] {
  try {
    const raw = window.localStorage?.getItem(RECENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecents(list: string[]) {
  window.localStorage?.setItem(RECENTS_KEY, JSON.stringify(list));
}

export function App() {
  void getCurrentWindow();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [appTheme, setAppTheme] = useState<"dark" | "light">(
    (window.localStorage?.getItem(THEME_KEY) as "dark" | "light") || "dark",
  );
  const [leftWidth, setLeftWidth] = useState(240);
  const [rightWidth, setRightWidth] = useState(320);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const leftStoredWidthRef = useRef(240);
  const rightStoredWidthRef = useRef(320);
  const draggingRef = useRef<null | "left" | "right" | "model">(null);
  const startRef = useRef({ x: 0, y: 0, left: 240, right: 320, model: 260 });
  const [rootPath, setRootPath] = useState<string>(() => window.localStorage?.getItem(ROOT_STORAGE_KEY) || "");
  const [recentProjects, setRecentProjects] = useState<string[]>(() => loadRecents());
  const [treeEntries, setTreeEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, FileEntry[]>>({});
  const editorValueRef = useRef("");
  const editorChangeRafRef = useRef<number | null>(null);
  const [editorChangeTick, setEditorChangeTick] = useState(0);
  const [openTabs, setOpenTabs] = useState<Array<{
    path: string;
    name: string;
    dirty: boolean;
    kind?: "file" | "descriptor" | "diagram" | "ai" | "data";
    sourcePath?: string;
  }>>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [descriptorViewMode, setDescriptorViewMode] = useState<"view" | "json">("view");
  const [tabContent, setTabContent] = useState<Record<string, string>>({});
  const suppressDirtyRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry; scope: "root" | "node" } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [tabOverflowOpen, setTabOverflowOpen] = useState(false);
  const [showProjectInfo, setShowProjectInfo] = useState(false);
  const [hasProjectDescriptor, setHasProjectDescriptor] = useState(false);
  const [projectDescriptor, setProjectDescriptor] = useState<{
    name?: string | null;
    author?: string | null;
    description?: string | null;
    organization?: string | null;
    default_library: boolean;
    raw_json?: string;
  } | null>(null);
  const [showNewFile, setShowNewFile] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [newFileParent, setNewFileParent] = useState<string>("");
  const [newFileType, setNewFileType] = useState("sysml");
  const [showExport, setShowExport] = useState(false);
  const [exportFormat, setExportFormat] = useState<"jsonld" | "kpar" | "xmi">("jsonld");
  const [exportIncludeStdlib, setExportIncludeStdlib] = useState(true);
  const [exportPath, setExportPath] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showOpenProject, setShowOpenProject] = useState(false);
  const [openProjectPath, setOpenProjectPath] = useState("");
  const [newProjectLocation, setNewProjectLocation] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectFolder, setNewProjectFolder] = useState("");
  const [newProjectAuthor, setNewProjectAuthor] = useState("");
  const [newProjectDescription, setNewProjectDescription] = useState("");
  const [newProjectOrganization, setNewProjectOrganization] = useState("");
  const [newProjectFolderStatus, setNewProjectFolderStatus] = useState("");
  const [newProjectFolderAvailable, setNewProjectFolderAvailable] = useState(false);
  const [newProjectDefaultLib, setNewProjectDefaultLib] = useState(true);
  const [newProjectBusy, setNewProjectBusy] = useState(false);
  const [newProjectError, setNewProjectError] = useState("");
  const [centerView, setCenterView] = useState<"file" | "diagram" | "ai" | "data">("file");
  const [cursorPos, setCursorPos] = useState<{ line: number; col: number } | null>(null);
  const [aiInput, setAiInput] = useState("");
  const [aiMessages, setAiMessages] = useState<Array<{ role: "user" | "assistant"; text: string; pendingId?: number }>>([]);
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [aiEndpoints, setAiEndpoints] = useState<Array<{
    id: string;
    name: string;
    url: string;
    type: "chat" | "embeddings";
    model: string;
    token: string;
  }>>(() => {
    try {
      const raw = window.localStorage?.getItem(AI_ENDPOINTS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [selectedChatEndpoint, setSelectedChatEndpoint] = useState<string | null>(
    () => window.localStorage?.getItem(AI_CHAT_KEY) || null,
  );
  const [selectedEmbeddingsEndpoint, setSelectedEmbeddingsEndpoint] = useState<string | null>(
    () => window.localStorage?.getItem(AI_EMBEDDINGS_KEY) || null,
  );
  const [endpointDraft, setEndpointDraft] = useState<{
    id?: string;
    name: string;
    url: string;
    type: "chat" | "embeddings";
    model: string;
    token: string;
  }>({ name: "", url: "", type: "chat", model: "", token: "" });
  const [endpointTestStatus, setEndpointTestStatus] = useState<Record<string, string>>({});
  const aiRequestRef = useRef(0);
  const [, setCompileStatus] = useState("Background compile: idle");
  const [compileRunId, setCompileRunId] = useState<number | null>(null);
  const [compileToast, setCompileToast] = useState<{
    open: boolean;
    ok: boolean | null;
    lines: string[];
    parseErrors: Array<{ path: string; errors: string[] }>;
    details: string[];
    parsedFiles: string[];
  }>({
    open: false,
    ok: null,
    lines: [],
    parseErrors: [],
    details: [],
    parsedFiles: [],
  });
  const compileToastTimerRef = useRef<number | null>(null);
  const backgroundCompileRef = useRef<number | null>(null);
  const backgroundCompileTokenRef = useRef(0);
  const [backgroundCompileEnabled, setBackgroundCompileEnabled] = useState(true);
  const [projectSymbolsLoaded, setProjectSymbolsLoaded] = useState(false);
  const [dataExcludeStdlib, setDataExcludeStdlib] = useState(true);
  const [symbols, setSymbols] = useState<Array<{
    name: string;
    kind: string;
    file_path: string;
    qualified_name: string;
    file: number;
    start_line: number;
    start_col: number;
    end_line: number;
    end_col: number;
    doc?: string | null;
    properties: Array<{
      name: string;
      label: string;
      value: { type: "text"; value: string } | { type: "list"; items: string[] } | { type: "bool"; value: boolean } | { type: "number"; value: number };
      hint?: string | null;
      group?: string | null;
    }>;
  }>>([]);
  const [unresolved, setUnresolved] = useState<Array<{ file_path: string; message: string; line: number; column: number }>>([]);
  const [libraryPath, setLibraryPath] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<typeof symbols[number] | null>(null);
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [modelTreeHeight, setModelTreeHeight] = useState(260);
  const [modelTreeViewportHeight, setModelTreeViewportHeight] = useState(0);
  const [collapseAllModel, setCollapseAllModel] = useState(false);
  const [showPropertiesPane, setShowPropertiesPane] = useState(true);
  const [modelExpanded, setModelExpanded] = useState<Record<string, boolean>>({});
  const [modelSectionOpen, setModelSectionOpen] = useState({ project: true, library: true, errors: true });
  const modelTreeRef = useRef<HTMLDivElement | null>(null);
  const navReqRef = useRef(0);
  const pendingNavRef = useRef<{
    path: string;
    name?: string;
    selection?: { startLine: number; startCol: number; endLine: number; endCol: number };
  } | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const cursorListenerRef = useRef<null | { dispose: () => void }>(null);
  const parseReqRef = useRef(0);
  const pendingEditorContentRef = useRef<string | null>(null);
  const pendingEditorPathRef = useRef<string | null>(null);
    const editorOptions: Parameters<typeof MonacoEditor>[0]["options"] = {
      minimap: { enabled: false },
      fontSize: 14,
      fontFamily: "IBM Plex Mono, Consolas, 'Courier New', monospace",
      wordWrap: "on" as const,
      selectionHighlight: false,
      occurrencesHighlight: "off",
      automaticLayout: true,
    };
  const [diagramScale, setDiagramScale] = useState(1);
  const [diagramOffset, setDiagramOffset] = useState({ x: 0, y: 0 });
  const diagramPanRef = useRef<null | { x: number; y: number; startX: number; startY: number }>(null);
  const diagramBodyRef = useRef<HTMLDivElement | null>(null);
  const diagramViewportRef = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);
  const [diagramViewport, setDiagramViewport] = useState<{ x: number; y: number; width: number; height: number }>({
    x: 0,
    y: 0,
    width: 80,
    height: 60,
  });
  const [diagramNodeOffsets, setDiagramNodeOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const [diagramNodeSizes, setDiagramNodeSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [syncDiagramSelection, setSyncDiagramSelection] = useState(false);
  const diagramDragRef = useRef<null | {
    node: string;
    startX: number;
    startY: number;
    base: { x: number; y: number };
  }>(null);
  const diagramResizeRef = useRef<null | {
    node: string;
    startX: number;
    startY: number;
    base: { width: number; height: number };
  }>(null);
  const diagramBoundsRef = useRef<Record<string, { minX: number; maxX: number; minY: number; maxY: number }>>({});
  const diagramWorkerRef = useRef<Worker | null>(null);
  const diagramLayoutReqRef = useRef(0);
  const diagramRafRef = useRef<number | null>(null);
  const diagramPendingRef = useRef<{ offsets?: Record<string, { x: number; y: number }>; sizes?: Record<string, { width: number; height: number }> }>({});
  const diagramPanRafRef = useRef<number | null>(null);
  const diagramPanPendingRef = useRef<{ x: number; y: number } | null>(null);
  const [diagramLayout, setDiagramLayout] = useState<DiagramLayout | null>(null);
  const [palettePos, setPalettePos] = useState({ x: 16, y: 16 });
  const paletteDragRef = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);
  const [diagramManualNodes, setDiagramManualNodes] = useState<Array<{ id: string; type: string; name: string; x: number; y: number; width: number; height: number; pending: boolean }>>([]);
  const paletteCreateRef = useRef<null | { type: string; name: string; startX: number; startY: number }>(null);
  const [paletteGhost, setPaletteGhost] = useState<null | { x: number; y: number; type: string }>(null);
  const fsChangeTimerRef = useRef<number | null>(null);
  const draggedTabPathRef = useRef<string | null>(null);
  const activeTabMeta = useMemo(
    () => openTabs.find((tab) => tab.path === activeTabPath) || null,
    [openTabs, activeTabPath],
  );
  const activeEditorPath = useMemo(() => {
    if (!activeTabMeta) return null;
    if (activeTabMeta.path === PROJECT_DESCRIPTOR_TAB) return null;
    if (activeTabMeta.kind === "ai" || activeTabMeta.kind === "data" || activeTabMeta.kind === "diagram") return null;
    return activeTabMeta.path;
  }, [activeTabMeta]);
  const activeDiagramPath = useMemo(() => {
    if (activeTabMeta?.kind === "diagram") return activeTabMeta.sourcePath || null;
    return activeEditorPath;
  }, [activeTabMeta, activeEditorPath]);

  useEffect(() => {
    document.body.classList.toggle("theme-light", appTheme === "light");
    window.localStorage?.setItem(THEME_KEY, appTheme);
    if (monacoRef.current) {
      monacoRef.current.editor.setTheme(appTheme === "light" ? "vs" : "vs-dark");
    }
  }, [appTheme]);

  useEffect(() => {
    const onDocClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || !target.closest(".menu-button") && !target.closest(".menu-dropdown")) {
        setOpenMenu(null);
      }
      if (!target || !target.closest(".context-menu")) {
        setContextMenu(null);
      }
      if (!target || !target.closest(".tab-menu")) {
        setTabMenu(null);
      }
      if (!target || !target.closest(".tab-overflow")) {
        setTabOverflowOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  useEffect(() => {
    window.localStorage?.setItem(AI_ENDPOINTS_KEY, JSON.stringify(aiEndpoints));
  }, [aiEndpoints]);

  useEffect(() => {
    if (selectedChatEndpoint) {
      window.localStorage?.setItem(AI_CHAT_KEY, selectedChatEndpoint);
    } else {
      window.localStorage?.removeItem(AI_CHAT_KEY);
    }
  }, [selectedChatEndpoint]);

  useEffect(() => {
    if (selectedEmbeddingsEndpoint) {
      window.localStorage?.setItem(AI_EMBEDDINGS_KEY, selectedEmbeddingsEndpoint);
    } else {
      window.localStorage?.removeItem(AI_EMBEDDINGS_KEY);
    }
  }, [selectedEmbeddingsEndpoint]);

  useEffect(() => {
    const worker = new Worker(new URL("./diagramWorker.ts", import.meta.url), { type: "module" });
    diagramWorkerRef.current = worker;
    return () => {
      worker.terminate();
      diagramWorkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    setProjectSymbolsLoaded(false);
  }, [rootPath]);

  const rememberProjectLocation = (path: string) => {
    if (!path) return;
    window.localStorage?.setItem(PROJECT_LOCATION_KEY, path);
  };

  const getDefaultProjectLocation = async () => {
    const stored = window.localStorage?.getItem(PROJECT_LOCATION_KEY);
    if (stored) return stored;
    try {
      const base = await invoke<string>("get_user_projects_root");
      return base || "";
    } catch {
      return "";
    }
  };

  const slugifyProjectName = (name: string) => {
    return (name || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  };

  const openNewProjectDialog = async () => {
    setNewProjectName("");
    setNewProjectFolder("");
    setNewProjectAuthor("");
    setNewProjectDescription("");
    setNewProjectOrganization("");
    setNewProjectFolderStatus("");
    setNewProjectFolderAvailable(false);
    setNewProjectDefaultLib(true);
    setNewProjectError("");
    setNewProjectLocation(await getDefaultProjectLocation());
    setShowNewProject(true);
    setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>("#new-project-name");
      input?.focus();
    }, 0);
  };

  const openNewFileDialog = (parent?: string) => {
    setNewFileName("");
    setNewFileType("sysml");
    const normRoot = rootPath ? rootPath.replace(/[\\/]+/g, "\\").toLowerCase() : "";
    const normParent = parent ? parent.replace(/[\\/]+/g, "\\").toLowerCase() : "";
    const nextParent = normRoot && normParent && normParent.startsWith(normRoot) ? parent! : rootPath || "";
    setNewFileParent(nextParent);
    setShowNewFile(true);
  };

  const updateNewProjectFolderStatus = async (forceError = false) => {
    const location = newProjectLocation.trim();
    const folder = newProjectFolder.trim();
    if (!location || !folder) {
      setNewProjectFolderStatus("");
      setNewProjectFolderAvailable(false);
      return;
    }
    if (forceError) {
      setNewProjectFolderStatus("Folder already exists");
      setNewProjectFolderAvailable(false);
      return;
    }
    try {
      const projectPath = `${location}\\${folder}`.replace(/[\\/]+/g, "\\");
      const exists = await invoke<boolean>("path_exists", { path: projectPath });
      setNewProjectFolderStatus(exists ? "Folder already exists" : "Folder available");
      setNewProjectFolderAvailable(!exists);
    } catch {
      setNewProjectFolderStatus("");
      setNewProjectFolderAvailable(false);
    }
  };

  useEffect(() => {
    if (!showNewProject) return;
    const timer = window.setTimeout(() => {
      void updateNewProjectFolderStatus();
    }, 200);
    return () => window.clearTimeout(timer);
  }, [showNewProject, newProjectLocation, newProjectFolder]);

  const createNewProject = async () => {
    if (newProjectBusy) return;
    const location = newProjectLocation.trim();
    const name = newProjectName.trim();
    const folder = newProjectFolder.trim();
    if (!location || !name || !folder) {
      setNewProjectError("Enter location, project name, and folder name.");
      return;
    }
    const projectPath = `${location}\\${folder}`.replace(/[\\/]+/g, "\\");
    try {
      setNewProjectBusy(true);
      setNewProjectError("");
      const exists = await invoke<boolean>("path_exists", { path: projectPath });
      if (exists) {
        setNewProjectError("Project folder already exists.");
        setNewProjectFolderStatus("Folder already exists");
        setNewProjectFolderAvailable(false);
        setNewProjectBusy(false);
        return;
      }
      const descriptor = await invoke<{
        name?: string | null;
        author?: string | null;
        description?: string | null;
        organization?: string | null;
        default_library: boolean;
        raw_json?: string;
      }>("create_project_descriptor", {
        payload: {
          root: projectPath,
          name,
          author: newProjectAuthor.trim() || null,
          description: newProjectDescription.trim() || null,
          organization: newProjectOrganization.trim() || null,
          use_default_library: newProjectDefaultLib,
        },
      });
      setProjectDescriptor(descriptor || null);
      setHasProjectDescriptor(!!descriptor);
      rememberProjectLocation(location);
      setShowNewProject(false);
      setNewProjectBusy(false);
      try {
        await openProject(projectPath);
      } catch (error) {
        setNewProjectError(`Open project failed: ${String(error)}`);
      }
      openProjectDescriptorTab(descriptor || null);
      setCompileStatus("Project created");
    } catch (error) {
      setNewProjectBusy(false);
      setNewProjectError(`Create project failed: ${String(error)}`);
    }
  };

    useEffect(() => {
      const onMove = (event: PointerEvent) => {
      if (!draggingRef.current) return;
      const delta = event.clientX - startRef.current.x;
      if (draggingRef.current === "left") {
        setLeftWidth(Math.max(200, Math.min(420, startRef.current.left + delta)));
      } else if (draggingRef.current === "right") {
        const rightDelta = event.clientX - startRef.current.x;
        setRightWidth(Math.max(200, Math.min(900, startRef.current.right - rightDelta)));
      } else if (draggingRef.current === "model") {
        const deltaY = event.clientY - startRef.current.y;
        setModelTreeHeight(Math.max(140, Math.min(520, startRef.current.model + deltaY)));
      }
    };
    const onUp = () => {
      draggingRef.current = null;
      document.body.classList.remove("dragging");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    }, []);

  useEffect(() => {
    if (!rootPath) {
      setProjectDescriptor(null);
      setHasProjectDescriptor(false);
      return;
    }
      invoke<{
        name?: string | null;
        author?: string | null;
        description?: string | null;
        organization?: string | null;
        default_library: boolean;
        raw_json?: string;
      } | null>("get_project_descriptor", { root: rootPath })
        .then((descriptor) => {
          setProjectDescriptor(descriptor || null);
          setHasProjectDescriptor(!!descriptor);
        })
        .catch(() => {
          setProjectDescriptor(null);
          setHasProjectDescriptor(false);
        });
    }, [rootPath]);

  useEffect(() => {
    if (!rootPath) return;
    void runBackgroundCompile(rootPath);
  }, [rootPath, backgroundCompileEnabled]);

  useEffect(() => {
    const container = modelTreeRef.current;
    if (!container) return;
    const updateHeight = () => {
      setModelTreeViewportHeight(container.clientHeight);
    };
    updateHeight();
    const resizeObserver = new ResizeObserver(() => updateHeight());
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [modelTreeHeight, showPropertiesPane]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (diagramDragRef.current) {
        const { node, startX, startY, base } = diagramDragRef.current;
        const deltaX = event.clientX - startX;
        const deltaY = event.clientY - startY;
        const bounds = diagramBoundsRef.current[node];
        const nextX = base.x + deltaX;
        const nextY = base.y + deltaY;
        const clampedX = bounds ? Math.min(bounds.maxX, Math.max(bounds.minX, nextX)) : nextX;
        const clampedY = bounds ? Math.min(bounds.maxY, Math.max(bounds.minY, nextY)) : nextY;
        diagramPendingRef.current.offsets = {
          ...(diagramPendingRef.current.offsets || {}),
          [node]: { x: clampedX, y: clampedY },
        };
      }
      if (diagramResizeRef.current) {
        const { node, startX, startY, base } = diagramResizeRef.current;
        const deltaX = event.clientX - startX;
        const deltaY = event.clientY - startY;
        diagramPendingRef.current.sizes = {
          ...(diagramPendingRef.current.sizes || {}),
          [node]: {
            width: Math.max(120, base.width + deltaX),
            height: Math.max(60, base.height + deltaY),
          },
        };
      }
      if (diagramDragRef.current || diagramResizeRef.current) {
        if (diagramRafRef.current == null) {
          diagramRafRef.current = window.requestAnimationFrame(() => {
            const pending = diagramPendingRef.current;
            if (pending.offsets) {
              setDiagramNodeOffsets((prev) => ({ ...prev, ...pending.offsets }));
            }
            if (pending.sizes) {
              setDiagramNodeSizes((prev) => ({ ...prev, ...pending.sizes }));
            }
            diagramPendingRef.current = {};
            diagramRafRef.current = null;
          });
        }
      }
      if (paletteDragRef.current) {
        const deltaX = event.clientX - paletteDragRef.current.startX;
        const deltaY = event.clientY - paletteDragRef.current.startY;
        setPalettePos({
          x: paletteDragRef.current.baseX + deltaX,
          y: paletteDragRef.current.baseY + deltaY,
        });
      }
      if (paletteCreateRef.current) {
        setPaletteGhost({ x: event.clientX, y: event.clientY, type: paletteCreateRef.current.type });
      }
    };
    const onUp = () => {
      diagramDragRef.current = null;
      diagramResizeRef.current = null;
      diagramViewportRef.current = null;
      paletteDragRef.current = null;
      if (paletteCreateRef.current && diagramBodyRef.current) {
        const body = diagramBodyRef.current.getBoundingClientRect();
        const within =
          paletteGhost &&
          paletteGhost.x >= body.left &&
          paletteGhost.x <= body.right &&
          paletteGhost.y >= body.top &&
          paletteGhost.y <= body.bottom;
        if (within) {
          const x = (paletteGhost!.x - body.left - diagramOffset.x) / diagramScale;
          const y = (paletteGhost!.y - body.top - diagramOffset.y) / diagramScale;
          const tempId = crypto.randomUUID();
          const tempName = `temp-${paletteCreateRef.current!.name.toLowerCase()}`;
          setDiagramManualNodes((prev) => [
            ...prev,
            {
              id: tempId,
              type: paletteCreateRef.current!.type,
              name: tempName,
              x,
              y,
              width: 180,
              height: 120,
              pending: true,
            },
          ]);
          if (!rootPath || !activeTabPath) {
            setCompileStatus("Select a file before creating a package");
            setDiagramManualNodes((prev) => prev.filter((node) => node.id !== tempId));
          } else {
            invoke("create_package", {
              payload: {
                root: rootPath,
                file: activeTabPath,
                name: `Package_${Date.now()}`,
              },
            })
              .then(() => {
                setDiagramManualNodes((prev) => prev.filter((node) => node.id !== tempId));
                void runBackgroundCompile(rootPath);
              })
              .catch((error) => {
                setCompileStatus(`Create package failed: ${error}`);
                setDiagramManualNodes((prev) =>
                  prev.map((node) => (node.id === tempId ? { ...node, pending: false } : node)),
                );
              });
          }
        }
      }
      paletteCreateRef.current = null;
      setPaletteGhost(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const startDrag = (side: "left" | "right" | "model", event: React.PointerEvent) => {
    event.preventDefault();
    if (event.currentTarget && "setPointerCapture" in event.currentTarget) {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    }
    if (side === "left" && leftCollapsed) {
      setLeftCollapsed(false);
      setLeftWidth(leftStoredWidthRef.current || 240);
    }
    if (side === "right" && rightCollapsed) {
      setRightCollapsed(false);
      setRightWidth(rightStoredWidthRef.current || 320);
    }
    draggingRef.current = side;
    startRef.current = { x: event.clientX, y: event.clientY, left: leftWidth, right: rightWidth, model: modelTreeHeight };
    document.body.classList.add("dragging");
  };

  const refreshRoot = async (path: string) => {
    const entries = await invoke<FileEntry[]>("list_dir", { path });
    setTreeEntries(entries || []);
    setExpanded({});
  };

  const openProject = async (path: string) => {
    if (!path) return;
    if (compileRunId) {
      void invoke("cancel_compile", { run_id: compileRunId }).catch(() => {});
      setCompileRunId(null);
    }
    if (backgroundCompileRef.current) {
      void invoke("cancel_compile", { run_id: backgroundCompileRef.current }).catch(() => {});
      backgroundCompileRef.current = null;
    }
    backgroundCompileTokenRef.current += 1;
    closeAllTabs();
    setSelectedSymbol(null);
    setCenterView("file");
    setDescriptorViewMode("view");
    setProjectDescriptor(null);
    setHasProjectDescriptor(false);
    setRootPath(path);
    window.localStorage?.setItem(ROOT_STORAGE_KEY, path);
    const next = [path, ...recentProjects.filter((p) => p !== path)].slice(0, 8);
    setRecentProjects(next);
    saveRecents(next);
    await refreshRoot(path);
  };

  const chooseProject = () => {
    setOpenProjectPath("");
    setShowOpenProject(true);
  };

  const browseOpenProject = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string" && selected) {
      setOpenProjectPath(selected);
    }
  };

  const confirmOpenProject = async () => {
    const path = openProjectPath.trim();
    if (!path) return;
    await openProject(path);
    setShowOpenProject(false);
  };

  const toggleExpand = async (entry: FileEntry) => {
    if (!entry.is_dir) return;
    if (expanded[entry.path]) {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[entry.path];
        return next;
      });
      return;
    }
    const children = await invoke<FileEntry[]>("list_dir", { path: entry.path });
    setExpanded((prev) => ({ ...prev, [entry.path]: children || [] }));
  };

  const applyEditorSelection = (
    editor: Parameters<OnMount>[0],
    selection?: { startLine: number; startCol: number; endLine: number; endCol: number },
  ) => {
    if (!selection) return;
    editor.setSelection({
      startLineNumber: selection.startLine || 1,
      startColumn: selection.startCol || 1,
      endLineNumber: selection.endLine || selection.startLine || 1,
      endColumn: selection.endCol || selection.startCol || 1,
    });
    editor.revealLineInCenter(selection.startLine || 1);
  };

  const navigateTo = async (target: {
    path: string;
    name?: string;
    selection?: { startLine: number; startCol: number; endLine: number; endCol: number };
  }) => {
    setCenterView("file");
    const reqId = ++navReqRef.current;
    pendingNavRef.current = target;
    if (currentFilePath !== target.path) {
      const content = await invoke<string>("read_file", { path: target.path });
      if (reqId !== navReqRef.current) return;
        suppressDirtyRef.current = true;
        editorValueRef.current = content || "";
        if (editorRef.current && centerView === "file" && activeTabPath !== PROJECT_DESCRIPTOR_TAB) {
          editorRef.current.setValue(editorValueRef.current);
        } else {
          pendingEditorContentRef.current = editorValueRef.current;
          pendingEditorPathRef.current = target.path;
        }
      setCurrentFilePath(target.path);
      setActiveTabPath(target.path);
      setOpenTabs((prev) => {
        if (prev.some((tab) => tab.path === target.path)) return prev;
        const name = target.name || target.path.split(/[\\/]/).pop() || "Untitled";
        return [...prev, { path: target.path, name, dirty: false, kind: "file" }];
      });
      setTabContent((prev) => ({ ...prev, [target.path]: content || "" }));
    }
    if (reqId !== navReqRef.current) return;
    if (editorRef.current) {
      applyEditorSelection(editorRef.current, target.selection);
      editorRef.current.focus();
      pendingNavRef.current = null;
    }
  };

  const openFile = async (entry: FileEntry) => {
    if (entry.is_dir) {
      void toggleExpand(entry);
      return;
    }
    await navigateTo({ path: entry.path, name: entry.name });
  };

  const showContext = (event: React.MouseEvent, entry: FileEntry) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, entry, scope: "node" });
  };

  const showRootContext = (event: React.MouseEvent) => {
    if (!rootPath) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      scope: "root",
      entry: { name: rootPath.split(/[\\/]/).pop() || rootPath, path: rootPath, is_dir: true },
    });
  };

  const handleContextAction = async (action: string) => {
    const entry = contextMenu?.entry;
    if (!entry || !rootPath) return;
    if (action === "new-file") {
      openNewFileDialog(entry.is_dir ? entry.path : rootPath);
    } else if (action === "show-in-explorer") {
      await invoke("open_in_explorer", { path: entry.path });
    } else if (action === "open-project") {
      if (entry.is_dir) {
        await openProject(entry.path);
      }
    } else if (action === "new-folder") {
      const name = window.prompt("Folder name:");
      if (!name) return;
      const parent = entry.is_dir ? entry.path : rootPath;
      await invoke("create_dir", { root: rootPath, parent, name });
      await refreshRoot(rootPath);
    } else if (action === "rename") {
      const name = window.prompt("New name:", entry.name);
      if (!name) return;
      await invoke("rename_path", { root: rootPath, path: entry.path, new_name: name });
      await refreshRoot(rootPath);
    }
    setContextMenu(null);
  };

  const loadProjectInfo = async () => {
    if (!rootPath) return;
    try {
      const descriptor = await invoke<{
        name?: string | null;
        author?: string | null;
        description?: string | null;
        organization?: string | null;
        default_library: boolean;
        raw_json?: string;
      } | null>("get_project_descriptor", { root: rootPath });
      setProjectDescriptor(descriptor || null);
      setHasProjectDescriptor(!!descriptor);
    } catch {
      setProjectDescriptor(null);
      setHasProjectDescriptor(false);
    }
    openProjectDescriptorTab();
  };

  const createNewFile = async () => {
    if (!rootPath || !newFileName) return;
    const normRoot = rootPath.replace(/[\\/]+/g, "\\").toLowerCase();
    const parentCandidate = newFileParent || rootPath;
    const normParentCandidate = parentCandidate.replace(/[\\/]+/g, "\\").toLowerCase();
    const parent = normParentCandidate.startsWith(normRoot) ? parentCandidate : rootPath;
    const trimmed = newFileName.trim();
    const baseName = trimmed.split(/[\\/]/).pop() || trimmed;
    const extension = newFileType === "kerml" ? ".kerml" : ".sysml";
    const finalName = baseName.toLowerCase().endsWith(extension) ? baseName : `${baseName}${extension}`;
    await invoke("create_file", { root: rootPath, parent, name: finalName });
    setShowNewFile(false);
    setNewFileName("");
    await refreshRoot(rootPath);
  };

  const openExportDialog = () => {
    setExportFormat("jsonld");
    setExportIncludeStdlib(true);
    setExportPath("");
    setShowExport(true);
  };

  const runExportModel = async () => {
    if (!rootPath || !exportPath) {
      setCompileStatus("Export requires a project root and output path");
      return;
    }
    try {
      setExportBusy(true);
      await invoke("export_compiled_model", {
        payload: {
          root: rootPath,
          output: exportPath,
          format: exportFormat,
          include_stdlib: exportIncludeStdlib,
        },
      });
      setCompileStatus("Export complete");
      setShowExport(false);
    } catch (error) {
      setCompileStatus(`Export failed: ${error}`);
    } finally {
      setExportBusy(false);
    }
  };

  useEffect(() => {
    if (rootPath) {
      void refreshRoot(rootPath);
      void runBackgroundCompile(rootPath);
    }
  }, []);

  useEffect(() => {
    if (!rootPath) return;
    void invoke("set_watch_root", { root: rootPath }).catch(() => {});
  }, [rootPath]);

  useEffect(() => {
    const unlistenPromise = listen("fs-changed", () => {
      if (!rootPath) return;
      if (fsChangeTimerRef.current) {
        window.clearTimeout(fsChangeTimerRef.current);
      }
      fsChangeTimerRef.current = window.setTimeout(() => {
        fsChangeTimerRef.current = null;
        void refreshRoot(rootPath);
      }, 200);
    });
    return () => {
      if (fsChangeTimerRef.current) {
        window.clearTimeout(fsChangeTimerRef.current);
        fsChangeTimerRef.current = null;
      }
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [rootPath]);

  useEffect(() => {
    const unlistenPromise = listen<{
      run_id: number;
      stage: string;
      file?: string;
      index?: number;
      total?: number;
    }>("compile-progress", (event) => {
      const payload = event.payload;
      if (!payload) return;
      const stage = payload.stage || "running";
      if (payload.run_id && compileRunId && payload.run_id !== compileRunId) {
        return;
      }
      const detail = payload.file ? `${stage}: ${payload.file}` : stage;
      const prefix = compileRunId ? "Compile" : "Background compile";
      setCompileStatus(`${prefix}: ${detail}`);
      if (compileRunId && payload.run_id === compileRunId) {
        setCompileToast((prev) => ({ ...prev, open: true, lines: [...prev.lines, detail].slice(-8) }));
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [compileRunId]);

  const runCompile = async () => {
    if (!rootPath) return;
    if (backgroundCompileRef.current) {
      void invoke("cancel_compile", { run_id: backgroundCompileRef.current }).catch(() => {});
      backgroundCompileRef.current = null;
    }
    const runId = Date.now();
    setCompileRunId(runId);
    setCompileToast({ open: true, ok: null, lines: ["starting..."], parseErrors: [], details: [], parsedFiles: [] });
    setCompileStatus("Compile: starting...");
    try {
      const response = await invoke<{
        ok: boolean;
        files?: Array<{ path: string; ok: boolean; errors: string[]; symbol_count: number }>;
        parsed_files?: string[];
        parse_duration_ms?: number;
        analysis_duration_ms?: number;
        stdlib_duration_ms?: number;
        total_duration_ms?: number;
        stdlib_cache_hit?: boolean;
        symbols: Array<{
          name: string;
          kind: string;
          file_path: string;
          qualified_name: string;
          file: number;
          start_line: number;
          start_col: number;
          end_line: number;
          end_col: number;
          doc?: string | null;
          properties: Array<{
            name: string;
            label: string;
            value: { type: "text"; value: string } | { type: "list"; items: string[] } | { type: "bool"; value: boolean } | { type: "number"; value: number };
            hint?: string | null;
            group?: string | null;
          }>;
        }>;
        unresolved: Array<{ file_path: string; message: string; line: number; column: number }>;
        library_path?: string | null;
      }>("compile_workspace", {
        payload: {
          root: rootPath,
          run_id: runId,
          allow_parse_errors: true,
          unsaved: [],
        },
      });
      setSymbols(response?.symbols || []);
      setUnresolved(response?.unresolved || []);
      setLibraryPath(response?.library_path ?? null);
      setProjectSymbolsLoaded(true);
      setProjectSymbolsLoaded(true);
      setProjectSymbolsLoaded(true);
      const ok = !!response?.ok;
      const parseErrors = (response?.files || [])
        .filter((file) => !file.ok && file.errors && file.errors.length)
        .map((file) => ({ path: file.path, errors: file.errors }));
      const details: string[] = [];
      if (typeof response?.stdlib_cache_hit === "boolean") {
        details.push(`Stdlib: ${response.stdlib_cache_hit ? "cache hit" : "reloaded"}`);
      }
      if (typeof response?.stdlib_duration_ms === "number") {
        details.push(`Stdlib load: ${response.stdlib_duration_ms} ms`);
      }
      if (typeof response?.parse_duration_ms === "number") {
        details.push(`Parse: ${response.parse_duration_ms} ms`);
      }
      if (typeof response?.analysis_duration_ms === "number") {
        details.push(`Analysis: ${response.analysis_duration_ms} ms`);
      }
      if (typeof response?.total_duration_ms === "number") {
        details.push(`Total: ${response.total_duration_ms} ms`);
      }
      const parsedFiles = response?.parsed_files || [];
      if (parsedFiles.length) {
        details.push(`Files parsed: ${parsedFiles.length}`);
      }
      if (response?.symbols?.length != null) {
        details.push(`Symbols: ${response.symbols.length}`);
      }
      if (response?.unresolved?.length != null) {
        details.push(`Unresolved: ${response.unresolved.length}`);
      }
      setCompileStatus(ok ? "Compile: complete" : "Compile: finished with errors");
      setCompileToast((prev) => ({ ...prev, ok, open: true, parseErrors, details, parsedFiles }));
      if (ok) {
        if (compileToastTimerRef.current) {
          window.clearTimeout(compileToastTimerRef.current);
        }
        compileToastTimerRef.current = window.setTimeout(() => {
          setCompileToast((prev) => ({ ...prev, open: false }));
          compileToastTimerRef.current = null;
        }, 2000);
      }
    } catch (error) {
      setCompileStatus(`Compile: failed: ${error}`);
      setCompileToast((prev) => ({
        ...prev,
        ok: false,
        open: true,
        lines: [...prev.lines, `failed: ${String(error)}`].slice(-8),
      }));
    } finally {
      setCompileRunId(null);
    }
  };

  const cancelCompile = async () => {
    if (!compileRunId) return;
    await invoke("cancel_compile", { run_id: compileRunId });
    setCompileStatus("Compile: canceling...");
  };

  const runBackgroundCompile = async (path: string) => {
    if (!backgroundCompileEnabled || !path || compileRunId || backgroundCompileRef.current) return;
    const runId = Date.now();
    const token = backgroundCompileTokenRef.current;
    backgroundCompileRef.current = runId;
    setCompileStatus("Background compile: starting...");
    try {
      const response = await invoke<{
        ok: boolean;
        symbols: Array<{
          name: string;
          kind: string;
          file_path: string;
          qualified_name: string;
          file: number;
          start_line: number;
          start_col: number;
          end_line: number;
          end_col: number;
          doc?: string | null;
          properties: Array<{
            name: string;
            label: string;
            value: { type: "text"; value: string } | { type: "list"; items: string[] } | { type: "bool"; value: boolean } | { type: "number"; value: number };
            hint?: string | null;
            group?: string | null;
          }>;
        }>;
        unresolved: Array<{ file_path: string; message: string; line: number; column: number }>;
        library_path?: string | null;
      }>("compile_workspace", {
        payload: {
          root: path,
          run_id: runId,
          allow_parse_errors: true,
          unsaved: [],
        },
      });
      if (token !== backgroundCompileTokenRef.current || path !== rootPath) {
        return;
      }
      setSymbols(response?.symbols || []);
      setUnresolved(response?.unresolved || []);
      setLibraryPath(response?.library_path ?? null);
      setCompileStatus(response?.ok ? "Background compile: complete" : "Background compile: finished with errors");
    } catch (error) {
      if (token === backgroundCompileTokenRef.current) {
        setCompileStatus(`Background compile: failed: ${error}`);
      }
    } finally {
      if (token === backgroundCompileTokenRef.current) {
        backgroundCompileRef.current = null;
      }
    }
  };

  const runBackgroundCompileWithUnsaved = async (path: string, filePath: string, content: string) => {
    if (!backgroundCompileEnabled || !path || compileRunId || backgroundCompileRef.current) return;
    const runId = Date.now();
    const token = backgroundCompileTokenRef.current;
    backgroundCompileRef.current = runId;
    setCompileStatus("Background compile: starting...");
    try {
      const response = await invoke<{
        ok: boolean;
        symbols: Array<{
          name: string;
          kind: string;
          file_path: string;
          qualified_name: string;
          file: number;
          start_line: number;
          start_col: number;
          end_line: number;
          end_col: number;
          doc?: string | null;
          properties: Array<{
            name: string;
            label: string;
            value: { type: "text"; value: string } | { type: "list"; items: string[] } | { type: "bool"; value: boolean } | { type: "number"; value: number };
            hint?: string | null;
            group?: string | null;
          }>;
        }>;
        unresolved: Array<{ file_path: string; message: string; line: number; column: number }>;
        library_path?: string | null;
      }>("compile_workspace", {
        payload: {
          root: path,
          run_id: runId,
          allow_parse_errors: true,
          unsaved: [{ path: filePath, content }],
        },
      });
      if (token !== backgroundCompileTokenRef.current || path !== rootPath) {
        return;
      }
      setSymbols(response?.symbols || []);
      setUnresolved(response?.unresolved || []);
      setLibraryPath(response?.library_path ?? null);
      setCompileStatus(response?.ok ? "Background compile: complete" : "Background compile: finished with errors");
    } catch (error) {
      if (token === backgroundCompileTokenRef.current) {
        setCompileStatus(`Background compile: failed: ${error}`);
      }
    } finally {
      if (token === backgroundCompileTokenRef.current) {
        backgroundCompileRef.current = null;
      }
    }
  };

  const handleEditorMount: OnMount = (editorInstance, monaco) => {
    editorRef.current = editorInstance;
    monacoRef.current = monaco;
    if (cursorListenerRef.current) {
      cursorListenerRef.current.dispose();
      cursorListenerRef.current = null;
    }
    cursorListenerRef.current = editorInstance.onDidChangeCursorPosition((event) => {
      setCursorPos({ line: event.position.lineNumber, col: event.position.column });
    });
    const initialPos = editorInstance.getPosition();
    if (initialPos) {
      setCursorPos({ line: initialPos.lineNumber, col: initialPos.column });
    }
    if (pendingEditorContentRef.current && (!pendingEditorPathRef.current || pendingEditorPathRef.current === currentFilePath)) {
      editorInstance.setValue(pendingEditorContentRef.current);
      pendingEditorContentRef.current = null;
      pendingEditorPathRef.current = null;
    }
    if (pendingNavRef.current && pendingNavRef.current.path === currentFilePath) {
      applyEditorSelection(editorInstance, pendingNavRef.current.selection);
      editorInstance.focus();
      pendingNavRef.current = null;
    }
    if (monaco.languages.getLanguages().some((lang) => lang.id === "sysml")) return;
    monaco.languages.register({ id: "sysml" });
    monaco.languages.setMonarchTokensProvider("sysml", {
      keywords: [
        "package",
        "import",
        "part",
        "item",
        "action",
        "port",
        "attribute",
        "connection",
        "interface",
        "allocation",
        "requirement",
        "constraint",
        "state",
        "calculation",
        "usecase",
        "analysis",
        "concern",
        "view",
        "viewpoint",
        "rendering",
        "enum",
        "definition",
        "def",
        "usage",
        "alias",
        "private",
        "public",
        "specializes",
        "subsets",
        "redefines",
        "satisfies",
        "perform",
        "performs",
        "exhibits",
        "include",
        "assert",
        "verify",
      ],
      typeKeywords: ["Boolean", "Integer", "Real", "String", "Natural"],
      operators: [":", "::", "=", "->", "<-", ":>", ":>>", "::>"],
      tokenizer: {
        root: [
          [/[a-zA-Z_][\w$]*/, {
            cases: {
              "@keywords": "keyword",
              "@typeKeywords": "type",
              "@default": "identifier",
            },
          }],
          { include: "@whitespace" },
          [/\d+\.?\d*/, "number"],
          [/\"([^\"\\]|\\.)*$/, "string.invalid"],
          [/\"/, { token: "string.quote", bracket: "@open", next: "@string" }],
          [/[{}()[\]]/, "@brackets"],
          [/[;,.]/, "delimiter"],
          [/(::>|\:>>|\:>|\:\:|->|<-|=|:)/, "operator"],
        ],
        whitespace: [
          [/[ \t\r\n]+/, "white"],
          [/\/\/.*$/, "comment"],
          [/\/\*/, { token: "comment", next: "@comment" }],
        ],
        comment: [
          [/[^/*]+/, "comment"],
          [/\*\//, { token: "comment", next: "@pop" }],
          [/[/\*]/, "comment"],
        ],
        string: [
          [/[^\\"]+/, "string"],
          [/\\./, "string.escape"],
          [/\"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
        ],
      },
    });
    monaco.editor.setTheme(appTheme === "light" ? "vs" : "vs-dark");
    editorInstance.focus();
  };

  useEffect(() => {
    if (!activeEditorPath) return;
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    const model = editor.getModel();
    if (!model) return;
    const reqId = ++parseReqRef.current;
    const timer = window.setTimeout(() => {
      invoke<{
        path: string;
        errors: Array<{ message: string; line: number; column: number; kind: string }>;
      }>("get_parse_errors_for_content", { path: activeEditorPath, content: editorValueRef.current })
        .then((payload) => {
          if (reqId !== parseReqRef.current) return;
          const markers = (payload?.errors || []).map((err) => ({
            severity: monaco.MarkerSeverity.Error,
            message: err.message,
            startLineNumber: err.line || 1,
            startColumn: err.column || 1,
            endLineNumber: err.line || 1,
            endColumn: (err.column || 1) + 1,
          }));
          monaco.editor.setModelMarkers(model, "sysml-parse", markers);
        })
        .catch(() => {
          if (reqId !== parseReqRef.current) return;
          monaco.editor.setModelMarkers(model, "sysml-parse", []);
        });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [editorChangeTick, activeEditorPath]);

  useEffect(() => {
    if (!rootPath || !activeEditorPath) return;
    const timer = window.setTimeout(() => {
      void runBackgroundCompileWithUnsaved(rootPath, activeEditorPath, editorValueRef.current);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [editorChangeTick, activeEditorPath, rootPath]);

  const selectSymbolInEditor = async (symbol: typeof symbols[number]) => {
    if (!symbol) return;
    if (symbol.name?.startsWith("<anon")) return;
    if (!symbol.file_path) return;
    const startLine = (symbol.start_line ?? 0) + 1;
    const startCol = (symbol.start_col ?? 0) + 1;
    const endLine = (symbol.end_line ?? symbol.start_line ?? 0) + 1;
    const endCol = (symbol.end_col ?? symbol.start_col ?? 0) + 1;
    await navigateTo({
      path: symbol.file_path,
      name: symbol.file_path.split(/[\\/]/).pop() || "Untitled",
      selection: {
        startLine,
        startCol,
        endLine,
        endCol,
      },
    });
  };

  const openProjectDescriptorTab = (descriptor?: {
    name?: string | null;
    author?: string | null;
    description?: string | null;
    organization?: string | null;
    default_library: boolean;
    raw_json?: string;
  } | null) => {
    if (descriptor) {
      setProjectDescriptor(descriptor);
      setHasProjectDescriptor(true);
    }
    setCenterView("file");
    setShowProjectInfo(true);
    setDescriptorViewMode("view");
    setOpenTabs((prev) => {
      if (prev.some((tab) => tab.path === PROJECT_DESCRIPTOR_TAB)) return prev;
      return [...prev, { path: PROJECT_DESCRIPTOR_TAB, name: "Project Descriptor", dirty: false, kind: "descriptor" }];
    });
    setActiveTabPath(PROJECT_DESCRIPTOR_TAB);
  };

  const selectTab = async (path: string) => {
    if (path === activeTabPath) return;
    const tab = openTabs.find((entry) => entry.path === path);
    if (path === PROJECT_DESCRIPTOR_TAB || tab?.kind === "descriptor") {
      setCenterView("file");
      setDescriptorViewMode("view");
      setActiveTabPath(PROJECT_DESCRIPTOR_TAB);
      return;
    }
    if (tab?.kind === "ai") {
      setCenterView("ai");
      setActiveTabPath(tab.path);
      return;
    }
    if (tab?.kind === "data") {
      setCenterView("data");
      setActiveTabPath(tab.path);
      return;
    }
    if (tab?.kind === "diagram") {
      setCenterView("diagram");
      setActiveTabPath(tab.path);
      return;
    }
    setCenterView("file");
    await navigateTo({ path });
  };

  const openAiViewTab = () => {
    setOpenTabs((prev) => {
      if (prev.some((tab) => tab.path === AI_VIEW_TAB)) return prev;
      return [...prev, { path: AI_VIEW_TAB, name: "AI", dirty: false, kind: "ai" }];
    });
    setActiveTabPath(AI_VIEW_TAB);
    setCenterView("ai");
  };

  const openDataViewTab = () => {
    setOpenTabs((prev) => {
      if (prev.some((tab) => tab.path === DATA_VIEW_TAB)) return prev;
      return [...prev, { path: DATA_VIEW_TAB, name: "Data", dirty: false, kind: "data" }];
    });
    setActiveTabPath(DATA_VIEW_TAB);
    setCenterView("data");
  };

  const openDiagramViewTab = (filePath: string) => {
    if (!filePath || filePath === PROJECT_DESCRIPTOR_TAB) return;
    const id = `${DIAGRAM_TAB_PREFIX}${filePath}`;
    const name = `Diagram: ${filePath.split(/[\\/]/).pop() || "file"}`;
    setOpenTabs((prev) => {
      if (prev.some((tab) => tab.path === id)) return prev;
      return [...prev, { path: id, name, dirty: false, kind: "diagram", sourcePath: filePath }];
    });
    setActiveTabPath(id);
    setCenterView("diagram");
  };

  const tabIcon = (tab: (typeof openTabs)[number]) => {
    if (tab.kind === "ai") return "AI";
    if (tab.kind === "data") return "DT";
    if (tab.kind === "diagram") return "DG";
    if (tab.kind === "descriptor") return "PD";
    const ext = tab.path.split(".").pop()?.toLowerCase() || "";
    if (ext === "sysml") return "S";
    if (ext === "kerml") return "K";
    if (ext === "json" || ext === "jsonld") return "{}";
    return "F";
  };

  const tabKindClass = (tab: (typeof openTabs)[number]) => {
    if (tab.kind === "ai" || tab.kind === "data" || tab.kind === "diagram" || tab.kind === "descriptor") {
      return tab.kind;
    }
    const ext = tab.path.split(".").pop()?.toLowerCase() || "";
    if (ext === "sysml") return "sysml";
    if (ext === "kerml") return "kerml";
    if (ext === "json" || ext === "jsonld") return "json";
    return "file";
  };

  const reorderTabs = (fromPath: string, toPath: string) => {
    if (!fromPath || !toPath || fromPath === toPath) return;
    setOpenTabs((prev) => {
      const fromIndex = prev.findIndex((tab) => tab.path === fromPath);
      const toIndex = prev.findIndex((tab) => tab.path === toPath);
      if (fromIndex < 0 || toIndex < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  useEffect(() => {
    if (!currentFilePath || !editorRef.current) return;
    const pending = pendingNavRef.current;
    if (!pending || pending.path !== currentFilePath) return;
    pendingNavRef.current = null;
    applyEditorSelection(editorRef.current, pending.selection);
    editorRef.current.focus();
  }, [currentFilePath]);

  useEffect(() => {
    if (centerView !== "file" || !activeEditorPath) {
      setCursorPos(null);
      return;
    }
    const editor = editorRef.current;
    if (!editor) return;
    const pos = editor.getPosition();
    if (pos) {
      setCursorPos({ line: pos.lineNumber, col: pos.column });
    }
  }, [activeEditorPath, centerView]);

  const closeTab = (path: string) => {
    navReqRef.current += 1;
    pendingNavRef.current = null;
    setOpenTabs((prev) => prev.filter((tab) => tab.path !== path));
    if (path === PROJECT_DESCRIPTOR_TAB) {
      setShowProjectInfo(false);
    }
    if (activeTabPath === path) {
      const remaining = openTabs.filter((tab) => tab.path !== path);
      const next = remaining[remaining.length - 1];
      if (next) {
        void selectTab(next.path);
      } else {
        setActiveTabPath(null);
        setCenterView("file");
        editorValueRef.current = "";
        if (editorRef.current) {
          editorRef.current.setValue("");
        }
        setCurrentFilePath(null);
      }
    }
    if (selectedSymbol && selectedSymbol.file_path === path) {
      setSelectedSymbol(null);
    }
  };

  const closeAllTabs = () => {
    navReqRef.current += 1;
    pendingNavRef.current = null;
    setOpenTabs([]);
    setActiveTabPath(null);
    setCenterView("file");
    editorValueRef.current = "";
    if (editorRef.current) {
      editorRef.current.setValue("");
    }
    setCurrentFilePath(null);
  };

  const closeOtherTabs = (path: string) => {
    navReqRef.current += 1;
    pendingNavRef.current = null;
    const kept = openTabs.find((tab) => tab.path === path);
    if (!kept) return;
    setOpenTabs([kept]);
    setActiveTabPath(path);
    if (path === PROJECT_DESCRIPTOR_TAB) {
      setShowProjectInfo(true);
      setCenterView("file");
      setDescriptorViewMode("view");
      return;
    }
    if (kept.kind === "ai") {
      setCenterView("ai");
      return;
    }
    if (kept.kind === "data") {
      setCenterView("data");
      return;
    }
    if (kept.kind === "diagram") {
      setCenterView("diagram");
      return;
    }
    setCenterView("file");
  };

  const saveActiveTab = async () => {
    if (!activeEditorPath) return;
    await invoke("write_file", { path: activeEditorPath, content: editorValueRef.current });
    setOpenTabs((prev) => prev.map((tab) => (tab.path === activeEditorPath ? { ...tab, dirty: false } : tab)));
    setTabContent((prev) => ({ ...prev, [activeEditorPath]: editorValueRef.current }));
  };

  useEffect(() => {
    if (!activeEditorPath) return;
    if (suppressDirtyRef.current) {
      suppressDirtyRef.current = false;
      setOpenTabs((prev) =>
        prev.map((tab) =>
          tab.path === activeEditorPath ? { ...tab, dirty: false } : tab,
        ),
      );
      return;
    }
    const baseline = tabContent[activeEditorPath] ?? "";
    const isDirty = editorValueRef.current !== baseline;
    setOpenTabs((prev) =>
      prev.map((tab) =>
        tab.path === activeEditorPath ? { ...tab, dirty: isDirty } : tab,
      ),
    );
  }, [editorChangeTick, activeEditorPath, tabContent]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const isBuild = (event.ctrlKey || event.metaKey) && key === "b";
      const isSave = (event.ctrlKey || event.metaKey) && key === "s";
      if (event.key === "Escape") {
        if (openMenu) {
          setOpenMenu(null);
          return;
        }
        if (contextMenu) {
          setContextMenu(null);
          return;
        }
        if (tabMenu) {
          setTabMenu(null);
          return;
        }
        if (showProjectInfo && activeTabPath === PROJECT_DESCRIPTOR_TAB) {
          closeTab(PROJECT_DESCRIPTOR_TAB);
          return;
        }
        if (showAiSettings) {
          setShowAiSettings(false);
          return;
        }
        if (showSettings) {
          setShowSettings(false);
          return;
        }
        if (showExport) {
          setShowExport(false);
          return;
        }
        if (showNewFile) {
          setShowNewFile(false);
          return;
        }
        if (showOpenProject) {
          setShowOpenProject(false);
          return;
        }
        if (showNewProject) {
          setShowNewProject(false);
          return;
        }
        return;
      }
      if (isBuild) {
        event.preventDefault();
        runCompile();
        return;
      }
      if (isSave) {
        event.preventDefault();
        void saveActiveTab();
        return;
      }
      if (event.key === "F10") {
        event.preventDefault();
        if (activeTabPath === PROJECT_DESCRIPTOR_TAB) {
          setDescriptorViewMode((prev) => (prev === "view" ? "json" : "view"));
          return;
        }
        if (activeTabMeta?.kind === "diagram") {
          if (activeTabMeta.sourcePath) {
            void selectTab(activeTabMeta.sourcePath);
          }
          return;
        }
        if (!activeEditorPath) return;
        if (editorRef.current && activeEditorPath) {
          pendingEditorContentRef.current = editorValueRef.current;
          pendingEditorPathRef.current = activeEditorPath;
        }
        openDiagramViewTab(activeEditorPath);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTabPath, activeTabMeta, activeEditorPath, contextMenu, openMenu, showAiSettings, showExport, showNewFile, showNewProject, showOpenProject, showSettings, tabMenu]);

  const resetEndpointDraft = () => {
    setEndpointDraft({ name: "", url: "", type: "chat", model: "", token: "" });
  };

  const saveEndpointDraft = () => {
    const name = endpointDraft.name.trim();
    const url = endpointDraft.url.trim();
    if (!name || !url) return;
    setAiEndpoints((prev) => {
      if (endpointDraft.id) {
        return prev.map((endpoint) =>
          endpoint.id === endpointDraft.id
            ? { ...endpoint, name, url, type: endpointDraft.type, model: endpointDraft.model.trim(), token: endpointDraft.token }
            : endpoint,
        );
      }
      const id = crypto.randomUUID();
      return [
        ...prev,
        { id, name, url, type: endpointDraft.type, model: endpointDraft.model.trim(), token: endpointDraft.token },
      ];
    });
    resetEndpointDraft();
  };

  const editEndpoint = (endpointId: string) => {
    const endpoint = aiEndpoints.find((item) => item.id === endpointId);
    if (!endpoint) return;
    setEndpointDraft({ ...endpoint });
  };

  const deleteEndpoint = (endpointId: string) => {
    setAiEndpoints((prev) => prev.filter((item) => item.id !== endpointId));
    setEndpointTestStatus((prev) => {
      const next = { ...prev };
      delete next[endpointId];
      return next;
    });
    if (selectedChatEndpoint === endpointId) setSelectedChatEndpoint(null);
    if (selectedEmbeddingsEndpoint === endpointId) setSelectedEmbeddingsEndpoint(null);
  };

  const testEndpoint = async (endpointId: string) => {
    const endpoint = aiEndpoints.find((item) => item.id === endpointId);
    if (!endpoint) return;
    if (!endpoint.url || !endpoint.url.trim()) {
      setEndpointTestStatus((prev) => ({ ...prev, [endpointId]: "fail: missing url" }));
      return;
    }
    setEndpointTestStatus((prev) => ({ ...prev, [endpointId]: "testing..." }));
    try {
      const response = await invoke<{ ok: boolean; status?: number; detail?: string }>("ai_test_endpoint", {
        payload: {
          url: endpoint.url || "",
          type: endpoint.type,
          model: endpoint.model || null,
          token: endpoint.token || null,
        },
      });
      if (!response?.ok) {
        const status = response?.status ? ` ${response.status}` : "";
        const detail = response?.detail ? ` ${response.detail}` : "";
        setEndpointTestStatus((prev) => ({ ...prev, [endpointId]: `fail:${status}${detail}`.trim() }));
        return;
      }
      setEndpointTestStatus((prev) => ({ ...prev, [endpointId]: "pass" }));
    } catch (error) {
      setEndpointTestStatus((prev) => ({ ...prev, [endpointId]: `fail: ${String(error)}` }));
    }
  };

  const sendAiMessage = async (text: string) => {
    const endpoint = selectedChatEndpoint ? aiEndpoints.find((item) => item.id === selectedChatEndpoint) : null;
    const requestId = ++aiRequestRef.current;
    setAiMessages((prev) => [...prev, { role: "user", text }, { role: "assistant", text: "...", pendingId: requestId }]);
    setAiInput("");
    if (!endpoint) {
      setAiMessages((prev) =>
        prev.map((msg) =>
          msg.pendingId === requestId ? { ...msg, text: "No chat endpoint selected.", pendingId: undefined } : msg,
        ),
      );
      return;
    }
    if (!endpoint.url || !endpoint.url.trim()) {
      setAiMessages((prev) =>
        prev.map((msg) =>
          msg.pendingId === requestId ? { ...msg, text: "Chat endpoint is missing a URL.", pendingId: undefined } : msg,
        ),
      );
      return;
    }
    const history = aiMessages.filter((msg) => msg.text !== "...");
    const messages = [...history, { role: "user" as const, text }];
    try {
      const response = await invoke<any>("ai_chat_completion", {
        payload: {
          url: endpoint.url,
          model: endpoint.model || null,
          token: endpoint.token || null,
          max_tokens: 512,
          messages: messages.map((msg) => ({ role: msg.role, content: msg.text })),
        },
      });
      const content =
        response?.choices?.[0]?.message?.content ??
        response?.choices?.[0]?.text ??
        response?.message ??
        "";
      const nextText = content || "No response.";
      setAiMessages((prev) =>
        prev.map((msg) => (msg.pendingId === requestId ? { ...msg, text: nextText, pendingId: undefined } : msg)),
      );
    } catch (error) {
      setAiMessages((prev) =>
        prev.map((msg) =>
          msg.pendingId === requestId ? { ...msg, text: `Error: ${String(error)}`, pendingId: undefined } : msg,
        ),
      );
    }
  };

  const tree = useMemo(() => {
    const renderEntries = (entries: FileEntry[], depth = 0) => {
      return entries.map((entry) => {
        const isExpanded = Boolean(expanded[entry.path]);
        const ext = entry.name.toLowerCase().split(".").pop() || "";
        const iconLabel =
          entry.is_dir
            ? ""
            : ext === "sysml"
              ? "s"
              : ext === "kerml"
                ? "k"
                : ext === "json" || ext === "jsonld"
                  ? "{}"
                  : "";
        return (
          <div key={`${entry.path}-${depth}`} className="tree-node">
            <div
              className={`tree-row ${entry.is_dir ? "dir" : "file"}`}
              style={{ paddingLeft: `${10 + depth * 14}px` }}
              onClick={() => openFile(entry)}
              onContextMenu={(e) => showContext(e, entry)}
            >
              <span className="tree-caret">{entry.is_dir ? (isExpanded ? "v" : ">") : ""}</span>
              <span className={`tree-icon ${entry.is_dir ? "folder" : "file"}`}>
                {iconLabel ? <span className="tree-icon-label">{iconLabel}</span> : null}
              </span>
              <span className="tree-label">{entry.name}</span>
            </div>
            {entry.is_dir && isExpanded ? (
              <div className="tree-children">
                {renderEntries(expanded[entry.path] || [], depth + 1)}
              </div>
            ) : null}
          </div>
        );
      });
    };

    return renderEntries(treeEntries, 0);
  }, [treeEntries, expanded]);

  const deferredSymbols = useDeferredValue(symbols);
  const deferredUnresolved = useDeferredValue(unresolved);

  const groupedSymbols = useMemo(() => {
    const groups = new Map<string, typeof symbols>();
    deferredSymbols.forEach((symbol) => {
      const key = symbol.file_path || "unknown";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)?.push(symbol);
    });
    return Array.from(groups.entries()).map(([path, list]) => ({
      path,
      list: list.sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }, [deferredSymbols]);

  const projectGroups = useMemo(() => {
    const prefix = rootPath ? rootPath.toLowerCase() : "";
    const libPrefix = libraryPath ? libraryPath.toLowerCase() : "";
    return groupedSymbols.filter((group) => {
      const path = group.path.toLowerCase();
      if (libPrefix && path.startsWith(libPrefix)) return false;
      return prefix ? path.startsWith(prefix) : true;
    });
  }, [groupedSymbols, rootPath, libraryPath]);

  const libraryGroups = useMemo(() => {
    const libPrefix = libraryPath ? libraryPath.toLowerCase() : "";
    if (!libPrefix) return [];
    return groupedSymbols.filter((group) => group.path.toLowerCase().startsWith(libPrefix));
  }, [groupedSymbols, libraryPath]);

  const projectCounts = useMemo(() => {
    const fileCount = projectGroups.length;
    const symbolCount = projectGroups.reduce((sum, group) => sum + group.list.length, 0);
    return { fileCount, symbolCount };
  }, [projectGroups]);

  const libraryCounts = useMemo(() => {
    const fileCount = libraryGroups.length;
    const symbolCount = libraryGroups.reduce((sum, group) => sum + group.list.length, 0);
    return { fileCount, symbolCount };
  }, [libraryGroups]);

  const errorCounts = useMemo(() => {
    const fileCount = new Set(deferredUnresolved.map((entry) => entry.file_path)).size;
    const symbolCount = deferredUnresolved.length;
    return { fileCount, symbolCount };
  }, [deferredUnresolved]);

  const dataViewSymbols = useMemo(() => {
    if (!dataExcludeStdlib || !libraryPath) return deferredSymbols;
    const libPrefix = libraryPath.toLowerCase();
    return deferredSymbols.filter((symbol) => !(symbol.file_path || "").toLowerCase().startsWith(libPrefix));
  }, [deferredSymbols, dataExcludeStdlib, libraryPath]);
  const dataViewSymbolKindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    dataViewSymbols.forEach((symbol) => {
      const key = symbol.kind || "Unknown";
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [dataViewSymbols]);

  type SymbolNode = {
    name: string;
    fullName: string;
    symbols: typeof symbols;
    children: Map<string, SymbolNode>;
  };

  const buildSymbolTree = (list: typeof symbols) => {
    const root: SymbolNode = {
      name: "root",
      fullName: "",
      symbols: [],
      children: new Map(),
    };
    list.forEach((symbol) => {
      const qualified = symbol.qualified_name || symbol.name;
      const segments = qualified.split("::").filter(Boolean);
      let cursor = root;
      segments.forEach((segment, index) => {
        if (!cursor.children.has(segment)) {
          cursor.children.set(segment, {
            name: segment,
            fullName: cursor.fullName ? `${cursor.fullName}::${segment}` : segment,
            symbols: [],
            children: new Map(),
          });
        }
        cursor = cursor.children.get(segment)!;
        if (index === segments.length - 1) {
          cursor.symbols.push(symbol);
        }
      });
    });
    return root;
  };

  const getKindKey = (kind: string) => {
    const value = (kind || "").toLowerCase();
    if (value.includes("package")) return "package";
    if (value.includes("part def")) return "part-def";
    if (value.includes("part") && value.includes("usage")) return "part";
    if (value.includes("part")) return "part";
    if (value.includes("requirement")) return "requirement";
    if (value.includes("port")) return "port";
    if (value.includes("interface")) return "interface";
    if (value.includes("action")) return "action";
    if (value.includes("state")) return "state";
    if (value.includes("item")) return "item";
    if (value.includes("constraint")) return "constraint";
    if (value.includes("allocation")) return "allocation";
    if (value.includes("connection")) return "connection";
    if (value.includes("viewpoint")) return "viewpoint";
    if (value.includes("view")) return "view";
    if (value.includes("concern")) return "concern";
    if (value.includes("usecase")) return "usecase";
    if (value.includes("enum")) return "enum";
    if (value.includes("attribute")) return "attribute";
    return "default";
  };

  const renderTypeIcon = (kind: string, variant: "model" | "diagram") => {
    const key = getKindKey(kind);
    return (
      <span className={`type-icon type-${key} ${variant}`} aria-hidden="true">
        <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
          {key === "package" ? (
            <>
              <rect x="2" y="5" width="12" height="8" rx="1.5" />
              <rect x="2" y="2" width="6" height="3" rx="1" />
            </>
          ) : key === "part-def" ? (
            <>
              <rect x="2" y="2" width="12" height="12" rx="2" />
              <path d="M5 6h6M5 9h6" />
            </>
          ) : key === "part" ? (
            <>
              <rect x="3" y="3" width="10" height="10" rx="2" />
              <circle cx="5.5" cy="5.5" r="1" />
            </>
          ) : key === "requirement" ? (
            <>
              <rect x="2" y="2" width="12" height="12" rx="2" />
              <path d="M5 5h6M5 8h6M5 11h4" />
            </>
          ) : key === "port" ? (
            <>
              <circle cx="8" cy="8" r="5" />
              <path d="M8 3v10M3 8h10" />
            </>
          ) : key === "interface" ? (
            <>
              <rect x="3" y="3" width="10" height="10" rx="2" />
              <path d="M5 8h6" />
            </>
          ) : key === "action" ? (
            <>
              <path d="M3 3h6l4 5-4 5H3z" />
            </>
          ) : key === "state" ? (
            <>
              <rect x="3" y="4" width="10" height="8" rx="4" />
            </>
          ) : key === "item" ? (
            <>
              <rect x="2.5" y="3" width="11" height="10" rx="2" />
            </>
          ) : key === "constraint" ? (
            <>
              <path d="M4 4h8v8H4z" />
              <path d="M6 6h4M6 8h4M6 10h4" />
            </>
          ) : key === "allocation" ? (
            <>
              <path d="M3 8h10M8 3v10" />
              <circle cx="8" cy="8" r="5" />
            </>
          ) : key === "connection" ? (
            <>
              <circle cx="4" cy="8" r="2" />
              <circle cx="12" cy="8" r="2" />
              <path d="M6 8h4" />
            </>
          ) : key === "view" ? (
            <>
              <rect x="2.5" y="3" width="11" height="10" rx="2" />
              <path d="M4 5h8M4 8h8M4 11h5" />
            </>
          ) : key === "viewpoint" ? (
            <>
              <circle cx="8" cy="8" r="5" />
              <path d="M8 4v8M4 8h8" />
            </>
          ) : key === "concern" ? (
            <>
              <path d="M8 3l5 5-5 5-5-5z" />
            </>
          ) : key === "usecase" ? (
            <>
              <ellipse cx="8" cy="8" rx="5" ry="3" />
            </>
          ) : key === "enum" ? (
            <>
              <rect x="3" y="3" width="10" height="10" rx="2" />
              <path d="M5 6h6M5 8h6M5 10h6" />
            </>
          ) : key === "attribute" ? (
            <>
              <rect x="4" y="4" width="8" height="8" rx="1" />
              <path d="M6 8h4" />
            </>
          ) : (
            <>
              <circle cx="8" cy="8" r="5" />
            </>
          )}
        </svg>
      </span>
    );
  };

  const buildRowsForTree = (
    root: SymbolNode,
    rootLabel: string | undefined,
    rootKey: string,
    expanded: Record<string, boolean>,
    collapseAll: boolean,
  ) => {
    const rows: Array<{
      id: string;
      name: string;
      kindLabel: string;
      kindKey: string;
      depth: number;
      node: SymbolNode;
      hasChildren: boolean;
      expanded: boolean;
    }> = [];
    const walk = (node: SymbolNode, depth: number, isTop: boolean, pathKey: string) => {
      const displayName = isTop && node.name === "root" && rootLabel ? rootLabel : node.name;
      const nodeId = `${rootKey}::${node.fullName || pathKey}`;
      const kindLabel = node.symbols.map((symbol) => symbol.kind).filter(Boolean).join(", ");
      const kindKey = getKindKey(node.symbols[0]?.kind || "");
      const hasChildren = node.children.size > 0;
      const expandedState = collapseAll ? false : expanded[nodeId] ?? false;
      const isVirtualRoot = node.name === "root" && node.symbols.length === 0;
      if (!isVirtualRoot) {
        rows.push({
          id: nodeId,
          name: displayName,
          kindLabel,
          kindKey,
          depth,
          node,
          hasChildren,
          expanded: expandedState,
        });
      }
      if (hasChildren && (expandedState || isVirtualRoot)) {
        const byNameCount = new Map<string, number>();
        Array.from(node.children.values())
          .sort((a, b) => a.name.localeCompare(b.name))
          .forEach((child) => {
            const keyBase = child.name || "node";
            const count = (byNameCount.get(keyBase) || 0) + 1;
            byNameCount.set(keyBase, count);
            const childKey = `${pathKey}::${keyBase}#${count}`;
            walk(child, isVirtualRoot ? depth : depth + 1, false, childKey);
          });
      }
    };
    walk(root, 0, true, rootKey || "root");
    return rows;
  };

  type ModelRow =
    | { type: "section"; key: string; section: "project" | "library" | "errors"; label: string; countLabel: string }
    | {
        type: "symbol";
        key: string;
        name: string;
        kindLabel: string;
        kindKey: string;
        depth: number;
        node: SymbolNode;
        hasChildren: boolean;
        expanded: boolean;
      }
    | { type: "empty"; key: string; text: string }
    | { type: "error"; key: string; issue: (typeof deferredUnresolved)[number] };

  const modelRows = useMemo<ModelRow[]>(() => {
    const rows: ModelRow[] = [];
    const pushSymbolGroups = (groups: typeof projectGroups, sectionKey: string) => {
      groups.forEach((group) => {
        const rootLabel = group.path.split(/[\\/]/).pop() || group.path;
        const fileRow: SymbolNode = {
          name: rootLabel,
          fullName: `${sectionKey}::${group.path}`,
          symbols: [],
          children: new Map([[rootLabel, buildSymbolTree(group.list)]]),
        };
        const builtRows = buildRowsForTree(fileRow, rootLabel, `${sectionKey}::${group.path}`, modelExpanded, collapseAllModel);
        builtRows.forEach((row) => {
          rows.push({
            type: "symbol",
            key: row.id,
            name: row.name,
            kindLabel: row.kindLabel,
            kindKey: row.kindKey,
            depth: row.depth,
            node: row.node,
            hasChildren: row.hasChildren,
            expanded: row.expanded,
          });
        });
      });
    };
    const addSection = (
      section: "project" | "library" | "errors",
      label: string,
      countLabel: string,
      addBody: () => void,
      emptyLabel: string,
    ) => {
      rows.push({ type: "section", key: `section-${section}`, section, label, countLabel });
      if (!modelSectionOpen[section]) return;
      const beforeCount = rows.length;
      addBody();
      if (rows.length === beforeCount) {
        rows.push({ type: "empty", key: `empty-${section}`, text: emptyLabel });
      }
    };
    addSection(
      "project",
      "Project",
      `${projectCounts.fileCount} files • ${projectCounts.symbolCount} symbols`,
      () => {
        if (projectGroups.length) {
          pushSymbolGroups(projectGroups, "project");
        }
      },
      projectSymbolsLoaded ? "No project symbols." : "Loading project symbols...",
    );
    addSection(
      "library",
      "Library",
      `${libraryCounts.fileCount} files • ${libraryCounts.symbolCount} symbols`,
      () => {
        if (libraryGroups.length) {
          pushSymbolGroups(libraryGroups, "library");
        }
      },
      "No library symbols loaded.",
    );
    addSection(
      "errors",
      "Errors",
      `${errorCounts.fileCount} files • ${errorCounts.symbolCount} issues`,
      () => {
        deferredUnresolved.forEach((issue, index) => {
          rows.push({
            type: "error",
            key: `error-${issue.file_path}-${issue.line}-${issue.column}-${index}`,
            issue,
          });
        });
      },
      "No semantic errors.",
    );
    return rows;
  }, [
    projectGroups,
    libraryGroups,
    deferredUnresolved,
    modelExpanded,
    collapseAllModel,
    modelSectionOpen,
    projectCounts.fileCount,
    projectCounts.symbolCount,
    libraryCounts.fileCount,
    libraryCounts.symbolCount,
    errorCounts.fileCount,
    errorCounts.symbolCount,
    projectSymbolsLoaded,
  ]);

  const modelListRef = useRef<ListImperativeAPI | null>(null);
  const pendingScrollSymbolRef = useRef<string | null>(null);
  const [modelCursorIndex, setModelCursorIndex] = useState<number | null>(null);
  const modelSectionIndent = 12;
  const getModelRowHeight = (row: ModelRow) => {
    if (row.type === "section") return 28;
    if (row.type === "error") return 64;
    if (row.type === "empty") return 24;
    return 24;
  };

  const modelListHeight = Math.max(120, (modelTreeViewportHeight || modelTreeHeight) - 16);

  const findSelectedSymbolIndex = () => {
    if (!selectedSymbol) return -1;
    return modelRows.findIndex((row) => {
      if (row.type !== "symbol") return false;
      if (selectedSymbol.qualified_name) {
        return row.node.symbols.some((sym) => sym.qualified_name === selectedSymbol.qualified_name);
      }
      return row.node.symbols.some((sym) => sym.file_path === selectedSymbol.file_path && sym.name === selectedSymbol.name);
    });
  };

  const activateModelRow = (row: ModelRow, index: number) => {
    if (row.type === "section") {
      setModelSectionOpen((prev) => ({ ...prev, [row.section]: !prev[row.section] }));
      return;
    }
    if (row.type === "symbol") {
      const symbol = row.node.symbols[0];
      if (symbol) {
        setSelectedSymbol(symbol);
        void selectSymbolInEditor(symbol);
      }
      return;
    }
    if (row.type === "error") {
      const issue = row.issue;
      const path = issue.file_path;
      if (!path) return;
      void navigateTo({
        path,
        name: path.split(/[\\/]/).pop() || "Untitled",
        selection: {
          startLine: issue.line || 1,
          startCol: issue.column || 1,
          endLine: issue.line || 1,
          endCol: (issue.column || 1) + 1,
        },
      });
      return;
    }
    if (row.type === "empty") {
      setModelCursorIndex(index);
    }
  };

  const handleModelTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, indexOverride?: number) => {
    if (!modelRows.length) return;
    const key = event.key;
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(key)) return;
    event.preventDefault();
    event.stopPropagation();

    const currentIndex = modelCursorIndex ?? indexOverride ?? 0;
    if (modelCursorIndex == null) {
      setModelCursorIndex(currentIndex);
    }
    if (key === "ArrowUp") {
      setModelCursorIndex(Math.max(0, currentIndex - 1));
      return;
    }
    if (key === "ArrowDown") {
      setModelCursorIndex(Math.min(modelRows.length - 1, currentIndex + 1));
      return;
    }

    const row = modelRows[currentIndex];
    if (!row) return;
    if (key === "Enter") {
      activateModelRow(row, currentIndex);
      return;
    }
    if (key === "ArrowRight") {
      if (row.type === "section") {
        setModelSectionOpen((prev) => ({ ...prev, [row.section]: true }));
      } else if (row.type === "symbol" && row.hasChildren && !row.expanded) {
        setModelExpanded((prev) => ({ ...prev, [row.key]: true }));
      }
      return;
    }
    if (key === "ArrowLeft") {
      if (row.type === "section") {
        setModelSectionOpen((prev) => ({ ...prev, [row.section]: false }));
      } else if (row.type === "symbol" && row.hasChildren && row.expanded) {
        setModelExpanded((prev) => ({ ...prev, [row.key]: false }));
      }
    }
  };

  const syncModelTreeToSymbol = (symbol: typeof symbols[number]) => {
    if (!symbol?.file_path) return;
    const qualified = symbol.qualified_name || symbol.name;
    const projectGroup = projectGroups.find((group) => group.path === symbol.file_path);
    const libraryGroup = projectGroup ? null : libraryGroups.find((group) => group.path === symbol.file_path);
    const section = projectGroup ? "project" : libraryGroup ? "library" : null;
    if (!section) return;
    const group = projectGroup || libraryGroup;
    if (!group) return;
    const rootKey = `${section}::${group.path}`;
    const nextExpanded: Record<string, boolean> = {};
    nextExpanded[`${rootKey}::${rootKey}`] = true;
    if (qualified) {
      const segments = qualified.split("::").filter(Boolean);
      let prefix = "";
      segments.forEach((segment) => {
        prefix = prefix ? `${prefix}::${segment}` : segment;
        nextExpanded[`${rootKey}::${prefix}`] = true;
      });
    }
    setModelSectionOpen((prev) => ({ ...prev, [section]: true }));
    setModelExpanded((prev) => ({ ...prev, ...nextExpanded }));
    pendingScrollSymbolRef.current = qualified;
  };

  useEffect(() => {
    if (!pendingScrollSymbolRef.current) return;
    const target = pendingScrollSymbolRef.current;
    const index = modelRows.findIndex((row) => {
      if (row.type !== "symbol") return false;
      if (row.node.fullName === target) return true;
      return row.node.symbols.some((sym) => (sym.qualified_name || sym.name) === target);
    });
    if (index >= 0) {
      modelListRef.current?.scrollToRow({ index, align: "center" });
      pendingScrollSymbolRef.current = null;
    }
  }, [modelRows]);

  useEffect(() => {
    if (modelCursorIndex == null) return;
    if (modelCursorIndex < 0 || modelCursorIndex >= modelRows.length) {
      setModelCursorIndex(modelRows.length ? 0 : null);
      return;
    }
    modelListRef.current?.scrollToRow({ index: modelCursorIndex, align: "smart" });
  }, [modelCursorIndex, modelRows.length]);

  const renderModelRow = ({ index, style, rows }: RowComponentProps<{ rows: ModelRow[] }>) => {
    const row = rows[index];
    if (!row) return null;
    const isFocused = modelCursorIndex === index;
    if (row.type === "section") {
      const isOpen = modelSectionOpen[row.section];
      return (
        <div
          style={style}
          className={`model-section-row ${isFocused ? "model-row-focused" : ""}`}
          role="button"
          tabIndex={-1}
          onKeyDown={(event) => handleModelTreeKeyDown(event, index)}
          onMouseDown={(event) => {
            event.preventDefault();
            modelTreeRef.current?.focus();
          }}
          onClick={() => {
            setModelCursorIndex(index);
            setModelSectionOpen((prev) => ({ ...prev, [row.section]: !isOpen }));
          }}
        >
          <span className="model-section-toggle">{isOpen ? "-" : "+"}</span>
          <span className="model-section-label">{row.label}</span>
          <span className="model-section-count">{row.countLabel}</span>
        </div>
      );
    }
    if (row.type === "empty") {
      return (
        <div
          style={{ ...style, paddingLeft: `${modelSectionIndent}px` }}
          className={`model-empty-row ${isFocused ? "model-row-focused" : ""}`}
          onClick={() => setModelCursorIndex(index)}
          role="button"
          tabIndex={-1}
          onKeyDown={(event) => handleModelTreeKeyDown(event, index)}
          onMouseDown={(event) => {
            event.preventDefault();
            modelTreeRef.current?.focus();
          }}
        >
          {row.text}
        </div>
      );
    }
    if (row.type === "error") {
      const issue = row.issue;
      return (
        <div
          style={{ ...style, paddingLeft: `${modelSectionIndent + 8}px` }}
          className={`error-row ${isFocused ? "model-row-focused" : ""}`}
          role="button"
          tabIndex={-1}
          onKeyDown={(event) => handleModelTreeKeyDown(event, index)}
          onMouseDown={(event) => {
            event.preventDefault();
            modelTreeRef.current?.focus();
          }}
          onClick={() => {
            setModelCursorIndex(index);
            const path = issue.file_path;
            if (!path) return;
            void navigateTo({
              path,
              name: path.split(/[\\/]/).pop() || "Untitled",
              selection: {
                startLine: issue.line || 1,
                startCol: issue.column || 1,
                endLine: issue.line || 1,
                endCol: (issue.column || 1) + 1,
              },
            });
          }}
        >
          <span className="error-icon" aria-hidden="true" />
          <div className="error-text">
            <div className="error-message">{issue.message}</div>
            <div className="error-title">{issue.file_path}:{issue.line}:{issue.column}</div>
          </div>
        </div>
      );
    }
    const symbol = row.node.symbols[0];
    const isSelected =
      !!symbol &&
      (selectedSymbol?.qualified_name
        ? selectedSymbol.qualified_name === symbol.qualified_name
        : selectedSymbol?.file_path === symbol.file_path && selectedSymbol?.name === symbol.name);
    return (
      <div
        style={{ ...style, paddingLeft: `${modelSectionIndent + 8 + row.depth * 14}px` }}
        className={`model-virtual-row ${isSelected ? "selected" : ""} ${isFocused ? "model-row-focused" : ""}`}
        role="button"
        tabIndex={-1}
        onKeyDown={(event) => handleModelTreeKeyDown(event, index)}
        onMouseDown={(event) => {
          event.preventDefault();
          modelTreeRef.current?.focus();
        }}
        onClick={(event) => {
          event.stopPropagation();
          setModelCursorIndex(index);
          if (symbol) {
            setSelectedSymbol(symbol);
            void selectSymbolInEditor(symbol);
          }
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (symbol) {
            void selectSymbolInEditor(symbol);
          }
        }}
      >
        <span
          className="model-caret"
          onClick={(event) => {
            event.stopPropagation();
            if (row.hasChildren) {
              setModelExpanded((prev) => ({ ...prev, [row.key]: !row.expanded }));
            }
          }}
        >
          {row.hasChildren ? (row.expanded ? "-" : "+") : ""}
        </span>
        {renderTypeIcon(row.kindKey, "model")}
        <span className="model-name">{row.name}</span>
        {row.kindLabel ? <span className="model-kind">{row.kindLabel}</span> : null}
      </div>
    );
  };

  const fileSymbols = useMemo(() => {
    if (!activeDiagramPath) return [];
    return deferredSymbols.filter((symbol) => symbol.file_path === activeDiagramPath);
  }, [deferredSymbols, activeDiagramPath]);

  const symbolByQualified = useMemo(() => {
    const map = new Map<string, typeof symbols[number]>();
    fileSymbols.forEach((symbol) => map.set(symbol.qualified_name, symbol));
    return map;
  }, [fileSymbols]);

  const requestDiagramLayout = () => {
    if (!diagramWorkerRef.current) return;
    if (!fileSymbols.length) {
      setDiagramLayout(null);
      return;
    }
    const worker = diagramWorkerRef.current;
    const reqId = ++diagramLayoutReqRef.current;
    worker.postMessage({
      type: "layout",
      reqId,
      nodes: fileSymbols.map((symbol) => ({
        qualified: symbol.qualified_name,
        name: symbol.name,
        kind: symbol.kind,
      })),
    });
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type: string; reqId: number; layout?: DiagramLayout };
      if (data?.type !== "layout" || data.reqId !== reqId) return;
      setDiagramLayout(data.layout || null);
      worker.removeEventListener("message", onMessage);
    };
    worker.addEventListener("message", onMessage);
  };

  useEffect(() => {
    requestDiagramLayout();
  }, [fileSymbols]);


  type DiagramLayout = {
    node: { name: string; fullName: string; kind: string };
    width: number;
    height: number;
    children: Array<{ layout: DiagramLayout; x: number; y: number }>;
  };

  const renderDiagramLayout = (layout: DiagramLayout) => {
    if (layout.node.name === "root") {
      return (
        <div className="diagram-content" style={{ width: `${layout.width}px`, height: `${layout.height}px` }}>
          {layout.children.map((child) => (
            <div
              key={child.layout.node.fullName}
              className="diagram-position"
              style={{ left: `${child.x}px`, top: `${child.y}px` }}
            >
              {renderDiagramLayout(child.layout)}
            </div>
          ))}
        </div>
      );
    }
      const symbol = symbolByQualified.get(layout.node.fullName);
      const kindLabel = symbol?.kind || layout.node.kind;
      const kindKey = getKindKey(kindLabel || "");
    const isSelected = selectedSymbol?.qualified_name === layout.node.fullName;
    const offset = diagramNodeOffsets[layout.node.fullName] || { x: 0, y: 0 };
    const sizeOverride = diagramNodeSizes[layout.node.fullName];
    return (
      <div
        className={`diagram-node ${isSelected ? "selected" : ""}`}
        style={{
          width: `${sizeOverride?.width ?? layout.width}px`,
          height: `${sizeOverride?.height ?? layout.height}px`,
          transform: `translate(${offset.x}px, ${offset.y}px)`,
        }}
        role="button"
        tabIndex={0}
        onPointerDown={(event) => {
          event.stopPropagation();
          diagramDragRef.current = {
            node: layout.node.fullName,
            startX: event.clientX,
            startY: event.clientY,
            base: offset,
          };
          (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (symbol) {
            setSelectedSymbol(symbol);
            void selectSymbolInEditor(symbol);
            if (syncDiagramSelection) {
              syncModelTreeToSymbol(symbol);
            }
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && symbol) {
            setSelectedSymbol(symbol);
            void selectSymbolInEditor(symbol);
          }
        }}
      >
        <div className="diagram-node-header">
          {renderTypeIcon(kindKey, "diagram")}
          <span className="diagram-node-name">{layout.node.name}</span>
          {kindLabel ? <span className="diagram-node-kind">{kindLabel}</span> : null}
        </div>
        {layout.children.map((child) => {
          const childOffset = diagramNodeOffsets[child.layout.node.fullName] || { x: 0, y: 0 };
          return (
            <div
              key={child.layout.node.fullName}
              className="diagram-position"
              style={{ left: `${child.x + childOffset.x}px`, top: `${child.y + childOffset.y}px` }}
            >
              {renderDiagramLayout(child.layout)}
            </div>
          );
        })}
        <div
          className="diagram-resize-handle"
          onPointerDown={(event) => {
            event.stopPropagation();
            diagramResizeRef.current = {
              node: layout.node.fullName,
              startX: event.clientX,
              startY: event.clientY,
              base: {
                width: sizeOverride?.width ?? layout.width,
                height: sizeOverride?.height ?? layout.height,
              },
            };
            (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
          }}
        />
      </div>
    );
  };

  const renderManualNode = (node: { id: string; type: string; name: string; x: number; y: number; width: number; height: number; pending: boolean }) => {
    const kindKey = getKindKey(node.type);
    return (
      <div
        key={node.id}
        className={`diagram-node manual ${node.pending ? "pending" : ""}`}
        style={{
          width: `${node.width}px`,
          height: `${node.height}px`,
          transform: `translate(${node.x}px, ${node.y}px)`,
        }}
      >
        <div className="diagram-node-header">
          {renderTypeIcon(kindKey, "diagram")}
          <span className="diagram-node-name">{node.name}</span>
        </div>
      </div>
    );
  };


  const renderMinimapLayout = (layout: DiagramLayout) => {
    if (layout.node.name === "root") {
      return (
        <div className="minimap-content" style={{ width: `${layout.width}px`, height: `${layout.height}px` }}>
          {layout.children.map((child) => (
            <div
              key={child.layout.node.fullName}
              className="diagram-position"
              style={{ left: `${child.x}px`, top: `${child.y}px` }}
            >
              {renderMinimapLayout(child.layout)}
            </div>
          ))}
        </div>
      );
    }
    return (
      <div className="minimap-node" style={{ width: `${layout.width}px`, height: `${layout.height}px` }}>
        {layout.children.map((child) => (
          <div
            key={child.layout.node.fullName}
            className="diagram-position"
            style={{ left: `${child.x}px`, top: `${child.y}px` }}
          >
            {renderMinimapLayout(child.layout)}
          </div>
        ))}
      </div>
    );
  };

  useEffect(() => {
    if (!diagramLayout || !diagramBodyRef.current) return;
    const body = diagramBodyRef.current.getBoundingClientRect();
    const canvasWidth = diagramLayout.width * diagramScale;
    const canvasHeight = diagramLayout.height * diagramScale;
    const viewWidth = Math.min(140, Math.max(60, (body.width / Math.max(canvasWidth, 1)) * 140));
    const viewHeight = Math.min(100, Math.max(40, (body.height / Math.max(canvasHeight, 1)) * 100));
    const miniScaleX = 140 / Math.max(canvasWidth, 1);
    const miniScaleY = 100 / Math.max(canvasHeight, 1);
    const viewX = Math.min(140 - viewWidth, Math.max(0, -diagramOffset.x * miniScaleX));
    const viewY = Math.min(100 - viewHeight, Math.max(0, -diagramOffset.y * miniScaleY));
    setDiagramViewport({ x: viewX, y: viewY, width: viewWidth, height: viewHeight });
  }, [diagramLayout, diagramScale, diagramOffset]);

  const diagramBounds = useMemo(() => {
    if (!diagramLayout) return {};
    const bounds: Record<string, { minX: number; maxX: number; minY: number; maxY: number }> = {};
    const walk = (layout: DiagramLayout) => {
      const sizeOverride = diagramNodeSizes[layout.node.fullName];
      const width = sizeOverride?.width ?? layout.width;
      const height = sizeOverride?.height ?? layout.height;
      layout.children.forEach((child) => {
        const childSizeOverride = diagramNodeSizes[child.layout.node.fullName];
        const childWidth = childSizeOverride?.width ?? child.layout.width;
        const childHeight = childSizeOverride?.height ?? child.layout.height;
        bounds[child.layout.node.fullName] = {
          minX: -child.x,
          maxX: width - childWidth - child.x,
          minY: -child.y,
          maxY: height - childHeight - child.y,
        };
        walk(child.layout);
      });
    };
    walk(diagramLayout);
    return bounds;
  }, [diagramLayout, diagramNodeSizes]);

  useEffect(() => {
    diagramBoundsRef.current = diagramBounds;
  }, [diagramBounds]);

    return (
      <div
        className="app-shell"
        style={{
          ["--left-width" as string]: `${leftCollapsed ? 0 : leftWidth}px`,
          ["--right-width" as string]: `${rightCollapsed ? 0 : rightWidth}px`,
          ["--split-left-width" as string]: `${leftCollapsed ? 16 : 6}px`,
          ["--split-right-width" as string]: `${rightCollapsed ? 16 : 6}px`,
        }}
      >
      <header className="titlebar" data-tauri-drag-region>
        <div className="titlebar-left">
          <span className="app-mark" aria-hidden="true" />
          <nav className="menu-row" aria-label="App menu">
            <div className="menu-item">
              <button type="button" className="menu-button" onClick={() => setOpenMenu(openMenu === "File" ? null : "File")}>File</button>
                {openMenu === "File" ? (
                  <div className="menu-dropdown" data-tauri-drag-region="false">
                    <button type="button" onClick={openNewProjectDialog}>New Project</button>
                    <button type="button" onClick={chooseProject}>Open Project</button>
                    <div className="menu-divider" />
                    <button type="button" onClick={() => { void invoke("window_close"); }}>Exit</button>
                  </div>
                ) : null}
            </div>
            <div className="menu-item">
              <button type="button" className="menu-button" onClick={() => setOpenMenu(openMenu === "Edit" ? null : "Edit")}>Edit</button>
              {openMenu === "Edit" ? (
            <div className="menu-dropdown" data-tauri-drag-region="false">
              <button type="button">Undo</button>
              <button type="button">Redo</button>
              <div className="menu-divider" />
              <button type="button">Find</button>
            </div>
              ) : null}
            </div>
            <div className="menu-item">
              <button type="button" className="menu-button" onClick={() => setOpenMenu(openMenu === "View" ? null : "View")}>View</button>
              {openMenu === "View" ? (
            <div className="menu-dropdown" data-tauri-drag-region="false">
              <button type="button">Project Panel</button>
              <button type="button">Model Panel</button>
              <div className="menu-divider" />
              <button type="button" onClick={() => { setOpenMenu(null); openAiViewTab(); }}>AI View</button>
              <button type="button" onClick={() => { setOpenMenu(null); openDataViewTab(); }}>Data Analysis View</button>
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  if (activeEditorPath) openDiagramViewTab(activeEditorPath);
                }}
                disabled={!activeEditorPath}
              >
                Diagram View
              </button>
              <div className="menu-divider" />
              <button type="button" onClick={() => { setShowSettings(true); setOpenMenu(null); }}>Settings?</button>
              <button type="button">Logs</button>
            </div>
              ) : null}
            </div>
            <div className="menu-item">
              <button type="button" className="menu-button" onClick={() => setOpenMenu(openMenu === "Build" ? null : "Build")}>Build</button>
              {openMenu === "Build" ? (
            <div className="menu-dropdown" data-tauri-drag-region="false">
              <button type="button" onClick={() => { setOpenMenu(null); runCompile(); }}>Build Workspace</button>
              <button type="button" onClick={() => { setOpenMenu(null); openExportDialog(); }}>Export Model</button>
            </div>
              ) : null}
            </div>
            <div className="menu-item">
              <button type="button" className="menu-button" onClick={() => setOpenMenu(openMenu === "Help" ? null : "Help")}>Help</button>
              {openMenu === "Help" ? (
            <div className="menu-dropdown" data-tauri-drag-region="false">
              <button type="button">About</button>
            </div>
              ) : null}
            </div>
          </nav>
        </div>
        <div className="titlebar-center" />
        <div className="titlebar-right" data-tauri-drag-region="false">
            <button
              type="button"
              className="titlebar-btn minimize"
              data-tauri-drag-region="false"
              aria-label="Minimize"
              onClick={() => { void invoke("window_minimize"); }}
            >
              <span className="titlebar-icon" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="titlebar-btn maximize"
              data-tauri-drag-region="false"
              aria-label="Maximize"
              onClick={() => { void invoke("window_toggle_maximize"); }}
            >
              <span className="titlebar-icon" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="titlebar-btn close"
              data-tauri-drag-region="false"
              aria-label="Close"
              onClick={() => { void invoke("window_close"); }}
            >
              <span className="titlebar-icon" aria-hidden="true" />
            </button>
        </div>
      </header>
      <main className="content">
          {leftCollapsed ? <div className="panel-spacer" /> : (
            <section className="panel sidebar">
              <div className="panel-header">
                <span>Project</span>
                <button
                  type="button"
                  className="ghost collapse-btn"
                  onClick={() => {
                    leftStoredWidthRef.current = leftWidth;
                    setLeftCollapsed(true);
                  }}
                  title="Collapse project"
                >
                  «
                </button>
              </div>
            <div className="project-actions inline">
                <button
                  type="button"
                  className={`ghost icon-info ${hasProjectDescriptor ? "active" : ""}`}
                  onClick={loadProjectInfo}
                  aria-label="Project info"
                  title="Project info"
                />
                <button type="button" className="icon-button" onClick={chooseProject} aria-label="Open Project" title="Open Project" />
                <select className="recent-select" value="" onChange={(e) => openProject(e.target.value)} aria-label="Open recent" title="Open recent">
                  <option value="">Recent</option>
                  {recentProjects.map((path) => (
                    <option key={path} value={path}>{path}</option>
                  ))}
                </select>
            </div>
          <div className="project-root">
            {rootPath ? (
              <>
                <span className="project-root-name">{rootPath.split(/[\\/]/).pop()}</span>
                <span className="project-root-path">{rootPath}</span>
              </>
            ) : (
              "No project selected"
            )}
          </div>
            <div className="file-tree" onContextMenu={showRootContext}>{tree}</div>
            </section>
          )}
          <div
            className={`splitter ${leftCollapsed ? "collapsed" : ""}`}
            onPointerDown={leftCollapsed ? undefined : (event) => startDrag("left", event)}
          >
            {leftCollapsed ? (
              <button
                type="button"
                className="splitter-toggle"
                onClick={() => {
                  setLeftCollapsed(false);
                  setLeftWidth(leftStoredWidthRef.current || 240);
                }}
                title="Restore project"
              >
                »
              </button>
            ) : null}
          </div>
          <section className="panel editor">
            <div className="panel-header editor-tabs">
              <div className="tabs">
                {openTabs.length ? (
                openTabs.map((tab) => (
                  <button
                    key={tab.path}
                    type="button"
                    className={`tab tab-kind-${tabKindClass(tab)} ${tab.path === activeTabPath ? "active" : ""}`}
                    draggable
                    onClick={() => selectTab(tab.path)}
                    onDragStart={() => {
                      draggedTabPathRef.current = tab.path;
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const fromPath = draggedTabPathRef.current;
                      if (fromPath) {
                        reorderTabs(fromPath, tab.path);
                      }
                    }}
                    onDragEnd={() => {
                      draggedTabPathRef.current = null;
                    }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setActiveTabPath(tab.path);
                        setTabMenu({ x: event.clientX, y: event.clientY, path: tab.path });
                      }}
                    >
                    <span className="tab-icon" aria-hidden="true">{tabIcon(tab)}</span>
                    <span className="tab-label">{tab.name}</span>
                    {tab.dirty ? <span className="tab-dirty" aria-hidden="true">•</span> : null}
                    <span className="tab-close" onClick={(event) => { event.stopPropagation(); closeTab(tab.path); }}>x</span>
                  </button>
                ))
              ) : (
                <div className="muted">No files open.</div>
              )}
            </div>
              {openTabs.length ? (
                <div className="tab-overflow">
                  <button
                    type="button"
                    className="tab-overflow-btn"
                    title="Tab overflow"
                    onClick={() => setTabOverflowOpen((prev) => !prev)}
                  >
                    v
                  </button>
                  {tabOverflowOpen ? (
                    <div className="tab-overflow-menu">
                      {openTabs.map((tab) => (
                        <button
                          key={tab.path}
                          type="button"
                          className={tab.path === activeTabPath ? "active" : ""}
                          onClick={() => {
                            setTabOverflowOpen(false);
                            void selectTab(tab.path);
                          }}
                        >
                          {tabIcon(tab)} {tab.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="editor-host" id="monaco-root">
              {activeTabMeta?.kind === "ai" ? (
                <div className="ai-view">
                  <div className="view-header">
                    <div className="view-title">AI</div>
                    <button type="button" className="ghost" onClick={() => setShowAiSettings(true)}>Settings</button>
                  </div>
                  <div className="ai-pane">
                    <div className="ai-messages">
                      {aiMessages.length ? (
                        aiMessages.map((msg, idx) => (
                          <div key={idx} className={`ai-message ${msg.role}`}>{msg.text}</div>
                        ))
                      ) : (
                        <div className="muted">Ask about your model.</div>
                      )}
                    </div>
                    <div className="ai-input">
                      <textarea
                        value={aiInput}
                        onChange={(e) => setAiInput(e.target.value)}
                        placeholder="Type a prompt..."
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const text = aiInput.trim();
                          if (!text) return;
                          void sendAiMessage(text);
                        }}
                      >
                        Send
                      </button>
                    </div>
                  </div>
                </div>
              ) : activeTabMeta?.kind === "data" ? (
                <div className="data-view">
                  <div className="view-header">
                    <div className="view-title">Data Analysis</div>
                    <label className="view-toggle">
                      <input
                        type="checkbox"
                        checked={dataExcludeStdlib}
                        onChange={(event) => setDataExcludeStdlib(event.target.checked)}
                      />
                      <span>Exclude stdlib</span>
                    </label>
                  </div>
                  <div className="data-grid">
                    <div className="data-card">
                      <div className="data-card-label">Project</div>
                      <div className="data-card-value">{projectCounts.fileCount} files / {projectCounts.symbolCount} symbols</div>
                    </div>
                    <div className="data-card">
                      <div className="data-card-label">Library</div>
                      <div className="data-card-value">{libraryCounts.fileCount} files / {libraryCounts.symbolCount} symbols</div>
                    </div>
                    <div className="data-card">
                      <div className="data-card-label">Errors</div>
                      <div className="data-card-value">{errorCounts.fileCount} files / {errorCounts.symbolCount} issues</div>
                    </div>
                  </div>
                  <div className="data-section">
                    <div className="data-section-title">Top symbol kinds</div>
                    {dataViewSymbolKindCounts.length ? (
                      <div className="data-list">
                        {dataViewSymbolKindCounts.slice(0, 12).map(([kind, count]) => (
                          <div key={kind} className="data-row">
                            <span className="data-row-label">{kind}</span>
                            <span className="data-row-value">{count}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="muted">No symbols yet.</div>
                    )}
                  </div>
                </div>
              ) : !activeTabPath ? (
                <div className="editor-placeholder">
                  <div className="welcome-screen">
                      <div className="welcome-title">Welcome to Mercurio</div>
                      <div className="welcome-subtitle">Open a project or create a new one to get started.</div>
                      <div className="welcome-actions">
                        <button type="button" className="ghost" onClick={openNewProjectDialog}>New Project</button>
                        <button type="button" className="ghost" onClick={chooseProject}>Open Project</button>
                      </div>
                      <div className="welcome-hint">Tip: Press F10 to open the diagram view.</div>
                    </div>
                  </div>
              ) : activeTabPath === PROJECT_DESCRIPTOR_TAB ? (
                <div className="descriptor-view">
                  <div className="descriptor-header">Project Descriptor</div>
                  {descriptorViewMode === "view" ? (
                    projectDescriptor ? (
                      <div className="descriptor-grid">
                        <div className="descriptor-row">
                          <div className="descriptor-label">Name</div>
                          <div className="descriptor-value">{projectDescriptor.name || "—"}</div>
                        </div>
                        <div className="descriptor-row">
                          <div className="descriptor-label">Author</div>
                          <div className="descriptor-value">{projectDescriptor.author || "—"}</div>
                        </div>
                        <div className="descriptor-row">
                          <div className="descriptor-label">Organization</div>
                          <div className="descriptor-value">{projectDescriptor.organization || "—"}</div>
                        </div>
                        <div className="descriptor-row">
                          <div className="descriptor-label">Description</div>
                          <div className="descriptor-value">{projectDescriptor.description || "—"}</div>
                        </div>
                        <div className="descriptor-row">
                          <div className="descriptor-label">Default library</div>
                          <div className="descriptor-value">{projectDescriptor.default_library ? "Yes" : "No"}</div>
                        </div>
                      </div>
                    ) : (
                      <div className="muted">No project descriptor found.</div>
                    )
                  ) : (
                    <pre className="descriptor-json">
                      {projectDescriptor?.raw_json || "{}"}
                    </pre>
                  )}
                </div>
              ) : activeTabMeta?.kind !== "diagram" ? (
                <MonacoEditor
                  defaultValue=""
                  onChange={(value) => {
                    editorValueRef.current = value ?? "";
                    if (editorChangeRafRef.current == null) {
                      editorChangeRafRef.current = window.requestAnimationFrame(() => {
                        setEditorChangeTick((tick) => tick + 1);
                        editorChangeRafRef.current = null;
                      });
                    }
                  }}
                  language="sysml"
                  theme={appTheme === "light" ? "vs" : "vs-dark"}
                  onMount={handleEditorMount}
                  options={editorOptions}
                />
              ) : (
                <div className="diagram-surface">
                  <div className="diagram-header">
                  <span>Diagram view</span>
                  <div className="diagram-controls">
                    <button
                      type="button"
                      className="ghost toggle-btn"
                      onClick={() => setCenterView("file")}
                      title="Switch to text"
                    >
                      Text
                    </button>
                    <button
                      type="button"
                      className={`ghost ${syncDiagramSelection ? "active" : ""}`}
                      onClick={() => setSyncDiagramSelection((prev) => !prev)}
                      title="Sync diagram selection to model tree"
                    >
                      Sync
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        setDiagramNodeOffsets({});
                        setDiagramNodeSizes({});
                        setDiagramOffset({ x: 0, y: 0 });
                        requestDiagramLayout();
                      }}
                    >
                      Auto-layout
                    </button>
                    <button type="button" className="ghost" onClick={() => setDiagramScale((s) => Math.min(2.0, s + 0.1))}>+</button>
                    <button type="button" className="ghost" onClick={() => setDiagramScale((s) => Math.max(0.4, s - 0.1))}>-</button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        setDiagramScale(1);
                        setDiagramOffset({ x: 0, y: 0 });
                      }}
                    >
                      Reset
                    </button>
                  </div>
                </div>
                <div
                  className="diagram-body"
                  ref={diagramBodyRef}
                  onPointerDown={(event) => {
                    const target = event.target as HTMLElement | null;
                    if (target?.closest(".diagram-node") || target?.closest(".diagram-viewport")) return;
                    diagramPanRef.current = {
                      x: diagramOffset.x,
                      y: diagramOffset.y,
                      startX: event.clientX,
                      startY: event.clientY,
                    };
                    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={(event) => {
                    if (!diagramPanRef.current) return;
                    const deltaX = event.clientX - diagramPanRef.current.startX;
                    const deltaY = event.clientY - diagramPanRef.current.startY;
                    diagramPanPendingRef.current = {
                      x: diagramPanRef.current.x + deltaX,
                      y: diagramPanRef.current.y + deltaY,
                    };
                    if (diagramPanRafRef.current == null) {
                      diagramPanRafRef.current = window.requestAnimationFrame(() => {
                        if (diagramPanPendingRef.current) {
                          setDiagramOffset(diagramPanPendingRef.current);
                        }
                        diagramPanPendingRef.current = null;
                        diagramPanRafRef.current = null;
                      });
                    }
                  }}
                  onPointerUp={() => {
                    diagramPanRef.current = null;
                  }}
                >
                  {diagramLayout ? (
                    <>
                      <div
                        className="diagram-canvas"
                        style={{
                          transform: `translate(${diagramOffset.x}px, ${diagramOffset.y}px) scale(${diagramScale})`,
                        }}
                      >
                        {renderDiagramLayout(diagramLayout)}
                        {diagramManualNodes.map((node) => renderManualNode(node))}
                      </div>
                      {paletteGhost ? (
                        <div
                          className="diagram-ghost"
                          style={{ left: `${paletteGhost.x}px`, top: `${paletteGhost.y}px` }}
                        >
                          {renderTypeIcon(paletteGhost.type, "diagram")}
                        </div>
                      ) : null}
                      <div
                        className="diagram-palette"
                        style={{ left: `${palettePos.x}px`, top: `${palettePos.y}px` }}
                      >
                        <div
                          className="diagram-palette-header"
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            paletteDragRef.current = {
                              startX: event.clientX,
                              startY: event.clientY,
                              baseX: palettePos.x,
                              baseY: palettePos.y,
                            };
                            (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
                          }}
                        >
                          Palette
                        </div>
                        <button
                          type="button"
                          className="diagram-palette-item"
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            paletteCreateRef.current = { type: "package", name: "Package", startX: event.clientX, startY: event.clientY };
                            setPaletteGhost({ x: event.clientX, y: event.clientY, type: "package" });
                            (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
                          }}
                        >
                          {renderTypeIcon("package", "diagram")}
                          <span>Package</span>
                        </button>
                      </div>
                      <div className="diagram-minimap">
                        {diagramLayout ? (
                          <div className="diagram-minimap-canvas">
                            <div
                              className="diagram-minimap-scale"
                              style={{
                                transform: `scale(${140 / Math.max(diagramLayout.width * diagramScale, 1)}, ${100 / Math.max(diagramLayout.height * diagramScale, 1)})`,
                              }}
                            >
                              {renderMinimapLayout(diagramLayout)}
                            </div>
                          </div>
                        ) : null}
                        <div
                          className="diagram-viewport"
                          style={{
                            left: `${diagramViewport.x}px`,
                            top: `${diagramViewport.y}px`,
                            width: `${diagramViewport.width}px`,
                            height: `${diagramViewport.height}px`,
                          }}
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            diagramViewportRef.current = {
                              startX: event.clientX,
                              startY: event.clientY,
                              baseX: diagramViewport.x,
                              baseY: diagramViewport.y,
                            };
                            (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
                          }}
                          onPointerMove={(event) => {
                            if (!diagramViewportRef.current || !diagramLayout || !diagramBodyRef.current) return;
                            const deltaX = event.clientX - diagramViewportRef.current.startX;
                            const deltaY = event.clientY - diagramViewportRef.current.startY;
                            const nextX = Math.min(140 - diagramViewport.width, Math.max(0, diagramViewportRef.current.baseX + deltaX));
                            const nextY = Math.min(100 - diagramViewport.height, Math.max(0, diagramViewportRef.current.baseY + deltaY));
                            const canvasWidth = diagramLayout.width * diagramScale;
                            const canvasHeight = diagramLayout.height * diagramScale;
                            const miniScaleX = 140 / Math.max(canvasWidth, 1);
                            const miniScaleY = 100 / Math.max(canvasHeight, 1);
                            setDiagramOffset({
                              x: -nextX / miniScaleX,
                              y: -nextY / miniScaleY,
                            });
                          }}
                          onPointerUp={() => {
                            diagramViewportRef.current = null;
                          }}
                        />
                      </div>
                    </>
                  ) : (
                    <div className="diagram-placeholder">
                      No symbols found for {activeDiagramPath ? activeDiagramPath.split(/[\\/]/).pop() : "file"}.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
          <div
            className={`splitter ${rightCollapsed ? "collapsed" : ""}`}
            onPointerDown={rightCollapsed ? undefined : (event) => startDrag("right", event)}
          >
            {rightCollapsed ? (
              <button
                type="button"
                className="splitter-toggle"
                onClick={() => {
                  setRightCollapsed(false);
                  setRightWidth(rightStoredWidthRef.current || 320);
                }}
                title="Restore model pane"
              >
                «
              </button>
            ) : null}
          </div>
          {rightCollapsed ? null : (
            <section className="panel sidebar">
              <div className="panel-header">
              <button type="button" className="ghost" onClick={() => setCollapseAllModel((prev) => !prev)}>
                {collapseAllModel ? "Expand all" : "Collapse all"}
              </button>
              <button
                type="button"
                className={`ghost icon-properties ${showPropertiesPane ? "active" : ""}`}
                onClick={() => setShowPropertiesPane((prev) => !prev)}
                aria-label="Toggle properties"
                title={showPropertiesPane ? "Hide properties" : "Show properties"}
              />
              <button
                type="button"
                className="ghost collapse-btn"
                onClick={() => {
                  rightStoredWidthRef.current = rightWidth;
                  setRightCollapsed(true);
                }}
                title="Collapse model pane"
              >
                »
              </button>
            </div>
            <div
              className={`model-pane ${showPropertiesPane ? "" : "no-properties"}`}
              style={{ ["--model-tree-height" as string]: `${modelTreeHeight}px` }}
            >
              <div
                className="model-tree"
                ref={modelTreeRef}
                tabIndex={0}
                onKeyDown={handleModelTreeKeyDown}
                onMouseDown={() => {
                  if (document.activeElement !== modelTreeRef.current) {
                    modelTreeRef.current?.focus();
                  }
                }}
                onFocus={() => {
                  if (modelCursorIndex != null || !modelRows.length) return;
                  const selectedIndex = findSelectedSymbolIndex();
                  setModelCursorIndex(selectedIndex >= 0 ? selectedIndex : 0);
                }}
              >
                <List
                  listRef={modelListRef}
                  rowCount={modelRows.length}
                  rowHeight={(index) => getModelRowHeight(modelRows[index])}
                  rowComponent={renderModelRow}
                  rowProps={{ rows: modelRows }}
                  overscanCount={6}
                  style={{ height: modelListHeight, width: "100%" }}
                />
              </div>
              {showPropertiesPane ? (
                <>
                  <div className="h-splitter" onPointerDown={(event) => startDrag("model", event)} />
                  <div className="properties-pane">
                    <div className="properties-header" />
                    {selectedSymbol ? (
                      <div className="properties-body">
                        <div className="properties-title">
                          <span>{selectedSymbol.name}</span>
                          <span className="model-kind">{selectedSymbol.kind}</span>
                        </div>
                        {selectedSymbol.doc ? <div className="properties-doc">{selectedSymbol.doc}</div> : null}
                        <div className="properties-list">
                          {selectedSymbol.properties.length ? (
                            selectedSymbol.properties.map((prop, index) => (
                              <div key={`${prop.name}-${index}`} className="properties-row">
                                <div className="properties-key">{prop.label}</div>
                                <div className="properties-value">
                                  {"type" in prop.value && prop.value.type === "text" ? prop.value.value : null}
                                  {"type" in prop.value && prop.value.type === "bool" ? (prop.value.value ? "true" : "false") : null}
                                  {"type" in prop.value && prop.value.type === "number" ? String(prop.value.value) : null}
                                  {"type" in prop.value && prop.value.type === "list" ? prop.value.items.join(", ") : null}
                                </div>
                              </div>
                            ))
                          ) : (
                            <div className="muted">No properties.</div>
                          )}
                        </div>
                        <details className="properties-section" key={`parse-${selectedSymbol.qualified_name}`}>
                          <summary>Parse information</summary>
                          <div className="properties-parse">
                            {selectedSymbol.file == null &&
                            selectedSymbol.start_line == null &&
                            selectedSymbol.start_col == null &&
                            selectedSymbol.end_line == null &&
                            selectedSymbol.end_col == null ? (
                              <div className="muted">No parse data available.</div>
                              ) : (
                                <>
                                  <div className="properties-row">
                                    <div className="properties-key">File id</div>
                                    <div className="properties-value">
                                      {selectedSymbol.file == null ? "—" : String(selectedSymbol.file)}
                                    </div>
                                  </div>
                                  <div className="properties-row">
                                    <div className="properties-key">File path</div>
                                    <div className="properties-value">{selectedSymbol.file_path ?? "—"}</div>
                                  </div>
                                <div className="properties-row">
                                  <div className="properties-key">Start line</div>
                                  <div className="properties-value">{selectedSymbol.start_line ?? "—"}</div>
                                </div>
                                <div className="properties-row">
                                  <div className="properties-key">Start column</div>
                                  <div className="properties-value">{selectedSymbol.start_col ?? "—"}</div>
                                </div>
                                <div className="properties-row">
                                  <div className="properties-key">End line</div>
                                  <div className="properties-value">{selectedSymbol.end_line ?? "—"}</div>
                                </div>
                                <div className="properties-row">
                                  <div className="properties-key">End column</div>
                                  <div className="properties-value">{selectedSymbol.end_col ?? "—"}</div>
                                </div>
                              </>
                            )}
                          </div>
                        </details>
                      </div>
                    ) : (
                      <div className="muted">Select a model element to view its properties.</div>
                    )}
                  </div>
                </>
              ) : null}
            </div>
            </section>
          )}
      </main>
        {tabMenu ? (
          <div className="context-menu tab-menu" style={{ left: tabMenu.x, top: tabMenu.y }}>
            <button
              type="button"
              onClick={() => {
                closeTab(tabMenu.path);
                setTabMenu(null);
              }}
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => {
                closeOtherTabs(tabMenu.path);
                setTabMenu(null);
              }}
              disabled={openTabs.length <= 1}
            >
              Close Others
            </button>
            <button
              type="button"
              onClick={() => {
                closeAllTabs();
                setTabMenu(null);
              }}
              disabled={!openTabs.length}
            >
              Close All
            </button>
          </div>
        ) : null}
        {contextMenu ? (
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
            {contextMenu.scope === "root" ? (
              <>
                <button type="button" onClick={() => handleContextAction("new-file")}>New file</button>
                <button type="button" onClick={() => handleContextAction("new-folder")}>New folder</button>
              </>
            ) : (
              <>
                {contextMenu.entry.is_dir ? (
                  <>
                    <button type="button" onClick={() => handleContextAction("new-file")}>New file</button>
                    <button type="button" onClick={() => handleContextAction("new-folder")}>New folder</button>
                    <button type="button" onClick={() => handleContextAction("open-project")}>Open As Project</button>
                  </>
                ) : null}
                <button type="button" onClick={() => handleContextAction("show-in-explorer")}>Show in Explorer</button>
                <button type="button" onClick={() => handleContextAction("rename")}>Rename</button>
              </>
            )}
          </div>
        ) : null}
          {showNewFile ? (
            <div className="modal">
              <div className="modal-card">
                <div className="modal-header">
                  <span>New File</span>
                  <button type="button" onClick={() => setShowNewFile(false)}>Close</button>
                </div>
                <div className="modal-body">
                <label className="field">
                  <span>Name</span>
                  <input value={newFileName} onChange={(e) => setNewFileName(e.target.value)} />
                </label>
                <label className="field">
                  <span>Type</span>
                  <select value={newFileType} onChange={(e) => setNewFileType(e.target.value)}>
                    <option value="sysml">.sysml</option>
                    <option value="kerml">.kerml</option>
                  </select>
                </label>
                <div className="field">
                  <span>Parent</span>
                  <div className="field-value">{newFileParent || rootPath || "—"}</div>
                </div>
              </div>
                <div className="modal-actions">
                  <button type="button" className="ghost" onClick={() => setShowNewFile(false)}>Cancel</button>
                  <button type="button" onClick={createNewFile}>Create</button>
                </div>
              </div>
            </div>
          ) : null}
        {showNewProject ? (
          <div className="modal">
            <div className="modal-card">
              <div className="modal-header">
                <span>New Project</span>
              </div>
              <div className="modal-body">
              <label className="field">
                <span>Location</span>
                <div className="field-inline">
                  <input
                    value={newProjectLocation}
                    onChange={(event) => {
                      setNewProjectLocation(event.target.value);
                      void updateNewProjectFolderStatus();
                    }}
                  />
                  <button
                    type="button"
                    className="ghost"
                    onClick={async () => {
                      const selected = await open({ directory: true, multiple: false, defaultPath: newProjectLocation || undefined });
                      if (typeof selected === "string" && selected) {
                        setNewProjectLocation(selected);
                        void updateNewProjectFolderStatus();
                      }
                    }}
                  >
                    Browse
                  </button>
                </div>
              </label>
                <label className="field">
                  <span>Project Name</span>
                  <input
                    id="new-project-name"
                    value={newProjectName}
                    onChange={(event) => {
                      const value = event.target.value;
                      setNewProjectName(value);
                      const slug = slugifyProjectName(value);
                      setNewProjectFolder(slug);
                      void updateNewProjectFolderStatus();
                    }}
                    placeholder="My SysML Project"
                  />
                </label>
                <label className="field">
                  <span>Author</span>
                  <input
                    value={newProjectAuthor}
                    onChange={(event) => setNewProjectAuthor(event.target.value)}
                    placeholder="Your name"
                  />
                </label>
                <label className="field">
                  <span>Organization</span>
                  <input
                    value={newProjectOrganization}
                    onChange={(event) => setNewProjectOrganization(event.target.value)}
                    placeholder="Company or team"
                  />
                </label>
                <label className="field">
                  <span>Description</span>
                  <input
                    value={newProjectDescription}
                    onChange={(event) => setNewProjectDescription(event.target.value)}
                    placeholder="Short project summary"
                  />
                </label>
                <label className="field">
                  <span>Folder Name</span>
                  <div className="field-value">{newProjectFolder}</div>
                  <span className={`field-hint ${newProjectFolderStatus.includes("exists") ? "error" : ""}`}>{newProjectFolderStatus}</span>
                </label>
                <label className="field checkbox">
                  <input
                    type="checkbox"
                    checked={newProjectDefaultLib}
                    onChange={(event) => setNewProjectDefaultLib(event.target.checked)}
                  />
                  <span>Use default library</span>
                </label>
                {newProjectError ? <div className="field-hint error">{newProjectError}</div> : null}
              </div>
              <div className="modal-actions">
                <button type="button" className="ghost" onClick={() => setShowNewProject(false)}>Cancel</button>
                <button type="button" onClick={createNewProject} disabled={newProjectBusy || !newProjectFolderAvailable}>Create Project</button>
              </div>
            </div>
          </div>
        ) : null}
        {showOpenProject ? (
          <div className="modal">
            <div className="modal-card">
              <div className="modal-header">
                <span>Open Project</span>
              </div>
              <div className="modal-body">
                <label className="field">
                  <span>Project folder</span>
                  <div className="field-inline">
                    <input
                      value={openProjectPath}
                      onChange={(event) => setOpenProjectPath(event.target.value)}
                      placeholder="Select a project directory"
                    />
                    <button type="button" className="ghost" onClick={browseOpenProject}>Browse</button>
                  </div>
                </label>
                <label className="field">
                  <span>Recent</span>
                  <select
                    value=""
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value) {
                        setOpenProjectPath(value);
                      }
                    }}
                  >
                    <option value="">Select recent</option>
                    {recentProjects.map((path) => (
                      <option key={path} value={path}>{path}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="modal-actions">
                <button type="button" className="ghost" onClick={() => setShowOpenProject(false)}>Cancel</button>
                <button type="button" onClick={confirmOpenProject} disabled={!openProjectPath.trim()}>Open</button>
              </div>
            </div>
          </div>
        ) : null}
        {showExport ? (
        <div className="modal">
          <div className="modal-card">
            <div className="modal-header">
              <span>Export Model</span>
              <button type="button" onClick={() => setShowExport(false)}>Close</button>
            </div>
            <div className="modal-body">
              <label className="field">
                <span>Format</span>
                <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as "jsonld" | "kpar" | "xmi")}>
                  <option value="jsonld">JSON-LD</option>
                  <option value="kpar">KPAR</option>
                  <option value="xmi">XMI</option>
                </select>
              </label>
              <label className="field">
                <span>Output</span>
                <div className="field-inline">
                  <input value={exportPath} onChange={(event) => setExportPath(event.target.value)} placeholder="Select output file" />
                  <button
                    type="button"
                    className="ghost"
                    onClick={async () => {
                      const selected = await save({
                        defaultPath: exportPath || undefined,
                        filters: [
                          exportFormat === "jsonld"
                            ? { name: "JSON-LD", extensions: ["jsonld"] }
                            : exportFormat === "kpar"
                              ? { name: "KPAR", extensions: ["kpar"] }
                              : { name: "XMI", extensions: ["xmi"] },
                        ],
                      });
                      if (typeof selected === "string" && selected) {
                        setExportPath(selected);
                      }
                    }}
                  >
                    Browse
                  </button>
                </div>
              </label>
              <label className="field checkbox">
                <input
                  type="checkbox"
                  checked={exportIncludeStdlib}
                  onChange={(event) => setExportIncludeStdlib(event.target.checked)}
                />
                <span>Include standard library</span>
              </label>
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setShowExport(false)}>Cancel</button>
              <button type="button" onClick={runExportModel} disabled={exportBusy}>Export</button>
            </div>
          </div>
        </div>
      ) : null}
      {showAiSettings ? (
        <div className="modal">
          <div className="modal-backdrop" onClick={() => setShowAiSettings(false)} />
          <div className="modal-card modal-wide legacy-modal" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title">
            <div className="modal-header">
              <h3 id="ai-settings-title">AI Settings</h3>
            </div>
            <div className="modal-body">
              <div className="endpoint-list">
                {aiEndpoints.length ? (
                  aiEndpoints.map((endpoint) => (
                    <div key={endpoint.id} className="endpoint-row">
                      <div className="endpoint-main">
                        <div className="endpoint-title">{endpoint.name}</div>
                        <div className="endpoint-meta">{endpoint.type.toUpperCase()} • {endpoint.url}</div>
                        {endpoint.model ? <div className="endpoint-meta">Model: {endpoint.model}</div> : null}
                        {endpointTestStatus[endpoint.id] ? (
                          <div className={`endpoint-status ${endpointTestStatus[endpoint.id].startsWith("pass") ? "ok" : endpointTestStatus[endpoint.id].startsWith("fail") ? "fail" : ""}`}>
                            {endpointTestStatus[endpoint.id]}
                          </div>
                        ) : null}
                      </div>
                      <div className="endpoint-actions">
                        <button type="button" className="ghost" onClick={() => editEndpoint(endpoint.id)}>Edit</button>
                        <button type="button" className="ghost" onClick={() => deleteEndpoint(endpoint.id)}>Delete</button>
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
                      value={selectedChatEndpoint || ""}
                      onChange={(event) => setSelectedChatEndpoint(event.target.value || null)}
                    >
                      <option value="">None</option>
                      {aiEndpoints.filter((endpoint) => endpoint.type === "chat").map((endpoint) => (
                        <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="ghost"
                      disabled={!selectedChatEndpoint}
                      onClick={() => selectedChatEndpoint && testEndpoint(selectedChatEndpoint)}
                    >
                      Test
                    </button>
                  </div>
                </label>
                <label className="field">
                  <span className="field-label">Embeddings endpoint</span>
                  <div className="field-inline">
                    <select
                      value={selectedEmbeddingsEndpoint || ""}
                      onChange={(event) => setSelectedEmbeddingsEndpoint(event.target.value || null)}
                    >
                      <option value="">None</option>
                      {aiEndpoints.filter((endpoint) => endpoint.type === "embeddings").map((endpoint) => (
                        <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="ghost"
                      disabled={!selectedEmbeddingsEndpoint}
                      onClick={() => selectedEmbeddingsEndpoint && testEndpoint(selectedEmbeddingsEndpoint)}
                    >
                      Test
                    </button>
                  </div>
                </label>
              </div>
              <div className="endpoint-form">
                <div className="endpoint-form-title">{endpointDraft.id ? "Edit endpoint" : "Add endpoint"}</div>
                <label className="field">
                  <span className="field-label">Name</span>
                  <input value={endpointDraft.name} onChange={(e) => setEndpointDraft({ ...endpointDraft, name: e.target.value })} />
                </label>
                <label className="field">
                  <span className="field-label">URL</span>
                  <input value={endpointDraft.url} onChange={(e) => setEndpointDraft({ ...endpointDraft, url: e.target.value })} placeholder="https://api.openai.com" />
                </label>
                <label className="field">
                  <span className="field-label">Type</span>
                  <select value={endpointDraft.type} onChange={(e) => setEndpointDraft({ ...endpointDraft, type: e.target.value as "chat" | "embeddings" })}>
                    <option value="chat">Chat</option>
                    <option value="embeddings">Embeddings</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Model</span>
                  <input value={endpointDraft.model} onChange={(e) => setEndpointDraft({ ...endpointDraft, model: e.target.value })} />
                </label>
                <label className="field">
                  <span className="field-label">Token</span>
                  <input type="password" value={endpointDraft.token} onChange={(e) => setEndpointDraft({ ...endpointDraft, token: e.target.value })} />
                </label>
                <div className="modal-actions">
                  <button type="button" className="ghost" onClick={resetEndpointDraft}>Clear</button>
                  <button type="button" onClick={saveEndpointDraft}>{endpointDraft.id ? "Update" : "Add"}</button>
                </div>
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setShowAiSettings(false)}>Close</button>
            </div>
          </div>
        </div>
      ) : null}
      {showSettings ? (
        <div className="modal">
          <div className="modal-backdrop" onClick={() => setShowSettings(false)} />
          <div className="modal-card legacy-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="modal-header">
              <h3 id="settings-title">Settings</h3>
            </div>
            <div className="modal-body">
              <div className="field">
                <span className="field-label">Theme</span>
                <div className="theme-toggle">
                  <button
                    type="button"
                    className={`theme-option ${appTheme === "dark" ? "active" : ""}`}
                    onClick={() => setAppTheme("dark")}
                  >
                    Dark
                  </button>
                  <button
                    type="button"
                    className={`theme-option ${appTheme === "light" ? "active" : ""}`}
                    onClick={() => setAppTheme("light")}
                  >
                    Light
                  </button>
                </div>
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setShowSettings(false)}>Close</button>
            </div>
          </div>
        </div>
      ) : null}
        <footer className="statusbar">
          <div className="status-left" />
          <div className="status-right">
            {errorCounts.symbolCount ? (
              <span className="status-error-badge">{errorCounts.symbolCount}</span>
            ) : null}
            {cursorPos && activeEditorPath ? (
              <span className="status-cursor">Ln {cursorPos.line}, Col {cursorPos.col}</span>
            ) : null}
            <span
              className={`status-compile-indicator ${backgroundCompileRef.current ? "active" : ""} ${backgroundCompileEnabled ? "" : "disabled"}`}
              title={backgroundCompileEnabled ? "Background compile enabled (right-click to disable)" : "Background compile disabled (right-click to enable)"}
              onContextMenu={(event) => {
                event.preventDefault();
                setBackgroundCompileEnabled((prev) => !prev);
              }}
            >
              BG
            </span>
            {compileRunId ? (
              <button type="button" className="ghost" onClick={cancelCompile}>Cancel compile</button>
            ) : null}
          </div>
      </footer>
      {compileToast.open ? (
        <div className={`compile-toast ${compileToast.ok === false ? "error" : compileToast.ok ? "ok" : ""}`}>
          <div className="compile-toast-header">
            <span className={`compile-toast-title ${compileToast.ok === null ? "running" : ""}`}>
              <span className="compile-spinner" aria-hidden="true" />
              Compile
            </span>
            <button type="button" onClick={() => setCompileToast((prev) => ({ ...prev, open: false }))}>x</button>
          </div>
          <div className="compile-toast-body">
            {compileToast.lines.map((line, index) => (
              <div key={`${line}-${index}`}>{line}</div>
            ))}
            {compileToast.details.length ? (
              <div className="compile-toast-details">
                {compileToast.details.map((line, index) => (
                  <div key={`${line}-${index}`}>{line}</div>
                ))}
              </div>
            ) : null}
            {compileToast.parsedFiles.length ? (
              <div className="compile-toast-files">
                <div className="compile-toast-files-title">Reparsed files</div>
                {compileToast.parsedFiles.slice(0, 8).map((path) => (
                  <div key={path} className="compile-toast-file-path">{path}</div>
                ))}
                {compileToast.parsedFiles.length > 8 ? (
                  <div className="compile-toast-file-more">+{compileToast.parsedFiles.length - 8} more</div>
                ) : null}
              </div>
            ) : null}
            {compileToast.parseErrors.length ? (
              <div className="compile-toast-errors">
                <div className="compile-toast-errors-title">Parse errors</div>
                {compileToast.parseErrors.map((file) => (
                  <div key={file.path} className="compile-toast-error-item">
                    <div className="compile-toast-error-path">{file.path}</div>
                    <div className="compile-toast-error-count">{file.errors.length} issues</div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
