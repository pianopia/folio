import { test, expect } from "bun:test";
import { Hono } from "hono";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveWeb } from "./src/static-web";

test("serves HTML, immutable assets, and SPA routes without exposing the filesystem", async () => {
  const directory = await mkdtemp(join(tmpdir(), "folio-static-"));
  try {
    await mkdir(join(directory, "assets"));
    await writeFile(
      join(directory, "index.html"),
      "<!doctype html><title>folio</title>"
    );
    await writeFile(join(directory, "assets", "app.css"), "body{color:green}");
    const app = new Hono();
    serveWeb(app, directory);
    const root = await app.request("http://localhost/");
    expect(root.status).toBe(200);
    expect(root.headers.get("Content-Type")).toStartWith("text/html");
    expect(await root.text()).toContain("folio");
    expect(root.headers.get("Cache-Control")).toBe("no-cache");
    const asset = await app.request("http://localhost/assets/app.css");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Content-Type")).toStartWith("text/css");
    expect(asset.headers.get("Cache-Control")).toContain("immutable");
    expect(
      (await app.request("http://localhost/assets/missing.js")).status
    ).toBe(404);
    expect((await app.request("http://localhost/groups/studio")).status).toBe(
      200
    );
    expect(
      (await app.request("http://localhost/%2e%2e%2fsecret.txt")).status
    ).toBe(400);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
