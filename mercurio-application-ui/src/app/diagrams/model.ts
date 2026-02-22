export const DIAGRAM_TYPES = {
  Bdd: "bdd",
  Ibd: "ibd",
  Package: "package",
} as const;

export type DiagramType = (typeof DIAGRAM_TYPES)[keyof typeof DIAGRAM_TYPES];

export const DEFAULT_DIAGRAM_TYPE: DiagramType = DIAGRAM_TYPES.Bdd;

export const DIAGRAM_TYPE_OPTIONS: Array<{ value: DiagramType; label: string }> = [
  { value: DIAGRAM_TYPES.Bdd, label: "BDD" },
  { value: DIAGRAM_TYPES.Ibd, label: "IBD" },
  { value: DIAGRAM_TYPES.Package, label: "Package" },
];

export const normalizeDiagramType = (value: string | null | undefined): DiagramType => {
  if (!value) return DEFAULT_DIAGRAM_TYPE;
  const normalized = value.toLowerCase();
  if (normalized === DIAGRAM_TYPES.Bdd) return DIAGRAM_TYPES.Bdd;
  if (normalized === DIAGRAM_TYPES.Ibd) return DIAGRAM_TYPES.Ibd;
  if (normalized === DIAGRAM_TYPES.Package) return DIAGRAM_TYPES.Package;
  return DEFAULT_DIAGRAM_TYPE;
};
