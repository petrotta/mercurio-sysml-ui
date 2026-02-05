import { useCallback, useMemo, useRef, useState } from "react";

export type EditorDoc = {
  path: string | null;
  text: string;
  dirty: boolean;
};

export function useEditorState() {
  const editorValueRef = useRef("");
  const editorChangeRafRef = useRef<number | null>(null);
  const [editorChangeTick, setEditorChangeTick] = useState(0);
  const [cursorPos, setCursorPos] = useState<{ line: number; col: number } | null>(null);
  const [docsByPath, setDocsByPath] = useState<Record<string, { text: string; dirty: boolean }>>({});
  const [activePath, setActivePath] = useState<string | null>(null);
  const currentFilePathRef = useRef<string | null>(null);
  const pendingEditorContentRef = useRef<string | null>(null);
  const pendingEditorPathRef = useRef<string | null>(null);
  const activeDoc: EditorDoc = useMemo(() => {
    if (!activePath) return { path: null, text: "", dirty: false };
    const doc = docsByPath[activePath];
    return { path: activePath, text: doc?.text ?? "", dirty: doc?.dirty ?? false };
  }, [activePath, docsByPath]);

  const onEditorChange = useCallback((value?: string) => {
    const next = value ?? "";
    editorValueRef.current = next;
    setDocsByPath((prev) => {
      if (!activePath) return prev;
      const current = prev[activePath];
      if (!current) return prev;
      return { ...prev, [activePath]: { text: next, dirty: true } };
    });
    if (editorChangeRafRef.current == null) {
      editorChangeRafRef.current = window.requestAnimationFrame(() => {
        setEditorChangeTick((tick) => tick + 1);
        editorChangeRafRef.current = null;
      });
    }
  }, [activePath]);

  const updateCursorPos = useCallback((line: number, col: number) => {
    setCursorPos({ line, col });
  }, []);

  const setActiveEditorDoc = useCallback((path: string | null, text: string, dirty = false) => {
    editorValueRef.current = text;
    if (!path) {
      setActivePath(null);
      currentFilePathRef.current = null;
      return;
    }
    setDocsByPath((prev) => ({ ...prev, [path]: { text, dirty } }));
    setActivePath(path);
    currentFilePathRef.current = path;
  }, []);

  const queuePendingEditorContent = useCallback((path: string, text: string) => {
    pendingEditorContentRef.current = text;
    pendingEditorPathRef.current = path;
  }, []);

  const clearPendingEditorContent = useCallback(() => {
    pendingEditorContentRef.current = null;
    pendingEditorPathRef.current = null;
  }, []);

  const consumePendingEditorContent = useCallback((path: string | null) => {
    if (!path) return null;
    if (!pendingEditorContentRef.current) return null;
    if (pendingEditorPathRef.current && pendingEditorPathRef.current !== path) return null;
    const text = pendingEditorContentRef.current;
    pendingEditorContentRef.current = null;
    pendingEditorPathRef.current = null;
    return text;
  }, []);

  const markSaved = useCallback(() => {
    setDocsByPath((prev) => {
      if (!activePath) return prev;
      const current = prev[activePath];
      if (!current) return prev;
      return { ...prev, [activePath]: { ...current, dirty: false } };
    });
  }, [activePath]);

  const getDoc = useCallback(
    (path: string) => {
      const doc = docsByPath[path];
      if (!doc) return null;
      return { path, ...doc };
    },
    [docsByPath],
  );

  return {
    editorValueRef,
    editorChangeTick,
    cursorPos,
    setCursorPos,
    onEditorChange,
    updateCursorPos,
    activeDoc,
    setActiveEditorDoc,
    queuePendingEditorContent,
    clearPendingEditorContent,
    consumePendingEditorContent,
    markSaved,
    getDoc,
    currentFilePathRef,
  };
}
