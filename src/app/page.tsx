/**
 * The triage queue — server shell.
 *
 * **Auth is resolved here, on the server, before anything is sent.**
 *
 * This used to be a client component that fetched `/api/auth/me` after mount:
 * it painted a spinner, waited a round trip, and then either showed the deck or
 * bounced the browser to `/signin`. Every visitor saw that flash on every load
 * and refresh, and on an unconfigured deployment they saw a spinner followed by
 * a redirect — the app appearing to load something it had already decided it
 * could not.
 *
 * The server knows the answer before the first byte. Resolving it here means an
 * unservable deployment never renders the deck at all, and a working one paints
 * straight into it with no intermediate state.
 */

import { redirect } from "next/navigation";
import TriageApp from "@/components/TriageApp";
import { authMode, getViewer } from "@/lib/auth/session";
import type { AuthState } from "@/hooks/useAuth";

/** The mode comes from the environment and the session cookie — never cached. */
export const dynamic = "force-dynamic";

export default async function Home() {
  const mode = authMode();
  const viewer = mode === "oauth" ? await getViewer() : null;

  // Can this deployment serve data at all? Demo and local modes can, without
  // anyone signing in — they have credentials the server can use. Only `oauth`
  // needs a session, and `unconfigured` can never serve anything.
  const ready = mode === "demo" || mode === "local" || viewer !== null;

  if (!ready) {
    redirect("/signin");
  }

  const auth: AuthState = {
    mode,
    ready,
    signedIn: viewer !== null,
    login: viewer?.login ?? null,
    avatarUrl: viewer?.avatarUrl ?? null,
    demoMode: mode === "demo",
    oauthEnabled: mode === "oauth",
  };

  return <TriageApp auth={auth} />;
}
