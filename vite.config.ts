import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(PROJECT_ROOT, "web"),
  plugins: [react()],
  build: {
    outDir: path.join(PROJECT_ROOT, "dist", "web"),
    emptyOutDir: true,
    sourcemap: true,
  },
});
