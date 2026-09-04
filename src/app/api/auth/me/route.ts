import { NextResponse } from "next/server";
import { authMode, getViewer, type AuthMode } from "@/lib/auth/session";

/**
 * GET /api/auth/me
 *
 * Who is signed in, and how this deployment authenticates. The client decides
 * whether to show the deck or the sign-in screen from this rather than reading
 * the environment itself and guessing.
 *
 * Never returns the access token.
 */
export async function GET() {
  const mode: AuthMode = authMode();
  const viewer = mode === "oauth" ? await getViewer() : null;

  return NextResponse.json({
    mode,
    /**
     * Whether the app can serve data right now.
     *
     * True for demo and local mode without anyone signing in — both have
     * credentials the server can use. Only `oauth` requires a session, and
     * only `unconfigured` can never serve anything.
     */
    ready: mode === "demo" || mode === "local" || viewer !== null,
    signedIn: viewer !== null,
    login: viewer?.login ?? null,
    avatarUrl: viewer?.avatarUrl ?? null,

    // Retained so the sign-in page can explain what is missing.
    demoMode: mode === "demo",
    oauthEnabled: mode === "oauth",
  });
}
