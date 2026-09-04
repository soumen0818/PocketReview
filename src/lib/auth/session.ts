/**
 * User sessions.
 *
 * The whole multi-user model rests on one idea: **every user brings their own
 * GitHub token, and the server never holds a shared one.** A user sees exactly
 * the pull requests GitHub would show them, because the request is made with
 * their credentials. There is no way for one user's queue to contain another
 * user's private repository, because there is no shared identity to leak
 * across.
 *
 * The token lives in an encrypted, httpOnly, SameSite cookie:
 *
 *   - **encrypted** — the browser cannot read it, only the server can decrypt
 *   - **httpOnly** — JavaScript on the page cannot touch it, so an XSS bug
 *     cannot exfiltrate a GitHub token
 *   - **SameSite=Lax** — a third-party page cannot ride the session
 *
 * Choosing a cookie over a database is deliberate: there is no user table to
 * breach, no token store to encrypt at rest, and nothing to clean up when
 * someone stops using the app. Sign out and the credential is gone.
 */

import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";

/** What we keep about a signed-in user. Deliberately minimal. */
export interface SessionData {
  /** GitHub OAuth access token. Never leaves the server. */
  accessToken?: string;
  /** GitHub login, e.g. "soumen0818". Used to hide the user's own PRs. */
  login?: string;
  /** Numeric GitHub id — the stable key for per-user cache namespacing. */
  userId?: number;
  /** Avatar URL, shown in the header. */
  avatarUrl?: string;
  /** Unix ms when this session was created, for the max-age check. */
  createdAt?: number;
  /** Anti-CSRF value for the OAuth round trip. */
  oauthState?: string;
}

/** Sessions older than this require signing in again. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * The cookie password.
 *
 * Required in production and validated at startup rather than on first use —
 * a misconfigured deployment should fail loudly at boot, not silently hand
 * every visitor a broken session.
 */
function sessionPassword(): string {
  const password = process.env.SESSION_SECRET;

  if (!password || password.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "SESSION_SECRET must be set to a random string of at least 32 characters. " +
          "Generate one with:  openssl rand -base64 32",
      );
    }

    // Development convenience only. Fixed rather than random so restarting the
    // dev server does not silently sign you out mid-test.
    return "dev-only-insecure-password-do-not-use-in-production-32+";
  }

  return password;
}

export function sessionOptions(): SessionOptions {
  return {
    password: sessionPassword(),
    cookieName: "pocketreview_session",
    cookieOptions: {
      httpOnly: true,
      // Vercel terminates TLS, so secure cookies are correct in production.
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: MAX_AGE_SECONDS,
      path: "/",
    },
  };
}

/** Read (or create) the session for the current request. */
export async function getSession() {
  const store = await cookies();
  return getIronSession<SessionData>(store, sessionOptions());
}

/** A signed-in user, once the session has been validated. */
export interface Viewer {
  accessToken: string;
  login: string;
  userId: number;
  avatarUrl?: string;
}

/**
 * The signed-in user, or null.
 *
 * Also enforces the age limit explicitly. `maxAge` on the cookie is a browser
 * hint — a client that ignores it must not get an indefinite session, so the
 * server checks too.
 */
export async function getViewer(): Promise<Viewer | null> {
  const session = await getSession();

  if (!session.accessToken || !session.login || session.userId === undefined) {
    return null;
  }

  const age = Date.now() - (session.createdAt ?? 0);
  if (age > MAX_AGE_SECONDS * 1000) {
    session.destroy();
    return null;
  }

  return {
    accessToken: session.accessToken,
    login: session.login,
    userId: session.userId,
    avatarUrl: session.avatarUrl,
  };
}

/** True when this deployment lets anyone in without signing in. */
export function isDemoDeployment(): boolean {
  return process.env.DEMO_MODE === "1" || process.env.DEMO_MODE === "true";
}

/**
 * How this deployment authenticates.
 *
 * A single source of truth, because the UI and the route guard reading the
 * environment separately is exactly how they drift: the guard happily served
 * a local `GITHUB_TOKEN` while the client, seeing neither a session nor an
 * OAuth app, redirected to a sign-in page that could not sign anyone in.
 *
 * Resolution order matches `withAuth` exactly — demo, then OAuth, then a local
 * token — so what the UI shows and what the API does can never disagree.
 */
export type AuthMode = "demo" | "oauth" | "local" | "unconfigured";

export function authMode(): AuthMode {
  if (isDemoDeployment()) return "demo";

  // OAuth wins over a local token. A shared token on a multi-user deployment
  // would let any visitor browse the deployer's private repositories.
  const hasOAuth =
    Boolean(process.env.GITHUB_CLIENT_ID?.trim()) &&
    Boolean(process.env.GITHUB_CLIENT_SECRET?.trim());
  if (hasOAuth) return "oauth";

  if (process.env.GITHUB_TOKEN?.trim()) return "local";

  return "unconfigured";
}
