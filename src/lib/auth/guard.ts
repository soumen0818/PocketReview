/**
 * Route authorisation.
 *
 * One helper wraps every route that touches GitHub, so the rules cannot drift
 * between endpoints and a new route cannot accidentally ship unauthenticated.
 *
 * Three deployment shapes are supported by the same code:
 *
 *   - **Signed-in user** — the request runs with *their* token. This is the
 *     multi-user path, and the only one safe to expose publicly.
 *   - **Demo deployment** (`DEMO_MODE=1`) — no credentials at all; fixtures
 *     are served. Safe to make public because nothing private is reachable.
 *   - **Local single user** (`GITHUB_TOKEN` set, no OAuth configured) — the
 *     original developer workflow, preserved so `npm run dev` still works
 *     without registering an OAuth app.
 */

import { NextResponse } from "next/server";
import { getViewer, isDemoDeployment, type Viewer } from "./session";
import { oauthEnabled } from "./github-oauth";
import { withGitHub } from "../signals/github";

/** Who the request is acting as. */
export interface RequestIdentity {
  /** GitHub login, or null in demo mode. */
  login: string | null;
  /** Stable id for cache namespacing. `"demo"` when unauthenticated. */
  userId: number | string;
  /** True when serving fixtures rather than live GitHub data. */
  demo: boolean;
}

/**
 * Run a handler with GitHub credentials bound to the caller.
 *
 * Returns a 401 rather than falling back to any shared identity when nobody is
 * signed in and no local token exists. Falling back would mean an anonymous
 * visitor browsing the deployer's private repositories.
 */
export async function withAuth(
  handler: (identity: RequestIdentity) => Promise<NextResponse>,
): Promise<NextResponse> {
  // Demo deployments serve fixtures and never touch GitHub, so there is
  // nothing to authorise.
  if (isDemoDeployment()) {
    return handler({ login: null, userId: "demo", demo: true });
  }

  const viewer = await getViewer();

  if (viewer) {
    return withGitHub(
      {
        token: viewer.accessToken,
        login: viewer.login,
        userId: viewer.userId,
      },
      () =>
        handler({
          login: viewer.login,
          userId: viewer.userId,
          demo: false,
        }),
    );
  }

  // Local development: a personal token in the environment, no OAuth app.
  // Deliberately refused once OAuth is configured — on a real deployment a
  // shared token would be exactly the leak this whole layer exists to prevent.
  const localToken = process.env.GITHUB_TOKEN?.trim();
  if (localToken && !oauthEnabled()) {
    return withGitHub({ token: localToken, userId: null }, () =>
      handler({ login: null, userId: "local", demo: false }),
    );
  }

  return NextResponse.json(
    {
      error: "Sign in with GitHub to load your review queue.",
      signedIn: false,
    },
    { status: 401 },
  );
}

/** The viewer, or null. Re-exported so routes need one import. */
export type { Viewer };
