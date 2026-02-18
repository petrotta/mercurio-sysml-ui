import "./style.css";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getName, getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import MonacoEditor, { loader, type OnMount } from "@monaco-editor/react";
import { listen } from "@tauri-apps/api/event";
import {
  AI_CHAT_KEY,
  AI_ENDPOINTS_KEY,
  PROJECT_DESCRIPTOR_TAB,
  PROJECT_LOCATION_KEY,
  ROOT_STORAGE_KEY,
  THEME_KEY,
  TRACK_TEXT_KEY,
  FILTER_MODEL_FILES_KEY,
  MODEL_SHOW_FILES_KEY,
  MODEL_PROPERTIES_DOCK_KEY,
} from "./app/constants";
import { loadRecents, saveRecents } from "./app/storage";
import { useEditorState } from "./app/editorState";
import { AiView } from "./app/components/AiView";
import { ModelPane } from "./app/components/ModelPane";
import { ModelHeader } from "./app/components/ModelHeader";
import { EditorPane } from "./app/components/EditorPane";
import { ProjectTree } from "./app/components/ProjectTree";
import { DataView } from "./app/components/DataView";
import { ProjectModelPaneView } from "./app/components/ProjectModelView";
import { DescriptorView } from "./app/components/DescriptorView";
import { SettingsDialog } from "./app/components/SettingsDialog";
import { DiagramView } from "./app/components/DiagramView";
import { TerminalPane } from "./app/components/TerminalPane";
import { AstStatus } from "./app/components/AstStatus";
import { CompileToastPanel } from "./app/components/CompileToast";
import { Modal } from "./app/components/Modal";
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
import { useAstLoader } from "./app/useAstLoader";
import { readFileText } from "./app/fileOps";
import { useProjectTree } from "./app/useProjectTree";
import { runAgent } from "./app/agentClient";
import { parseErrorLocation } from "./app/parseErrors";
import { isPathWithin } from "./app/pathUtils";
import type {
  FileEntry,
  OpenTab,
  ProjectElementAttributesView,
  ProjectModelView,
  StdlibMetamodelView,
  SymbolView,
} from "./app/types";

loader.config({ paths: { vs: "/monaco/vs" } });

type TerminalTabState = {
  id: string;
  title: string;
  input: string;
  lines: string[];
  history: string[];
  historyIndex: number | null;
};

