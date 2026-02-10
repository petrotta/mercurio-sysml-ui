export type ParsedErrorLocation = { line: number; col: number };

export function parseErrorLocation(text: string): ParsedErrorLocation | null {
  if (!text) return null;
  const colonMatch = text.match(/:(\d+):(\d+)/);
  if (colonMatch) {
    return { line: Number(colonMatch[1]) || 1, col: Number(colonMatch[2]) || 1 };
  }
  const lineMatch = text.match(/line\s+(\d+)/i);
  const colMatch = text.match(/col(?:umn)?\s+(\d+)/i);
  if (lineMatch) {
    return { line: Number(lineMatch[1]) || 1, col: colMatch ? Number(colMatch[1]) || 1 : 1 };
  }
  return null;
}
