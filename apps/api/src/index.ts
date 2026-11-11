import { createApp } from "./app";
import { serveWeb } from "./static-web";
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
serveWeb(app);
export default {
  port: Number(process.env.PORT ?? 3001),
  hostname: process.env.HOST ?? "127.0.0.1",
  fetch: app.fetch,
};
