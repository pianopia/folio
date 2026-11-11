import {
  initialArtworks,
  initialGroups,
  type Artwork,
  type Group,
} from "@folio/shared";
export type LibraryData = { groups: Group[]; artworks: Artwork[] };
let authToken = "";
export const getAuthToken = () => authToken;
export const setAuthToken = (value: string) => {
  authToken = value;
};
export const apiBase = () =>
  typeof window === "undefined" ? "" : localStorage.getItem("folio-api") ?? "";
export async function request<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const token = getAuthToken();
  const r = await fetch(`${apiBase()}/api${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) {
    const b = await r.json().catch(() => ({}));
    throw new Error(b.error ?? `APIエラー (${r.status})`);
  }
  return r.status === 204 ? (undefined as T) : r.json();
}
export const sampleData = (): LibraryData => {
  try {
    const stored = localStorage.getItem("folio-demo");
    if (stored) return JSON.parse(stored);
  } catch {}
  return {
    groups: structuredClone(initialGroups),
    artworks: structuredClone(initialArtworks),
  };
};
