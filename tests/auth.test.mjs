/**
 * Authentication and multi-tenancy.
 *
 * The tests that matter here are the isolation ones. A scoring bug produces a
 * wrong number; a tenancy bug shows one person another person's private
 * repository. They are not the same severity, and these are the guards.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { withGitHub, github, currentUserId, getViewerLogin } =
  await import("../src/lib/signals/github.ts");
const { cacheKey, queueKey } = await import("../src/lib/cache/store.ts");
const { ExplanationCache } = await import("../src/lib/llm/cache.ts");

// ---------------------------------------------------------------------------
// Per-request credentials — the multi-tenancy boundary
// ---------------------------------------------------------------------------

test("concurrent requests never share a GitHub client", async () => {
  // The failure this prevents: a module-level cached client means User B's
  // queue is fetched with User A's token. Interleaved awaits below would
  // expose any shared state.
  const seen = [];

  await Promise.all([
    withGitHub(
      { token: "token-alice", login: "alice", userId: 1 },
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        seen.push(["alice", currentUserId(), await getViewerLogin()]);
      },
    ),
    withGitHub({ token: "token-bob", login: "bob", userId: 2 }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(["bob", currentUserId(), await getViewerLogin()]);
    }),
  ]);

  for (const [expected, id, login] of seen) {
    assert.equal(login, expected, `${expected} saw ${login}`);
    assert.equal(id, expected === "alice" ? 1 : 2);
  }
});

test("nested calls inherit the outer request's identity", async () => {
  await withGitHub({ token: "t", login: "alice", userId: 1 }, async () => {
    const inner = async () => {
      // A helper several layers down must still act as the same user.
      await new Promise((r) => setTimeout(r, 1));
      return getViewerLogin();
    };

    assert.equal(await inner(), "alice");
    assert.equal(currentUserId(), 1);
  });
});

test("identity does not leak after the request completes", async () => {
  await withGitHub({ token: "t", login: "alice", userId: 1 }, async () => {
    assert.equal(currentUserId(), 1);
  });

  assert.equal(
    currentUserId(),
    null,
    "a later request must not inherit the previous user",
  );
});

test("a bound client is created per request, not shared", async () => {
  let a, b;
  await withGitHub({ token: "token-a", userId: 1 }, async () => {
    a = github();
  });
  await withGitHub({ token: "token-b", userId: 2 }, async () => {
    b = github();
  });

  assert.notEqual(a, b, "two users must not receive the same client instance");
});

// ---------------------------------------------------------------------------
// Cache isolation
// ---------------------------------------------------------------------------

test("cache keys isolate users", () => {
  // Without the user id, a cached private PR would be served to any account
  // asking for the same repo:number:sha — including one that cannot see it.
  assert.notEqual(
    cacheKey("signals", 1, "acme/private", 42, "sha"),
    cacheKey("signals", 2, "acme/private", 42, "sha"),
  );

  assert.notEqual(
    queueKey(1, "acme/private", 50),
    queueKey(2, "acme/private", 50),
  );

  assert.notEqual(
    ExplanationCache.key(1, "acme/private", 42, "sha"),
    ExplanationCache.key(2, "acme/private", 42, "sha"),
  );
});

test("the same user reuses their own cache entries", () => {
  assert.equal(
    cacheKey("signals", 1, "acme/api", 42, "sha"),
    cacheKey("signals", 1, "acme/api", 42, "sha"),
  );
});

test("a push still invalidates, per user", () => {
  assert.notEqual(
    cacheKey("signals", 1, "acme/api", 42, "old-sha"),
    cacheKey("signals", 1, "acme/api", 42, "new-sha"),
  );
});

// ---------------------------------------------------------------------------
// Session configuration
// ---------------------------------------------------------------------------

test("production refuses to start without a strong SESSION_SECRET", async () => {
  // `NODE_ENV` cannot be reassigned in-process, so the guard is exercised in a
  // real production-mode child rather than by faking the environment.
  const { execFileSync } = await import("node:child_process");

  const script = `
    const { sessionOptions } = await import("./src/lib/auth/session.ts");
    const results = [];
    for (const secret of [undefined, "short", "a".repeat(32)]) {
      if (secret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = secret;
      try { sessionOptions(); results.push("accepted"); }
      catch { results.push("refused"); }
    }
    console.log(JSON.stringify(results));
  `;

  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { env: { ...process.env, NODE_ENV: "production" }, encoding: "utf8" },
  );

  const lines = output.trim().split(/\r?\n/);
  const [missing, tooShort, valid] = JSON.parse(lines[lines.length - 1]);

  assert.equal(missing, "refused", "a missing secret must fail at startup");
  assert.equal(tooShort, "refused", "a weak secret must fail at startup");
  assert.equal(valid, "accepted");
});

test("session cookies are hardened", async () => {
  const { sessionOptions } = await import("../src/lib/auth/session.ts");
  const options = sessionOptions();

  // httpOnly is what stops an XSS bug exfiltrating a GitHub token.
  assert.equal(options.cookieOptions.httpOnly, true);
  // SameSite stops a third-party page riding the session.
  assert.equal(options.cookieOptions.sameSite, "lax");
  assert.ok(options.cookieOptions.maxAge > 0, "sessions must expire");
});

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

test("OAuth state values are unique and unguessable", async () => {
  const { newState } = await import("../src/lib/auth/github-oauth.ts");

  const values = new Set(Array.from({ length: 200 }, () => newState()));

  assert.equal(values.size, 200, "state must never repeat");
  for (const value of values) {
    assert.ok(
      value.length >= 32,
      "state must be long enough to resist guessing",
    );
  }
});

test("oauthEnabled reflects configuration", async () => {
  const { oauthEnabled } = await import("../src/lib/auth/github-oauth.ts");

  const id = process.env.GITHUB_CLIENT_ID;
  const secret = process.env.GITHUB_CLIENT_SECRET;

  try {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    assert.equal(oauthEnabled(), false);

    process.env.GITHUB_CLIENT_ID = "id";
    assert.equal(oauthEnabled(), false, "both halves are required");

    process.env.GITHUB_CLIENT_SECRET = "secret";
    assert.equal(oauthEnabled(), true);
  } finally {
    if (id === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = id;
    if (secret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
    else process.env.GITHUB_CLIENT_SECRET = secret;
  }
});

test("the callback URL honours proxy headers", async () => {
  const { callbackUrl } = await import("../src/lib/auth/github-oauth.ts");

  // Behind Vercel's proxy, request.url reports the internal address — using it
  // directly would produce a redirect_uri that GitHub rejects.
  const proxied = new Request("http://internal.local/api/auth/signin", {
    headers: {
      "x-forwarded-host": "pocketreview.vercel.app",
      "x-forwarded-proto": "https",
    },
  });

  assert.equal(
    callbackUrl(proxied),
    "https://pocketreview.vercel.app/api/auth/callback",
  );

  const direct = new Request("http://localhost:3000/api/auth/signin");
  assert.equal(callbackUrl(direct), "http://localhost:3000/api/auth/callback");
});

// ---------------------------------------------------------------------------
// Auth mode — the UI and the guard must never disagree
// ---------------------------------------------------------------------------

test("authMode resolves in the same order as the route guard", async () => {
  const { authMode } = await import("../src/lib/auth/session.ts");

  const saved = {
    demo: process.env.DEMO_MODE,
    id: process.env.GITHUB_CLIENT_ID,
    secret: process.env.GITHUB_CLIENT_SECRET,
    token: process.env.GITHUB_TOKEN,
  };

  const clear = () => {
    delete process.env.DEMO_MODE;
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.GITHUB_TOKEN;
  };

  try {
    clear();
    assert.equal(authMode(), "unconfigured", "nothing set");

    // The bug this pins: a working local token reported as unconfigured, so
    // the UI bounced to a sign-in page that could not sign anyone in.
    clear();
    process.env.GITHUB_TOKEN = "ghp_local";
    assert.equal(authMode(), "local", "a personal token is a valid mode");

    clear();
    process.env.GITHUB_CLIENT_ID = "id";
    process.env.GITHUB_CLIENT_SECRET = "secret";
    assert.equal(authMode(), "oauth");

    // OAuth must win over a stray token, or a leftover GITHUB_TOKEN on a
    // multi-user deployment would serve the deployer's private repositories
    // to anonymous visitors.
    clear();
    process.env.GITHUB_CLIENT_ID = "id";
    process.env.GITHUB_CLIENT_SECRET = "secret";
    process.env.GITHUB_TOKEN = "ghp_leftover";
    assert.equal(authMode(), "oauth", "OAuth outranks a shared token");

    // Demo outranks everything: nothing private is reachable.
    clear();
    process.env.DEMO_MODE = "1";
    process.env.GITHUB_CLIENT_ID = "id";
    process.env.GITHUB_CLIENT_SECRET = "secret";
    process.env.GITHUB_TOKEN = "ghp_x";
    assert.equal(authMode(), "demo");

    // Half-configured OAuth is not OAuth.
    clear();
    process.env.GITHUB_CLIENT_ID = "id";
    assert.equal(authMode(), "unconfigured", "both halves are required");

    clear();
    process.env.GITHUB_CLIENT_ID = "id";
    process.env.GITHUB_TOKEN = "ghp_local";
    assert.equal(
      authMode(),
      "local",
      "incomplete OAuth falls through to the local token",
    );
  } finally {
    clear();
    if (saved.demo !== undefined) process.env.DEMO_MODE = saved.demo;
    if (saved.id !== undefined) process.env.GITHUB_CLIENT_ID = saved.id;
    if (saved.secret !== undefined)
      process.env.GITHUB_CLIENT_SECRET = saved.secret;
    if (saved.token !== undefined) process.env.GITHUB_TOKEN = saved.token;
  }
});
