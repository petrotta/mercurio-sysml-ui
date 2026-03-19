export function normalizeFsPath(path: string | null | undefined): string {
  if (!path) return "";
  return path
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function normalizePathKey(path: string | null | undefined): string {
  return normalizeFsPath(path);
}

export function isPathWithin(path: string | null | undefined, root: string | null | undefined): boolean {
  const normalizedPath = normalizeFsPath(path);
  const normalizedRoot = normalizeFsPath(root);
  if (!normalizedPath || !normalizedRoot) return false;
  if (normalizedPath === normalizedRoot) return true;
  return normalizedPath.startsWith(`${normalizedRoot}/`);
}
