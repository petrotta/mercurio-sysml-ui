import { useCallback } from "react";
import type { MutableRefObject } from "react";
import { AI_VIEW_TAB, DATA_VIEW_TAB, PROJECT_DESCRIPTOR_TAB } from "./constants";
import { makeDiagramTabId, makeDiagramTabName } from "./tabs";
import type { OpenTab, SymbolView } from "./types";

type DescriptorPayload = {
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
};

type NavigateTarget = {
  path: string;
  name?: string;
  selection?: { startLine: number; startCol: number; endLine: number; endCol: number };
};

type UseTabsOptions = {
  openTabs: OpenTab[];
  setOpenTabs: (next: OpenTab[] | ((prev: OpenTab[]) => OpenTab[])) => void;
  activeTabPath: string | null;
  setActiveTabPath: (path: string | null) => void;
  activeTabPathRef: MutableRefObject<string | null>;
  setCenterView: (value: "file" | "diagram" | "ai" | "data") => void;
  setActiveEditorDoc: (path: string | null, text: string, dirty: boolean) => void;
  setDescriptorViewMode: (mode: "view" | "json") => void;
  setShowProjectInfo: (value: boolean) => void;
  setProjectDescriptor: (descriptor: DescriptorPayload | null) => void;
  setHasProjectDescriptor: (value: boolean) => void;
  clearPendingEditorContent: () => void;
  editorRef: MutableRefObject<{ setValue: (value: string) => void } | null>;
  suppressDirtyRef: MutableRefObject<boolean>;
  navReqRef: MutableRefObject<number>;
  pendingNavRef: MutableRefObject<{
    path: string;
    name?: string;
    selection?: { startLine: number; startCol: number; endLine: number; endCol: number };
  } | null>;
  selectedSymbol: SymbolView | null;
  setSelectedSymbol: (symbol: SymbolView | null) => void;
  navigateTo: (target: NavigateTarget) => Promise<void> | void;
};

