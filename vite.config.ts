import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import tailwindcss from "@tailwindcss/vite";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";
import { xaiImagineApi } from "./sugar-dress/server/xaiImagineApi.ts";

const meshDirectory = resolve("public/mesh");
const meshIndexFile = resolve(meshDirectory, "index.json");

function getMeshJsonFiles() {
  try {
    return readdirSync(meshDirectory)
      .filter((file) => file.toLowerCase().endsWith(".json") && file !== "index.json")
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function writeMeshIndex() {
  mkdirSync(meshDirectory, { recursive: true });
  writeFileSync(meshIndexFile, JSON.stringify({ files: getMeshJsonFiles() }, null, 2));
}

// Vite only serves public/ files that were present at startup or already seen by
// its watcher. A Dress still is requested the instant it is saved, before that
// add event, and the SPA fallback returns index.html — the thumbnail then stays
// broken. Read the file from disk on each request instead.
const GALLERY_PNG = /^\/models\/[a-z][a-z0-9_]*\/gallery\/[a-f0-9]{12}\.png$/;

function serveModelGallery(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) {
  const raw = (req.url ?? "").split("?")[0] ?? "";
  let pathname = raw;
  try {
    pathname = decodeURIComponent(raw);
  } catch {
    next();
    return;
  }
  if (!GALLERY_PNG.test(pathname)) {
    next();
    return;
  }
  const root = resolve("public/models");
  const file = resolve("public", pathname.slice(1));
  if (file !== root && !file.startsWith(root + sep)) {
    next();
    return;
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    next();
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Length", String(bytes.length));
  res.setHeader("Cache-Control", "no-cache");
  res.end(bytes);
}

function modelGalleryFiles(): Plugin {
  const attach = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use(serveModelGallery);
  };
  return {
    name: "model-gallery-files",
    configureServer: attach,
    configurePreviewServer: attach,
  };
}

export default defineConfig(({ mode: _mode }) => {
  return {
  resolve: {
    alias: {
      "@": resolve("src/dashGame"),
    },
    dedupe: ["react", "react-dom"],
  },
  plugins: [
    modelGalleryFiles(),
    // Dress /dress-api/* middleware must register before the FastAPI /api proxy.
    xaiImagineApi(),
    react(),
    basicSsl(),
    tailwindcss(),
    {
      name: "mesh-json-index",
      buildStart() {
        writeMeshIndex();
      },
      configureServer(server) {
        server.middlewares.use("/mesh/index.json", (_request, response) => {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ files: getMeshJsonFiles() }));
        });
      },
    },
  ],
  optimizeDeps: {
    // Default scan picks up every HTML file, including the nested n8n app,
    // then skips pre-bundling when those imports do not resolve.
    entries: ["index.html"],
  },
  server: {
    host: "0.0.0.0",
    port: 5080,
    https: true,
    watch: {
      ignored: ["**/n8n/**", "**/n8n-data/**"],
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8090",
        // Operator auth is cookie-based (login at /dashboard/login).
        // Do not inject X-Dashboard-Token here — that bypassed the login UI.
        // Sugar Dress uses /dress-api/* (Vite plugin), not this /api proxy.
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5080,
    https: true,
  },
  };
});
