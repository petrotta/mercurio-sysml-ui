import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SymbolView } from "../types";

type DataViewProps = {
  dataExcludeStdlib: boolean;
  onToggleExcludeStdlib: (value: boolean) => void;
  rootPath: string;
  libraryPath: string | null;
  projectCounts: { fileCount: number; symbolCount: number };
  libraryCounts: { fileCount: number; symbolCount: number };
  errorCounts: { fileCount: number; symbolCount: number };
  dataViewSymbols: SymbolView[];
  dataViewSymbolKindCounts: Array<[string, number]>;
};

export function DataView({
  dataExcludeStdlib,
  onToggleExcludeStdlib,
  rootPath,
  libraryPath,
  projectCounts,
  libraryCounts,
  errorCounts,
  dataViewSymbols,
  dataViewSymbolKindCounts,
}: DataViewProps) {
  const [indexActionCount, setIndexActionCount] = useState<number | null>(null);
  const [indexDocCount, setIndexDocCount] = useState<number | null>(null);
  const [indexStatus, setIndexStatus] = useState("");
  const [exprInput, setExprInput] = useState("");
  const [exprResult, setExprResult] = useState<string | null>(null);

  const normalizeLibraryKey = (value: string) =>
    value.replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();

  const refreshIndexMetrics = async () => {
    if (!rootPath) return;
    setIndexStatus("Loading index metrics...");
    try {
      const [actions, docs] = await Promise.all([
        invoke<Array<{ id: string }>>("query_index_symbols_by_metatype", {
          payload: { root: rootPath, metatype_qname: "KerML::Action" },
        }),
        libraryPath
          ? invoke<Array<{ id: string }>>("query_index_stdlib_documentation_symbols", {
              payload: { library_key: normalizeLibraryKey(libraryPath) },
            })
          : Promise.resolve([]),
      ]);
      setIndexActionCount(actions.length);
      setIndexDocCount(docs.length);
      setIndexStatus("Index metrics loaded.");
    } catch (error) {
      setIndexStatus(`Index query failed: ${String(error)}`);
      setIndexActionCount(null);
      setIndexDocCount(null);
    }
  };

  useEffect(() => {
    void refreshIndexMetrics();
  }, [rootPath, libraryPath]);

  const normalizeExpression = (value: string) => value.trim().replace(/\./g, "::");
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const symbolTextProperty = (symbol: SymbolView, key: string) => {
    const prop = (symbol.properties || []).find((item) => item.name === key && item.value?.type === "text");
    if (!prop || prop.value.type !== "text") return null;
    return (prop.value.value || "").trim();
  };

  const evaluateExpression = async () => {
    const expr = normalizeExpression(exprInput);
    if (!expr) {
      setExprResult("Enter an expression, e.g. A.i");
      return;
    }
    const symbol = dataViewSymbols.find((item) => (item.qualified_name || "").trim() === expr);
    if (!symbol) {
      setExprResult(`No symbol found for '${exprInput.trim()}'`);
      return;
    }
    const keys = ["cst_value", "expr", "value", "default", "initial_value", "initializer"];
    for (const key of keys) {
      const value = symbolTextProperty(symbol, key);
      if (value) {
        setExprResult(value);
        return;
      }
    }
    try {
      const text = await invoke<string>("read_file", { path: symbol.file_path });
      const lines = text.split(/\r?\n/);
      const start = Math.max(0, (symbol.start_line || 1) - 1);
      const end = Math.min(lines.length - 1, Math.max(start, (symbol.end_line || symbol.start_line || 1) - 1) + 3);
      const windowText = lines.slice(start, end + 1).join("\n");
      const symbolName = (symbol.name || symbol.qualified_name.split("::").pop() || "").trim();
      const exactPattern = new RegExp(
        `\\battribute\\b[^;\\n]*\\b${escapeRegExp(symbolName)}\\b[^;\\n]*=\\s*([^;\\n]+)\\s*;`,
        "i",
      );
      const exactMatch = windowText.match(exactPattern);
      if (exactMatch?.[1]) {
        setExprResult(exactMatch[1].trim());
        return;
      }
      const genericPattern = /\battribute\b[^;\n]*=\s*([^;\n]+)\s*;/i;
      const genericMatch = windowText.match(genericPattern);
      if (genericMatch?.[1]) {
        setExprResult(genericMatch[1].trim());
        return;
      }
    } catch {
    }
    setExprResult(`Symbol found (${symbol.kind}) but no evaluable literal value`);
  };

  return (
    <div className="data-view">
      <div className="view-header">
        <div className="view-title">Data Analysis</div>
        <label className="view-toggle">
          <input
            type="checkbox"
            checked={dataExcludeStdlib}
            onChange={(event) => onToggleExcludeStdlib(event.target.checked)}
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
      <div className="data-section">
        <div className="data-section-title">Expression Eval</div>
        <div className="data-list">
          <div className="data-row">
            <span className="data-row-label">Expression</span>
            <input
              type="text"
              placeholder="A.i"
              value={exprInput}
              onChange={(event) => setExprInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                void evaluateExpression();
              }}
            />
          </div>
          <div className="data-row">
            <span className="data-row-label">Result</span>
            <span className="data-row-value">{exprResult ?? "-"}</span>
          </div>
        </div>
        <button type="button" className="ghost" onClick={() => void evaluateExpression()}>
          Evaluate
        </button>
      </div>
      <div className="data-section">
        <div className="data-section-title">Index Metrics</div>
        <div className="data-list">
          <div className="data-row">
            <span className="data-row-label">KerML::Action symbols</span>
            <span className="data-row-value">{indexActionCount ?? "-"}</span>
          </div>
          <div className="data-row">
            <span className="data-row-label">Stdlib documentation symbols</span>
            <span className="data-row-value">{indexDocCount ?? "-"}</span>
          </div>
        </div>
        <div className="muted">{indexStatus}</div>
        <button type="button" className="ghost" onClick={() => void refreshIndexMetrics()}>
          Refresh Index Metrics
        </button>
      </div>
    </div>
  );
}
