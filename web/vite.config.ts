import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const root = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(resolve(root, "../package.json"), "utf8")) as {
  version: string;
};

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": resolve(root, "src") },
  },
  define: {
    __JEVONIAN_VERSION__: JSON.stringify(version),
  },
  build: {
    outDir: resolve(root, "../dist/web"),
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/v1": "http://127.0.0.1:8787",
      "/healthz": "http://127.0.0.1:8787",
    },
  },
});
