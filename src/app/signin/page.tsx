"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Github, ShieldCheck, Eye, AlertTriangle, Wrench } from "lucide-react";

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

function SignInContent() {
  const params = useSearchParams();
  const error = params.get("error");

  const [status, setStatus] = useState<{
    mode: "demo" | "oauth" | "local" | "unconfigured";
    ready: boolean;
    setupHintsVisible: boolean;
  } | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((data) => {
        // Nobody should be on this page when the app can already serve data.
        // Arriving here in demo or local mode means a stale link or a manual
        // URL — send them where they meant to go rather than showing a
        // sign-in flow that does not apply.
        if (data.ready) {
          window.location.href = "/";
          return;
        }
        setStatus(data);
      })
      .catch(() =>
        setStatus({
          mode: "unconfigured",
          ready: false,
          setupHintsVisible: false,
        }),
      );
  }, []);

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

      {/* Nothing is rendered until the mode is known — showing a sign-in
          button that turns out not to apply is worse than a brief blank. */}
      {status === null && <div className="h-12" />}

      {status?.mode === "oauth" && (
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
        and that nothing is broken on their end. Env-var names mean nothing to
        them, and publishing deployment detail to the internet is worse than
        useless.

        In development it is the person who can actually fix it, so the setup
        steps appear there.
      */}
      {status?.mode === "unconfigured" && !status.setupHintsVisible && (
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

      {status?.mode === "unconfigured" && status.setupHintsVisible && (
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
          know why it is being asked for. Only relevant when there is actually
          something to sign in to. */}
      <div
        className="mt-7 space-y-3 border-t border-gray-100 pt-6"
        hidden={status?.mode !== "oauth"}
      >
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

      {status?.mode === "oauth" && (
        <p className="mt-7 text-center text-[10.5px] text-gray-400">
          You see only the pull requests your own GitHub account can see.
        </p>
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

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInContent />
    </Suspense>
  );
}
