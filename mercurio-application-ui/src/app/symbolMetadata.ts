type ContractIdentityFields = {
  kind?: string | null;
  semantic_kind?: string | null;
  structural_metatype_qname?: string | null;
  classification_qname?: string | null;
  metatype_qname?: string | null;
};

function normalizeValue(value: string | null | undefined): string {
  return `${value || ""}`.trim();
}

function shortTypeName(value: string | null | undefined): string {
  const raw = normalizeValue(value);
  if (!raw) return "";
  const withoutRootPrefix = raw.replace(/^(sysml|kerml)::/i, "");
  const parts = withoutRootPrefix.split("::").filter(Boolean);
  if (!parts.length) return withoutRootPrefix;
  return parts[parts.length - 1] || withoutRootPrefix;
}

export function semanticKindOf(fields: ContractIdentityFields): string {
  return normalizeValue(fields.semantic_kind) || normalizeValue(fields.kind);
}

export function structuralMetatypeOf(fields: ContractIdentityFields): string {
  return normalizeValue(fields.structural_metatype_qname) || normalizeValue(fields.metatype_qname);
}

export function classificationQnameOf(fields: ContractIdentityFields): string {
  return normalizeValue(fields.classification_qname) || normalizeValue(fields.metatype_qname);
}

export function primaryKindLabel(fields: ContractIdentityFields): string {
  const semanticKind = semanticKindOf(fields);
  if (semanticKind) return semanticKind;
  const structuralMetatype = shortTypeName(structuralMetatypeOf(fields));
  if (structuralMetatype) return structuralMetatype;
  const classification = shortTypeName(classificationQnameOf(fields));
  if (classification) return classification;
  return normalizeValue(fields.kind) || "?";
}

export function isPackageLikeMetadata(fields: ContractIdentityFields): boolean {
  const semanticKind = semanticKindOf(fields).toLowerCase();
  const structuralMetatype = structuralMetatypeOf(fields).toLowerCase();
  const classification = classificationQnameOf(fields).toLowerCase();
  return semanticKind.includes("package")
    || structuralMetatype.endsWith("::package")
    || structuralMetatype === "package"
    || classification.endsWith("::package")
    || classification === "package";
}

export function isDefinitionLikeMetadata(fields: ContractIdentityFields): boolean {
  const semanticKind = semanticKindOf(fields).toLowerCase();
  const structuralMetatype = structuralMetatypeOf(fields).toLowerCase();
  const classification = classificationQnameOf(fields).toLowerCase();
  return semanticKind.includes("definition")
    || semanticKind === "package"
    || structuralMetatype.includes("definition")
    || structuralMetatype.endsWith("::package")
    || classification.includes("definition")
    || classification.endsWith("::package");
}
