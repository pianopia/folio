import type { Hono } from "hono";
import { resolve, sep, extname } from "node:path";
import { stat } from "node:fs/promises";

// Return Web Responses directly. This also keeps the bundled Bun runtime free
// from adapter/function-name collisions in third-party static-file wrappers.
export function serveWeb(app: Hono, directory = "./dist") {
  const root = resolve(directory);
  const isFile = async (path: string) => {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  };
  app.get("*", async (c) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(c.req.path);
    } catch {
      return c.text("Invalid path", 400);
    }
    if (pathname.includes("\0")) return c.text("Invalid path", 400);
    let path = resolve(root, `.${pathname}`);
    if (path !== root && !path.startsWith(root + sep))
      return c.text("Invalid path", 400);
    if (path === root) path = resolve(root, "index.html");
    if (!(await isFile(path))) {
      if (pathname.startsWith("/assets/") || extname(pathname))
        return c.text("Not found", 404);
      path = resolve(root, "index.html");
      if (!(await isFile(path))) return c.text("Web build not found", 503);
    }
    const file = Bun.file(path);
    return new Response(file, {
      headers: {
        "Content-Type": file.type,
        "Cache-Control": path.endsWith(`${sep}index.html`)
          ? "no-cache"
          : pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
