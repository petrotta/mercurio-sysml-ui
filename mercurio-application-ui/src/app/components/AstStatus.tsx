import type { ReactNode } from "react";

type AstState = {
  content: string;
  error: string;
  loading: boolean;
};

type AstStatusProps = {
  state: AstState;
  emptyFallback?: ReactNode;
  children: ReactNode;
};

export function AstStatus({ state, emptyFallback, children }: AstStatusProps) {
  if (state.loading) {
    return <div className="muted">Loading AST...</div>;
  }
  if (state.error) {
    return <div className="error-text">{state.error}</div>;
  }
  if (!state.content && emptyFallback !== undefined) {
    return <>{emptyFallback}</>;
  }
  return <>{children}</>;
}
