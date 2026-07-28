import { api } from "./api";

export type SymbolInfo = {
  id: string;
  file: string;
  label: string;
  src: string;
  updated_at: number;
};

export type SymbolJsonPayload = {
  id: string;
  path: string;
  json_text: string;
};

export async function fetchSymbols(): Promise<SymbolInfo[]> {
  const data = await api<{ symbols: SymbolInfo[] }>("/api/symbols");
  return Array.isArray(data.symbols) ? data.symbols : [];
}

export async function updateSymbolLabel(symbolId: string, label: string): Promise<SymbolInfo> {
  return api<SymbolInfo>(`/api/symbols/${encodeURIComponent(symbolId)}`, {
    method: "PUT",
    body: JSON.stringify({ label }),
  });
}

export async function uploadSymbolLottie(symbolId: string, file: File): Promise<SymbolInfo> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`/api/symbols/${encodeURIComponent(symbolId)}/lottie`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<SymbolInfo>;
}

export async function fetchSymbolJson(symbolId: string): Promise<SymbolJsonPayload> {
  return api<SymbolJsonPayload>(`/api/symbols/${encodeURIComponent(symbolId)}/json`);
}

export async function rewriteSymbolJson(symbolId: string, jsonText: string): Promise<SymbolInfo> {
  return api<SymbolInfo>(`/api/symbols/${encodeURIComponent(symbolId)}/json`, {
    method: "PUT",
    body: JSON.stringify({ json_text: jsonText }),
  });
}
