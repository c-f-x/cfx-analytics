import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard builds into the Worker's assets under /app/, and the Worker
// serves it from the ASSETS binding (platform/dashboard.ts). Same origin as
// the API, so the session cookie goes with every request.
export default defineConfig({
  base: "/app/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5174,
    proxy: { "/api": "http://localhost:8787", "/auth": "http://localhost:8787" },
  },
  build: {
    outDir: "../worker/assets/app",
    emptyOutDir: true,
    target: "es2022",
    // One person uses the dashboard, behind sign-in; its main chunk (React,
    // the router, Base UI and the shared schemas) is about 240 kB gzipped,
    // and rrweb loads apart, only on the recording screens.
    chunkSizeWarningLimit: 800,
  },
});