export function useTabs({
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
}: UseTabsOptions) {
  const openProjectDescriptorTab = useCallback(
    (descriptor?: DescriptorPayload | null) => {
      if (descriptor) {
        setProjectDescriptor(descriptor);
        setHasProjectDescriptor(true);
      }
      setCenterView("file");
      setShowProjectInfo(true);
      setDescriptorViewMode("view");
      setActiveEditorDoc(null, "", false);
      setOpenTabs((prev) => {
        if (prev.some((tab) => tab.path === PROJECT_DESCRIPTOR_TAB)) return prev;
        return [...prev, { path: PROJECT_DESCRIPTOR_TAB, name: "Project Descriptor", dirty: false, kind: "descriptor" }];
      });
      setActiveTabPath(PROJECT_DESCRIPTOR_TAB);
    },
    [
      setProjectDescriptor,
      setHasProjectDescriptor,
      setCenterView,
      setShowProjectInfo,
      setDescriptorViewMode,
      setActiveEditorDoc,
      setOpenTabs,
      setActiveTabPath,
    ],
  );

  const selectTab = useCallback(
    async (path: string) => {
      if (path === activeTabPath) return;
      const tab = openTabs.find((entry) => entry.path === path);
      if (path === PROJECT_DESCRIPTOR_TAB || tab?.kind === "descriptor") {
        setCenterView("file");
        setDescriptorViewMode("view");
        setActiveEditorDoc(null, "", false);
        setActiveTabPath(PROJECT_DESCRIPTOR_TAB);
        return;
      }
      if (tab?.kind === "ai") {
        setCenterView("ai");
        setActiveEditorDoc(null, "", false);
        setActiveTabPath(tab.path);
        return;
      }
      if (tab?.kind === "data") {
        setCenterView("data");
        setActiveEditorDoc(null, "", false);
        setActiveTabPath(tab.path);
        return;
      }
      if (tab?.kind === "diagram") {
        setCenterView("diagram");
        setActiveEditorDoc(null, "", false);
        setActiveTabPath(tab.path);
        return;
      }
      setCenterView("file");
      await navigateTo({ path });
    },
    [activeTabPath, openTabs, setCenterView, setDescriptorViewMode, setActiveEditorDoc, setActiveTabPath, navigateTo],
  );

  const openAiViewTab = useCallback(() => {
    setOpenTabs((prev) => {
      if (prev.some((tab) => tab.path === AI_VIEW_TAB)) return prev;
      return [...prev, { path: AI_VIEW_TAB, name: "Agent", dirty: false, kind: "ai" }];
    });
    setActiveTabPath(AI_VIEW_TAB);
    setActiveEditorDoc(null, "", false);
    setCenterView("ai");
  }, [setOpenTabs, setActiveTabPath, setActiveEditorDoc, setCenterView]);

  const openDataViewTab = useCallback(() => {
    setOpenTabs((prev) => {
      if (prev.some((tab) => tab.path === DATA_VIEW_TAB)) return prev;
      return [...prev, { path: DATA_VIEW_TAB, name: "Data", dirty: false, kind: "data" }];
    });
    setActiveTabPath(DATA_VIEW_TAB);
    setActiveEditorDoc(null, "", false);
    setCenterView("data");
  }, [setOpenTabs, setActiveTabPath, setActiveEditorDoc, setCenterView]);

  const openDiagramViewTab = useCallback(
    (filePath: string) => {
      if (!filePath || filePath === PROJECT_DESCRIPTOR_TAB) return;
      const id = makeDiagramTabId(filePath);
      const name = makeDiagramTabName(filePath);
      setOpenTabs((prev) => {
        if (prev.some((tab) => tab.path === id)) return prev;
        return [...prev, { path: id, name, dirty: false, kind: "diagram", sourcePath: filePath }];
      });
      setActiveTabPath(id);
      setActiveEditorDoc(null, "", false);
      setCenterView("diagram");
    },
    [setOpenTabs, setActiveTabPath, setActiveEditorDoc, setCenterView],
  );

  const reorderTabs = useCallback(
    (fromPath: string, toPath: string) => {
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
    },
    [setOpenTabs],
  );

  const closeTab = useCallback(
    (path: string) => {
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
          activeTabPathRef.current = null;
          setCenterView("file");
          setActiveEditorDoc(null, "", false);
          if (editorRef.current) {
            suppressDirtyRef.current = true;
            editorRef.current.setValue("");
          }
          clearPendingEditorContent();
          setActiveEditorDoc(null, "", false);
        }
      }
      if (selectedSymbol && selectedSymbol.file_path === path) {
        setSelectedSymbol(null);
      }
    },
    [
      navReqRef,
      pendingNavRef,
      setOpenTabs,
      setShowProjectInfo,
      activeTabPath,
      openTabs,
      selectTab,
      setActiveTabPath,
      activeTabPathRef,
      setCenterView,
      setActiveEditorDoc,
      editorRef,
      clearPendingEditorContent,
      selectedSymbol,
      setSelectedSymbol,
    ],
  );

  const closeAllTabs = useCallback(() => {
    navReqRef.current += 1;
    pendingNavRef.current = null;
    setOpenTabs([]);
    setActiveTabPath(null);
    activeTabPathRef.current = null;
    setCenterView("file");
    setActiveEditorDoc(null, "", false);
    if (editorRef.current) {
      suppressDirtyRef.current = true;
      editorRef.current.setValue("");
    }
    clearPendingEditorContent();
    setActiveEditorDoc(null, "", false);
  }, [
    navReqRef,
    pendingNavRef,
    setOpenTabs,
    setActiveTabPath,
    activeTabPathRef,
    setCenterView,
    setActiveEditorDoc,
    editorRef,
    clearPendingEditorContent,
  ]);

  const closeOtherTabs = useCallback(
    (path: string) => {
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
        setActiveEditorDoc(null, "", false);
      } else if (kept.kind === "ai") {
        setCenterView("ai");
        setActiveEditorDoc(null, "", false);
      } else if (kept.kind === "data") {
        setCenterView("data");
        setActiveEditorDoc(null, "", false);
      } else if (kept.kind === "diagram") {
        setCenterView("diagram");
        setActiveEditorDoc(null, "", false);
      } else {
        setCenterView("file");
        void navigateTo({ path });
      }
    },
    [
      navReqRef,
      pendingNavRef,
      openTabs,
      setOpenTabs,
      setActiveTabPath,
      setShowProjectInfo,
      setCenterView,
      setDescriptorViewMode,
      setActiveEditorDoc,
      navigateTo,
    ],
  );

  return {
    openProjectDescriptorTab,
    selectTab,
    openAiViewTab,
    openDataViewTab,
    openDiagramViewTab,
    reorderTabs,
    closeTab,
    closeAllTabs,
    closeOtherTabs,
  };
}
