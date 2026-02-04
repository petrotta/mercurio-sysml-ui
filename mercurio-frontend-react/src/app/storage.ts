import { RECENTS_KEY } from "./constants";

export function loadRecents(): string[] {
  try {
    const raw = window.localStorage?.getItem(RECENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveRecents(list: string[]) {
  window.localStorage?.setItem(RECENTS_KEY, JSON.stringify(list));
}
