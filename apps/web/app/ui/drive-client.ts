import type { Artwork } from "@folio/shared";
import { apiBase, getAuthToken, request } from "./api";
export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  thumbnailUrl?: string;
};
export type DrivePage = { files: DriveFile[]; nextPageToken?: string };
const blobs = new Map<string, { blob: Blob; expires: number }>();
const pending = new Map<string, Promise<Blob>>();
const pages = new Map<string, { page: DrivePage; expires: number }>();
let bytes = 0,
  active = 0,
  generation = 0;
const queue: Array<() => void> = [];
const listeners = new Set<() => void>();
export const subscribeDriveCache = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const driveCacheVersion = () => generation;
const scope = () => `${apiBase()}|${getAuthToken()}`;
export function clearDriveCaches() {
  generation++;
  blobs.clear();
  pending.clear();
  pages.clear();
  bytes = 0;
  listeners.forEach((listener) => listener());
}
export function previewPath(art: Artwork, size: 512 | 1024 = 512) {
  return `/api/artworks/${encodeURIComponent(art.id)}/thumbnail?size=${size}`;
}
async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 6) await new Promise<void>((resolve) => queue.push(resolve));
  else active++;
  try {
    return await work();
  } finally {
    const next = queue.shift();
    if (next) next();
    else active--;
  }
}
export function loadDrivePreview(path: string): Promise<Blob> {
  const key = `${scope()}|${path}`;
  const cached = blobs.get(key);
  if (cached && cached.expires > Date.now()) {
    blobs.delete(key);
    blobs.set(key, cached);
    return Promise.resolve(cached.blob);
  }
  if (cached) {
    bytes -= cached.blob.size;
    blobs.delete(key);
  }
  const existing = pending.get(key);
  if (existing) return existing;
  const base = apiBase(),
    token = getAuthToken(),
    currentGeneration = generation;
  const task = limited(async () => {
    const response = await fetch(`${base}${path}`, {
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) throw Error("プレビューを取得できませんでした");
    const blob = await response.blob();
    if (currentGeneration === generation) {
      blobs.set(key, { blob, expires: Date.now() + 5 * 60_000 });
      bytes += blob.size;
      while (bytes > 24 * 1024 * 1024 && blobs.size) {
        const entry = blobs.entries().next().value;
        if (!entry) break;
        bytes -= entry[1].blob.size;
        blobs.delete(entry[0]);
      }
    }
    if (currentGeneration !== generation)
      throw Error("Drive接続が変更されました");
    return blob;
  }).finally(() => {
    if (pending.get(key) === task) pending.delete(key);
  });
  pending.set(key, task);
  return task;
}
export async function loadDrivePage(
  folder = "",
  pageToken = "",
  refresh = false
): Promise<DrivePage> {
  const key = `${scope()}|${folder}|${pageToken}`;
  const cached = pages.get(key);
  if (!refresh && cached && cached.expires > Date.now()) return cached.page;
  const currentGeneration = generation;
  const result = await request<DrivePage>(
    `/drive/files?${new URLSearchParams({
      ...(folder ? { folder } : {}),
      ...(pageToken ? { pageToken } : {}),
      ...(refresh ? { refresh: "1" } : {}),
    })}`
  );
  if (currentGeneration !== generation)
    throw Error("Drive接続が変更されました");
  pages.set(key, { page: result, expires: Date.now() + 30_000 });
  while (pages.size > 100) pages.delete(pages.keys().next().value!);
  return result;
}
