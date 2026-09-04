import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  callbackUrl,
  exchangeCode,
  fetchUser,
  oauthEnabled,
} from "@/lib/auth/github-oauth";

/**
 * GET /api/auth/callback
 *
 * Where GitHub sends the browser back after the user approves (or denies).
 *
 * The state check is the security-critical step: without it, an attacker can
 * complete this flow with their own `code` in your browser and silently bind
 * your session to their GitHub account. The stored state is consumed on first
 * use so a captured callback URL cannot be replayed.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const session = await getSession();
  const expectedState = session.oauthState;

  // Single-use, whatever happens next.
  session.oauthState = undefined;
  await session.save();

  if (!oauthEnabled()) {
    return redirectWithError(request, "not-configured");
  }

  // The user pressed "Cancel" on GitHub's consent screen.
  if (error) {
    return redirectWithError(request, "denied");
  }

  if (!code || !state) {
    return redirectWithError(request, "invalid-callback");
  }

  if (!expectedState || state !== expectedState) {
    // Either a forged callback or a session that expired mid-flow. Both are
    // handled the same way: refuse and start over.
    return redirectWithError(request, "state-mismatch");
  }

  try {
    const accessToken = await exchangeCode(code, callbackUrl(request));
    const user = await fetchUser(accessToken);

    session.accessToken = accessToken;
    session.login = user.login;
    session.userId = user.id;
    session.avatarUrl = user.avatarUrl;
    session.createdAt = Date.now();
    await session.save();

    return NextResponse.redirect(new URL("/", origin(request)));
  } catch {
    // Deliberately not surfacing the upstream message: it can contain request
    // detail, and there is nothing actionable in it for the user.
    return redirectWithError(request, "exchange-failed");
  }
}

function origin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  const proto =
    request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

function redirectWithError(request: Request, reason: string): NextResponse {
  const target = new URL("/signin", origin(request));
  target.searchParams.set("error", reason);
  return NextResponse.redirect(target);
}
