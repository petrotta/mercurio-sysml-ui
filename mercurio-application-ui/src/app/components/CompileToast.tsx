import type { CompileToast } from "../useCompileRunner";
import type { ParsedErrorLocation } from "../parseErrors";

type CompileToastProps = {
  compileToast: CompileToast;
  onClose: () => void;
  onNavigate: (path: string, loc: ParsedErrorLocation | null) => void;
  parseErrorLocation: (text: string) => ParsedErrorLocation | null;
};

export function CompileToastPanel({ compileToast, onClose, onNavigate, parseErrorLocation }: CompileToastProps) {
  return (
    <div className={`compile-toast ${compileToast.ok === false ? "error" : compileToast.ok ? "ok" : ""}`}>
      <div className="compile-toast-header">
        <span className={`compile-toast-title ${compileToast.ok === null ? "running" : ""}`}>
          <span className="compile-spinner" aria-hidden="true" />
          Compile
        </span>
        <button type="button" onClick={onClose}>x</button>
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
                <button
                  type="button"
                  className="compile-toast-link"
                  onClick={() => {
                    const first = file.errors?.[0] || "";
                    const loc = parseErrorLocation(first);
                    onNavigate(file.path, loc);
                  }}
                >
                  {file.path}
                </button>
                <div className="compile-toast-error-count">{file.errors.length} issues</div>
                {file.errors.length ? (
                  <div className="compile-toast-error-lines">
                    {file.errors.slice(0, 5).map((err, index) => (
                      <button
                        key={`${file.path}-${index}`}
                        type="button"
                        className="compile-toast-link subtle"
                        onClick={() => {
                          const loc = parseErrorLocation(err);
                          onNavigate(file.path, loc);
                        }}
                      >
                        {err}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