export function App() {
  void getCurrentWindow();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"theme" | "ai" | "stdlib">("theme");
  const [settingsStdlibVersions, setSettingsStdlibVersions] = useState<string[]>([]);
  const [settingsDefaultStdlib, setSettingsDefaultStdlib] = useState("");
  const [settingsStdlibBusy, setSettingsStdlibBusy] = useState(false);
  const [settingsStdlibStatus, setSettingsStdlibStatus] = useState("");
  const [appTheme, setAppTheme] = useState<"dark" | "light">(
    (window.localStorage?.getItem(THEME_KEY) as "dark" | "light") || "dark",
  );
  const [leftWidth, setLeftWidth] = useState(240);
  const [rightWidth, setRightWidth] = useState(320);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const leftStoredWidthRef = useRef(240);
  const rightStoredWidthRef = useRef(320);
  const draggingRef = useRef<null | "left" | "right" | "model" | "modelProps">(null);
  const startRef = useRef({ x: 0, y: 0, left: 240, right: 320, model: 260, modelProps: 320 });
  const [rootPath, setRootPath] = useState<string>(() => window.localStorage?.getItem(ROOT_STORAGE_KEY) || "");
  const [recentProjects, setRecentProjects] = useState<string[]>(() => loadRecents());
  const { treeEntries, expanded, refreshRoot, toggleExpand } = useProjectTree();
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
  const [modelContextMenu, setModelContextMenu] = useState<{
    x: number;
    y: number;
    filePath: string | null;
    label: string;
    section: "project" | "library";
    loadError?: string;
  } | null>(null);
  const [modelOptionsMenu, setModelOptionsMenu] = useState<{ x: number; y: number } | null>(null);
  const [astViewOpen, setAstViewOpen] = useState(false);
  const [astViewTitle, setAstViewTitle] = useState("");
  const { astState: astViewState, loadForPath: loadAstViewForPath } = useAstLoader();
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [tabOverflowOpen, setTabOverflowOpen] = useState(false);
  const [showUsageNodes, setShowUsageNodes] = useState(true);
  const [libraryKindFilter, setLibraryKindFilter] = useState<string | null>(null);
  const [showAstSplit, setShowAstSplit] = useState(false);
  const {
    astState: astSplitState,
    setAstState: setAstSplitState,
    loadForContent: loadAstSplitForContent,
    clearTimer: clearAstSplitTimer,
  } = useAstLoader();
  const [showAbout, setShowAbout] = useState(false);
  const [metamodelDebugLoading, setMetamodelDebugLoading] = useState(false);
  const [metamodelDebugError, setMetamodelDebugError] = useState("");
  const [stdlibMetamodel, setStdlibMetamodel] = useState<StdlibMetamodelView | null>(null);
  const [projectModelView, setProjectModelView] = useState<ProjectModelView | null>(null);
  const [projectModelLoading, setProjectModelLoading] = useState(false);
  const [projectModelError, setProjectModelError] = useState("");
  const [projectModelFocusQuery, setProjectModelFocusQuery] = useState("");
  const [aboutVersion, setAboutVersion] = useState<string | null>(null);
  const [aboutBuild, setAboutBuild] = useState<string | null>(null);
  const astEditorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const astScrollSyncRef = useRef<{ dispose: () => void } | null>(null);
  const astCursorSyncRef = useRef<{ dispose: () => void } | null>(null);
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
  const [exportAfterBuild, setExportAfterBuild] = useState(false);
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
  const [centerView, setCenterView] = useState<"file" | "diagram" | "ai" | "data" | "project-model">("file");
  // cursorPos is managed by useEditorState
  const [aiInput, setAiInput] = useState("");
  const [aiHistoryIndex, setAiHistoryIndex] = useState<number | null>(null);
  const [aiMessages, setAiMessages] = useState<Array<{
    role: "user" | "assistant";
    text: string;
    raw?: string;
    pendingId?: number;
    steps?: Array<{ kind: string; detail: string }>;
    nextSteps?: Array<{ id: string; label: string; recommended: boolean; action: string }>;
  }>>([]);
  const [aiFloatingSteps, setAiFloatingSteps] = useState<Array<{ id: string; label: string; recommended: boolean; action: string }>>([]);
  const [aiFloatingPos, setAiFloatingPos] = useState<{ x: number; y: number }>(() => ({
    x: window.innerWidth - 280,
    y: window.innerHeight - 380,
  }));
  const aiFloatingDragRef = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);
  const lastAiProjectRef = useRef<string | null>(null);
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
    libraryFiles,
    libraryLoadingFiles,
    libraryLoadErrors,
    libraryBulkLoading,
    loadedLibraryFileCount,
    libraryBulkTotal,
    libraryBulkCompleted,
    libraryBulkFailed,
    libraryImportCount,
    libraryKindCounts,
    libraryIndexedSymbolCount,
    loadLibrarySymbolsForFile,
    loadAllLibrarySymbols,
    retryFailedLibraryLoads,
    cancelLibrarySymbolLoading,
    stdlibFileCount,
    projectSymbolsLoaded,
    parseErrorPaths,
    setEditorParseError,
  } = useCompileRunner({ rootPath });
  const [dataExcludeStdlib, setDataExcludeStdlib] = useState(true);
  const [showTerminal, setShowTerminal] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(180);
  const [terminalTabs, setTerminalTabs] = useState<TerminalTabState[]>([
    { id: "term-1", title: "Terminal 1", input: "", lines: [], history: [], historyIndex: null },
  ]);
  const [activeTerminalTabId, setActiveTerminalTabId] = useState<string | null>("term-1");
  const terminalTabCounterRef = useRef(1);
  const terminalResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<SymbolView | null>(null);
  const [selectedNodeSymbols, setSelectedNodeSymbols] = useState<SymbolView[] | null>(null);
  const [modelTreeHeight, setModelTreeHeight] = useState(260);
  const [collapseAllModel, setCollapseAllModel] = useState(false);
  const [showPropertiesPane, setShowPropertiesPane] = useState(true);
  const [propertiesDock, setPropertiesDock] = useState<"bottom" | "right">(() => {
    try {
      const stored = window.localStorage?.getItem(MODEL_PROPERTIES_DOCK_KEY);
      return stored === "right" ? "right" : "bottom";
    } catch {
      return "bottom";
    }
  });
  const [modelPropertiesWidth, setModelPropertiesWidth] = useState(320);
  const [trackText, setTrackText] = useState(() => {
    try {
      return window.localStorage?.getItem(TRACK_TEXT_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [modelExpanded, setModelExpanded] = useState<Record<string, boolean>>({});
  const [modelSectionOpen, setModelSectionOpen] = useState({ project: true, library: true, errors: true });
  const [showOnlyModelFiles, setShowOnlyModelFiles] = useState(() => {
    try {
      return window.localStorage?.getItem(FILTER_MODEL_FILES_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [modelShowFiles, setModelShowFiles] = useState(() => {
    try {
      const stored = window.localStorage?.getItem(MODEL_SHOW_FILES_KEY);
      return stored !== "false";
    } catch {
      return true;
    }
  });
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
  const elementAttrsCacheRef = useRef<Record<string, ProjectElementAttributesView | null>>({});
  const elementAttrsInflightRef = useRef<Record<string, Promise<ProjectElementAttributesView | null>>>({});
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
    if (
      activeTabMeta.kind === "ai" ||
      activeTabMeta.kind === "data" ||
      activeTabMeta.kind === "diagram" ||
      activeTabMeta.kind === "project-model"
    ) {
      return null;
    }
    return activeTabMeta.path;
  }, [activeTabMeta]);
  const activeDiagramPath = useMemo(() => {
    if (activeTabMeta?.kind === "diagram") return activeTabMeta.sourcePath || null;
    return null;
  }, [activeTabMeta]);
  const activeTerminalTab = useMemo(
    () => terminalTabs.find((tab) => tab.id === activeTerminalTabId) || null,
    [terminalTabs, activeTerminalTabId],
  );

  const updateActiveTerminalTab = (updater: (tab: TerminalTabState) => TerminalTabState) => {
    if (!activeTerminalTabId) return;
    setTerminalTabs((prev) =>
      prev.map((tab) => (tab.id === activeTerminalTabId ? updater(tab) : tab)),
    );
  };

  const ensureTerminalTab = () => {
    setTerminalTabs((prev) => {
      if (prev.length) return prev;
      terminalTabCounterRef.current = 1;
      return [{ id: "term-1", title: "Terminal 1", input: "", lines: [], history: [], historyIndex: null }];
    });
    setActiveTerminalTabId((prev) => prev || "term-1");
  };

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
    if (!showAstSplit) return;
    if (!activeEditorPath) {
      setAstSplitState({ content: "", error: "No active file.", loading: false });
      return;
    }
    const lower = activeEditorPath.toLowerCase();
    if (!lower.endsWith(".sysml") && !lower.endsWith(".kerml")) {
      setAstSplitState({ content: "", error: "AST is only available for .sysml and .kerml files.", loading: false });
      return;
    }
    const content = editorValueRef.current;
    loadAstSplitForContent(activeEditorPath, content);
    return () => {
      clearAstSplitTimer();
    };
  }, [showAstSplit, activeEditorPath, editorChangeTick, loadAstSplitForContent, setAstSplitState, clearAstSplitTimer]);

  const attachAstSync = () => {
    const editor = editorRef.current;
    const astEditor = astEditorRef.current;
    if (!showAstSplit || !editor || !astEditor) return;
    if (astScrollSyncRef.current) {
      astScrollSyncRef.current.dispose();
      astScrollSyncRef.current = null;
    }
    if (astCursorSyncRef.current) {
      astCursorSyncRef.current.dispose();
      astCursorSyncRef.current = null;
    }
    const syncScroll = () => {
      const scrollTop = editor.getScrollTop();
      const scrollHeight = editor.getScrollHeight();
      const layout = editor.getLayoutInfo();
      const maxEditor = Math.max(1, scrollHeight - layout.height);
      const ratio = scrollTop / maxEditor;
      const astScrollHeight = astEditor.getScrollHeight();
      const astLayout = astEditor.getLayoutInfo();
      const maxAst = Math.max(1, astScrollHeight - astLayout.height);
      astEditor.setScrollTop(ratio * maxAst);
    };
    astScrollSyncRef.current = editor.onDidScrollChange(syncScroll);
    astCursorSyncRef.current = editor.onDidChangeCursorPosition((event) => {
      const model = editor.getModel();
      const astModel = astEditor.getModel();
      if (!model || !astModel) return;
      const lineCount = model.getLineCount();
      const astLineCount = astModel.getLineCount();
      if (lineCount <= 0 || astLineCount <= 0) return;
      const ratio = event.position.lineNumber / lineCount;
      const astLine = Math.max(1, Math.min(astLineCount, Math.round(ratio * astLineCount)));
      astEditor.revealLineInCenter(astLine);
    });
    syncScroll();
  };

  useEffect(() => {
    if (!showAstSplit) return;
    attachAstSync();
    return () => {
      astScrollSyncRef.current?.dispose();
      astScrollSyncRef.current = null;
      astCursorSyncRef.current?.dispose();
      astCursorSyncRef.current = null;
    };
  }, [showAstSplit]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const raf = window.requestAnimationFrame(() => {
      editor.layout();
      astEditorRef.current?.layout();
      attachAstSync();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [showAstSplit]);

  useEffect(() => {
    const onDocClick = (event: globalThis.MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || !target.closest(".menu-button") && !target.closest(".menu-dropdown")) {
        setOpenMenu(null);
      }
      if (!target || !target.closest(".context-menu")) {
        setContextMenu(null);
        setModelContextMenu(null);
        setModelOptionsMenu(null);
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
    if (!showTerminal) return;
    ensureTerminalTab();
  }, [showTerminal]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = terminalResizeRef.current;
      if (!drag) return;
      const delta = drag.startY - event.clientY;
      const next = Math.max(120, Math.min(520, drag.startHeight + delta));
      setTerminalHeight(next);
    };
    const onPointerUp = () => {
      terminalResizeRef.current = null;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<string>("menu-action", (event) => {
      if (event.payload === "about") {
        setShowAbout(true);
      } else if (event.payload === "compile-workspace") {
        void runCompile();
      } else if (event.payload === "build-options") {
        openBuildOptions();
      } else if (event.payload === "toggle-project") {
        setLeftCollapsed((prev) => {
          if (!prev) {
            leftStoredWidthRef.current = leftWidth;
          } else {
            setLeftWidth(leftStoredWidthRef.current || 240);
          }
          return !prev;
        });
      } else if (event.payload === "toggle-terminal") {
        toggleTerminal();
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [leftWidth, runCompile]);

  useEffect(() => {
    let active = true;
    const loadAbout = async () => {
      try {
        const [version, tauriVersion, appName] = await Promise.all([
          getVersion(),
          getTauriVersion(),
          getName(),
        ]);
        if (!active) return;
        setAboutVersion(`${appName} ${version}`);
        setAboutBuild(`Tauri ${tauriVersion}`);
      } catch {
        if (!active) return;
        setAboutVersion(null);
        setAboutBuild(null);
      }
    };
    void loadAbout();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    window.localStorage?.setItem(AI_ENDPOINTS_KEY, JSON.stringify(aiEndpoints));
  }, [aiEndpoints]);

  useEffect(() => {
    if (!showSettings) return;
    setSettingsTab("theme");
    setSettingsStdlibStatus("");
    void (async () => {
      try {
        const [versions, selected] = await Promise.all([
          invoke<string[]>("list_stdlib_versions"),
          invoke<string | null>("get_default_stdlib"),
        ]);
        const nextVersions = Array.isArray(versions) ? versions : [];
        setSettingsStdlibVersions(nextVersions);
        setSettingsDefaultStdlib(selected || "");
      } catch (error) {
        setSettingsStdlibStatus(`Failed to load stdlib settings: ${String(error)}`);
        setSettingsStdlibVersions([]);
        setSettingsDefaultStdlib("");
      }
    })();
  }, [showSettings]);

  useEffect(() => {
    window.localStorage?.setItem(TRACK_TEXT_KEY, trackText ? "true" : "false");
  }, [trackText]);

  useEffect(() => {
    window.localStorage?.setItem(FILTER_MODEL_FILES_KEY, showOnlyModelFiles ? "true" : "false");
  }, [showOnlyModelFiles]);

  useEffect(() => {
    window.localStorage?.setItem(MODEL_SHOW_FILES_KEY, modelShowFiles ? "true" : "false");
  }, [modelShowFiles]);

  useEffect(() => {
    window.localStorage?.setItem(MODEL_PROPERTIES_DOCK_KEY, propertiesDock);
  }, [propertiesDock]);

  useEffect(() => {
    elementAttrsCacheRef.current = {};
    elementAttrsInflightRef.current = {};
  }, [rootPath, symbols]);


  useEffect(() => {
    if (selectedChatEndpoint) {
      window.localStorage?.setItem(AI_CHAT_KEY, selectedChatEndpoint);
    } else {
      window.localStorage?.removeItem(AI_CHAT_KEY);
    }
  }, [selectedChatEndpoint]);


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

  const loadStdlibMetamodel = async () => {
    if (!rootPath) {
      setMetamodelDebugError("Select a project root first.");
      setStdlibMetamodel(null);
      return;
    }
    setMetamodelDebugLoading(true);
    setMetamodelDebugError("");
    try {
      const payload = await invoke<StdlibMetamodelView>("get_stdlib_metamodel", { root: rootPath });
      setStdlibMetamodel(payload);
    } catch (error) {
      setMetamodelDebugError(`Failed to load metamodel: ${String(error)}`);
      setStdlibMetamodel(null);
    } finally {
      setMetamodelDebugLoading(false);
    }
  };

  const loadProjectModel = async () => {
    if (!rootPath) {
      setProjectModelError("Select a project root first.");
      setProjectModelView(null);
      return;
    }
    setProjectModelLoading(true);
    setProjectModelError("");
    try {
      const payload = await invoke<ProjectModelView>("get_project_model", { root: rootPath });
      setProjectModelView(payload);
    } catch (error) {
      setProjectModelError(`Failed to load project model: ${String(error)}`);
      setProjectModelView(null);
    } finally {
      setProjectModelLoading(false);
    }
  };

  const loadProjectAndLibraryModel = async () => {
    await Promise.all([loadProjectModel(), loadStdlibMetamodel()]);
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
      } else if (draggingRef.current === "modelProps") {
        const deltaX = event.clientX - startRef.current.x;
        setModelPropertiesWidth(Math.max(220, Math.min(720, startRef.current.modelProps - deltaX)));
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
    const onMove = (event: PointerEvent) => {
      if (!aiFloatingDragRef.current) return;
      const deltaX = event.clientX - aiFloatingDragRef.current.startX;
      const deltaY = event.clientY - aiFloatingDragRef.current.startY;
      const nextX = aiFloatingDragRef.current.baseX + deltaX;
      const nextY = aiFloatingDragRef.current.baseY + deltaY;
      const maxX = Math.max(0, window.innerWidth - 280);
      const maxY = Math.max(0, window.innerHeight - 160);
      setAiFloatingPos({
        x: Math.min(Math.max(0, nextX), maxX),
        y: Math.min(Math.max(0, nextY), maxY),
      });
    };
    const onUp = () => {
      aiFloatingDragRef.current = null;
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
  }, [rootPath, backgroundCompileEnabled, activeEditorPath]);

  useEffect(() => {
    if (activeTabMeta?.kind !== "project-model") return;
    if (!rootPath) return;
    void loadProjectAndLibraryModel();
  }, [activeTabMeta?.kind, rootPath]);

  useEffect(() => {
    if (!modelPaneContainerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setModelPaneHeight(Math.round(entry.contentRect.height));
    });
    observer.observe(modelPaneContainerRef.current);
    return () => observer.disconnect();
  }, [rightCollapsed]);


  const startDrag = (side: "left" | "right" | "model" | "modelProps", event: React.PointerEvent) => {
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
    startRef.current = {
      x: event.clientX,
      y: event.clientY,
      left: leftWidth,
      right: rightWidth,
      model: modelTreeHeight,
      modelProps: modelPropertiesWidth,
    };
    document.body.classList.add("dragging");
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
    setProjectModelView(null);
    setProjectModelError("");
    setProjectModelFocusQuery("");
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
    openProjectModelViewTab,
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

  const showContext = (event: ReactMouseEvent, entry: FileEntry) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, entry, scope: "node" });
    setModelContextMenu(null);
    setModelOptionsMenu(null);
  };

  const showRootContext = (event: ReactMouseEvent) => {
    if (!rootPath) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      scope: "root",
      entry: { name: rootPath.split(/[\\/]/).pop() || rootPath, path: rootPath, is_dir: true },
    });
    setModelContextMenu(null);
    setModelOptionsMenu(null);
  };

  const showModelContext = (
    event: ReactMouseEvent,
    payload: { filePath: string | null; label: string; section: "project" | "library"; loadError?: string },
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setModelContextMenu({
      x: event.clientX,
      y: event.clientY,
      filePath: payload.filePath,
      label: payload.label,
      section: payload.section,
      loadError: payload.loadError,
    });
    setModelOptionsMenu(null);
    setContextMenu(null);
  };

  const showModelOptions = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setModelOptionsMenu({ x: Math.round(rect.left), y: Math.round(rect.bottom + 4) });
    setModelContextMenu(null);
    setContextMenu(null);
  };

  const openAstView = async (filePath: string, label: string) => {
    setAstViewTitle(label);
    setAstViewOpen(true);
    await loadAstViewForPath(filePath);
  };

  const loadElementAttributes = async (symbol: SymbolView): Promise<ProjectElementAttributesView | null> => {
    if (!rootPath || !symbol.qualified_name) return null;
    const cacheKey = `${rootPath}::${symbol.qualified_name}::${symbol.kind || ""}`;
    if (cacheKey in elementAttrsCacheRef.current) {
      return elementAttrsCacheRef.current[cacheKey];
    }
    const inflight = elementAttrsInflightRef.current[cacheKey];
    if (inflight) {
      return inflight;
    }
    const request = (async () => {
      try {
        const data = await invoke<ProjectElementAttributesView>("get_project_element_attributes", {
          root: rootPath,
          elementQualifiedName: symbol.qualified_name,
          symbolKind: symbol.kind || null,
        });
        elementAttrsCacheRef.current[cacheKey] = data;
        return data;
      } catch {
        return null;
      } finally {
        delete elementAttrsInflightRef.current[cacheKey];
      }
    })();
    elementAttrsInflightRef.current[cacheKey] = request;
    try {
      return await request;
    } catch {
      return null;
    }
  };

  const openAttributeInProjectModel = (
    symbol: SymbolView,
    attrQualifiedName: string,
    attrName: string,
  ) => {
    setProjectModelFocusQuery(attrQualifiedName || `${symbol.qualified_name}::${attrName}`);
    openProjectModelViewTab();
  };

  const openAttributeSourceText = async (
    symbol: SymbolView,
    attrQualifiedName: string,
    attrName: string,
  ) => {
    if (!rootPath) return;
    type SemanticQueryPayload = {
      metatype?: string | null;
      metatype_is_a?: string | null;
      predicates: Array<{ name: string; equals: string }>;
    };
    type SemanticElementResult = {
      file_path: string;
      start_line: number;
      start_col: number;
      end_line: number;
      end_col: number;
    };
    try {
      const query: SemanticQueryPayload = {
        metatype: null,
        metatype_is_a: null,
        predicates: [
          {
            name: "qualified_name",
            equals: attrQualifiedName,
          },
        ],
      };
      const matches = await invoke<SemanticElementResult[]>("query_semantic", {
        root: rootPath,
        query,
      });
      const first = Array.isArray(matches) && matches.length ? matches[0] : null;
      if (first?.file_path) {
        await navigateTo({
          path: first.file_path,
          name: first.file_path.split(/[\\/]/).pop() || attrName || "Attribute",
          selection: {
            startLine: first.start_line,
            startCol: first.start_col,
            endLine: first.end_line,
            endCol: first.end_col,
          },
        });
        return;
      }
    } catch {
      // Fall back to opening the owning symbol when attribute lookup fails.
    }
    await navigateTo({
      path: symbol.file_path,
      name: symbol.file_path.split(/[\\/]/).pop() || symbol.name || "Source",
      selection: {
        startLine: symbol.start_line,
        startCol: symbol.start_col,
        endLine: symbol.end_line,
        endCol: symbol.end_col,
      },
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

  const [gitCommitSectionsOpen, setGitCommitSectionsOpen] = useState({
    changes: true,
    unversioned: true,
  });

  const toggleCommitAll = (section: "changes" | "unversioned", checked: boolean) => {
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
      const normalizedParent = parent.replace(/[\\/]+$/, "");
      const createdPath = `${normalizedParent}\\${finalName}`;
      if (newFileType === "diagram") {
        await invoke<string>("create_file", { root: rootPath, parent, name: finalName });
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
      await navigateTo({ path: createdPath, name: finalName });
    };

  const getDefaultBuildPath = (format: "jsonld" | "kpar" | "xmi") => {
    if (!rootPath) return "";
    const folder = `${rootPath}\\build`;
    const ext = format;
    return `${folder}\\model.${ext}`;
  };

  const openBuildOptions = () => {
    setExportFormat("jsonld");
    setExportIncludeStdlib(true);
    setExportAfterBuild(false);
    setExportPath(getDefaultBuildPath("jsonld"));
    setShowExport(true);
  };

  const runExportModel = async () => {
    if (!rootPath || !exportPath) {
      setCompileStatus("Export requires a project root and output path");
      return;
    }
    if (rootPath && exportPath.startsWith(rootPath)) {
      const buildDir = `${rootPath}\\build`;
      if (exportPath.toLowerCase().startsWith(buildDir.toLowerCase())) {
        await invoke("create_dir", { root: rootPath, parent: rootPath, name: "build" }).catch(() => {});
      }
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

  const runBuildWithOptions = async () => {
    if (!rootPath) {
      setCompileStatus("Build requires a project root");
      return;
    }
    const ok = await runCompile();
    if (exportAfterBuild) {
      if (!exportPath) {
        setCompileStatus("Export after build requires an output path");
        return;
      }
      if (ok) {
        await runExportModel();
      }
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
            const content = await readFileText(changedPath);
            updateDocContent(changedPath, content || "", false);
            if (currentFilePathRef.current === changedPath && editorRef.current && centerView === "file") {
              suppressDirtyRef.current = true;
              editorRef.current.setValue(content || "");
            }
          } catch {
            // ignore
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

    // Ensure Ctrl+/ toggles line comments.
    editorInstance.addAction({
      id: "toggle-line-comment",
      label: "Toggle Line Comment",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash],
      run: () => editorInstance.getAction("editor.action.commentLine")?.run(),
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
          setEditorParseError(activeEditorPath, markers.length > 0);
        })
        .catch(() => {
          if (reqId !== parseReqRef.current) return;
          monaco.editor.setModelMarkers(model, "sysml-parse", []);
          setEditorParseError(activeEditorPath, false);
        });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [editorChangeTick, activeEditorPath, setEditorParseError]);

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
    if (!symbol.file_path) return;
    const startLine = Math.max(1, symbol.start_line || 1);
    const startCol = Math.max(1, symbol.start_col || 1);
    let endLine = Math.max(startLine, symbol.end_line || symbol.start_line || 1);
    let endCol = Math.max(1, symbol.end_col || symbol.start_col || 1);
    if (endLine === startLine && endCol < startCol) {
      endCol = startCol;
    }
    if (endLine === startLine && endCol === startCol) {
      endCol = startCol + 1;
    }
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

  const evaluateTerminalExpression = async (rawExpr: string): Promise<string> => {
    if (!rawExpr.trim()) return "Error = missing expression";
    if (!rootPath) return "Error = no project root selected";
    try {
      const value = await invoke<string>("eval_expression", { root: rootPath, expression: rawExpr });
      return `Result = ${value}`;
    } catch (error) {
      return `Error = ${String(error)}`;
    }
  };

  const normalizeTerminalRef = (value: string) => value.trim().replace(/\./g, "::");

  const appendTerminalLines = (next: string[]) => {
    updateActiveTerminalTab((tab) => ({ ...tab, lines: [...tab.lines, ...next].slice(-300) }));
  };

  const toggleTerminal = () => {
    setShowTerminal((prev) => {
      const next = !prev;
      if (next) ensureTerminalTab();
      return next;
    });
  };

  const inspectByType = (raw: string): string[] => {
    const needle = raw.trim().toLowerCase();
    if (!needle) return ["Error = missing type query"];
    const projectSymbols = symbols.filter((symbol) => !isPathWithin(symbol.file_path, libraryPath));
    const matches = projectSymbols.filter((symbol) => {
      const kind = (symbol.kind || "").toLowerCase();
      if (kind === needle) return true;
      const metatype = (symbol.properties || []).find(
        (prop) => prop.name === "metatype_qname" && prop.value?.type === "text",
      );
      if (metatype && metatype.value.type === "text") {
        const value = (metatype.value.value || "").toLowerCase();
        return value.endsWith(needle) || value.includes(needle);
      }
      return false;
    });
    if (!matches.length) return [`Result = no symbols for type '${raw.trim()}'`];
    const lines = [`Result = ${matches.length} symbols`];
    matches.slice(0, 20).forEach((symbol) => {
      lines.push(
        `- ${symbol.kind} ${symbol.qualified_name} @ ${symbol.file_path}:${symbol.start_line || 0}`,
      );
    });
    if (matches.length > 20) {
      lines.push(`... ${matches.length - 20} more`);
    }
    return lines;
  };

  const inspectSymbol = (raw: string): string[] => {
    const query = normalizeTerminalRef(raw);
    if (!query) return ["Error = missing symbol query"];
    const projectSymbols = symbols.filter((symbol) => !isPathWithin(symbol.file_path, libraryPath));
    let symbol = projectSymbols.find((item) => (item.qualified_name || "").trim() === query);
    if (!symbol) {
      symbol = projectSymbols.find((item) => (item.name || "").trim() === query);
    }
    if (!symbol) {
      const partial = projectSymbols.filter((item) => {
        const qn = (item.qualified_name || "").trim();
        return qn.endsWith(`::${query}`) || qn.includes(query);
      });
      if (!partial.length) return [`Result = symbol '${raw.trim()}' not found`];
      const lines = [`Result = ${partial.length} matches`];
      partial.slice(0, 20).forEach((item) => {
        lines.push(`- ${item.kind} ${item.qualified_name} @ ${item.file_path}:${item.start_line || 0}`);
      });
      if (partial.length > 20) lines.push(`... ${partial.length - 20} more`);
      return lines;
    }
    const lines = [
      `Result = ${symbol.kind} ${symbol.qualified_name}`,
      `file = ${symbol.file_path}`,
      `span = ${symbol.start_line || 0}:${symbol.start_col || 0} - ${symbol.end_line || 0}:${symbol.end_col || 0}`,
    ];
    const properties = symbol.properties || [];
    if (properties.length) {
      lines.push("properties:");
      properties.slice(0, 16).forEach((prop) => {
        const value =
          prop.value.type === "text"
            ? prop.value.value
            : prop.value.type === "number"
              ? String(prop.value.value)
              : prop.value.type === "bool"
                ? String(prop.value.value)
                : `[${prop.value.items.join(", ")}]`;
        lines.push(`- ${prop.name} = ${value}`);
      });
      if (properties.length > 16) lines.push(`... ${properties.length - 16} more properties`);
    }
    const rels = symbol.relationships || [];
    if (rels.length) {
      lines.push("relationships:");
      rels.slice(0, 12).forEach((rel) => {
        lines.push(`- ${rel.kind} -> ${rel.resolved_target || rel.target}`);
      });
      if (rels.length > 12) lines.push(`... ${rels.length - 12} more relationships`);
    }
    return lines;
  };

  const runTerminalCommand = async () => {
    const command = (activeTerminalTab?.input || "").trim();
    if (!command) return;
    updateActiveTerminalTab((tab) => ({
      ...tab,
      history: [...tab.history, command].slice(-200),
      historyIndex: null,
      input: "",
    }));
    appendTerminalLines([`> ${command}`]);
    if (command.toLowerCase().startsWith("eval ")) {
      const expr = command.slice(5);
      const result = await evaluateTerminalExpression(expr);
      appendTerminalLines([result]);
      return;
    }
    if (command.toLowerCase().startsWith("inspect ")) {
      const rest = command.slice(8).trim();
      if (rest.toLowerCase().startsWith("type ")) {
        appendTerminalLines(inspectByType(rest.slice(5)));
      } else {
        appendTerminalLines(inspectSymbol(rest));
      }
      return;
    }
    appendTerminalLines(["Error = unknown command (try: eval A.x or inspect A.x or inspect type Usage)"]);
  };

  const autocompleteTerminalEval = () => {
    const trimmed = (activeTerminalTab?.input || "").trim().toLowerCase();
    if (trimmed === "e" || trimmed === "ev" || trimmed === "eva" || trimmed === "eval") {
      updateActiveTerminalTab((tab) => ({ ...tab, input: "eval " }));
    }
  };

  const terminalHistoryUp = () => {
    updateActiveTerminalTab((tab) => {
      if (!tab.history.length) return tab;
      if (tab.historyIndex == null) {
        const nextIndex = tab.history.length - 1;
        return { ...tab, historyIndex: nextIndex, input: tab.history[nextIndex] || "" };
      }
      const nextIndex = Math.max(0, tab.historyIndex - 1);
      return { ...tab, historyIndex: nextIndex, input: tab.history[nextIndex] || "" };
    });
  };

  const terminalHistoryDown = () => {
    updateActiveTerminalTab((tab) => {
      if (!tab.history.length || tab.historyIndex == null) return tab;
      const lastIndex = tab.history.length - 1;
      if (tab.historyIndex >= lastIndex) {
        return { ...tab, historyIndex: null, input: "" };
      }
      const nextIndex = tab.historyIndex + 1;
      return { ...tab, historyIndex: nextIndex, input: tab.history[nextIndex] || "" };
    });
  };

  const createTerminalTab = () => {
    terminalTabCounterRef.current += 1;
    const id = `term-${terminalTabCounterRef.current}`;
    const next: TerminalTabState = {
      id,
      title: `Terminal ${terminalTabCounterRef.current}`,
      input: "",
      lines: [],
      history: [],
      historyIndex: null,
    };
    setTerminalTabs((prev) => [...prev, next]);
    setActiveTerminalTabId(id);
    setShowTerminal(true);
  };

  const closeTerminalTab = (id: string) => {
    setTerminalTabs((prev) => {
      const idx = prev.findIndex((tab) => tab.id === id);
      if (idx < 0) return prev;
      const next = prev.filter((tab) => tab.id !== id);
      if (!next.length) {
        setShowTerminal(false);
        setActiveTerminalTabId(null);
        return next;
      }
      if (activeTerminalTabId === id) {
        const fallback = next[Math.max(0, idx - 1)]?.id || next[0].id;
        setActiveTerminalTabId(fallback);
      }
      return next;
    });
  };


  const saveActiveTab = async () => {
    if (!activeEditorPath) return;
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
      const isTerminalToggle = (event.ctrlKey || event.metaKey) && key === "t";
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
        if (activeTabPath === PROJECT_DESCRIPTOR_TAB) {
          closeTab(PROJECT_DESCRIPTOR_TAB);
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
      if (isTerminalToggle) {
        event.preventDefault();
        toggleTerminal();
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
  }, [activeTabPath, activeTabMeta, activeEditorPath, contextMenu, openMenu, showExport, showNewFile, showNewProject, showOpenProject, showProjectProperties, showSettings, tabMenu]);

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

  const saveDefaultStdlibSelection = async () => {
    setSettingsStdlibBusy(true);
    setSettingsStdlibStatus("Saving...");
    try {
      const selected = settingsDefaultStdlib.trim();
      const saved = await invoke<string | null>("set_default_stdlib", {
        stdlib: selected ? selected : null,
      });
      setSettingsDefaultStdlib(saved || "");
      setSettingsStdlibStatus("Saved default stdlib.");
    } catch (error) {
      setSettingsStdlibStatus(`Failed to save stdlib setting: ${String(error)}`);
    } finally {
      setSettingsStdlibBusy(false);
    }
  };

  const sendAiMessage = async (text: string) => {
    const endpoint = selectedChatEndpoint ? aiEndpoints.find((item) => item.id === selectedChatEndpoint) : null;
    const requestId = ++aiRequestRef.current;
    setAiMessages((prev) => [
      ...prev,
      { role: "user", text, raw: text },
      { role: "assistant", text: "...", raw: "...", pendingId: requestId },
    ]);
    setAiInput("");
    setAiHistoryIndex(null);
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
      const projectSymbols = symbols.filter((symbol) => !isPathWithin(symbol.file_path, libraryPath));
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
          `- ${symbol.kind} ${symbol.qualified_name} @ ${symbol.file_path}:${symbol.start_line ?? 0}`,
      );
      const unresolvedLines = unresolvedTop.map(
        (item) => `- ${item.file_path}:${item.line ?? 0}:${item.column ?? 0} ${item.message}`,
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
      const contextTextRaw = buildModelContext();
      const clampText = (value: string, limit: number) => {
        if (value.length <= limit) return value;
        return value.slice(0, limit) + "\n... (truncated)";
      };
      const contextText = clampText(contextTextRaw, 12000);
      const historyTrimmed = history.slice(-12);
      const projectNote =
        rootPath && lastAiProjectRef.current !== rootPath
          ? [{ role: "user" as const, text: `Project changed to: ${rootPath}` }]
          : [];
    lastAiProjectRef.current = rootPath || null;
      const messages = [
        {
          role: "user" as const,
          text:
            "Model context (read-only). Use it as ground truth when answering about this workspace:\n\n" +
            contextText,
        },
        ...projectNote,
        ...historyTrimmed.map((msg) => ({ role: msg.role, text: msg.raw ?? msg.text })),
        { role: "user" as const, text },
      ];
    try {
      const response = await runAgent({
        url: endpoint.url,
        provider: endpoint.provider,
        model: endpoint.model || null,
        token: endpoint.token || null,
        root: rootPath || null,
        enable_tools: true,
        messages: messages.map((msg) => ({ role: msg.role, content: msg.text })),
      });
        const content = response?.message || "";
        const extractFirstJsonObject = (text: string) => {
          let inString = false;
          let escape = false;
          let depth = 0;
          let start = -1;
          for (let i = 0; i < text.length; i += 1) {
            const ch = text[i];
            if (escape) {
              escape = false;
              continue;
            }
            if (ch === "\\") {
              escape = true;
              continue;
            }
            if (ch === "\"") {
              inString = !inString;
              continue;
            }
            if (inString) continue;
            if (ch === "{") {
              if (depth === 0) start = i;
              depth += 1;
            } else if (ch === "}") {
              depth = Math.max(0, depth - 1);
              if (depth === 0 && start >= 0) {
                return text.slice(start, i + 1);
              }
            }
          }
          return null;
        };

        const fixLooseJson = (value: string) => value.replace(/\\(?![\\/"bfnrtu])/g, "\\\\");

        const parseAgentJson = (text: string) => {
          if (!text) return null;
          let candidate = text.trim();
          if (candidate.startsWith("```")) {
            candidate = candidate.replace(/^```[a-zA-Z]*\s*/, "");
            candidate = candidate.replace(/```\s*$/, "");
            candidate = candidate.trim();
          }
          const extracted = extractFirstJsonObject(candidate);
          if (extracted) {
            candidate = extracted;
          }
          try {
            const parsed = JSON.parse(candidate);
            return parsed && typeof parsed === "object" ? parsed : null;
          } catch {
            try {
              const fixed = fixLooseJson(candidate);
              const parsed = JSON.parse(fixed);
              return parsed && typeof parsed === "object" ? parsed : null;
            } catch {
              return null;
            }
          }
        };
        const parsedAgent = parseAgentJson(content);
        let parsedSummary: string | undefined;
        let parsedSteps: Array<{ id: string; label: string; recommended: boolean; action: string }> | undefined;
        let parsedToolNote: string | undefined;
        if (parsedAgent && typeof parsedAgent === "object" && typeof parsedAgent.action === "string") {
          if (parsedAgent.action === "final" && typeof parsedAgent.content === "string") {
            const parsedFinal = parseAgentJson(parsedAgent.content);
            if (parsedFinal && typeof parsedFinal.summary === "string") {
              parsedSummary = parsedFinal.summary;
            }
            if (Array.isArray(parsedFinal?.next_steps)) {
              parsedSteps = parsedFinal.next_steps
                .map((step: any, index: number) => ({
                  id: typeof step?.id === "string" && step.id.trim() ? step.id : String(index + 1),
                  label: typeof step?.label === "string" ? step.label : "",
                  recommended: Boolean(step?.recommended),
                  action: typeof step?.action === "string" ? step.action : "",
                }))
                .filter((step: { label: string; action: string }) => step.label || step.action);
            }
          } else {
            const detail = parsedAgent.path || parsedAgent.query || parsedAgent.detail || "";
            parsedToolNote = `Tool request: ${parsedAgent.action}${detail ? ` ${detail}` : ""}`;
          }
        } else {
          parsedSummary = parsedAgent && typeof parsedAgent.summary === "string" ? parsedAgent.summary : undefined;
          parsedSteps = Array.isArray(parsedAgent?.next_steps)
            ? parsedAgent.next_steps
                .map((step: any, index: number) => ({
                  id: typeof step?.id === "string" && step.id.trim() ? step.id : String(index + 1),
                  label: typeof step?.label === "string" ? step.label : "",
                  recommended: Boolean(step?.recommended),
                  action: typeof step?.action === "string" ? step.action : "",
                }))
                .filter((step: { label: string; action: string }) => step.label || step.action)
            : undefined;
        }
        const nextText =
          response?.final_response?.summary ||
          parsedSummary ||
          parsedToolNote ||
          content ||
          "No response.";
        const toolEdits = (response?.steps || [])
          .filter((step) => step.kind === "tool" && typeof step.detail === "string")
          .map((step) => step.detail);
        if (toolEdits.length && rootPath) {
          const rootBase = rootPath.replace(/[\\/]+$/, "");
          const resolveToolPath = (rawPath: string) => {
            const trimmed = rawPath.trim();
            if (!trimmed) return null;
            if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\")) {
              return trimmed;
            }
            const cleaned = trimmed.replace(/^[\\/]+/, "");
            return `${rootBase}\\${cleaned}`;
          };
          const touched = new Set<string>();
          for (const detail of toolEdits) {
            if (detail.startsWith("write_file:")) {
              const resolved = resolveToolPath(detail.slice("write_file:".length));
              if (resolved) touched.add(resolved);
            } else if (detail.startsWith("apply_patch:")) {
              const resolved = resolveToolPath(detail.slice("apply_patch:".length));
              if (resolved) touched.add(resolved);
            }
          }
          if (touched.size) {
            await Promise.all(
              Array.from(touched).map(async (path) => {
                try {
                  const content = await readFileText(path);
                  updateDocContent(path, content || "", false);
                  if (currentFilePathRef.current === path && editorRef.current && centerView === "file") {
                    suppressDirtyRef.current = true;
                    editorRef.current.setValue(content || "");
                  }
                } catch {
                  // ignore tool sync errors
                }
              }),
            );
          }
        }
        const nextSteps = Array.isArray(response?.final_response?.next_steps)
          ? response.final_response.next_steps
          : parsedSteps;
      setAiMessages((prev) =>
        prev.map((msg) =>
          msg.pendingId === requestId
            ? {
                ...msg,
                text: nextText,
                raw: content || nextText,
                pendingId: undefined,
                steps: Array.isArray(response?.steps) ? response.steps : [],
                nextSteps,
              }
            : msg,
        ),
      );
      if (nextSteps && nextSteps.length) {
        setAiFloatingSteps(nextSteps);
      }
    } catch (error) {
      setAiMessages((prev) =>
        prev.map((msg) =>
          msg.pendingId === requestId ? { ...msg, text: `Error: ${String(error)}`, pendingId: undefined } : msg,
        ),
      );
    }
  };

    const cycleAiHistory = (direction: "up" | "down") => {
      const history = aiMessages.filter((msg) => msg.role === "user").map((msg) => msg.text);
      if (!history.length) return;
      let nextIndex = aiHistoryIndex ?? history.length;
    if (direction === "up") {
      nextIndex = Math.max(0, nextIndex - 1);
    } else {
      nextIndex = Math.min(history.length, nextIndex + 1);
    }
    if (nextIndex === history.length) {
      setAiHistoryIndex(null);
      setAiInput("");
      return;
    }
    setAiHistoryIndex(nextIndex);
    setAiInput(history[nextIndex] || "");
  };

    const runAiNextStep = (step: { id: string; label: string; recommended: boolean; action: string }) => {
      const content = step.action || step.label;
      if (!content.trim()) return;
      setAiInput(content);
      void sendAiMessage(content);
    };

    const clearAiMessages = () => {
      setAiMessages([]);
      setAiFloatingSteps([]);
      setAiHistoryIndex(null);
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
    dataViewSymbols,
    dataViewSymbolKindCounts,
  } = useModelGroups({
    deferredSymbols,
    deferredUnresolved,
    rootPath,
    libraryPath,
    libraryFilePaths: libraryFiles,
    stdlibFileCount,
    librarySymbolCount: libraryIndexedSymbolCount,
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
    showUsages: showUsageNodes,
    modelShowFiles,
    libraryLoadingFilePaths: libraryLoadingFiles,
    libraryLoadErrors,
    libraryKindFilter,
  });
  const pendingLibraryFiles = Math.max(0, libraryFiles.length - loadedLibraryFileCount);
  const failedLibraryFiles = Object.keys(libraryLoadErrors).length;
  const libraryStatusLabel = libraryBulkLoading
    ? `Library ${libraryBulkCompleted}/${libraryBulkTotal || pendingLibraryFiles} loading${libraryBulkFailed ? ` (${libraryBulkFailed} failed)` : ""}`
    : `Library ${loadedLibraryFileCount}/${libraryFiles.length} loaded | ${libraryIndexedSymbolCount} symbols${failedLibraryFiles ? ` (${failedLibraryFiles} failed)` : ""}${libraryImportCount ? ` | imports ${libraryImportCount}` : ""}${libraryKindFilter ? ` | filter ${libraryKindFilter}` : ""}`;

  const undockedTreeHeight = Math.max(
    modelTreeHeight,
    modelPaneHeight > 0 ? modelPaneHeight - 44 : modelTreeHeight,
  );
  const effectiveModelTreeHeight =
    showPropertiesPane && propertiesDock === "bottom" ? modelTreeHeight : undockedTreeHeight;

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
    setSelectedNodeSymbols,
    selectSymbolInEditor,
    navigateTo,
    onRequestLibraryFileSymbols: (filePath) => {
      void loadLibrarySymbolsForFile(filePath);
    },
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

  const { trackCandidate } = useModelTracking({
    symbols,
    activeEditorPath,
    cursorPos,
    enabled: trackText,
    onTrack: (symbol) => {
      setSelectedSymbol(symbol);
      setSelectedNodeSymbols([symbol]);
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
        onModelContextMenu: showModelContext,
        setModelCursorIndex,
        setModelSectionOpen,
        setModelExpanded,
        selectedSymbol,
        setSelectedSymbol,
        setSelectedNodeSymbols,
        selectSymbolInEditor,
        navigateTo,
        renderTypeIcon,
        onRequestLibraryFileSymbols: (filePath) => {
          void loadLibrarySymbolsForFile(filePath);
        },
        onRetryLibraryFileSymbols: (filePath) => {
          void loadLibrarySymbolsForFile(filePath);
        },
      }),
    [
      modelCursorIndex,
      modelSectionOpen,
      modelSectionIndent,
      handleModelTreeKeyDown,
      showModelContext,
      selectedSymbol,
      setSelectedSymbol,
      setSelectedNodeSymbols,
      selectSymbolInEditor,
      navigateTo,
      renderTypeIcon,
      loadLibrarySymbolsForFile,
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
              <div className="menu-header">Debug</div>
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  setShowAstSplit((prev) => !prev);
                }}
              >
                {showAstSplit ? "✓ " : ""}AST Split
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  toggleTerminal();
                }}
              >
                {showTerminal ? "✓ " : ""}View Terminal
              </button>
              <div className="menu-divider" />
              <button type="button" onClick={() => { setOpenMenu(null); openAiViewTab(); }}>Agent</button>
              <button type="button" onClick={() => { setOpenMenu(null); openDataViewTab(); }}>Data Analysis View</button>
              <button type="button" onClick={() => { setOpenMenu(null); openProjectModelViewTab(); }}>Project Model View</button>
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
              <button type="button" onClick={() => { setOpenMenu(null); void runCompile(); }}>Build</button>
              <button type="button" onClick={() => { setOpenMenu(null); openBuildOptions(); }}>Show Build Options</button>
            </div>
              ) : null}
            </div>
            <div className="menu-item">
              <button type="button" className="menu-button" onClick={() => setOpenMenu(openMenu === "Help" ? null : "Help")}>Help</button>
              {openMenu === "Help" ? (
            <div className="menu-dropdown" data-tauri-drag-region="false">
              <button type="button" onClick={() => { setOpenMenu(null); setShowAbout(true); }}>About</button>
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
              <div className="project-actions inline">
                <button
                  type="button"
                  className="ghost collapse-btn"
                  onClick={() => {
                    leftStoredWidthRef.current = leftWidth;
                    setLeftCollapsed(true);
                  }}
                  title="Collapse project"
                >
                  {"<<"}
                </button>
                <button type="button" className="icon-button" onClick={chooseProject} aria-label="Open Project" title="Open Project" />
                <select className="recent-select" value="" onChange={(e) => openProject(e.target.value)} aria-label="Open recent" title="Open recent">
                  <option value="">Recent</option>
                  {recentProjects.map((path) => (
                    <option key={path} value={path}>{path}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className={`ghost ${showOnlyModelFiles ? "active" : ""}`}
                  onClick={() => setShowOnlyModelFiles((prev) => !prev)}
                  title={showOnlyModelFiles ? "Show all files" : "Filter to .sysml/.kerml"}
                  aria-label="Filter SysML/KerML"
                >
                  <span className="icon-filter" aria-hidden="true" />
                </button>
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
              showOnlyModelFiles={showOnlyModelFiles}
              parseErrorPaths={parseErrorPaths}
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
                {">>"}
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
                      onRunStep={runAiNextStep}
                      onCycleHistory={cycleAiHistory}
                      onClear={clearAiMessages}
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
                  rootPath={rootPath}
                  libraryPath={libraryPath}
                  projectCounts={projectCounts}
                  libraryCounts={libraryCounts}
                  errorCounts={errorCounts}
                  dataViewSymbols={dataViewSymbols}
                  dataViewSymbolKindCounts={dataViewSymbolKindCounts}
                />
              ) : activeTabMeta?.kind === "project-model" ? (
                <ProjectModelPaneView
                  rootPath={rootPath}
                  model={projectModelView}
                  library={stdlibMetamodel}
                  loading={projectModelLoading}
                  libraryLoading={metamodelDebugLoading}
                  error={projectModelError}
                  libraryError={metamodelDebugError}
                  focusQuery={projectModelFocusQuery}
                  onRefresh={() => {
                    void loadProjectAndLibraryModel();
                  }}
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
                    </div>
                    {trackCandidate ? null : (
                      <div className="editor-toolbar-group">
                        <span className="muted">No symbol near cursor</span>
                      </div>
                    )}
                </div>
                  <div className={`editor-body ${showAstSplit ? "editor-split" : ""}`}>
                    <div className="editor-pane">
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
                    {showAstSplit ? (
                      <div className="ast-pane">
                        <div className="ast-pane-header">AST (read-only)</div>
                        <AstStatus state={astSplitState}>
                          <MonacoEditor
                            value={astSplitState.content || ""}
                            language="plaintext"
                            theme={appTheme === "light" ? "vs" : "vs-dark"}
                            onMount={(editorInstance) => {
                              astEditorRef.current = editorInstance;
                              editorInstance.updateOptions({
                                readOnly: true,
                                domReadOnly: true,
                                minimap: { enabled: false },
                                wordWrap: "off",
                                scrollBeyondLastLine: false,
                                renderLineHighlight: "none",
                              });
                              editorInstance.layout();
                              attachAstSync();
                            }}
                            options={{
                              readOnly: true,
                              domReadOnly: true,
                              minimap: { enabled: false },
                              wordWrap: "off",
                              scrollBeyondLastLine: false,
                              renderLineHighlight: "none",
                              fontSize: editorOptions?.fontSize,
                              lineNumbers: "on",
                            }}
                          />
                        </AstStatus>
                      </div>
                    ) : null}
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
            <TerminalPane
              open={showTerminal}
              height={terminalHeight}
              tabs={terminalTabs.map((tab) => ({ id: tab.id, title: tab.title }))}
              activeTabId={activeTerminalTabId}
              onSelectTab={setActiveTerminalTabId}
              onNewTab={createTerminalTab}
              onCloseTab={closeTerminalTab}
              onResizeStart={(event) => {
                terminalResizeRef.current = { startY: event.clientY, startHeight: terminalHeight };
              }}
              lines={activeTerminalTab?.lines || []}
              input={activeTerminalTab?.input || ""}
              onInputChange={(value) => {
                updateActiveTerminalTab((tab) => ({ ...tab, input: value, historyIndex: null }));
              }}
              onSubmit={() => {
                void runTerminalCommand();
              }}
              onClose={() => setShowTerminal(false)}
              onAutocompleteEval={autocompleteTerminalEval}
              onHistoryUp={terminalHistoryUp}
              onHistoryDown={terminalHistoryDown}
              onClear={() => {
                updateActiveTerminalTab((tab) => ({ ...tab, lines: [] }));
              }}
            />
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
                {"<<"}
              </button>
            ) : null}
          </div>
          {rightCollapsed ? null : (
            <section className="panel sidebar" ref={modelPaneContainerRef}>
              <div className="panel-header">
              <ModelHeader
                collapseAll={collapseAllModel}
                libraryStatus={libraryStatusLabel}
                onCollapseAll={() => setCollapseAllModel(true)}
                onExpandAll={() => setCollapseAllModel(false)}
                onOpenOptions={showModelOptions}
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
                {">>"}
              </button>
            </div>
            <ModelPane
              modelTreeHeight={effectiveModelTreeHeight}
              showPropertiesPane={showPropertiesPane}
              propertiesDock={propertiesDock}
              modelPropertiesWidth={modelPropertiesWidth}
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
              selectedSymbols={selectedNodeSymbols}
              getDoc={getDoc}
              readFile={async (path: string) => {
                const content = await readFileText(path);
                return content || "";
              }}
              onOpenInProjectModel={(symbol) => {
                setProjectModelFocusQuery(symbol.qualified_name || symbol.name || symbol.kind);
                openProjectModelViewTab();
              }}
              onOpenAttributeInProjectModel={openAttributeInProjectModel}
              onOpenAttributeSourceText={openAttributeSourceText}
              loadElementAttributes={loadElementAttributes}
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
        {modelOptionsMenu ? (
          <div className="context-menu" style={{ left: modelOptionsMenu.x, top: modelOptionsMenu.y }}>
            <button
              type="button"
              onClick={() => {
                setModelShowFiles((prev) => !prev);
                setModelOptionsMenu(null);
              }}
            >
              {modelShowFiles ? "Hide File Groups" : "Show File Groups"}
            </button>
            <button
              type="button"
              disabled={!pendingLibraryFiles || libraryBulkLoading}
              onClick={() => {
                void loadAllLibrarySymbols();
                setModelOptionsMenu(null);
              }}
            >
              {libraryBulkLoading
                ? "Loading Library Symbols..."
                : `Load All Library Symbols (${loadedLibraryFileCount}/${libraryFiles.length})`}
            </button>
            <button
              type="button"
              disabled={!libraryBulkLoading}
              onClick={() => {
                cancelLibrarySymbolLoading();
                setModelOptionsMenu(null);
              }}
            >
              Cancel Library Load
            </button>
            <button
              type="button"
              disabled={!failedLibraryFiles || libraryBulkLoading}
              onClick={() => {
                void retryFailedLibraryLoads();
                setModelOptionsMenu(null);
              }}
            >
              Retry Failed Library Loads{failedLibraryFiles ? ` (${failedLibraryFiles})` : ""}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowPropertiesPane((prev) => !prev);
                setModelOptionsMenu(null);
              }}
            >
              {showPropertiesPane ? "Undock Properties Panel" : "Dock Properties Panel"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPropertiesDock("bottom");
                setShowPropertiesPane(true);
                setModelOptionsMenu(null);
              }}
            >
              Dock Properties: Bottom{propertiesDock === "bottom" ? " (current)" : ""}
            </button>
            <button
              type="button"
              onClick={() => {
                setPropertiesDock("right");
                setShowPropertiesPane(true);
                setModelOptionsMenu(null);
              }}
            >
              Dock Properties: Right{propertiesDock === "right" ? " (current)" : ""}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowUsageNodes((prev) => !prev);
                setModelOptionsMenu(null);
              }}
            >
              {showUsageNodes ? "Hide Usages" : "Show Usages"}
            </button>
            <div className="context-meta">
              Library kinds ({libraryKindCounts.reduce((sum, [, count]) => sum + count, 0)}):
            </div>
            {libraryKindCounts.slice(0, 8).map(([kind, count]) => (
              <button
                key={`library-kind-${kind}`}
                type="button"
                className={libraryKindFilter === kind ? "context-kind-filter active" : "context-kind-filter"}
                onClick={() => setLibraryKindFilter((prev) => (prev === kind ? null : kind))}
              >
                {kind}: {count}
              </button>
            ))}
            <button
              type="button"
              disabled={!libraryKindFilter}
              onClick={() => setLibraryKindFilter(null)}
            >
              Clear Library Kind Filter
            </button>
          </div>
        ) : null}
        {modelContextMenu ? (
          <div className="context-menu" style={{ left: modelContextMenu.x, top: modelContextMenu.y }}>
            <button
              type="button"
              disabled={!modelContextMenu.filePath}
              onClick={() => {
                if (!modelContextMenu.filePath) return;
                void openAstView(modelContextMenu.filePath, modelContextMenu.label);
                setModelContextMenu(null);
              }}
            >
              Show AST
            </button>
            <button
              type="button"
              disabled={modelContextMenu.section !== "library" || !modelContextMenu.filePath}
              onClick={() => {
                if (!modelContextMenu.filePath || modelContextMenu.section !== "library") return;
                void loadLibrarySymbolsForFile(modelContextMenu.filePath);
                setModelContextMenu(null);
              }}
            >
              Retry Library File Load
            </button>
            {modelContextMenu.section === "library" && modelContextMenu.loadError ? (
              <div className="context-meta">Last load error: {modelContextMenu.loadError}</div>
            ) : null}
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
                  <div className="field-value">{newFileParent || rootPath || "â€”"}</div>
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
                    <span>{gitInfo.repo_root.replace(/^\\\\\\?\\/, "")}</span>
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
                  <div className="commit-tree">
                    <div className="commit-header">
                      <input
                        type="checkbox"
                        checked={
                          gitStatus.staged.length + gitStatus.unstaged.length > 0 &&
                          [...gitStatus.staged, ...gitStatus.unstaged].every((path) => gitCommitSelection[path])
                        }
                        onChange={(event) => toggleCommitAll("changes", event.target.checked)}
                      />
                      <button
                        type="button"
                        className="commit-toggle"
                        onClick={() => setGitCommitSectionsOpen((prev) => ({ ...prev, changes: !prev.changes }))}
                        aria-expanded={gitCommitSectionsOpen.changes}
                      >
                        {gitCommitSectionsOpen.changes ? "v" : ">"}
                      </button>
                      <span>Changes</span>
                      <span>{gitStatus.staged.length + gitStatus.unstaged.length}</span>
                    </div>
                    {gitCommitSectionsOpen.changes ? (
                      <div className="commit-list">
                        {[
                          ...gitStatus.staged.map((path) => ({ path, state: "staged" as const })),
                          ...gitStatus.unstaged.map((path) => ({ path, state: "unstaged" as const })),
                        ].map(({ path, state }) => (
                          <label key={`change-${path}`} className="commit-row">
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
                    <div className="commit-header">
                      <input
                        type="checkbox"
                        checked={
                          gitStatus.untracked.length > 0 &&
                          gitStatus.untracked.every((path) => gitCommitSelection[path])
                        }
                        onChange={(event) => toggleCommitAll("unversioned", event.target.checked)}
                      />
                      <button
                        type="button"
                        className="commit-toggle"
                        onClick={() => setGitCommitSectionsOpen((prev) => ({ ...prev, unversioned: !prev.unversioned }))}
                        aria-expanded={gitCommitSectionsOpen.unversioned}
                      >
                        {gitCommitSectionsOpen.unversioned ? "v" : ">"}
                      </button>
                      <span>Unversioned</span>
                      <span>{gitStatus.untracked.length}</span>
                    </div>
                    {gitCommitSectionsOpen.unversioned ? (
                      <div className="commit-list">
                        {gitStatus.untracked.map((path) => (
                          <label key={`unversioned-${path}`} className="commit-row">
                            <input
                              type="checkbox"
                              checked={!!gitCommitSelection[path]}
                              onChange={() => toggleCommitSelection(path)}
                            />
                            <span>{path}</span>
                            <span className="muted">untracked</span>
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
          <div
            className="modal-card"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void runBuildWithOptions();
              }
            }}
          >
            <div className="modal-header">
              <span>Build Options</span>
              <button type="button" onClick={() => setShowExport(false)}>Close</button>
            </div>
            <div className="modal-body">
              <label className="field checkbox">
                <input
                  type="checkbox"
                  checked={exportAfterBuild}
                  onChange={(event) => setExportAfterBuild(event.target.checked)}
                />
                <span>Export model after build</span>
              </label>
              <label className="field">
                <span>Format</span>
                <select
                  value={exportFormat}
                  onChange={(event) => {
                    const next = event.target.value as "jsonld" | "kpar" | "xmi";
                    setExportFormat(next);
                    if (!exportPath || exportPath.includes("\\build\\")) {
                      setExportPath(getDefaultBuildPath(next));
                    }
                  }}
                  disabled={!exportAfterBuild}
                >
                  <option value="jsonld">JSON-LD</option>
                  <option value="kpar">KPAR</option>
                  <option value="xmi">XMI</option>
                </select>
              </label>
              <label className="field">
                <span>Output</span>
                <div className="field-inline">
                  <input
                    value={exportPath}
                    onChange={(event) => setExportPath(event.target.value)}
                    placeholder="Select output file"
                    disabled={!exportAfterBuild}
                  />
                  <button
                    type="button"
                    className="ghost"
                    disabled={!exportAfterBuild}
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
                  disabled={!exportAfterBuild}
                />
                <span>Include standard library</span>
              </label>
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setShowExport(false)}>Cancel</button>
              <button type="button" onClick={runBuildWithOptions} disabled={exportBusy}>Build</button>
            </div>
          </div>
        </div>
      ) : null}
        <SettingsDialog
          open={showSettings}
          onClose={() => setShowSettings(false)}
          appTheme={appTheme}
          onThemeChange={setAppTheme}
          settingsTab={settingsTab}
          onSettingsTabChange={setSettingsTab}
          aiEndpoints={aiEndpoints}
          endpointTestStatus={endpointTestStatus}
          onEditEndpoint={editEndpoint}
          onDeleteEndpoint={deleteEndpoint}
          selectedChatEndpoint={selectedChatEndpoint}
          onSelectedChatEndpointChange={setSelectedChatEndpoint}
          onTestEndpoint={(endpointId) => {
            void testEndpoint(endpointId);
          }}
          endpointDraft={endpointDraft}
          onEndpointDraftChange={setEndpointDraft}
          onResetEndpointDraft={resetEndpointDraft}
          onSaveEndpointDraft={saveEndpointDraft}
          settingsDefaultStdlib={settingsDefaultStdlib}
          onSettingsDefaultStdlibChange={setSettingsDefaultStdlib}
          settingsStdlibVersions={settingsStdlibVersions}
          settingsStdlibStatus={settingsStdlibStatus}
          settingsStdlibBusy={settingsStdlibBusy}
          onSaveDefaultStdlibSelection={() => {
            void saveDefaultStdlibSelection();
          }}
        />
        {aiFloatingSteps.length ? (
          <div className="ai-floating" style={{ left: aiFloatingPos.x, top: aiFloatingPos.y }}>
            <div
              className="ai-floating-header"
              onPointerDown={(event) => {
                aiFloatingDragRef.current = {
                  startX: event.clientX,
                  startY: event.clientY,
                  baseX: aiFloatingPos.x,
                  baseY: aiFloatingPos.y,
                };
                (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
              }}
            >
              <span>Next steps</span>
              <button type="button" className="ghost" onClick={() => setAiFloatingSteps([])}>x</button>
            </div>
            <div className="ai-floating-list">
              {aiFloatingSteps.map((step) => (
                <button
                  key={step.id}
                  type="button"
                  className={`ai-floating-item ${step.recommended ? "recommended" : ""}`}
                  onClick={() => runAiNextStep(step)}
                >
                  <span className="ai-floating-id">{step.id}.</span>
                  <span className="ai-floating-label">{step.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <Modal open={showAbout} onClose={() => setShowAbout(false)} cardClassName="legacy-modal" ariaLabelledBy="about-title">
          <div className="modal-header">
            <h3 id="about-title">About Mercurio</h3>
          </div>
          <div className="modal-body">
            <p className="about-text">
              Mercurio is a SysML/KerML workbench for editing, compiling, and exploring models with integrated analysis tools.
            </p>
            {aboutVersion ? <p className="about-text">Version: {aboutVersion}</p> : null}
            {aboutBuild ? <p className="about-text">Build: {aboutBuild}</p> : null}
            <p className="about-text">
              GitHub:{" "}
              <a className="about-link" href="https://github.com/petrotta/mercurio" target="_blank" rel="noreferrer">
                https://github.com/petrotta/mercurio
              </a>
            </p>
          </div>
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={() => setShowAbout(false)}>
              Close
            </button>
          </div>
        </Modal>
        <Modal open={astViewOpen} onClose={() => setAstViewOpen(false)} cardClassName="modal-wide ast-modal" ariaLabelledBy="ast-title">
          <div className="modal-header">
            <h3 id="ast-title">AST: {astViewTitle || "Untitled"}</h3>
            <button type="button" className="icon-button" onClick={() => setAstViewOpen(false)} aria-label="Close AST view" />
          </div>
          <div className="modal-body">
            <AstStatus state={astViewState} emptyFallback={<pre className="ast-content">(empty)</pre>}>
              <pre className="ast-content">{astViewState.content}</pre>
            </AstStatus>
          </div>
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={() => setAstViewOpen(false)}>
              Close
            </button>
          </div>
        </Modal>
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
        <CompileToastPanel
          compileToast={compileToast}
          onClose={() => setCompileToast((prev) => ({ ...prev, open: false }))}
          parseErrorLocation={parseErrorLocation}
          onNavigate={(path, loc) => {
            void navigateTo({
              path,
              name: path.split(/[\\/]/).pop() || "Untitled",
              selection: loc
                ? {
                    startLine: loc.line,
                    startCol: loc.col,
                    endLine: loc.line,
                    endCol: loc.col + 1,
                  }
                : undefined,
            });
          }}
        />
      ) : null}
    </div>
  );
}


