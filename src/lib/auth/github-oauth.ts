/**
 * GitHub OAuth.
 *
 * The standard authorization-code flow. Two properties matter for security and
 * both are enforced here rather than assumed:
 *
 *   1. **State parameter.** A random value is stored in the session before the
 *      redirect and compared on return. Without it, an attacker can complete
 *      the flow with *their* code in *your* browser, silently binding your
 *      session to their GitHub account (login CSRF).
 *   2. **The client secret never leaves the server.** The code-for-token
 *      exchange happens in a route handler, never in the browser.
 *
 * Scope is `read:user` plus `repo`. `repo` is coarse — GitHub's classic OAuth
 * scopes have no read-only repository option, so this grants more than the app
 * uses. That is a real limitation and it is stated on the sign-in page rather
 * than buried: the app makes no write calls at all (verified: every GitHub
 * call in this codebase is a `get` or a `list`), but a user should be told
 * what they are granting.
 */

import { randomBytes } from "crypto";

/** What the app asks GitHub for. */
const SCOPES = ["read:user", "repo"].join(" ");

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
}

/** OAuth credentials, or null when this deployment has none configured. */
export function oauthConfig(): OAuthConfig | null {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** True when sign-in is possible on this deployment. */
export function oauthEnabled(): boolean {
  return oauthConfig() !== null;
}

/** A fresh anti-CSRF state value. */
export function newState(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Where to send the browser to begin sign-in.
 *
 * `redirectUri` is derived from the incoming request rather than configured,
 * so the same build works on localhost, a Vercel preview URL and production
 * without a per-environment variable to forget.
 */
export function authorizeUrl(redirectUri: string, state: string): string {
  const config = oauthConfig();
  if (!config) throw new Error("GitHub OAuth is not configured.");

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    allow_signup: "false",
  });

  return `${AUTHORIZE_URL}?${params}`;
}

export interface GitHubUser {
  login: string;
  id: number;
  avatarUrl?: string;
}

/** Exchange an authorization code for an access token. */
export async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<string> {
  const config = oauthConfig();
  if (!config) throw new Error("GitHub OAuth is not configured.");

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error("GitHub rejected the authorization code exchange.");
  }

  const data = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!data.access_token) {
    // GitHub reports failures with HTTP 200 and an `error` field, so the
    // status check above is not enough on its own.
    throw new Error(
      data.error_description || data.error || "No access token returned.",
    );
  }

  return data.access_token;
}

/** Identify the account a token belongs to. */
export async function fetchUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "pocketreview",
    },
  });

  if (!response.ok) {
    throw new Error("Could not read the GitHub profile for this token.");
  }

  const data = (await response.json()) as {
    login?: string;
    id?: number;
    avatar_url?: string;
  };

  if (!data.login || data.id === undefined) {
    throw new Error("GitHub returned an unexpected profile shape.");
  }

  return { login: data.login, id: data.id, avatarUrl: data.avatar_url };
}

/**
 * The callback URL for this request.
 *
 * Built from forwarded headers so it is correct behind Vercel's proxy, where
 * `request.url` reports the internal address rather than the public one.
 */
export function callbackUrl(request: Request): string {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");

  const host = forwardedHost ?? url.host;
  const proto = forwardedProto ?? url.protocol.replace(":", "");

  return `${proto}://${host}/api/auth/callback`;
}
