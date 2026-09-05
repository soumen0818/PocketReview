/**
 * The sign-in screen.
 *
 * **This is a server component on purpose.**
 *
 * The mode this deployment runs in — demo, OAuth, local token, or not yet
 * configured — is known on the server before a single byte of HTML is sent.
 * Fetching it from the browser after paint meant the page rendered a blank
 * placeholder, then flickered into whichever panel turned out to apply. On a
 * refresh that flash is the first thing anyone sees, and "the site is still
 * deciding what it is" is not the first impression this should make.
 *
 * Resolving `authMode()` here puts the correct, final screen in the initial
 * HTML. There is no loading state because there is nothing to load, and no
 * client-side redirect because the redirect happens before rendering.
 */

import { redirect } from "next/navigation";
import { Github, ShieldCheck, Eye, AlertTriangle, Wrench } from "lucide-react";
import { authMode, getViewer } from "@/lib/auth/session";

/** Static routing — the mode comes from the environment, never from a cache. */
export const dynamic = "force-dynamic";

/** What went wrong, in the user's language rather than the protocol's. */
const ERRORS: Record<string, string> = {
  denied: "Sign-in was cancelled. Nothing was shared with PocketReview.",
  "state-mismatch":
    "That sign-in link expired or did not match this browser. Please try again.",
  "invalid-callback": "GitHub sent an incomplete response. Please try again.",
  "exchange-failed":
    "GitHub could not complete the sign-in. Please try again in a moment.",
  "not-configured":
    "Sign-in is not available yet on this site. Please check back soon.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const mode = authMode();

  // Nobody should be on this page when the app can already serve data. In demo
  // and local mode there is no sign-in to perform, and an already-signed-in
  // user arriving here followed a stale link. Redirecting on the server means
  // they never see this page at all — previously they saw it flash first.
  const viewer = mode === "oauth" ? await getViewer() : null;
  if (mode === "demo" || mode === "local" || viewer !== null) {
    redirect("/");
  }

  // Env-var names are for whoever deployed the app, not for a visitor who
  // followed a link. Publishing deployment detail to the internet is confusing
  // at best, so the setup steps only appear outside production.
  const setupHintsVisible = process.env.NODE_ENV !== "production";

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col justify-center px-6 py-10">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">PocketReview</h1>
        <p className="mt-1 text-[13px] text-gray-500">
          Intelligent PR triage. We don&apos;t review your code — we decide
          where your attention goes.
        </p>
      </div>

      {error && (
        <div className="mb-5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600" />
          <p className="text-[11.5px] text-amber-800">
            {ERRORS[error] ?? "Sign-in did not complete. Please try again."}
          </p>
        </div>
      )}

      {mode === "oauth" && (
        <a
          href="/api/auth/signin"
          className="flex w-full items-center justify-center gap-2 rounded-full bg-gray-900 px-5 py-3 text-[14px] font-semibold text-white transition-colors hover:bg-gray-800 active:bg-gray-700"
        >
          <Github size={17} />
          Sign in with GitHub
        </a>
      )}

      {/*
        Credentials are missing.

        Who is looking decides what to say. On a deployed site this is a
        visitor who followed a link — they need to know it is not their fault
        and that nothing is broken on their end.
      */}
      {mode === "unconfigured" && !setupHintsVisible && (
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-6 text-center">
          <Wrench size={22} className="mx-auto text-gray-400" />
          <p className="mt-3 text-[14px] font-semibold text-gray-900">
            Not quite ready yet
          </p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-gray-600">
            PocketReview is still being set up on this site. Sign-in will be
            available shortly — please check back soon.
          </p>
          <p className="mt-3 text-[11px] text-gray-500">
            Nothing is wrong on your end.
          </p>
        </div>
      )}

      {mode === "unconfigured" && setupHintsVisible && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-[12px] font-semibold text-amber-900">
            No credentials configured
          </p>
          <p className="mt-0.5 text-[10.5px] text-amber-700">
            Only shown in development. Pick one and restart.
          </p>
          <ul className="mt-2.5 space-y-2 text-[11px] leading-relaxed text-amber-800">
            <li>
              <span className="font-semibold">Try it offline</span> — set{" "}
              <code className="rounded bg-amber-100 px-1">DEMO_MODE=1</code> to
              run on sample pull requests with no credentials at all.
            </li>
            <li>
              <span className="font-semibold">Your own PRs, locally</span> — set{" "}
              <code className="rounded bg-amber-100 px-1">GITHUB_TOKEN</code> to
              a read-only personal access token.
            </li>
            <li>
              <span className="font-semibold">Let others sign in</span> — set{" "}
              <code className="rounded bg-amber-100 px-1">
                GITHUB_CLIENT_ID
              </code>
              ,{" "}
              <code className="rounded bg-amber-100 px-1">
                GITHUB_CLIENT_SECRET
              </code>{" "}
              and{" "}
              <code className="rounded bg-amber-100 px-1">SESSION_SECRET</code>.
              See{" "}
              <code className="rounded bg-amber-100 px-1">
                docs/deployment.md
              </code>
              .
            </li>
          </ul>
        </div>
      )}

      {/* What the user is agreeing to, before they agree to it. Burying this
          would be the wrong trade: `repo` is a broad scope and they deserve to
          know why it is being asked for. */}
      {mode === "oauth" && (
        <>
          <div className="mt-7 space-y-3 border-t border-gray-100 pt-6">
            <Row
              icon={<Eye size={13} />}
              title="Read-only, always"
              body="PocketReview never merges, approves, comments on, or changes anything. Every GitHub call it makes is a read."
            />
            <Row
              icon={<ShieldCheck size={13} />}
              title="Your token stays on the server"
              body="It is held in an encrypted session cookie your browser cannot read, and is never sent to the page. Sign out and it is gone."
            />
            <Row
              icon={<Github size={13} />}
              title="Why it asks for repo access"
              body="GitHub has no read-only repository scope for OAuth apps, so `repo` is the narrowest option that can see your private pull requests. You can revoke it any time in GitHub settings."
            />
          </div>

          <p className="mt-7 text-center text-[10.5px] text-gray-400">
            You see only the pull requests your own GitHub account can see.
          </p>
        </>
      )}
    </main>
  );
}

function Row({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex gap-2.5">
      <span className="mt-0.5 shrink-0 text-gray-400">{icon}</span>
      <div>
        <p className="text-[12px] font-semibold text-gray-900">{title}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500">
          {body}
        </p>
      </div>
    </div>
  );
}
