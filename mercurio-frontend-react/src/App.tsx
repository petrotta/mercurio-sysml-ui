import "./style.css";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import MonacoEditor, { loader, type OnMount } from "@monaco-editor/react";
import { listen } from "@tauri-apps/api/event";
import {
  AI_CHAT_KEY,
  AI_EMBEDDINGS_KEY,
  AI_ENDPOINTS_KEY,
  PROJECT_DESCRIPTOR_TAB,
  PROJECT_LOCATION_KEY,
  ROOT_STORAGE_KEY,
  THEME_KEY,
} from "./app/constants";
import { loadRecents, saveRecents } from "./app/storage";
import { useEditorState } from "./app/editorState";
import { AiView } from "./app/components/AiView";
import { ModelPane } from "./app/components/ModelPane";
import { ModelHeader } from "./app/components/ModelHeader";
import { EditorPane } from "./app/components/EditorPane";
import { ProjectTree } from "./app/components/ProjectTree";
import { DataView } from "./app/components/DataView";
import { DescriptorView } from "./app/components/DescriptorView";
import { DiagramView } from "./app/components/DiagramView";
import { getKindKey, renderTypeIcon } from "./app/diagramIcons";
import { useModelTracking } from "./app/useModelTracking";
import { useDiagramView } from "./app/useDiagramView";
import { useModelTree } from "./app/useModelTree";
import { useModelTreeSelection } from "./app/useModelTreeSelection";
import { createModelRowRenderer } from "./app/modelRowRenderer";
import { useModelGroups } from "./app/useModelGroups";
import { useTabs } from "./app/useTabs";
import { useEditorNavigation } from "./app/useEditorNavigation";
import { useCompileRunner } from "./app/useCompileRunner";
import type { FileEntry, OpenTab, SymbolView } from "./app/types";

