import { api } from "./api";

export type SymbolGroupInfo = {
  id: string;
  label: string;
  is_default: boolean;
  sort_order: number;
};

export type SymbolInfo = {
  id: string;
  group_id: string;
  file: string;
  label: string;
  src: string;
  updated_at: number;
};

export type SymbolJsonPayload = {
  id: string;
  group_id: string;
  path: string;
  json_text: string;
};

function withGroup(path: string, groupId?: string): string {
  if (!groupId) return path;
  const join = path.includes("?") ? "&" : "?";
  return `${path}${join}group_id=${encodeURIComponent(groupId)}`;
}

export async function fetchSymbolGroups(): Promise<SymbolGroupInfo[]> {
  const data = await api<{ groups: SymbolGroupInfo[] }>("/api/symbol-groups");
  return Array.isArray(data.groups) ? data.groups : [];
}

export async function createSymbolGroup(
  id: string,
  label: string,
  copyFrom?: string,
): Promise<SymbolGroupInfo> {
  return api<SymbolGroupInfo>("/api/symbol-groups", {
    method: "POST",
    body: JSON.stringify({
      id,
      label,
      ...(copyFrom ? { copy_from: copyFrom } : {}),
    }),
  });
}

export async function updateSymbolGroupLabel(groupId: string, label: string): Promise<SymbolGroupInfo> {
  return api<SymbolGroupInfo>(`/api/symbol-groups/${encodeURIComponent(groupId)}`, {
    method: "PUT",
    body: JSON.stringify({ label }),
  });
}

export async function setDefaultSymbolGroup(groupId: string): Promise<SymbolGroupInfo> {
  return api<SymbolGroupInfo>(`/api/symbol-groups/${encodeURIComponent(groupId)}/default`, {
    method: "POST",
  });
}

export async function deleteSymbolGroup(groupId: string): Promise<void> {
  await api<{ ok: boolean }>(`/api/symbol-groups/${encodeURIComponent(groupId)}`, {
    method: "DELETE",
  });
}

export async function fetchSymbols(groupId?: string): Promise<SymbolInfo[]> {
  const data = await api<{ symbols: SymbolInfo[] }>(withGroup("/api/symbols", groupId));
  return Array.isArray(data.symbols) ? data.symbols : [];
}

export async function updateSymbolLabel(
  symbolId: string,
  label: string,
  groupId?: string,
): Promise<SymbolInfo> {
  return api<SymbolInfo>(withGroup(`/api/symbols/${encodeURIComponent(symbolId)}`, groupId), {
    method: "PUT",
    body: JSON.stringify({ label }),
  });
}

export async function uploadSymbolLottie(
  symbolId: string,
  file: File,
  groupId?: string,
): Promise<SymbolInfo> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(withGroup(`/api/symbols/${encodeURIComponent(symbolId)}/lottie`, groupId), {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<SymbolInfo>;
}

export async function fetchSymbolJson(symbolId: string, groupId?: string): Promise<SymbolJsonPayload> {
  return api<SymbolJsonPayload>(withGroup(`/api/symbols/${encodeURIComponent(symbolId)}/json`, groupId));
}

export async function rewriteSymbolJson(
  symbolId: string,
  jsonText: string,
  groupId?: string,
): Promise<SymbolInfo> {
  return api<SymbolInfo>(withGroup(`/api/symbols/${encodeURIComponent(symbolId)}/json`, groupId), {
    method: "PUT",
    body: JSON.stringify({ json_text: jsonText }),
  });
}
