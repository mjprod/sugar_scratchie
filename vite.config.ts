import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";

const meshDirectory = resolve("public/mesh");
const meshIndexFile = resolve(meshDirectory, "index.json");
const cardsDirectory = resolve("public/cards");
const cardsIndexFile = resolve(cardsDirectory, "index.json");
const modelsDirectory = resolve("public/models");
const modelsIndexFile = resolve(modelsDirectory, "index.json");

const ORIGINAL_BACKGROUND = "ai girl 2.mp4";
const ORIGINAL_FOREGROUND = "Green bg sample 2 swap.mp4";

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

function readCardMeta(cardDir: string, fallback: string) {
  const metaPath = resolve(cardDir, "meta.json");
  if (!existsSync(metaPath)) return { label: fallback };
  try {
    const data = JSON.parse(readFileSync(metaPath, "utf8")) as {
      label?: string;
      model_id?: string;
      photos?: Array<{ id?: string; src?: string }>;
    };
    return data;
  } catch {
    return { label: fallback };
  }
}

function readCardLabel(cardDir: string, fallback: string) {
  const meta = readCardMeta(cardDir, fallback);
  if (typeof meta.label === "string" && meta.label.trim()) return meta.label.trim();
  return fallback;
}

function publicCardUrl(relativePath: string) {
  return `/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

function getCardsIndexPayload() {
  const cards: Array<{
    id: string;
    label: string;
    bottom: string;
    foreground: string;
    mesh: string;
    chroma_key?: boolean;
    model_id?: string;
    photos?: Array<{ id: string; src: string }>;
  }> = [
    {
      id: "original",
      label: readCardLabel(cardsDirectory, "Original"),
      bottom: publicCardUrl(`cards/${ORIGINAL_BACKGROUND}`),
      foreground: publicCardUrl(`cards/${ORIGINAL_FOREGROUND}`),
      mesh: "tracked-mesh.json",
    },
  ];

  try {
    for (const entry of readdirSync(cardsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cardDir = resolve(cardsDirectory, entry.name);
      const background = resolve(cardDir, "background.mp4");
      const foreground = resolve(cardDir, "foreground.mp4");
      if (!existsSync(background) || !existsSync(foreground)) continue;
      const meta = readCardMeta(cardDir, entry.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
      const photos = Array.isArray(meta.photos)
        ? meta.photos
            .filter(
              (photo): photo is { id: string; src: string } =>
                typeof photo?.id === "string" && typeof photo?.src === "string",
            )
            .map((photo) => ({ id: photo.id, src: photo.src }))
        : undefined;
      cards.push({
        id: entry.name,
        label: readCardLabel(cardDir, entry.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())),
        bottom: publicCardUrl(`cards/${entry.name}/background.mp4`),
        foreground: publicCardUrl(`cards/${entry.name}/foreground.mp4`),
        mesh: `${entry.name}.json`,
        ...(typeof meta.model_id === "string" && meta.model_id.trim()
          ? { model_id: meta.model_id.trim() }
          : {}),
        ...(photos && photos.length > 0 ? { photos } : {}),
      });
    }
  } catch {
    return { cards };
  }

  return { cards };
}

function writeCardsIndex() {
  mkdirSync(cardsDirectory, { recursive: true });
  writeFileSync(cardsIndexFile, JSON.stringify(getCardsIndexPayload(), null, 2));
}

function findModelAvatar(modelId: string) {
  const modelDir = resolve(modelsDirectory, modelId);
  for (const ext of [".jpg", ".jpeg", ".png", ".webp"]) {
    const candidate = resolve(modelDir, `avatar${ext}`);
    if (existsSync(candidate)) return publicCardUrl(`models/${modelId}/avatar${ext}`);
  }
  return null;
}

function findModelFlagSvg(modelId: string) {
  const candidate = resolve(modelsDirectory, modelId, "flag.svg");
  if (!existsSync(candidate)) return null;
  let version = 0;
  try {
    version = Math.floor(statSync(candidate).mtimeMs / 1000);
  } catch {
    // file may have disappeared between existsSync and statSync
  }
  return `${publicCardUrl(`models/${modelId}/flag.svg`)}?v=${version}`;
}

function findModelVideo(modelId: string, filename: string): string | null {
  const candidate = resolve(modelsDirectory, modelId, filename);
  return existsSync(candidate) ? publicCardUrl(`models/${modelId}/${filename}`) : null;
}

function findModelThemeAvatars(modelId: string): Record<string, string> | undefined {
  const themesDir = resolve(modelsDirectory, modelId, "themes");
  if (!existsSync(themesDir)) return undefined;
  const avatars: Record<string, string> = {};
  try {
    for (const entry of readdirSync(themesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const themeDir = resolve(themesDir, entry.name);
      for (const avatarFile of readdirSync(themeDir)) {
        const ext = extname(avatarFile).toLowerCase();
        if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext) && avatarFile.startsWith("avatar")) {
          avatars[entry.name] = publicCardUrl(`models/${modelId}/themes/${entry.name}/${avatarFile}`);
          break;
        }
      }
    }
  } catch {
    // ignore FS errors
  }
  return Object.keys(avatars).length > 0 ? avatars : undefined;
}

function optionalMetaString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalMetaTags(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const tag = item.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function getModelsIndexPayload() {
  const models: Array<{
    id: string;
    label: string;
    avatar: string | null;
    influencerName: string | null;
    influencerCity: string | null;
    influencerCountry: string | null;
    influencerFlag: string | null;
    influencerFlagSvg: string | null;
    cardOverlayColorStart: string | null;
    cardOverlayColorEnd: string | null;
    cardLightColor1: string | null;
    cardLightColor2: string | null;
    cardPackName: string | null;
    cardPackName2: string | null;
    packFaceVideoUrl: string | null;
    packFaceVideoUrl2: string | null;
    swipeVideoUrl: string | null;
    theme_avatars?: Record<string, string>;
    tags: string[];
  }> = [];
  try {
    for (const entry of readdirSync(modelsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const modelDir = resolve(modelsDirectory, entry.name);
      const metaPath = resolve(modelDir, "meta.json");
      let label = entry.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      let influencerName: string | null = null;
      let influencerCity: string | null = null;
      let influencerCountry: string | null = null;
      let influencerFlag: string | null = null;
      let cardOverlayColorStart: string | null = null;
      let cardOverlayColorEnd: string | null = null;
      let cardLightColor1: string | null = null;
      let cardLightColor2: string | null = null;
      let cardPackName: string | null = null;
      let cardPackName2: string | null = null;
      let tags: string[] = [];
      if (existsSync(metaPath)) {
        try {
          const data = JSON.parse(readFileSync(metaPath, "utf8")) as {
            label?: string;
            influencerName?: string;
            influencerCity?: string;
            influencerCountry?: string;
            influencerFlag?: string;
            cardOverlayColorStart?: string;
            cardOverlayColorEnd?: string;
            cardLightColor1?: string;
            cardLightColor2?: string;
            influencerColorStart?: string;
            influencerColorEnd?: string;
            cardPackName?: string;
            cardPackName2?: string;
            tags?: unknown;
          };
          if (typeof data.label === "string" && data.label.trim()) label = data.label.trim();
          influencerName = optionalMetaString(data.influencerName);
          influencerCity = optionalMetaString(data.influencerCity);
          influencerCountry = optionalMetaString(data.influencerCountry);
          influencerFlag = optionalMetaString(data.influencerFlag);
          cardOverlayColorStart = optionalMetaString(
            data.cardOverlayColorStart ?? data.influencerColorStart,
          );
          cardOverlayColorEnd = optionalMetaString(
            data.cardOverlayColorEnd ?? data.influencerColorEnd,
          );
          cardLightColor1 = optionalMetaString(data.cardLightColor1);
          cardLightColor2 = optionalMetaString(data.cardLightColor2);
          cardPackName = optionalMetaString(data.cardPackName);
          cardPackName2 = optionalMetaString(data.cardPackName2);
          tags = optionalMetaTags(data.tags);
        } catch {
          // keep fallback label
        }
      }
      const themeAvatars = findModelThemeAvatars(entry.name);
      models.push({
        id: entry.name,
        label,
        avatar: findModelAvatar(entry.name),
        influencerName,
        influencerCity,
        influencerCountry,
        influencerFlag,
        influencerFlagSvg: findModelFlagSvg(entry.name),
        cardOverlayColorStart,
        cardOverlayColorEnd,
        cardLightColor1,
        cardLightColor2,
        cardPackName,
        cardPackName2,
        packFaceVideoUrl: findModelVideo(entry.name, "pack-face.mp4"),
        packFaceVideoUrl2: findModelVideo(entry.name, "pack-face-2.mp4"),
        swipeVideoUrl: findModelVideo(entry.name, "swipe.mp4"),
        tags,
        ...(themeAvatars ? { theme_avatars: themeAvatars } : {}),
      });
    }
  } catch {
    return { models };
  }
  return { models };
}

function writeModelsIndex() {
  mkdirSync(modelsDirectory, { recursive: true });
  writeFileSync(modelsIndexFile, JSON.stringify(getModelsIndexPayload(), null, 2));
}

export default defineConfig({
  plugins: [
    react(),
    basicSsl(),
    {
      name: "mesh-json-index",
      buildStart() {
        writeMeshIndex();
        writeCardsIndex();
        writeModelsIndex();
      },
      configureServer(server) {
        server.middlewares.use("/mesh/index.json", (_request, response) => {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ files: getMeshJsonFiles() }));
        });
        server.middlewares.use("/cards/index.json", (_request, response) => {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify(getCardsIndexPayload()));
        });
        server.middlewares.use("/models/index.json", (_request, response) => {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify(getModelsIndexPayload()));
        });
      },
    },
  ],
  server: {
    host: "0.0.0.0",
    port: 5080,
    https: true,
    proxy: {
      "/api": "http://127.0.0.1:8090",
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5080,
    https: true,
  },
});
