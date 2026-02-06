import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PROJECT_DESCRIPTOR_TAB } from "./constants";
import type { OpenTab } from "./types";

type EditorSelection = { startLine: number; startCol: number; endLine: number; endCol: number };

type NavigateTarget = {
  path: string;
  name?: string;
  selection?: EditorSelection;
};

type UseEditorNavigationOptions = {
  centerView: "file" | "diagram" | "ai" | "data";
  setCenterView: (value: "file" | "diagram" | "ai" | "data") => void;
  activeDocPath: string | null;
  getDoc: (path: string) => { text: string; dirty: boolean } | null;
  setActiveEditorDoc: (path: string | null, text: string, dirty: boolean) => void;
  queuePendingEditorContent: (path: string, text: string) => void;
  editorValueRef: { current: string };
  suppressDirtyRef: { current: boolean };
  editorRef: { current: { setValue: (value: string) => void; focus: () => void; setSelection: (selection: any) => void; revealLineInCenter: (line: number) => void } | null };
  currentFilePathRef: { current: string | null };
  activeTabPathRef: { current: string | null };
  navReqRef: { current: number };
  pendingNavRef: { current: NavigateTarget | null };
  setActiveTabPath: (path: string | null) => void;
  setOpenTabs: (updater: (prev: OpenTab[]) => OpenTab[]) => void;
};

export function useEditorNavigation({
  centerView,
  setCenterView,
  activeDocPath,
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
}: UseEditorNavigationOptions) {
  const applyEditorSelection = useCallback((selection?: EditorSelection) => {
    if (!selection || !editorRef.current) return;
    editorRef.current.setSelection({
      startLineNumber: selection.startLine || 1,
      startColumn: selection.startCol || 1,
      endLineNumber: selection.endLine || selection.startLine || 1,
      endColumn: selection.endCol || selection.startCol || 1,
    });
    editorRef.current.revealLineInCenter(selection.startLine || 1);
  }, [editorRef]);

  const navigateTo = useCallback(async (target: NavigateTarget) => {
    setCenterView("file");
    const reqId = ++navReqRef.current;
    pendingNavRef.current = target;
    const currentPath = currentFilePathRef.current;
    if (currentPath !== target.path) {
      const cached = getDoc(target.path);
      console.log("[nav] open", target.path, "cached?", !!cached, "dirty?", cached?.dirty);
      if (cached) {
        if (cached.dirty) {
          console.log("[nav] using cached dirty content", cached.text.length);
          suppressDirtyRef.current = true;
          setActiveEditorDoc(target.path, cached.text, cached.dirty);
          queuePendingEditorContent(target.path, cached.text);
          if (editorRef.current && centerView === "file" && activeTabPathRef.current !== PROJECT_DESCRIPTOR_TAB) {
            editorRef.current.setValue(cached.text);
          }
        } else {
          const content = await invoke<string>("read_file", { path: target.path });
          if (reqId !== navReqRef.current) return;
          console.log("[nav] read_file content length", content?.length ?? 0);
          suppressDirtyRef.current = true;
          setActiveEditorDoc(target.path, content || "", false);
          queuePendingEditorContent(target.path, content || "");
          if (editorRef.current && centerView === "file" && activeTabPathRef.current !== PROJECT_DESCRIPTOR_TAB) {
            editorRef.current.setValue(content || "");
          }
        }
      } else {
        const content = await invoke<string>("read_file", { path: target.path });
        if (reqId !== navReqRef.current) return;
        console.log("[nav] read_file (no cache) content length", content?.length ?? 0);
        suppressDirtyRef.current = true;
        setActiveEditorDoc(target.path, content || "", false);
        // Always queue content for the next editor mount in case the current ref is stale.
        queuePendingEditorContent(target.path, content || "");
        if (editorRef.current && centerView === "file" && activeTabPathRef.current !== PROJECT_DESCRIPTOR_TAB) {
          editorRef.current.setValue(content || "");
        }
      }
      // active doc already set when loading content above
      setActiveTabPath(target.path);
      activeTabPathRef.current = target.path;
      setOpenTabs((prev) => {
        if (prev.some((tab) => tab.path === target.path)) return prev;
        const name = target.name || target.path.split(/[\\/]/).pop() || "Untitled";
        return [...prev, { path: target.path, name, dirty: false, kind: "file" }];
      });
    } else {
      // Same file: keep unsaved editor content intact.
      queuePendingEditorContent(target.path, editorValueRef.current);
      setActiveTabPath(target.path);
      activeTabPathRef.current = target.path;
    }
    if (reqId !== navReqRef.current) return;
    if (editorRef.current) {
      applyEditorSelection(target.selection);
      editorRef.current.focus();
      pendingNavRef.current = null;
    }
  }, [
    setCenterView,
    navReqRef,
    pendingNavRef,
    currentFilePathRef,
    getDoc,
    suppressDirtyRef,
    setActiveEditorDoc,
    queuePendingEditorContent,
    editorRef,
    centerView,
    activeTabPathRef,
    setActiveTabPath,
    setOpenTabs,
    editorValueRef,
    applyEditorSelection,
  ]);

  useEffect(() => {
    if (!activeDocPath || !editorRef.current) return;
    const pending = pendingNavRef.current;
    if (!pending || pending.path !== activeDocPath) return;
    pendingNavRef.current = null;
    applyEditorSelection(pending.selection);
    editorRef.current.focus();
  }, [activeDocPath, applyEditorSelection, pendingNavRef, editorRef]);

  return { navigateTo, applyEditorSelection };
}
