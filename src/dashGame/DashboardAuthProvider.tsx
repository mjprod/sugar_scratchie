import type { ReactNode } from "react";
import { AuthContext, type AuthContextValue } from "./contexts/useAuth";

/**
 * The scratch game only reads `authed`. Staying signed-out skips player wallet
 * and scratch-hand API calls — the operator cookie is not a player session.
 */
const dashboardAuth = {
  authReady: true,
  authed: false,
  guest: true,
} as AuthContextValue;

export function DashboardAuthProvider({ children }: { children: ReactNode }) {
  return (
    <AuthContext.Provider value={dashboardAuth}>{children}</AuthContext.Provider>
  );
}
