"use client";

import { useCallback } from "react";

/** How the deployment authenticates. Mirrors `AuthMode` on the server. */
export type AuthMode = "demo" | "oauth" | "local" | "unconfigured";

export interface AuthState {
  mode: AuthMode;
  /** True when the app can serve data — no sign-in needed in demo or local. */
  ready: boolean;
  signedIn: boolean;
  login: string | null;
  avatarUrl: string | null;
  demoMode: boolean;
  oauthEnabled: boolean;
}

/**
 * Sign out.
 *
 * All that remains of the old `useAuth` hook. The state it used to fetch is now
 * resolved on the server and passed down as a prop — asking the browser to
 * re-derive what the server already knew is what produced the loading flash on
 * every page load. Signing out is a genuine user action, so it stays a client
 * concern.
 */
export function useSignOut() {
  return useCallback(async () => {
    await fetch("/api/auth/signout", { method: "POST" }).catch(() => {});
    window.location.href = "/signin";
  }, []);
}
