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
  const appWindow = getCurrentWindow();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [leftWidth, setLeftWidth] = useState(240);
  const [rightWidth, setRightWidth] = useState(320);
  const draggingRef = useRef<null | "left" | "right" | "model">(null);
  const startRef = useRef({ x: 0, y: 0, left: 240, right: 320, model: 260 });
  const [rootPath, setRootPath] = useState<string>(() => window.localStorage?.getItem(ROOT_STORAGE_KEY) || "");
  const [recentProjects, setRecentProjects] = useState<string[]>(() => loadRecents());
  const [treeEntries, setTreeEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, FileEntry[]>>({});
  const editorValueRef = useRef("");
  const editorChangeRafRef = useRef<number | null>(null);
  const [editorChangeTick, setEditorChangeTick] = useState(0);
  const [openTabs, setOpenTabs] = useState<Array<{ path: string; name: string; dirty: boolean }>>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [editorViewMode, setEditorViewMode] = useState<"text" | "diagram">("text");
  const [tabContent, setTabContent] = useState<Record<string, string>>({});
  const suppressDirtyRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  const [projectInfo, setProjectInfo] = useState<string>("");
  const [showProjectInfo, setShowProjectInfo] = useState(false);
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
  const [newProjectLocation, setNewProjectLocation] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectFolder, setNewProjectFolder] = useState("");
  const [newProjectFolderStatus, setNewProjectFolderStatus] = useState("");
  const [newProjectFolderAvailable, setNewProjectFolderAvailable] = useState(false);
  const [newProjectDefaultLib, setNewProjectDefaultLib] = useState(true);
  const [newProjectBusy, setNewProjectBusy] = useState(false);
  const [rightPaneMode, setRightPaneMode] = useState<"model" | "ai">("model");
  const [aiInput, setAiInput] = useState("");
  const [aiMessages, setAiMessages] = useState<{ role: "user" | "assistant"; text: string }[]>([]);
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
  const [compileStatus, setCompileStatus] = useState("Background compile: idle");
  const [compileRunId, setCompileRunId] = useState<number | null>(null);
  const backgroundCompileRef = useRef<number | null>(null);
  const [backgroundCompileEnabled, setBackgroundCompileEnabled] = useState(true);
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
  const parseReqRef = useRef(0);
  const pendingEditorContentRef = useRef<string | null>(null);
  const pendingEditorPathRef = useRef<string | null>(null);
  const editorOptions: Parameters<typeof MonacoEditor>[0]["options"] = {
    minimap: { enabled: false },
    fontSize: 14,
    fontFamily: "IBM Plex Mono, Consolas, 'Courier New', monospace",
    wordWrap: "on" as const,
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

  const buildProjectConfigText = (useDefaultLibrary: boolean) => {
    const base: { src: string[]; import: string[]; library?: string } = {
      src: ["**/*.sysml", "**/*.kerml"],
      import: ["**/*.sysmlx", "**/*.kermlx"],
    };
    if (useDefaultLibrary) {
      base.library = "default";
    }
    return JSON.stringify(base, null, 2);
  };

  const openNewProjectDialog = async () => {
    setNewProjectName("");
    setNewProjectFolder("");
    setNewProjectFolderStatus("");
    setNewProjectFolderAvailable(false);
    setNewProjectDefaultLib(true);
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
      setCompileStatus("Enter location, project name, and folder name");
      return;
    }
    const projectPath = `${location}\\${folder}`.replace(/[\\/]+/g, "\\");
    const projectFile = `${projectPath}\\.project.json`.replace(/[\\/]+/g, "\\");
    const config = buildProjectConfigText(newProjectDefaultLib);
    try {
      setNewProjectBusy(true);
      const exists = await invoke<boolean>("path_exists", { path: projectPath });
      if (exists) {
        setCompileStatus("Project folder already exists");
        setNewProjectFolderStatus("Folder already exists");
        setNewProjectFolderAvailable(false);
        setNewProjectBusy(false);
        return;
      }
      await invoke("write_file", { path: projectFile, content: config });
      rememberProjectLocation(location);
      setShowNewProject(false);
      setNewProjectBusy(false);
      await openProject(projectPath);
      setCompileStatus("Project created");
    } catch (error) {
      setNewProjectBusy(false);
      setCompileStatus(`Create project failed: ${error}`);
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
    if (rightPaneMode !== "model") return;
    const container = modelTreeRef.current;
    if (!container) return;
    const updateHeight = () => {
      setModelTreeViewportHeight(container.clientHeight);
    };
    updateHeight();
    const resizeObserver = new ResizeObserver(() => updateHeight());
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [rightPaneMode, modelTreeHeight, showPropertiesPane]);

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
    setRootPath(path);
    window.localStorage?.setItem(ROOT_STORAGE_KEY, path);
    const next = [path, ...recentProjects.filter((p) => p !== path)].slice(0, 8);
    setRecentProjects(next);
    saveRecents(next);
    await refreshRoot(path);
    void runBackgroundCompile(path);
  };

  const chooseProject = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string" && selected) {
      await openProject(selected);
    }
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
    const reqId = ++navReqRef.current;
    pendingNavRef.current = target;
    if (currentFilePath !== target.path) {
      const content = await invoke<string>("read_file", { path: target.path });
      if (reqId !== navReqRef.current) return;
      suppressDirtyRef.current = true;
      editorValueRef.current = content || "";
      if (editorRef.current) {
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
        return [...prev, { path: target.path, name, dirty: false }];
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
    setContextMenu({ x: event.clientX, y: event.clientY, entry });
  };

  const handleContextAction = async (action: string) => {
    const entry = contextMenu?.entry;
    if (!entry || !rootPath) return;
    if (action === "new-file") {
      openNewFileDialog(entry.is_dir ? entry.path : rootPath);
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
    } else if (action === "delete") {
      const ok = window.confirm(`Delete ${entry.name}?`);
      if (!ok) return;
      await invoke("delete_path", { root: rootPath, path: entry.path });
      await refreshRoot(rootPath);
    }
    setContextMenu(null);
  };

  const loadProjectInfo = async () => {
    if (!rootPath) return;
    try {
      const path = `${rootPath}\\.project.json`.replace(/[\\/]+/g, "\\");
      const raw = await invoke<string>("read_file", { path });
      setProjectInfo(raw || "");
    } catch {
      setProjectInfo("");
    }
    setShowProjectInfo(true);
  };

  const createNewFile = async () => {
    if (!rootPath || !newFileName) return;
    const parent = newFileParent || rootPath;
    const normRoot = rootPath.replace(/[\\/]+/g, "\\").toLowerCase();
    const normParent = parent.replace(/[\\/]+/g, "\\").toLowerCase();
    if (!normParent.startsWith(normRoot)) {
      setCompileStatus("New file path must be inside the project root");
      return;
    }
    const trimmed = newFileName.trim();
    const extension = newFileType === "kerml" ? ".kerml" : ".sysml";
    const finalName = trimmed.toLowerCase().endsWith(extension) ? trimmed : `${trimmed}${extension}`;
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
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [compileRunId]);

  const runCompile = async () => {
    if (!rootPath) return;
    const runId = Date.now();
    setCompileRunId(runId);
    setCompileStatus("Compile: starting...");
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
          root: rootPath,
          run_id: runId,
          allow_parse_errors: true,
          unsaved: [],
        },
      });
      setSymbols(response?.symbols || []);
      setUnresolved(response?.unresolved || []);
      setLibraryPath(response?.library_path ?? null);
      setCompileStatus(response?.ok ? "Compile: complete" : "Compile: finished with errors");
    } catch (error) {
      setCompileStatus(`Compile: failed: ${error}`);
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
      setSymbols(response?.symbols || []);
      setUnresolved(response?.unresolved || []);
      setLibraryPath(response?.library_path ?? null);
      setCompileStatus(response?.ok ? "Background compile: complete" : "Background compile: finished with errors");
    } catch (error) {
      setCompileStatus(`Background compile: failed: ${error}`);
    } finally {
      backgroundCompileRef.current = null;
    }
  };

  const runBackgroundCompileWithUnsaved = async (path: string, filePath: string, content: string) => {
    if (!backgroundCompileEnabled || !path || compileRunId || backgroundCompileRef.current) return;
    const runId = Date.now();
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
      setSymbols(response?.symbols || []);
      setUnresolved(response?.unresolved || []);
      setLibraryPath(response?.library_path ?? null);
      setCompileStatus(response?.ok ? "Background compile: complete" : "Background compile: finished with errors");
    } catch (error) {
      setCompileStatus(`Background compile: failed: ${error}`);
    } finally {
      backgroundCompileRef.current = null;
    }
  };

  const handleEditorMount: OnMount = (editorInstance, monaco) => {
    editorRef.current = editorInstance;
    monacoRef.current = monaco;
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
    monaco.editor.setTheme("vs-dark");
    editorInstance.focus();
  };

  useEffect(() => {
    if (!activeTabPath) return;
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
      }>("get_parse_errors_for_content", { path: activeTabPath, content: editorValueRef.current })
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
  }, [editorChangeTick, activeTabPath]);

  useEffect(() => {
    if (!rootPath || !activeTabPath) return;
    const timer = window.setTimeout(() => {
      void runBackgroundCompileWithUnsaved(rootPath, activeTabPath, editorValueRef.current);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [editorChangeTick, activeTabPath, rootPath]);

  const selectSymbolInEditor = async (symbol: typeof symbols[number]) => {
    if (!symbol) return;
    if (symbol.name?.startsWith("<anon")) return;
    if (!symbol.file_path) return;
    await navigateTo({
      path: symbol.file_path,
      name: symbol.file_path.split(/[\\/]/).pop() || "Untitled",
      selection: {
        startLine: symbol.start_line || 1,
        startCol: symbol.start_col || 1,
        endLine: symbol.end_line || symbol.start_line || 1,
        endCol: symbol.end_col || symbol.start_col || 1,
      },
    });
  };

  const selectTab = async (path: string) => {
    if (path === activeTabPath) return;
    await navigateTo({ path });
  };

  useEffect(() => {
    if (!currentFilePath || !editorRef.current) return;
    const pending = pendingNavRef.current;
    if (!pending || pending.path !== currentFilePath) return;
    pendingNavRef.current = null;
    applyEditorSelection(editorRef.current, pending.selection);
    editorRef.current.focus();
  }, [currentFilePath]);

  const closeTab = (path: string) => {
    navReqRef.current += 1;
    pendingNavRef.current = null;
    setOpenTabs((prev) => prev.filter((tab) => tab.path !== path));
    if (activeTabPath === path) {
      const remaining = openTabs.filter((tab) => tab.path !== path);
      const next = remaining[remaining.length - 1];
      if (next) {
        void selectTab(next.path);
      } else {
        setActiveTabPath(null);
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
    editorValueRef.current = "";
    if (editorRef.current) {
      editorRef.current.setValue("");
    }
    setCurrentFilePath(null);
  };

  const closeOtherTabs = (path: string) => {
    navReqRef.current += 1;
    pendingNavRef.current = null;
    setOpenTabs((prev) => prev.filter((tab) => tab.path === path));
    setActiveTabPath(path);
  };

  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  const showTabMenu = (event: React.MouseEvent, path: string) => {
    event.preventDefault();
    setTabMenu({ x: event.clientX, y: event.clientY, path });
  };

  const saveActiveTab = async () => {
    if (!activeTabPath) return;
    await invoke("write_file", { path: activeTabPath, content: editorValueRef.current });
    setOpenTabs((prev) => prev.map((tab) => (tab.path === activeTabPath ? { ...tab, dirty: false } : tab)));
    setTabContent((prev) => ({ ...prev, [activeTabPath]: editorValueRef.current }));
  };

  useEffect(() => {
    if (!activeTabPath) return;
    if (suppressDirtyRef.current) {
      suppressDirtyRef.current = false;
      setOpenTabs((prev) =>
        prev.map((tab) =>
          tab.path === activeTabPath ? { ...tab, dirty: false } : tab,
        ),
      );
      return;
    }
    const baseline = tabContent[activeTabPath] ?? "";
    const isDirty = editorValueRef.current !== baseline;
    setOpenTabs((prev) =>
      prev.map((tab) =>
        tab.path === activeTabPath ? { ...tab, dirty: isDirty } : tab,
      ),
    );
  }, [editorChangeTick]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const isSave = (event.ctrlKey || event.metaKey) && key === "s";
      if (isSave) {
        event.preventDefault();
        void saveActiveTab();
        return;
      }
      if (event.key === "F10") {
        event.preventDefault();
        setEditorViewMode((prev) => (prev === "text" ? "diagram" : "text"));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTabPath]);

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

  const normalizeEndpointUrl = (base: string, suffix: string) => {
    const trimmed = base.replace(/\/+$/, "");
    if (trimmed.endsWith("/v1")) {
      return `${trimmed}${suffix}`;
    }
    return `${trimmed}/v1${suffix}`;
  };

  const testEndpoint = async (endpointId: string) => {
    const endpoint = aiEndpoints.find((item) => item.id === endpointId);
    if (!endpoint) return;
    setEndpointTestStatus((prev) => ({ ...prev, [endpointId]: "testing..." }));
    try {
      const url =
        endpoint.type === "chat"
          ? normalizeEndpointUrl(endpoint.url, "/chat/completions")
          : normalizeEndpointUrl(endpoint.url, "/embeddings");
      const payload =
        endpoint.type === "chat"
          ? {
              model: endpoint.model || "gpt-4o-mini",
              messages: [{ role: "user", content: "ping" }],
              max_tokens: 1,
            }
          : {
              model: endpoint.model || "text-embedding-3-small",
              input: "ping",
            };
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const detail = await response.text();
        setEndpointTestStatus((prev) => ({ ...prev, [endpointId]: `fail: ${response.status} ${detail}` }));
        return;
      }
      setEndpointTestStatus((prev) => ({ ...prev, [endpointId]: "pass" }));
    } catch (error) {
      setEndpointTestStatus((prev) => ({ ...prev, [endpointId]: `fail: ${String(error)}` }));
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
      "No project symbols.",
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
  ]);

  const modelListRef = useRef<ListImperativeAPI | null>(null);
  const getModelRowHeight = (row: ModelRow) => {
    if (row.type === "section") return 28;
    if (row.type === "error") return 64;
    if (row.type === "empty") return 24;
    return 24;
  };

  const modelListHeight = Math.max(120, (modelTreeViewportHeight || modelTreeHeight) - 16);

  const renderModelRow = ({ index, style, rows }: RowComponentProps<{ rows: ModelRow[] }>) => {
    const row = rows[index];
    if (!row) return null;
    if (row.type === "section") {
      const isOpen = modelSectionOpen[row.section];
      return (
        <div
          style={style}
          className="model-section-row"
          role="button"
          tabIndex={0}
          onClick={() => setModelSectionOpen((prev) => ({ ...prev, [row.section]: !isOpen }))}
        >
          <span className="model-section-toggle">{isOpen ? "-" : "+"}</span>
          <span className="model-section-label">{row.label}</span>
          <span className="model-section-count">{row.countLabel}</span>
        </div>
      );
    }
    if (row.type === "empty") {
      return (
        <div style={style} className="model-empty-row">
          {row.text}
        </div>
      );
    }
    if (row.type === "error") {
      const issue = row.issue;
      return (
        <div
          style={style}
          className="error-row"
          role="button"
          tabIndex={0}
          onClick={() => {
            const path = issue.file_path;
            if (!path) return;
            const entry = { path, name: path.split(/[\\/]/).pop() || path, is_dir: false };
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
          onKeyDown={(event) => {
            if (event.key === "Enter") {
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
            }
          }}
        >
          <div className="error-title">{issue.file_path}:{issue.line}:{issue.column}</div>
          <div className="error-message">{issue.message}</div>
        </div>
      );
    }
    const symbol = row.node.symbols[0];
    return (
      <div
        style={{ ...style, paddingLeft: `${8 + row.depth * 14}px` }}
        className="model-virtual-row"
        role="button"
        tabIndex={0}
        onClick={(event) => {
          event.stopPropagation();
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
    if (!activeTabPath) return [];
    return deferredSymbols.filter((symbol) => symbol.file_path === activeTabPath);
  }, [deferredSymbols, activeTabPath]);

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
        onClick={() => {
          if (symbol) {
            setSelectedSymbol(symbol);
            void selectSymbolInEditor(symbol);
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
        ["--left-width" as string]: `${leftWidth}px`,
        ["--right-width" as string]: `${rightWidth}px`,
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
                  <button type="button" onClick={() => appWindow.close()}>Exit</button>
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
              <button type="button">Logs</button>
            </div>
              ) : null}
            </div>
            <div className="menu-item">
              <button type="button" className="menu-button" onClick={() => setOpenMenu(openMenu === "Compile" ? null : "Compile")}>Compile</button>
              {openMenu === "Compile" ? (
            <div className="menu-dropdown" data-tauri-drag-region="false">
              <button type="button" onClick={runCompile}>Compile Workspace</button>
              <button type="button" onClick={openExportDialog}>Export Model</button>
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
            className="titlebar-btn"
            data-tauri-drag-region="false"
            aria-label="Minimize"
            onClick={() => { void invoke("window_minimize"); }}
          >
            -
          </button>
          <button
            type="button"
            className="titlebar-btn"
            data-tauri-drag-region="false"
            aria-label="Maximize"
            onClick={() => { void invoke("window_toggle_maximize"); }}
          >
            [ ]
          </button>
          <button
            type="button"
            className="titlebar-btn close"
            data-tauri-drag-region="false"
            aria-label="Close"
            onClick={() => { void invoke("window_close"); }}
          >
            x
          </button>
        </div>
      </header>
      <main className="content">
        <section className="panel sidebar">
          <div className="panel-header">
            <span>Project</span>
          </div>
          <div className="project-actions inline">
            <button type="button" className="ghost" onClick={loadProjectInfo}>Info</button>
            <button type="button" className="icon-button" onClick={chooseProject} aria-label="Open Project" title="Open Project" />
            <select value="" onChange={(e) => openProject(e.target.value)}>
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
          <div className="file-tree">{tree}</div>
        </section>
        <div className="splitter" onPointerDown={(event) => startDrag("left", event)} />
        <section className="panel editor">
          <div className="panel-header editor-tabs">
            <div className="tabs">
              {openTabs.length ? (
                openTabs.map((tab) => (
                  <button
                    key={tab.path}
                    type="button"
                    className={`tab ${tab.path === activeTabPath ? "active" : ""}`}
                    onClick={() => selectTab(tab.path)}
                    onContextMenu={(event) => showTabMenu(event, tab.path)}
                  >
                    <span className="tab-label">{tab.name}</span>
                    {tab.dirty ? <span className="tab-dirty" aria-hidden="true">•</span> : null}
                    <span className="tab-close" onClick={(event) => { event.stopPropagation(); closeTab(tab.path); }}>x</span>
                  </button>
                ))
              ) : (
                <div className="muted">No files open.</div>
              )}
            </div>
            {openTabs.length > 6 ? (
              <select className="tab-dropdown" value={activeTabPath || ""} onChange={(event) => selectTab(event.target.value)}>
                {openTabs.map((tab) => (
                  <option key={tab.path} value={tab.path}>{tab.name}</option>
                ))}
              </select>
            ) : null}
          </div>
          <div className="editor-host" id="monaco-root">
            {!activeTabPath ? (
              <div className="editor-placeholder">Open a file to start editing.</div>
            ) : editorViewMode === "text" ? (
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
                theme="vs-dark"
                onMount={handleEditorMount}
                options={editorOptions}
              />
            ) : (
              <div className="diagram-surface">
                <div className="diagram-header">
                  <span>Diagram view (F10 to toggle)</span>
                  <div className="diagram-controls">
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
                      No symbols found for {activeTabPath ? activeTabPath.split(/[\\/]/).pop() : "file"}.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
        <div className="splitter" onPointerDown={(event) => startDrag("right", event)} />
        <section className="panel sidebar">
          <div className="panel-header">
            <button
              type="button"
              className="ghost toggle-btn"
              onClick={() => setRightPaneMode(rightPaneMode === "ai" ? "model" : "ai")}
            >
              {rightPaneMode === "ai" ? "AI" : "Model"}
            </button>
            {rightPaneMode === "model" ? (
              <button type="button" className="ghost" onClick={() => setCollapseAllModel((prev) => !prev)}>
                {collapseAllModel ? "Expand all" : "Collapse all"}
              </button>
            ) : null}
            {rightPaneMode === "model" ? (
              <button
                type="button"
                className={`ghost icon-properties ${showPropertiesPane ? "active" : ""}`}
                onClick={() => setShowPropertiesPane((prev) => !prev)}
                aria-label="Toggle properties"
                title={showPropertiesPane ? "Hide properties" : "Show properties"}
              />
            ) : null}
            {rightPaneMode === "ai" ? (
              <button type="button" className="ghost icon-gear" onClick={() => setShowAiSettings(true)} aria-label="AI settings" title="AI settings" />
            ) : null}
          </div>
          {rightPaneMode === "model" ? (
            <div
              className={`model-pane ${showPropertiesPane ? "" : "no-properties"}`}
              style={{ ["--model-tree-height" as string]: `${modelTreeHeight}px` }}
            >
              <div
                className="model-tree"
                ref={modelTreeRef}
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
          ) : (
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
                    setAiMessages((prev) => [...prev, { role: "user", text }, { role: "assistant", text: "..." }]);
                    setAiInput("");
                  }}
                >
                  Send
                </button>
              </div>
            </div>
          )}
        </section>
      </main>
      {contextMenu ? (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {contextMenu.entry.is_dir ? (
            <button type="button" onClick={() => handleContextAction("open-project")}>Open As Project</button>
          ) : null}
          <button type="button" onClick={() => handleContextAction("new-file")}>New file</button>
          <button type="button" onClick={() => handleContextAction("new-folder")}>New folder</button>
          <button type="button" onClick={() => handleContextAction("rename")}>Rename</button>
          <button type="button" onClick={() => handleContextAction("delete")}>Delete</button>
        </div>
      ) : null}
      {tabMenu ? (
        <div className="context-menu tab-menu" style={{ left: tabMenu.x, top: tabMenu.y }}>
          <button type="button" onClick={() => { closeTab(tabMenu.path); setTabMenu(null); }}>Close</button>
          <button type="button" onClick={() => { closeOtherTabs(tabMenu.path); setTabMenu(null); }}>Close others</button>
          <button type="button" onClick={() => { closeAllTabs(); setTabMenu(null); }}>Close all</button>
        </div>
      ) : null}
      {showProjectInfo ? (
        <div className="modal">
          <div className="modal-card">
            <div className="modal-header">
              <span>Project Info</span>
              <button type="button" onClick={() => setShowProjectInfo(false)}>Close</button>
            </div>
            <div className="modal-body">
              {projectInfo ? (
                <pre className="file-preview">{projectInfo}</pre>
              ) : (
                <div className="muted">No .project.json found.</div>
              )}
            </div>
          </div>
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
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setShowNewProject(false)}>Cancel</button>
              <button type="button" onClick={createNewProject} disabled={newProjectBusy || !newProjectFolderAvailable}>Create Project</button>
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
      <footer className="statusbar">
        <div className="status-left">{compileStatus}</div>
        <div className="status-right">
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
          {errorCounts.symbolCount ? (
            <span className="status-error-badge">{errorCounts.symbolCount}</span>
          ) : null}
          {compileRunId ? (
            <button type="button" className="ghost" onClick={cancelCompile}>Cancel compile</button>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
