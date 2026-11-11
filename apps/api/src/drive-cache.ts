import { createHash } from "node:crypto";
import { HTTPException } from "hono/http-exception";

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  thumbnailLink?: string;
  thumbnailVersion?: string;
};
type Page = { files: DriveFile[]; nextPageToken?: string };
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type Preview = {
  bytes: Uint8Array;
  contentType: string;
  etag: string;
  expires: number;
};
const PREVIEW_TTL = 5 * 60_000;

// One cache per authenticated workspace, bounded to 32 MiB and cleared on reconnect.
export class DriveCache {
  private metadata = new Map<string, { file: DriveFile; expires: number }>();
  private pages = new Map<string, { page: Page; expires: number }>();
  private previews = new Map<string, Preview>();
  private pending = new Map<string, Promise<any>>();
  private totalBytes = 0;
  private active = 0;
  private waiting: Array<() => void> = [];
  private generation = 0;
  constructor(
    private token: () => Promise<string>,
    private fetcher: Fetcher = (url, init) => fetch(url, init)
  ) {}
  clear() {
    this.generation++;
    this.metadata.clear();
    this.pages.clear();
    this.previews.clear();
    this.pending.clear();
    this.totalBytes = 0;
  }
  private async limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= 8)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
  private once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const old = this.pending.get(key);
    if (old) return old;
    const generation = this.generation;
    const task = work()
      .then((value) => {
        if (generation !== this.generation)
          throw new HTTPException(409, {
            message: "Drive接続が変更されました。再読み込みしてください。",
          });
        return value;
      })
      .finally(() => {
        if (this.pending.get(key) === task) this.pending.delete(key);
      });
    this.pending.set(key, task);
    return task;
  }
  remember(file: DriveFile) {
    const previous = this.metadata.get(file.id)?.file;
    if (previous && previous.thumbnailVersion !== file.thumbnailVersion) {
      for (const [key, value] of this.previews)
        if (key.startsWith(`${file.id}:`)) {
          this.totalBytes -= value.bytes.byteLength;
          this.previews.delete(key);
        }
    }
    this.metadata.delete(file.id);
    this.metadata.set(file.id, { file, expires: Date.now() + 10 * 60_000 });
    while (this.metadata.size > 2000)
      this.metadata.delete(this.metadata.keys().next().value!);
  }
  async list(folder = "", pageToken = "", refresh = false): Promise<Page> {
    const key = `list:${folder}:${pageToken}`;
    const cached = this.pages.get(key);
    if (!refresh && cached && cached.expires > Date.now()) return cached.page;
    return this.once(key, async () => {
      const generation = this.generation;
      const access = await this.token();
      const u = new URL("https://www.googleapis.com/drive/v3/files");
      u.search = new URLSearchParams({
        q:
          "trashed = false and (mimeType contains 'image/' or mimeType = 'application/vnd.google-apps.folder')" +
          (folder ? ` and '${folder}' in parents` : ""),
        pageSize: "100",
        orderBy: "folder,name",
        fields:
          "nextPageToken,files(id,name,mimeType,thumbnailLink,thumbnailVersion)",
        ...(pageToken ? { pageToken } : {}),
      }).toString();
      const response = await this.limited(() =>
        this.fetcher(u.href, {
          headers: { Authorization: `Bearer ${access}` },
          signal: AbortSignal.timeout(20000),
        })
      );
      if (!response.ok)
        throw new HTTPException(502, {
          message: "Drive一覧を取得できませんでした",
        });
      const page = (await response.json()) as Page;
      if (generation === this.generation) {
        page.files.forEach((file) => this.remember(file));
        this.pages.set(key, { page, expires: Date.now() + 30_000 });
        while (this.pages.size > 100)
          this.pages.delete(this.pages.keys().next().value!);
      }
      return page;
    });
  }
  async file(id: string): Promise<DriveFile> {
    const cached = this.metadata.get(id);
    if (cached && cached.expires > Date.now()) return cached.file;
    return this.once(`meta:${id}`, async () => {
      const generation = this.generation;
      const access = await this.token();
      const response = await this.limited(() =>
        this.fetcher(
          `https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,thumbnailLink,thumbnailVersion`,
          {
            headers: { Authorization: `Bearer ${access}` },
            signal: AbortSignal.timeout(20000),
          }
        )
      );
      if (!response.ok)
        throw new HTTPException(response.status === 404 ? 404 : 502, {
          message: "Driveのファイルを取得できませんでした",
        });
      const file = (await response.json()) as DriveFile;
      if (generation === this.generation) this.remember(file);
      return file;
    });
  }
  async preview(id: string, size: 512 | 1024): Promise<Preview> {
    const key = `${id}:${size}`;
    const cached = this.previews.get(key);
    if (cached && cached.expires > Date.now()) {
      this.previews.delete(key);
      this.previews.set(key, cached);
      return cached;
    }
    if (cached) {
      this.totalBytes -= cached.bytes.byteLength;
      this.previews.delete(key);
    }
    return this.once(`image:${key}`, async () => {
      const generation = this.generation;
      let file = await this.file(id);
      if (!file.thumbnailLink)
        throw new HTTPException(404, {
          message:
            "Driveでプレビューの生成待ちです。後でもう一度お試しください。",
        });
      const access = await this.token();
      const download = async (link: string) => {
        const u = new URL(link);
        if (
          u.protocol !== "https:" ||
          !u.hostname.endsWith(".googleusercontent.com")
        )
          throw new HTTPException(502, {
            message: "DriveのサムネイルURLが無効です",
          });
        // Drive thumbnail URLs normally end in =s220; request a bounded display size.
        u.pathname = u.pathname.replace(/=s\d+(?:-c)?$/, `=s${size}`);
        return this.limited(() =>
          this.fetcher(u.href, {
            headers: { Authorization: `Bearer ${access}` },
            redirect: "error",
            signal: AbortSignal.timeout(20000),
          })
        );
      };
      let response = await download(file.thumbnailLink);
      if ([401, 403, 404].includes(response.status)) {
        this.metadata.delete(id);
        file = await this.file(id);
        if (!file.thumbnailLink)
          throw new HTTPException(404, { message: "プレビューがありません" });
        response = await download(file.thumbnailLink);
      }
      if (!response.ok)
        throw new HTTPException(502, {
          message: "プレビューを取得できませんでした",
        });
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/"))
        throw new HTTPException(415, {
          message: "画像プレビューではありません",
        });
      const maxBytes = 4 * 1024 * 1024;
      if (Number(response.headers.get("content-length")) > maxBytes) {
        await response.body?.cancel();
        throw new HTTPException(413, { message: "プレビューが大きすぎます" });
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes)
        throw new HTTPException(413, { message: "プレビューが大きすぎます" });
      const result = {
        bytes,
        contentType,
        etag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
        expires: Date.now() + PREVIEW_TTL,
      };
      if (generation === this.generation) {
        this.previews.set(key, result);
        this.totalBytes += bytes.byteLength;
        while (this.totalBytes > 32 * 1024 * 1024) {
          const first = this.previews.keys().next().value!;
          this.totalBytes -= this.previews.get(first)!.bytes.byteLength;
          this.previews.delete(first);
        }
      }
      return result;
    });
  }
}
