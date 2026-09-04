import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  authorizeUrl,
  callbackUrl,
  newState,
  oauthEnabled,
} from "@/lib/auth/github-oauth";

/**
 * GET /api/auth/signin
 *
 * Starts the OAuth flow. Stores an anti-CSRF state value in the session, then
 * redirects to GitHub.
 */
export async function GET(request: Request) {
  if (!oauthEnabled()) {
    return NextResponse.json(
      {
        error:
          "Sign-in is not configured on this deployment. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.",
      },
      { status: 501 },
    );
  }

  const session = await getSession();
  const state = newState();

  session.oauthState = state;
  await session.save();

  return NextResponse.redirect(authorizeUrl(callbackUrl(request), state));
}
