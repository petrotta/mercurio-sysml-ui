export const getKindKey = (kind: string) => {
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

export const renderTypeIcon = (kind: string, variant: "model" | "diagram") => {
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
