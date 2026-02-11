import { useCallback, useEffect, useRef, useState } from "react";
import { getAstForContent, getAstForPath } from "./fileOps";

type AstState = {
  content: string;
  error: string;
  loading: boolean;
};

export function useAstLoader() {
  const [state, setState] = useState<AstState>({ content: "", error: "", loading: false });
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const loadForPath = useCallback(async (path: string) => {
    setState({ content: "", error: "", loading: true });
    try {
      const ast = await getAstForPath(path);
      setState({ content: ast, error: "", loading: false });
    } catch (error) {
      setState({ content: "", error: `AST load failed: ${String(error)}`, loading: false });
    }
  }, []);

  const loadForContent = useCallback((path: string, content: string) => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      setState((prev) => ({ ...prev, loading: true, error: "" }));
      getAstForContent(path, content)
        .then((ast) => {
          setState({ content: ast, error: "", loading: false });
        })
        .catch((error) => {
          setState({ content: "", error: `AST load failed: ${String(error)}`, loading: false });
        });
    }, 250);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  return {
    astState: state,
    setAstState: setState,
    loadForPath,
    loadForContent,
    clearTimer,
  };
}
