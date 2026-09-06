import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/client", emptyOutDir: true },
  server: {
    port: 3000,
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/healthz": "http://127.0.0.1:3001",
      "/readyz": "http://127.0.0.1:3001"
    }
  }
});