loader.config({ paths: { vs: "/monaco/vs" } });

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
  const {
    editorValueRef,
    editorChangeTick,
    cursorPos,
    updateCursorPos,
    onEditorChange,
    activeDoc,
    setActiveEditorDoc,
    updateDocContent,
    queuePendingEditorContent,
    clearPendingEditorContent,
    consumePendingEditorContent,
    markSaved,
    getDoc,
    currentFilePathRef,
  } = useEditorState();
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const activeTabPathRef = useRef<string | null>(null);
  const [descriptorViewMode, setDescriptorViewMode] = useState<"view" | "json">("view");
  const suppressDirtyRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry; scope: "root" | "node" } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [tabOverflowOpen, setTabOverflowOpen] = useState(false);
  const [showProjectInfo, setShowProjectInfo] = useState(false);
  const [hasProjectDescriptor, setHasProjectDescriptor] = useState(false);
  const [gitInfo, setGitInfo] = useState<{
    repo_root: string;
    branch: string;
    ahead: number;
    behind: number;
    clean: boolean;
    remote_url?: string | null;
  } | null>(null);
  const [gitStatus, setGitStatus] = useState<{
    staged: string[];
    unstaged: string[];
    untracked: string[];
  } | null>(null);
  const [showGitDialog, setShowGitDialog] = useState(false);
  const [gitStatusBusy, setGitStatusBusy] = useState(false);
  const [gitStatusError, setGitStatusError] = useState("");
  const [gitCommitMessage, setGitCommitMessage] = useState("");
  const [gitCommitBusy, setGitCommitBusy] = useState(false);
  const [gitCommitError, setGitCommitError] = useState("");
  const [gitCommitSelection, setGitCommitSelection] = useState<Record<string, boolean>>({});
  const [gitCommitSectionsOpen, setGitCommitSectionsOpen] = useState({
    changes: true,
    unversioned: false,
  });
  const [gitPushBusy, setGitPushBusy] = useState(false);
  const [gitPushError, setGitPushError] = useState("");
  const [gitBranches, setGitBranches] = useState<string[]>([]);
  const [gitCurrentBranch, setGitCurrentBranch] = useState("");
  const [gitCreateBranchName, setGitCreateBranchName] = useState("");
  const [gitCreateBranchCheckout, setGitCreateBranchCheckout] = useState(true);
  const [gitCheckoutBranchName, setGitCheckoutBranchName] = useState("");
  const [gitBranchBusy, setGitBranchBusy] = useState(false);
  const [gitBranchError, setGitBranchError] = useState("");
  const [showGitBranchDialog, setShowGitBranchDialog] = useState(false);
  const [projectDescriptor, setProjectDescriptor] = useState<{
    name?: string | null;
    author?: string | null;
    description?: string | null;
    organization?: string | null;
    default_library: boolean;
    stdlib?: string | null;
    library?: { path: string } | string | null;
    src?: string[];
    import_entries?: string[];
    raw_json?: string;
  } | null>(null);
  const [showProjectProperties, setShowProjectProperties] = useState(false);
  const [projectPropertiesBusy, setProjectPropertiesBusy] = useState(false);
  const [projectPropertiesError, setProjectPropertiesError] = useState("");
  const [projectPropertiesDraft, setProjectPropertiesDraft] = useState({
    name: "",
    author: "",
    description: "",
    organization: "",
    src: [] as string[],
    import_entries: [] as string[],
  });
  const [projectFileInput, setProjectFileInput] = useState("");
  const [projectLibraryInput, setProjectLibraryInput] = useState("");
  const [projectStdlibMode, setProjectStdlibMode] = useState<"default" | "version" | "custom">("default");
  const [projectStdlibVersion, setProjectStdlibVersion] = useState("");
  const [projectStdlibPath, setProjectStdlibPath] = useState("");
  const [projectStdlibVersions, setProjectStdlibVersions] = useState<string[]>([]);
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
  // cursorPos is managed by useEditorState
  const [aiInput, setAiInput] = useState("");
  const [aiMessages, setAiMessages] = useState<Array<{
    role: "user" | "assistant";
    text: string;
    pendingId?: number;
    steps?: Array<{ kind: string; detail: string }>;
  }>>([]);
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [aiEndpoints, setAiEndpoints] = useState<Array<{
    id: string;
    name: string;
    url: string;
    type: "chat" | "embeddings";
    provider: "openai" | "anthropic";
    model: string;
    token: string;
  }>>(() => {
    try {
      const raw = window.localStorage?.getItem(AI_ENDPOINTS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.map((item: any) => ({
        ...item,
        provider: item?.provider === "anthropic" ? "anthropic" : "openai",
      }));
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
    provider: "openai" | "anthropic";
    model: string;
    token: string;
  }>({ name: "", url: "", type: "chat", provider: "openai", model: "", token: "" });
  const [endpointTestStatus, setEndpointTestStatus] = useState<Record<string, string>>({});
  const aiRequestRef = useRef(0);
  const {
    setCompileStatus,
    compileRunId,
    compileToast,
    setCompileToast,
    runCompile,
    cancelCompile,
    runBackgroundCompile,
    runBackgroundCompileWithUnsaved,
    cancelBackgroundCompile,
    backgroundCompileEnabled,
    setBackgroundCompileEnabled,
    backgroundCompileActive,
    symbols,
    unresolved,
    libraryPath,
    projectSymbolsLoaded,
  } = useCompileRunner({ rootPath });
  const [dataExcludeStdlib, setDataExcludeStdlib] = useState(true);
  const [selectedSymbol, setSelectedSymbol] = useState<SymbolView | null>(null);
  const [modelTreeHeight, setModelTreeHeight] = useState(260);
  const [collapseAllModel, setCollapseAllModel] = useState(false);
  const [showPropertiesPane, setShowPropertiesPane] = useState(true);
  const [trackText, setTrackText] = useState(false);
  const [modelExpanded, setModelExpanded] = useState<Record<string, boolean>>({});
  const [modelSectionOpen, setModelSectionOpen] = useState({ project: true, library: true, errors: true });
  const modelTreeRef = useRef<HTMLDivElement | null>(null);
  const modelPaneContainerRef = useRef<HTMLDivElement | null>(null);
  const [modelPaneHeight, setModelPaneHeight] = useState(0);
  const navReqRef = useRef(0);
  const pendingNavRef = useRef<{
    path: string;
    name?: string;
    selection?: { startLine: number; startCol: number; endLine: number; endCol: number };
  } | null>(null);
  const lastCompiledContentRef = useRef<Record<string, string>>({});
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const cursorListenerRef = useRef<null | { dispose: () => void }>(null);
  const parseReqRef = useRef(0);
    const editorOptions: Parameters<typeof MonacoEditor>[0]["options"] = {
      minimap: { enabled: false },
      fontSize: 14,
      fontFamily: "IBM Plex Mono, Consolas, 'Courier New', monospace",
      wordWrap: "on" as const,
      selectionHighlight: false,
      occurrencesHighlight: "off",
      automaticLayout: true,
    };
  const fsChangeTimerRef = useRef<number | null>(null);
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
    return null;
  }, [activeTabMeta]);

  useEffect(() => {
    document.body.classList.toggle("theme-light", appTheme === "light");
    window.localStorage?.setItem(THEME_KEY, appTheme);
    if (monacoRef.current) {
      monacoRef.current.editor.setTheme(appTheme === "light" ? "vs" : "vs-dark");
    }
  }, [appTheme]);


  useEffect(() => {
    activeTabPathRef.current = activeTabPath;
  }, [activeTabPath]);

  useEffect(() => {
    currentFilePathRef.current = activeDoc.path;
  }, [activeDoc, currentFilePathRef]);

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
        stdlib?: string | null;
        library?: { path: string } | string | null;
        src?: string[];
        import_entries?: string[];
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
      setGitInfo(null);
      return;
    }
    invoke<{
      name?: string | null;
      author?: string | null;
      description?: string | null;
      organization?: string | null;
      default_library: boolean;
      stdlib?: string | null;
      library?: { path: string } | string | null;
      src?: string[];
      import_entries?: string[];
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
    void refreshGitInfo(rootPath);
  }, [rootPath]);

  useEffect(() => {
    if (!rootPath) return;
    void runBackgroundCompile(rootPath);
  }, [rootPath, backgroundCompileEnabled]);

  useEffect(() => {
    if (!modelPaneContainerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setModelPaneHeight(Math.round(entry.contentRect.height));
    });
    observer.observe(modelPaneContainerRef.current);
    return () => observer.disconnect();
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

  const refreshGitInfo = async (path: string) => {
    if (!path) {
      setGitInfo(null);
      return;
    }
    try {
      const info = await invoke<{
        repo_root: string;
        branch: string;
        ahead: number;
        behind: number;
        clean: boolean;
        remote_url?: string | null;
      } | null>("detect_git_repo", { root: path });
      setGitInfo(info || null);
    } catch {
      setGitInfo(null);
    }
  };

  const openProject = async (path: string) => {
    if (!path) return;
    if (compileRunId) {
      await cancelCompile();
    }
    await cancelBackgroundCompile();
    closeAllTabs();
    setSelectedSymbol(null);
    setCenterView("file");
    setDescriptorViewMode("view");
    setProjectDescriptor(null);
    setHasProjectDescriptor(false);
    setGitInfo(null);
    setGitStatus(null);
    setRootPath(path);
    window.localStorage?.setItem(ROOT_STORAGE_KEY, path);
    const next = [path, ...recentProjects.filter((p) => p !== path)].slice(0, 8);
    setRecentProjects(next);
    saveRecents(next);
    await refreshRoot(path);
    void refreshGitInfo(path);
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
  const { navigateTo, applyEditorSelection } = useEditorNavigation({
    centerView,
    setCenterView,
    activeDocPath: activeDoc.path,
    getDoc,
    setActiveEditorDoc,
    queuePendingEditorContent,
    editorValueRef,
    suppressDirtyRef,
    editorRef,
    currentFilePathRef,
    activeTabPathRef,
    navReqRef,
    pendingNavRef,
    setActiveTabPath,
    setOpenTabs,
  });
  const {
    selectTab,
    openAiViewTab,
    openDataViewTab,
    openDiagramViewTab,
    reorderTabs,
    closeTab,
    closeAllTabs,
    closeOtherTabs,
  } = useTabs({
    openTabs,
    setOpenTabs,
    activeTabPath,
    setActiveTabPath,
    activeTabPathRef,
    setCenterView,
    setActiveEditorDoc,
    setDescriptorViewMode,
    setShowProjectInfo,
    setProjectDescriptor,
    setHasProjectDescriptor,
    clearPendingEditorContent,
    editorRef,
    suppressDirtyRef,
    navReqRef,
    pendingNavRef,
    selectedSymbol,
    setSelectedSymbol,
    navigateTo,
  });

  const openFile = async (entry: FileEntry) => {
    if (entry.is_dir) {
      void toggleExpand(entry);
      return;
    }
    if (entry.path.toLowerCase().endsWith(".diagram")) {
      openDiagramViewTab(entry.path);
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

  const openProjectProperties = async () => {
    if (!rootPath) {
      setCompileStatus("Open a project folder first.");
      return;
    }
    setProjectPropertiesError("");
    setProjectPropertiesBusy(true);
    try {
      const [descriptor, stdlibVersions] = await Promise.all([
        invoke<{
          name?: string | null;
          author?: string | null;
          description?: string | null;
          organization?: string | null;
          default_library: boolean;
          stdlib?: string | null;
          library?: { path: string } | string | null;
          src?: string[];
          import_entries?: string[];
          raw_json?: string;
        }>("ensure_project_descriptor", { root: rootPath }),
        invoke<string[]>("list_stdlib_versions"),
      ]);
      setProjectDescriptor(descriptor || null);
      setHasProjectDescriptor(!!descriptor);
      setProjectPropertiesDraft({
        name: descriptor?.name || "",
        author: descriptor?.author || "",
        description: descriptor?.description || "",
        organization: descriptor?.organization || "",
        src: descriptor?.src || [],
        import_entries: descriptor?.import_entries || [],
      });
      const library = descriptor?.library;
      if (library && typeof library === "object" && "path" in library) {
        setProjectStdlibMode("custom");
        setProjectStdlibPath(library.path || "");
        setProjectStdlibVersion("");
      } else if (typeof library === "string" && library.trim() && library.trim().toLowerCase() !== "default") {
        setProjectStdlibMode("custom");
        setProjectStdlibPath(library.trim());
        setProjectStdlibVersion("");
      } else if (descriptor?.stdlib && descriptor.stdlib.trim() && descriptor.stdlib.trim().toLowerCase() !== "default") {
        setProjectStdlibMode("version");
        setProjectStdlibVersion(descriptor.stdlib);
        setProjectStdlibPath("");
      } else {
        setProjectStdlibMode("default");
        setProjectStdlibVersion("");
        setProjectStdlibPath("");
      }
      setProjectStdlibVersions(Array.isArray(stdlibVersions) ? stdlibVersions : []);
      setShowProjectProperties(true);
    } catch (error) {
      setProjectPropertiesError(`Project properties failed: ${String(error)}`);
      setShowProjectProperties(true);
    } finally {
      setProjectPropertiesBusy(false);
    }
  };

  const openGitDialog = async () => {
    setShowGitDialog(true);
    setGitCommitError("");
    setGitPushError("");
    setGitCommitMessage("");
    setGitCommitSelection({});
    setGitCommitSectionsOpen({ changes: true, unversioned: false });
    if (!gitInfo) {
      setGitStatus(null);
      setGitStatusBusy(false);
      setGitStatusError("No git repository detected.");
      return;
    }
    setGitStatusBusy(true);
    setGitStatusError("");
    try {
      const status = await invoke<{
        staged: string[];
        unstaged: string[];
        untracked: string[];
      }>("git_status", { repoRoot: gitInfo.repo_root });
      setGitStatus(status);
      setGitCommitSelection((prev) => {
        if (Object.keys(prev).length) return prev;
        const next: Record<string, boolean> = {};
        status.staged.forEach((path) => {
          next[path] = true;
        });
        return next;
      });
    } catch (error) {
      setGitStatus(null);
      setGitStatusError(`Failed to load git status: ${String(error)}`);
    } finally {
      setGitStatusBusy(false);
    }
  };

  const copyRepoUrl = async () => {
    if (!gitInfo?.remote_url) return;
    try {
      await navigator.clipboard.writeText(gitInfo.remote_url);
    } catch {
      // No-op for now.
    }
  };

  const refreshGitBranches = async () => {
    if (!gitInfo) return;
    try {
      const branches = await invoke<{ current: string; branches: string[] }>("git_list_branches", { repoRoot: gitInfo.repo_root });
      setGitCurrentBranch(branches.current || "");
      setGitBranches(branches.branches || []);
      setGitCheckoutBranchName((prev) => prev || branches.current || "");
    } catch (error) {
      setGitBranchError(`Failed to load branches: ${String(error)}`);
    }
  };

  const openGitBranchDialog = async () => {
    setGitBranchError("");
    setGitCreateBranchName("");
    setGitCreateBranchCheckout(true);
    setShowGitBranchDialog(true);
    await refreshGitBranches();
  };

  const runGitCreateBranch = async () => {
    if (!gitInfo || gitBranchBusy) return;
    const name = gitCreateBranchName.trim();
    if (!name) {
      setGitBranchError("Branch name is required.");
      return;
    }
    setGitBranchBusy(true);
    setGitBranchError("");
    try {
      await invoke("git_create_branch", { repoRoot: gitInfo.repo_root, name, checkout: gitCreateBranchCheckout });
      await refreshGitBranches();
      await refreshGitInfo(gitInfo.repo_root);
      if (gitCreateBranchCheckout) {
        setGitCheckoutBranchName(name);
      }
      setGitCreateBranchName("");
      setCompileStatus("Branch created");
    } catch (error) {
      setGitBranchError(`Create branch failed: ${String(error)}`);
    } finally {
      setGitBranchBusy(false);
    }
  };

  const runGitCheckoutBranch = async () => {
    if (!gitInfo || gitBranchBusy) return;
    const name = gitCheckoutBranchName.trim();
    if (!name) {
      setGitBranchError("Select a branch to checkout.");
      return;
    }
    setGitBranchBusy(true);
    setGitBranchError("");
    try {
      await invoke("git_checkout_branch", { repoRoot: gitInfo.repo_root, name });
      await refreshGitBranches();
      await refreshGitInfo(gitInfo.repo_root);
      setCompileStatus("Checked out branch");
    } catch (error) {
      setGitBranchError(`Checkout failed: ${String(error)}`);
    } finally {
      setGitBranchBusy(false);
    }
  };


  const toggleCommitSelection = (path: string) => {
    setGitCommitSelection((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const toggleCommitSectionAll = (section: "changes" | "unversioned", checked: boolean) => {
    if (!gitStatus) return;
    const paths = section === "changes"
      ? [...gitStatus.staged, ...gitStatus.unstaged]
      : [...gitStatus.untracked];
    setGitCommitSelection((prev) => {
      const next = { ...prev };
      paths.forEach((path) => {
        next[path] = checked;
      });
      return next;
    });
  };

  const stageCommitSelection = async () => {
    if (!gitInfo || !gitStatus) return false;
    const selected = Object.entries(gitCommitSelection)
      .filter(([, value]) => value)
      .map(([path]) => path);
    if (!selected.length) {
      setGitCommitError("Select files to commit.");
      return false;
    }
    const stagedSet = new Set(gitStatus.staged);
    const toUnstage = gitStatus.staged.filter((path) => !gitCommitSelection[path]);
    const toStage = selected.filter((path) => !stagedSet.has(path));
    try {
      if (toUnstage.length) {
        await invoke("git_unstage_paths", { repoRoot: gitInfo.repo_root, paths: toUnstage });
      }
      if (toStage.length) {
        await invoke("git_stage_paths", { repoRoot: gitInfo.repo_root, paths: toStage });
      }
      const status = await invoke<{
        staged: string[];
        unstaged: string[];
        untracked: string[];
      }>("git_status", { repoRoot: gitInfo.repo_root });
      setGitStatus(status);
      return true;
    } catch (error) {
      setGitCommitError(`Stage failed: ${String(error)}`);
      return false;
    }
  };

  const runGitCommitFlow = async (pushAfter: boolean) => {
    if (!gitInfo || gitCommitBusy || gitPushBusy) return;
    const message = gitCommitMessage.trim();
    if (!message) {
      setGitCommitError("Commit message is required.");
      return;
    }
    setGitCommitBusy(true);
    setGitPushBusy(pushAfter);
    setGitCommitError("");
    setGitPushError("");
    try {
      const ok = await stageCommitSelection();
      if (!ok) {
        return;
      }
      await invoke<string>("git_commit", { repoRoot: gitInfo.repo_root, message });
      if (pushAfter) {
        await invoke("git_push", { repoRoot: gitInfo.repo_root });
      }
      await refreshGitInfo(gitInfo.repo_root);
      const status = await invoke<{
        staged: string[];
        unstaged: string[];
        untracked: string[];
      }>("git_status", { repoRoot: gitInfo.repo_root });
      setGitStatus(status);
      setShowGitDialog(false);
      setGitCommitMessage("");
      setCompileStatus(pushAfter ? "Commit and push complete" : "Commit created");
    } catch (error) {
      if (pushAfter) {
        setGitPushError(`Commit/push failed: ${String(error)}`);
      } else {
        setGitCommitError(`Commit failed: ${String(error)}`);
      }
    } finally {
      setGitCommitBusy(false);
      setGitPushBusy(false);
    }
  };

  const addProjectFile = () => {
    const value = projectFileInput.trim();
    if (!value) return;
    setProjectPropertiesDraft((prev) => ({
      ...prev,
      src: prev.src.includes(value) ? prev.src : [...prev.src, value],
    }));
    setProjectFileInput("");
  };

  const removeProjectFile = (value: string) => {
    setProjectPropertiesDraft((prev) => ({
      ...prev,
      src: prev.src.filter((entry) => entry !== value),
    }));
  };

  const addProjectLibrary = () => {
    const value = projectLibraryInput.trim();
    if (!value) return;
    setProjectPropertiesDraft((prev) => ({
      ...prev,
      import_entries: prev.import_entries.includes(value) ? prev.import_entries : [...prev.import_entries, value],
    }));
    setProjectLibraryInput("");
  };

  const removeProjectLibrary = (value: string) => {
    setProjectPropertiesDraft((prev) => ({
      ...prev,
      import_entries: prev.import_entries.filter((entry) => entry !== value),
    }));
  };

  const saveProjectProperties = async () => {
    if (!rootPath) return;
    setProjectPropertiesError("");
    if (projectStdlibMode === "version" && !projectStdlibVersion.trim()) {
      setProjectPropertiesError("Select a stdlib version.");
      return;
    }
    if (projectStdlibMode === "custom" && !projectStdlibPath.trim()) {
      setProjectPropertiesError("Enter a stdlib path.");
      return;
    }
    setProjectPropertiesBusy(true);
    try {
      const trimmedName = projectPropertiesDraft.name.trim();
      const trimmedAuthor = projectPropertiesDraft.author.trim();
      const trimmedDescription = projectPropertiesDraft.description.trim();
      const trimmedOrganization = projectPropertiesDraft.organization.trim();
      const stdlibPayload =
        projectStdlibMode === "default"
          ? "default"
          : projectStdlibMode === "version"
            ? projectStdlibVersion.trim()
            : null;
      const libraryPayload =
        projectStdlibMode === "custom" ? { path: projectStdlibPath.trim() } : null;
      const descriptor = await invoke<{
        name?: string | null;
        author?: string | null;
        description?: string | null;
        organization?: string | null;
        default_library: boolean;
        stdlib?: string | null;
        library?: { path: string } | string | null;
        src?: string[];
        import_entries?: string[];
        raw_json?: string;
      }>("update_project_descriptor", {
        payload: {
          root: rootPath,
          name: trimmedName || null,
          author: trimmedAuthor || null,
          description: trimmedDescription || null,
          organization: trimmedOrganization || null,
          src: projectPropertiesDraft.src,
          import_entries: projectPropertiesDraft.import_entries,
          stdlib: stdlibPayload,
          library: libraryPayload,
        },
      });
      setProjectDescriptor(descriptor || null);
      setHasProjectDescriptor(!!descriptor);
      setShowProjectProperties(false);
    } catch (error) {
      setProjectPropertiesError(String(error));
    } finally {
      setProjectPropertiesBusy(false);
    }
  };

  const createNewFile = async () => {
    if (!rootPath || !newFileName) return;
    const normRoot = rootPath.replace(/[\\/]+/g, "\\").toLowerCase();
    const parentCandidate = newFileParent || rootPath;
    const normParentCandidate = parentCandidate.replace(/[\\/]+/g, "\\").toLowerCase();
    const parent = normParentCandidate.startsWith(normRoot) ? parentCandidate : rootPath;
    const trimmed = newFileName.trim();
    const baseName = trimmed.split(/[\\/]/).pop() || trimmed;
    const extension =
      newFileType === "diagram" ? ".diagram" : newFileType === "kerml" ? ".kerml" : ".sysml";
    const finalName = baseName.toLowerCase().endsWith(extension) ? baseName : `${baseName}${extension}`;
    if (newFileType === "diagram") {
      const createdPath = await invoke<string>("create_file", { root: rootPath, parent, name: finalName });
      await invoke("write_diagram", {
        root: rootPath,
        path: createdPath,
        diagram: { version: 1, nodes: [], offsets: {}, sizes: {} },
      });
    } else {
      await invoke("create_file", { root: rootPath, parent, name: finalName });
    }
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
    const unlistenPromise = listen<{ path: string; kind: string }>("fs-changed", async (event) => {
      if (!rootPath) return;
      const changedPath = event?.payload?.path;
      if (changedPath) {
        const cached = getDoc(changedPath);
        if (cached && !cached.dirty) {
          try {
            const content = await invoke<string>("read_file", { path: changedPath });
            console.log("[fs] reload", changedPath, "len", content?.length ?? 0);
            updateDocContent(changedPath, content || "", false);
            if (currentFilePathRef.current === changedPath && editorRef.current && centerView === "file") {
              suppressDirtyRef.current = true;
              editorRef.current.setValue(content || "");
            }
          } catch (error) {
            console.log("[fs] reload failed", changedPath, String(error));
          }
        }
      }
      if (fsChangeTimerRef.current) {
        window.clearTimeout(fsChangeTimerRef.current);
      }
      fsChangeTimerRef.current = window.setTimeout(() => {
        fsChangeTimerRef.current = null;
        void refreshRoot(rootPath);
        void runBackgroundCompile(rootPath);
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
  }, [compileRunId]);





  const handleEditorMount: OnMount = (editorInstance, monaco) => {
    editorRef.current = editorInstance;
    monacoRef.current = monaco;
    if (cursorListenerRef.current) {
      cursorListenerRef.current.dispose();
      cursorListenerRef.current = null;
    }
    cursorListenerRef.current = editorInstance.onDidChangeCursorPosition((event) => {
      updateCursorPos(event.position.lineNumber, event.position.column);
    });
    const initialPos = editorInstance.getPosition();
    if (initialPos) {
      updateCursorPos(initialPos.lineNumber, initialPos.column);
    }
    const pendingEditorContent = consumePendingEditorContent(currentFilePathRef.current);
    if (pendingEditorContent != null) {
      editorInstance.setValue(pendingEditorContent);
    }
    if (pendingNavRef.current && pendingNavRef.current.path === currentFilePathRef.current) {
      applyEditorSelection(pendingNavRef.current.selection);
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
    if (!activeDoc.dirty) return;
    const content = editorValueRef.current;
    if (lastCompiledContentRef.current[activeEditorPath] === content) return;
    const timer = window.setTimeout(() => {
      lastCompiledContentRef.current[activeEditorPath] = content;
      void runBackgroundCompileWithUnsaved(rootPath, activeEditorPath, content);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [editorChangeTick, activeEditorPath, rootPath, activeDoc.dirty]);

  const selectSymbolInEditor = async (symbol: SymbolView) => {
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


  const saveActiveTab = async () => {
    if (!activeEditorPath) return;
    console.log("[save] write_file", activeEditorPath, "len", editorValueRef.current.length);
    await invoke("write_file", { path: activeEditorPath, content: editorValueRef.current });
    setOpenTabs((prev) => prev.map((tab) => (tab.path === activeEditorPath ? { ...tab, dirty: false } : tab)));
    markSaved();
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
    const isDirty = activeDoc.path === activeEditorPath ? activeDoc.dirty : false;
    setOpenTabs((prev) =>
      prev.map((tab) =>
        tab.path === activeEditorPath ? { ...tab, dirty: isDirty } : tab,
      ),
    );
  }, [editorChangeTick, activeEditorPath, activeDoc]);

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
        if (showProjectProperties) {
          setShowProjectProperties(false);
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
            void navigateTo({ path: activeTabMeta.sourcePath });
          }
          return;
        }
        if (!activeEditorPath) return;
        if (!activeEditorPath.toLowerCase().endsWith(".diagram")) return;
        if (editorRef.current) {
          queuePendingEditorContent(activeEditorPath, editorValueRef.current);
        }
        openDiagramViewTab(activeEditorPath);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTabPath, activeTabMeta, activeEditorPath, contextMenu, openMenu, showAiSettings, showExport, showNewFile, showNewProject, showOpenProject, showProjectProperties, showSettings, tabMenu]);

  const resetEndpointDraft = () => {
    setEndpointDraft({ name: "", url: "", type: "chat", provider: "openai", model: "", token: "" });
  };

  const saveEndpointDraft = () => {
    const name = endpointDraft.name.trim();
    const url = endpointDraft.url.trim();
    if (!name || !url) return;
    setAiEndpoints((prev) => {
      if (endpointDraft.id) {
        return prev.map((endpoint) =>
          endpoint.id === endpointDraft.id
            ? {
                ...endpoint,
                name,
                url,
                type: endpointDraft.type,
                provider: endpointDraft.provider,
                model: endpointDraft.model.trim(),
                token: endpointDraft.token,
              }
            : endpoint,
        );
      }
      const id = crypto.randomUUID();
      return [
        ...prev,
        {
          id,
          name,
          url,
          type: endpointDraft.type,
          provider: endpointDraft.provider,
          model: endpointDraft.model.trim(),
          token: endpointDraft.token,
        },
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
          provider: endpoint.provider,
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
    const buildModelContext = () => {
      const activePath = activeEditorPath || activeDoc.path || "";
      const projectSymbols = symbols.filter((symbol) => !(libraryPath && symbol.file_path.startsWith(libraryPath)));
      const activeSymbols = activePath
        ? projectSymbols.filter((symbol) => symbol.file_path === activePath).slice(0, 40)
        : [];
      const unresolvedTop = unresolved.slice(0, 20);
      const snippet =
        activePath && activeDoc.path === activePath
          ? editorValueRef.current.slice(0, 8000)
          : "";
      const symbolLines = activeSymbols.map(
        (symbol) =>
          `- ${symbol.kind} ${symbol.qualified_name} @ ${symbol.file_path}:${(symbol.start_line ?? 0) + 1}`,
      );
      const unresolvedLines = unresolvedTop.map(
        (item) => `- ${item.file_path}:${(item.line ?? 0) + 1}:${(item.column ?? 0) + 1} ${item.message}`,
      );
      return [
        `root: ${rootPath || "unknown"}`,
        `active_file: ${activePath || "none"}`,
        `symbol_count: ${projectSymbols.length}`,
        "",
        "active_file_symbols:",
        ...(symbolLines.length ? symbolLines : ["- none"]),
        "",
        "unresolved_top:",
        ...(unresolvedLines.length ? unresolvedLines : ["- none"]),
        "",
        "active_file_content:",
        snippet || "(not loaded)",
      ].join("\n");
    };

    const history = aiMessages.filter((msg) => msg.text !== "...");
    const contextText = buildModelContext();
    const messages = [
      {
        role: "user" as const,
        text:
          "Model context (read-only). Use it as ground truth when answering about this workspace:\n\n" +
          contextText,
      },
      ...history,
      { role: "user" as const, text },
    ];
    try {
      const response = await invoke<any>("ai_agent_run", {
        payload: {
          url: endpoint.url,
          provider: endpoint.provider,
          model: endpoint.model || null,
          token: endpoint.token || null,
          max_tokens: 512,
          root: rootPath || null,
          enable_tools: true,
          messages: messages.map((msg) => ({ role: msg.role, content: msg.text })),
        },
      });
      const content =
        response?.message ??
        response?.choices?.[0]?.message?.content ??
        response?.choices?.[0]?.text ??
        response?.content?.find?.((part: any) => part?.type === "text")?.text ??
        response?.message ??
        "";
      const nextText = content || "No response.";
      setAiMessages((prev) =>
        prev.map((msg) =>
          msg.pendingId === requestId
            ? { ...msg, text: nextText, pendingId: undefined, steps: Array.isArray(response?.steps) ? response.steps : [] }
            : msg,
        ),
      );
    } catch (error) {
      setAiMessages((prev) =>
        prev.map((msg) =>
          msg.pendingId === requestId ? { ...msg, text: `Error: ${String(error)}`, pendingId: undefined } : msg,
        ),
      );
    }
  };

  const deferredSymbols = useDeferredValue(symbols);
  const deferredUnresolved = useDeferredValue(unresolved);

  useEffect(() => {
    if (!selectedSymbol) return;
    if (!deferredSymbols.length) {
      setSelectedSymbol(null);
      return;
    }
    const match = deferredSymbols.find((symbol) => {
      if (selectedSymbol.qualified_name && symbol.qualified_name) {
        return symbol.qualified_name === selectedSymbol.qualified_name;
      }
      return symbol.file_path === selectedSymbol.file_path && symbol.name === selectedSymbol.name;
    });
    setSelectedSymbol(match || null);
  }, [deferredSymbols, selectedSymbol]);

  const {
    projectGroups,
    libraryGroups,
    projectCounts,
    libraryCounts,
    errorCounts,
    dataViewSymbolKindCounts,
  } = useModelGroups({
    deferredSymbols,
    deferredUnresolved,
    rootPath,
    libraryPath,
    dataExcludeStdlib,
  });

  const { modelRows } = useModelTree({
    projectGroups,
    libraryGroups,
    deferredUnresolved,
    modelExpanded,
    collapseAllModel,
    modelSectionOpen,
    projectCounts,
    libraryCounts,
    errorCounts,
    projectSymbolsLoaded,
    getKindKey,
  });

  const effectiveModelTreeHeight = showPropertiesPane
    ? modelTreeHeight
    : Math.max(modelTreeHeight, modelPaneHeight || modelTreeHeight);

  const {
    modelListRef,
    modelSectionIndent,
    modelListHeight,
    modelCursorIndex,
    setModelCursorIndex,
    findSelectedSymbolIndex,
    syncModelTreeToSymbol,
    handleModelTreeKeyDown,
    getModelRowHeight,
  } = useModelTreeSelection({
    modelRows,
    modelTreeHeight: effectiveModelTreeHeight,
    setModelSectionOpen,
    setModelExpanded,
    selectedSymbol,
    setSelectedSymbol,
    selectSymbolInEditor,
    navigateTo,
    projectGroups,
    libraryGroups,
  });

  const {
    diagramScale,
    setDiagramScale,
    diagramOffset,
    setDiagramOffset,
    diagramPanRef,
    diagramBodyRef,
    diagramViewportRef,
    diagramViewport,
    diagramPanRafRef,
    diagramPanPendingRef,
    diagramLayout,
    diagramDropActive,
    palettePos,
    paletteGhost,
    paletteDragRef,
    paletteCreateRef,
    renderDiagramLayout,
    renderMinimapLayout,
    requestDiagramLayout,
    setDiagramNodeOffsets,
    setDiagramNodeSizes,
    setPaletteGhost,
    handleDiagramDrop,
    handleDiagramDragOver,
    handleDiagramDragLeave,
  } = useDiagramView({
    activeDiagramPath,
    getKindKey,
    renderTypeIcon,
    rootPath,
    setCompileStatus,
  });

  const { trackCandidate, trackNow } = useModelTracking({
    symbols,
    activeEditorPath,
    cursorPos,
    enabled: trackText,
    onTrack: (symbol) => {
      setSelectedSymbol(symbol);
      syncModelTreeToSymbol(symbol);
    },
  });

  const renderModelRow = useMemo(
    () =>
      createModelRowRenderer({
        modelCursorIndex,
        modelSectionOpen,
        modelSectionIndent,
        modelTreeRef,
        handleModelTreeKeyDown,
        setModelCursorIndex,
        setModelSectionOpen,
        setModelExpanded,
        selectedSymbol,
        setSelectedSymbol,
        selectSymbolInEditor,
        navigateTo,
        renderTypeIcon,
      }),
    [
      modelCursorIndex,
      modelSectionOpen,
      modelSectionIndent,
      handleModelTreeKeyDown,
      selectedSymbol,
      setSelectedSymbol,
      selectSymbolInEditor,
      navigateTo,
      renderTypeIcon,
    ],
  );

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
                    <button type="button" onClick={() => { setOpenMenu(null); void openProjectProperties(); }}>Project Properties</button>
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
              <button type="button" onClick={() => { setOpenMenu(null); openAiViewTab(); }}>Agent</button>
              <button type="button" onClick={() => { setOpenMenu(null); openDataViewTab(); }}>Data Analysis View</button>
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  if (activeEditorPath && activeEditorPath.toLowerCase().endsWith(".diagram")) {
                    if (editorRef.current) {
                      queuePendingEditorContent(activeEditorPath, editorValueRef.current);
                    }
                    openDiagramViewTab(activeEditorPath);
                  }
                }}
                disabled={!activeEditorPath || !activeEditorPath.toLowerCase().endsWith(".diagram")}
              >
                Diagram View
              </button>
              <div className="menu-divider" />
              <button type="button" onClick={() => { setShowSettings(true); setOpenMenu(null); }}>Settings</button>
              <button type="button">Logs</button>
            </div>
              ) : null}
            </div>
            <div className="menu-item">
              <button type="button" className="menu-button" onClick={() => setOpenMenu(openMenu === "Collab" ? null : "Collab")}>Collab</button>
              {openMenu === "Collab" ? (
            <div className="menu-dropdown" data-tauri-drag-region="false">
              <button type="button" onClick={() => { setOpenMenu(null); void openGitDialog(); }} disabled={!gitInfo}>Collab...</button>
              <button type="button" onClick={() => { setOpenMenu(null); void openGitBranchDialog(); }} disabled={!gitInfo}>Branches...</button>
              <button type="button" disabled>Model Changes</button>
              <div className="menu-divider" />
              <button
                type="button"
                disabled={!gitInfo?.repo_root}
                onClick={() => {
                  setOpenMenu(null);
                  if (gitInfo?.repo_root) {
                    void invoke("open_in_explorer", { path: gitInfo.repo_root });
                  }
                }}
              >
                Open Repo Folder
              </button>
              <button type="button" onClick={() => { setOpenMenu(null); void copyRepoUrl(); }} disabled={!gitInfo?.remote_url}>
                Copy Repo URL
              </button>
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
                {!hasProjectDescriptor ? <span className="project-root-hint">No .project file</span> : null}
              </>
            ) : (
              "No project selected"
            )}
          </div>
            <ProjectTree
              treeEntries={treeEntries}
              expanded={expanded}
              onOpenFile={openFile}
              onContextMenu={showContext}
              onRootContextMenu={showRootContext}
            />
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
          <EditorPane
            openTabs={openTabs}
            activeTabPath={activeTabPath}
            tabOverflowOpen={tabOverflowOpen}
            onSetTabOverflowOpen={setTabOverflowOpen}
            onSelectTab={(path) => {
              void selectTab(path);
            }}
            onCloseTab={closeTab}
            onReorderTabs={reorderTabs}
            onTabContextMenu={(path, x, y) => {
              setActiveTabPath(path);
              setTabMenu({ x, y, path });
            }}
          >
            {activeTabMeta?.kind === "ai" ? (
                <AiView
                  aiMessages={aiMessages}
                  aiInput={aiInput}
                  onInputChange={setAiInput}
                  onOpenSettings={() => setShowAiSettings(true)}
                  onSend={() => {
                    const text = aiInput.trim();
                    if (!text) return;
                    void sendAiMessage(text);
                  }}
                />
              ) : activeTabMeta?.kind === "data" ? (
                <DataView
                  dataExcludeStdlib={dataExcludeStdlib}
                  onToggleExcludeStdlib={setDataExcludeStdlib}
                  projectCounts={projectCounts}
                  libraryCounts={libraryCounts}
                  errorCounts={errorCounts}
                  dataViewSymbolKindCounts={dataViewSymbolKindCounts}
                />
              ) : !activeTabPath ? (
                <div className="editor-placeholder">
                  <div className="welcome-screen">
                      <div className="welcome-title">Welcome to Mercurio</div>
                      <div className="welcome-subtitle">Open a project or create a new one to get started.</div>
                      <div className="welcome-actions">
                        <button type="button" className="ghost" onClick={openNewProjectDialog}>New Project</button>
                        <button type="button" className="ghost" onClick={chooseProject}>Open Project</button>
                      </div>
                      <div className="welcome-hint">Tip: Open a .diagram file to view diagrams.</div>
                    </div>
                  </div>
              ) : activeTabPath === PROJECT_DESCRIPTOR_TAB ? (
                <DescriptorView
                  descriptorViewMode={descriptorViewMode}
                  projectDescriptor={projectDescriptor}
                />
              ) : activeTabMeta?.kind !== "diagram" ? (
                <>
                  <div className="editor-toolbar">
                    <div className="editor-toolbar-group">
                      <button
                        type="button"
                        className={`ghost icon-track ${trackText ? "active" : ""}`}
                        onClick={() => setTrackText((prev) => !prev)}
                        title={trackText ? "Stop tracking text" : "Track text"}
                        aria-pressed={trackText}
                        aria-label="Track text"
                      />
                      <span className="editor-toolbar-label">Track text</span>
                    </div>
                    <div className="editor-toolbar-group">
                      <button
                        type="button"
                        className="ghost"
                        onClick={trackNow}
                        disabled={!trackCandidate}
                        title={trackCandidate ? "Select symbol near cursor" : "No symbol near cursor"}
                      >
                        Track now
                      </button>
                    </div>
                  </div>
                  <div className="editor-body">
                    <MonacoEditor
                      defaultValue=""
                      onChange={(value) => {
                        const next = value ?? "";
                        if (suppressDirtyRef.current) {
                          suppressDirtyRef.current = false;
                          return;
                        }
                        onEditorChange(next);
                      }}
                      language="sysml"
                      theme={appTheme === "light" ? "vs" : "vs-dark"}
                      onMount={handleEditorMount}
                      options={editorOptions}
                    />
                  </div>
                </>
            ) : (
              <DiagramView
                activeDiagramPath={activeDiagramPath}
                diagramLayout={diagramLayout}
                diagramScale={diagramScale}
                diagramOffset={diagramOffset}
                diagramViewport={diagramViewport}
                paletteGhost={paletteGhost}
                palettePos={palettePos}
                diagramBodyRef={diagramBodyRef}
                diagramPanRef={diagramPanRef}
                diagramPanPendingRef={diagramPanPendingRef}
                diagramPanRafRef={diagramPanRafRef}
                diagramViewportRef={diagramViewportRef}
                paletteDragRef={paletteDragRef}
                paletteCreateRef={paletteCreateRef}
                diagramDropActive={diagramDropActive}
                onSwitchToText={() => {
                  if (activeDiagramPath) {
                    void navigateTo({ path: activeDiagramPath });
                  } else {
                    setCenterView("file");
                  }
                }}
                onAutoLayout={() => {
                  setDiagramNodeOffsets({});
                  setDiagramNodeSizes({});
                  setDiagramOffset({ x: 0, y: 0 });
                  requestDiagramLayout();
                }}
                onZoomIn={() => setDiagramScale((s) => Math.min(2.0, s + 0.1))}
                onZoomOut={() => setDiagramScale((s) => Math.max(0.4, s - 0.1))}
                onReset={() => {
                  setDiagramScale(1);
                  setDiagramOffset({ x: 0, y: 0 });
                }}
                onDiagramDrop={handleDiagramDrop}
                onDiagramDragOver={handleDiagramDragOver}
                onDiagramDragLeave={handleDiagramDragLeave}
                setDiagramOffset={setDiagramOffset}
                setPaletteGhost={setPaletteGhost}
                renderDiagramLayout={renderDiagramLayout}
                renderMinimapLayout={renderMinimapLayout}
                renderTypeIcon={renderTypeIcon}
              />
            )}
          </EditorPane>
          <>
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
            <section className="panel sidebar" ref={modelPaneContainerRef}>
              <div className="panel-header">
              <ModelHeader
                collapseAll={collapseAllModel}
                onCollapseAll={() => setCollapseAllModel(true)}
                onExpandAll={() => setCollapseAllModel(false)}
                onToggleProperties={() => setShowPropertiesPane((prev) => !prev)}
                showProperties={showPropertiesPane}
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
            <ModelPane
              modelTreeHeight={effectiveModelTreeHeight}
              showPropertiesPane={showPropertiesPane}
              modelTreeRef={modelTreeRef}
              modelListRef={modelListRef}
              modelRows={modelRows}
              modelListHeight={modelListHeight}
              getModelRowHeight={getModelRowHeight}
              renderModelRow={renderModelRow}
              handleModelTreeKeyDown={handleModelTreeKeyDown}
              onModelTreeFocus={() => {
                if (modelCursorIndex != null || !modelRows.length) return;
                const selectedIndex = findSelectedSymbolIndex();
                setModelCursorIndex(selectedIndex >= 0 ? selectedIndex : 0);
              }}
              startDrag={startDrag}
              selectedSymbol={selectedSymbol}
            />
            </section>
          )}
          </>
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
                    <option value="diagram">.diagram</option>
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
      {showProjectProperties ? (
        <div className="modal">
          <div className="modal-backdrop" onClick={() => setShowProjectProperties(false)} />
          <div className="modal-card modal-wide legacy-modal" role="dialog" aria-modal="true" aria-labelledby="project-properties-title">
            <div className="modal-header">
              <h3 id="project-properties-title">Project Properties</h3>
            </div>
            <div className="modal-body">
              <div className="project-properties">
                <div className="project-properties-grid">
                  <label className="field">
                    <span className="field-label">Name</span>
                    <input
                      value={projectPropertiesDraft.name}
                      onChange={(event) => setProjectPropertiesDraft((prev) => ({ ...prev, name: event.target.value }))}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Author</span>
                    <input
                      value={projectPropertiesDraft.author}
                      onChange={(event) => setProjectPropertiesDraft((prev) => ({ ...prev, author: event.target.value }))}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Organization</span>
                    <input
                      value={projectPropertiesDraft.organization}
                      onChange={(event) => setProjectPropertiesDraft((prev) => ({ ...prev, organization: event.target.value }))}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Description</span>
                    <input
                      value={projectPropertiesDraft.description}
                      onChange={(event) => setProjectPropertiesDraft((prev) => ({ ...prev, description: event.target.value }))}
                    />
                  </label>
                </div>
                <div className="project-properties-section">
                  <div className="project-properties-title">Files</div>
                  <div className="project-properties-list">
                    {projectPropertiesDraft.src.length ? (
                      projectPropertiesDraft.src.map((entry) => (
                        <div key={entry} className="project-properties-item">
                          <span>{entry}</span>
                          <button type="button" className="ghost" onClick={() => removeProjectFile(entry)}>Remove</button>
                        </div>
                      ))
                    ) : (
                      <div className="muted">No files configured.</div>
                    )}
                  </div>
                  <div className="field-inline">
                    <input
                      value={projectFileInput}
                      onChange={(event) => setProjectFileInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addProjectFile();
                        }
                      }}
                      placeholder="**/*.sysml"
                    />
                    <button type="button" className="ghost" onClick={addProjectFile}>Add</button>
                  </div>
                </div>
                <div className="project-properties-section">
                  <div className="project-properties-title">Libraries</div>
                  <div className="project-properties-list">
                    {projectPropertiesDraft.import_entries.length ? (
                      projectPropertiesDraft.import_entries.map((entry) => (
                        <div key={entry} className="project-properties-item">
                          <span>{entry}</span>
                          <button type="button" className="ghost" onClick={() => removeProjectLibrary(entry)}>Remove</button>
                        </div>
                      ))
                    ) : (
                      <div className="muted">No libraries configured.</div>
                    )}
                  </div>
                  <div className="field-inline">
                    <input
                      value={projectLibraryInput}
                      onChange={(event) => setProjectLibraryInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addProjectLibrary();
                        }
                      }}
                      placeholder="**/*.sysmlx"
                    />
                    <button type="button" className="ghost" onClick={addProjectLibrary}>Add</button>
                  </div>
                </div>
                <div className="project-properties-section">
                  <div className="project-properties-title">Stdlib</div>
                  <label className="field">
                    <span className="field-label">Selection</span>
                    <select
                      value={projectStdlibMode}
                      onChange={(event) => setProjectStdlibMode(event.target.value as "default" | "version" | "custom")}
                    >
                      <option value="default">Use default</option>
                      <option value="version">Pick version</option>
                      <option value="custom">Custom path</option>
                    </select>
                  </label>
                  {projectStdlibMode === "version" ? (
                    <label className="field">
                      <span className="field-label">Version</span>
                      <select
                        value={projectStdlibVersion}
                        onChange={(event) => setProjectStdlibVersion(event.target.value)}
                      >
                        <option value="">Select version</option>
                        {projectStdlibVersions.map((version) => (
                          <option key={version} value={version}>{version}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {projectStdlibMode === "custom" ? (
                    <label className="field">
                      <span className="field-label">Path</span>
                      <input
                        value={projectStdlibPath}
                        onChange={(event) => setProjectStdlibPath(event.target.value)}
                        placeholder="C:\\path\\to\\stdlib"
                      />
                    </label>
                  ) : null}
                </div>
                {projectPropertiesError ? <div className="field-hint error">{projectPropertiesError}</div> : null}
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setShowProjectProperties(false)}>Cancel</button>
              <button type="button" onClick={saveProjectProperties} disabled={projectPropertiesBusy}>Save</button>
            </div>
          </div>
        </div>
      ) : null}
      {showGitDialog ? (
        <div className="modal">
          <div className="modal-backdrop" onClick={() => setShowGitDialog(false)} />
          <div className="modal-card modal-wide legacy-modal" role="dialog" aria-modal="true" aria-labelledby="git-dialog-title">
            <div className="modal-header">
              <h3 id="git-dialog-title">Collab</h3>
            </div>
            <div className="modal-body">
              {gitInfo ? (
                <div className="field">
                  <div className="field-label">Repo</div>
                  <div className="field-inline">
                    <span>{gitInfo.repo_root}</span>
                  </div>
                  <div className="field-hint">
                    Branch: {gitInfo.branch} - Ahead {gitInfo.ahead} - Behind {gitInfo.behind} - {gitInfo.clean ? "Clean" : "Has changes"}
                  </div>
                  {gitInfo.remote_url ? (
                    <div className="field-hint">Remote: {gitInfo.remote_url}</div>
                  ) : null}
                </div>
              ) : (
                <div className="muted">No git repository detected.</div>
              )}
              {gitStatusBusy ? (
                <div className="muted">Loading status...</div>
              ) : null}
              {gitStatusError ? (
                <div className="field-hint error">{gitStatusError}</div>
              ) : null}
              {gitStatus ? (
                <div className="project-properties-section">
                  <div className="project-properties-title">Select files</div>
                  <div className="project-properties-list commit-section-scroll">
                    <div className="project-properties-item section-toggle">
                      <input
                        type="checkbox"
                        checked={
                          gitStatus.staged.length + gitStatus.unstaged.length > 0 &&
                          [...gitStatus.staged, ...gitStatus.unstaged].every((path) => gitCommitSelection[path])
                        }
                        onChange={(event) => toggleCommitSectionAll("changes", event.target.checked)}
                      />
                      <button
                        type="button"
                        className="ghost toggle-btn"
                        onClick={() => setGitCommitSectionsOpen((prev) => ({ ...prev, changes: !prev.changes }))}
                        aria-expanded={gitCommitSectionsOpen.changes}
                      >
                        {gitCommitSectionsOpen.changes ? "-" : "+"}
                      </button>
                      <span>Changes</span>
                      <span>{gitStatus.staged.length + gitStatus.unstaged.length}</span>
                    </div>
                    {gitCommitSectionsOpen.changes ? (
                      <div className="commit-section-list">
                        {[...gitStatus.staged.map((path) => ({ path, state: "staged" as const })), ...gitStatus.unstaged.map((path) => ({ path, state: "unstaged" as const }))].map(({ path, state }) => (
                          <label key={`change-${path}`} className="project-properties-item commit-item">
                            <input
                              type="checkbox"
                              checked={!!gitCommitSelection[path]}
                              onChange={() => toggleCommitSelection(path)}
                            />
                            <span>{path}</span>
                            <span className="muted">{state}</span>
                          </label>
                        ))}
                      </div>
                    ) : null}
                    <div className="project-properties-item section-toggle">
                      <input
                        type="checkbox"
                        checked={
                          gitStatus.untracked.length > 0 &&
                          gitStatus.untracked.every((path) => gitCommitSelection[path])
                        }
                        onChange={(event) => toggleCommitSectionAll("unversioned", event.target.checked)}
                      />
                      <button
                        type="button"
                        className="ghost toggle-btn"
                        onClick={() => setGitCommitSectionsOpen((prev) => ({ ...prev, unversioned: !prev.unversioned }))}
                        aria-expanded={gitCommitSectionsOpen.unversioned}
                      >
                        {gitCommitSectionsOpen.unversioned ? "-" : "+"}
                      </button>
                      <span>Unversioned files</span>
                      <span>{gitStatus.untracked.length}</span>
                    </div>
                    {gitCommitSectionsOpen.unversioned ? (
                      <div className="commit-section-list">
                        {gitStatus.untracked.map((path) => (
                          <label key={`unversioned-${path}`} className="project-properties-item commit-item">
                            <input
                              type="checkbox"
                              checked={!!gitCommitSelection[path]}
                              onChange={() => toggleCommitSelection(path)}
                            />
                            <span>{path}</span>
                          </label>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <label className="field field-commit-message">
                <span className="field-label">Commit message</span>
                <textarea
                  value={gitCommitMessage}
                  onChange={(event) => setGitCommitMessage(event.target.value)}
                  placeholder="Describe your changes"
                  rows={3}
                />
              </label>
              {gitCommitError ? <div className="field-hint error">{gitCommitError}</div> : null}
              {gitPushError ? <div className="field-hint error">{gitPushError}</div> : null}
              {gitBranchError ? <div className="field-hint error">{gitBranchError}</div> : null}
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setShowGitDialog(false)}>Close</button>
              <button type="button" onClick={() => runGitCommitFlow(false)} disabled={!gitInfo || gitCommitBusy || gitPushBusy}>Commit</button>
              <button type="button" onClick={() => runGitCommitFlow(true)} disabled={!gitInfo || gitCommitBusy || gitPushBusy}>Commit &amp; Push</button>
            </div>
          </div>
        </div>
      ) : null}
      {showGitBranchDialog ? (
        <div className="modal">
          <div className="modal-backdrop" onClick={() => setShowGitBranchDialog(false)} />
          <div className="modal-card legacy-modal" role="dialog" aria-modal="true" aria-labelledby="git-branch-title">
            <div className="modal-header">
              <h3 id="git-branch-title">Branches</h3>
            </div>
            <div className="modal-body">
              {gitInfo ? (
                <div className="field">
                  <div className="field-hint">Repo: {gitInfo.repo_root}</div>
                  {gitCurrentBranch ? (
                    <div className="field-hint">Current branch: {gitCurrentBranch}</div>
                  ) : null}
                </div>
              ) : (
                <div className="muted">No git repository detected.</div>
              )}
              <div className="project-properties-section">
                <div className="project-properties-title">Create branch</div>
                <div className="field-inline">
                  <input
                    value={gitCreateBranchName}
                    onChange={(event) => setGitCreateBranchName(event.target.value)}
                    placeholder="new-branch-name"
                  />
                  <label className="inline-checkbox">
                    <input
                      type="checkbox"
                      checked={gitCreateBranchCheckout}
                      onChange={(event) => setGitCreateBranchCheckout(event.target.checked)}
                    />
                    <span>Checkout</span>
                  </label>
                  <button type="button" className="ghost" onClick={runGitCreateBranch} disabled={!gitInfo || gitBranchBusy}>Create</button>
                </div>
              </div>
              <div className="project-properties-section">
                <div className="project-properties-title">Checkout branch</div>
                <div className="field-inline">
                  <select
                    value={gitCheckoutBranchName}
                    onChange={(event) => setGitCheckoutBranchName(event.target.value)}
                  >
                    <option value="">Select branch</option>
                    {gitBranches.map((branch) => (
                      <option key={branch} value={branch}>
                        {branch === gitCurrentBranch ? `${branch} (current)` : branch}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="ghost" onClick={runGitCheckoutBranch} disabled={!gitInfo || gitBranchBusy}>Checkout</button>
                  <button type="button" className="ghost" onClick={refreshGitBranches} disabled={!gitInfo || gitBranchBusy}>Refresh</button>
                </div>
              </div>
              {gitBranchError ? <div className="field-hint error">{gitBranchError}</div> : null}
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setShowGitBranchDialog(false)}>Close</button>
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
                        <div className="endpoint-meta">{endpoint.provider.toUpperCase()} / {endpoint.type.toUpperCase()} / {endpoint.url}</div>
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
                  <input
                    value={endpointDraft.url}
                    onChange={(e) => setEndpointDraft({ ...endpointDraft, url: e.target.value })}
                    placeholder={endpointDraft.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com"}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Type</span>
                  <select value={endpointDraft.type} onChange={(e) => setEndpointDraft({ ...endpointDraft, type: e.target.value as "chat" | "embeddings" })}>
                    <option value="chat">Chat</option>
                    <option value="embeddings">Embeddings</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Provider</span>
                  <select value={endpointDraft.provider} onChange={(e) => setEndpointDraft({ ...endpointDraft, provider: e.target.value as "openai" | "anthropic" })}>
                    <option value="openai">OpenAI-compatible</option>
                    <option value="anthropic">Anthropic</option>
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
              className={`status-compile-indicator ${backgroundCompileActive ? "active" : ""} ${backgroundCompileEnabled ? "" : "disabled"}`}
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
