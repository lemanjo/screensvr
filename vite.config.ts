import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  publicDir: "../public",
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    proxy: Object.fromEntries(
      ["/api", "/faces"].map((prefix) => [
        prefix,
        {
          target: "http://127.0.0.1:3000",
          // Preserve the browser-facing host for the backend's origin check.
          // Vite's string shorthand implicitly enables changeOrigin.
          changeOrigin: false,
        },
      ]),
    ),
  },
});
