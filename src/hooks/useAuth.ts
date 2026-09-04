"use client";

import { useState, useEffect, useCallback } from "react";

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

const UNKNOWN: AuthState = {
  mode: "unconfigured",
  ready: false,
  signedIn: false,
  login: null,
  avatarUrl: null,
  demoMode: false,
  oauthEnabled: false,
};

/**
 * Who is signed in.
 *
 * `loading` matters: rendering the sign-in prompt before this resolves would
 * flash a sign-in screen at an already-authenticated user on every load.
 */
export function useAuth() {
  const [auth, setAuth] = useState<AuthState>(UNKNOWN);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me");
      setAuth(res.ok ? await res.json() : UNKNOWN);
    } catch {
      setAuth(UNKNOWN);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/signout", { method: "POST" }).catch(() => {});
    window.location.href = "/signin";
  }, []);

  return { ...auth, loading, refresh, signOut };
}
