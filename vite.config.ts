import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const dashboardToken =
    env.VITE_DASHBOARD_TOKEN || env.DASHBOARD_TOKEN || "dev-dashboard";

  return {
  plugins: [
    react(),
    basicSsl(),
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
  server: {
    host: "0.0.0.0",
    port: 5080,
    https: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8090",
        configure(proxy) {
          const token =
            process.env.VITE_DASHBOARD_TOKEN ||
            process.env.DASHBOARD_TOKEN ||
            dashboardToken;
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("X-Dashboard-Token", token);
          });
        },
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
