import { describe, test, expect } from "bun:test";
import { DriveCache, type DriveFile } from "./src/drive-cache";
const file: DriveFile = {
  id: "image_1",
  name: "Artwork.jpg",
  mimeType: "image/jpeg",
  thumbnailLink: "https://lh3.googleusercontent.com/drive-storage/one=s220",
  thumbnailVersion: "1",
};
const json = (value: unknown) => Response.json(value);
const image = () =>
  new Response(new Uint8Array([137, 80, 78, 71]), {
    headers: { "Content-Type": "image/png" },
  });

describe("Drive fast preview cache", () => {
  test("reuses list metadata, coalesces parallel previews, and never downloads originals", async () => {
    const urls: string[] = [];
    const cache = new DriveCache(
      async () => "access-token",
      async (url, init) => {
        urls.push(url);
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer access-token"
        );
        if (url.startsWith("https://www.googleapis.com/drive/v3/files?"))
          return json({ files: [file], nextPageToken: "page2" });
        if (url.startsWith("https://lh3.googleusercontent.com/"))
          return image();
        throw Error(`Unexpected original/metadata download: ${url}`);
      }
    );
    await cache.list();
    await cache.list();
    expect((await cache.file(file.id)).name).toBe(file.name);
    const previews = await Promise.all(
      Array.from({ length: 12 }, () => cache.preview(file.id, 512))
    );
    expect(urls).toHaveLength(2);
    expect(urls[1]).toEndWith("=s512");
    expect(previews.every((p) => p.etag === previews[0].etag)).toBe(true);
    await cache.preview(file.id, 512);
    expect(urls).toHaveLength(2);
    await cache.preview(file.id, 1024);
    expect(urls).toHaveLength(3);
    expect(urls[2]).toEndWith("=s1024");
    expect(urls.some((u) => u.includes("alt=media"))).toBe(false);
  });
  test("refreshing changed thumbnail versions invalidates previews; disconnect clears all cached data", async () => {
    let version = "1",
      downloads = 0,
      lists = 0;
    const cache = new DriveCache(
      async () => "token",
      async (url) => {
        if (url.startsWith("https://lh3.")) {
          downloads++;
          return image();
        }
        lists++;
        return json({ files: [{ ...file, thumbnailVersion: version }] });
      }
    );
    await cache.list();
    await cache.preview(file.id, 512);
    version = "2";
    await cache.list("", "", true);
    await cache.preview(file.id, 512);
    expect(downloads).toBe(2);
    expect(lists).toBe(2);
    cache.clear();
    await cache.list();
    await cache.preview(file.id, 512);
    expect(downloads).toBe(3);
    expect(lists).toBe(3);
  });
  test("replaces expired Google thumbnail links rather than falling back to original files", async () => {
    let metadata = 0,
      downloads = 0;
    const cache = new DriveCache(
      async () => "token",
      async (url) => {
        if (url.startsWith("https://lh3.")) {
          downloads++;
          return downloads === 1
            ? new Response(null, { status: 403 })
            : image();
        }
        metadata++;
        return json({
          ...file,
          thumbnailLink:
            "https://lh3.googleusercontent.com/drive-storage/fresh=s220",
        });
      }
    );
    cache.remember(file);
    expect((await cache.preview(file.id, 512)).contentType).toBe("image/png");
    expect(metadata).toBe(1);
    expect(downloads).toBe(2);
  });
  test("bounds parallel metadata fetches to eight", async () => {
    let active = 0,
      peak = 0;
    const cache = new DriveCache(
      async () => "token",
      async (url) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        return json({ ...file, id: new URL(url).pathname.split("/").pop() });
      }
    );
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => cache.file(`image_${i}`))
    );
    expect(peak).toBe(8);
  });
  test("rejects non-Google thumbnail hosts without transmitting OAuth credentials", async () => {
    let network = 0;
    const cache = new DriveCache(
      async () => "token",
      async () => {
        network++;
        return image();
      }
    );
    cache.remember({ ...file, thumbnailLink: "https://evil.example/image" });
    await expect(cache.preview(file.id, 512)).rejects.toThrow(
      "サムネイルURLが無効"
    );
    expect(network).toBe(0);
  });
  test("does not return data from an old account after disconnect during a request", async () => {
    let complete!: (r: Response) => void;
    const cache = new DriveCache(
      async () => "token",
      async () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        })
    );
    const task = cache.list();
    await Promise.resolve();
    await Promise.resolve();
    cache.clear();
    complete(json({ files: [file] }));
    await expect(task).rejects.toThrow("Drive接続が変更");
  });
});
