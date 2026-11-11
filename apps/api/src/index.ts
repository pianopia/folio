import { createApp } from "./app";
import { serveStatic } from "hono/bun";
if (
  process.env.HOST &&
  !["localhost", "127.0.0.1"].includes(process.env.HOST) &&
  !process.env.API_TOKEN
)
  throw new Error("Remote hosting requires API_TOKEN");
if (process.env.NODE_ENV === "production" && !process.env.TURSO_DATABASE_URL)
  throw new Error("Production requires TURSO_DATABASE_URL");
const { app } = await createApp();
app.all("/api/*", (c) => c.json({ error: "API route not found" }, 404));
app.use(
  "*",
  serveStatic({
    root: "./dist",
    onFound: (path, c) => {
      if (path.includes("/assets/"))
        c.header("Cache-Control", "public, max-age=31536000, immutable");
    },
  })
);
app.get(
  "*",
  serveStatic({
    path: "./dist/index.html",
    onFound: (_path, c) => c.header("Cache-Control", "no-cache"),
  })
);
export default {
  port: Number(process.env.PORT ?? 3001),
  hostname: process.env.HOST ?? "127.0.0.1",
  fetch: app.fetch,
};
