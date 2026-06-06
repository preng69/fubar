import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const bridgeTarget = `http://127.0.0.1:${process.env.DTF_HTTP_PORT ?? "8787"}`;

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "web-dist"
  },
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": bridgeTarget,
      "/ws": {
        target: bridgeTarget,
        ws: true
      }
    }
  }
});
