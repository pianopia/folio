import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
export default defineConfig({
  resolve: { dedupe: ["react", "react-dom"] },
  plugins: [remix({ ssr: false })],
  server: { proxy: { "/api": "http://127.0.0.1:3001" } },
});
