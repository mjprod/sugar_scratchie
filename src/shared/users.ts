import { api } from "./api";

export type UserStatus = "active" | "banned" | "deleted";
export type WalletCurrency = "diamonds" | "coins";

export type AdminUserWallet = {
  diamonds: number;
  coins: number;
};

export type AdminUser = {
  id: string;
  email: string;
  provider: string;
  emailVerified: boolean;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  genderInterest: string | null;
  referralCode: string;
  welcomeClaimed: boolean;
  homeTutorialDone: boolean;
  recommendationStatus: string | null;
  status: UserStatus;
  createdAt: string | null;
  updatedAt: string | null;
  lastSeenAt: string | null;
  wallet: AdminUserWallet;
  activeSessions?: number | null;
};

export type WalletTransaction = {
  id: string;
  currency: WalletCurrency;
  delta: number;
  balanceAfter: number;
  reason: string;
  refType: string | null;
  refId: string | null;
  createdAt: string | null;
};

export type UsersListResponse = {
  total: number;
  limit: number;
  offset: number;
  users: AdminUser[];
};

export type UserDetailResponse = {
  user: AdminUser;
  transactions: WalletTransaction[];
};

export async function fetchUsers(params?: {
  q?: string;
  status?: UserStatus | "";
  limit?: number;
  offset?: number;
}): Promise<UsersListResponse> {
  const search = new URLSearchParams();
  if (params?.q?.trim()) search.set("q", params.q.trim());
  if (params?.status) search.set("status", params.status);
  if (params?.limit != null) search.set("limit", String(params.limit));
  if (params?.offset != null) search.set("offset", String(params.offset));
  const qs = search.toString();
  return api<UsersListResponse>(`/api/users${qs ? `?${qs}` : ""}`);
}

export async function fetchUser(userId: string): Promise<UserDetailResponse> {
  return api<UserDetailResponse>(`/api/users/${encodeURIComponent(userId)}`);
}

export async function patchUser(
  userId: string,
  payload: { status?: UserStatus; display_name?: string | null; username?: string | null },
): Promise<{ user: AdminUser }> {
  return api<{ user: AdminUser }>(`/api/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function adjustUserWallet(
  userId: string,
  payload: { currency: WalletCurrency; delta: number; note?: string },
): Promise<{ wallet: AdminUserWallet; idempotencyKey: string }> {
  return api(`/api/users/${encodeURIComponent(userId)}/wallet/adjust`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function revokeUserSessions(userId: string): Promise<{ revoked: number }> {
  return api<{ revoked: number }>(`/api/users/${encodeURIComponent(userId)}/sessions/revoke`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function deleteUserPermanently(
  userId: string,
): Promise<{ ok: boolean; id: string; email: string }> {
  return api(`/api/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
}
