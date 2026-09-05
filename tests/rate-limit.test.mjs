/**
 * Rate limiting.
 *
 * A backstop against a runaway client — a looping `useEffect`, a script, an
 * impatient refresh — exhausting a user's GitHub rate limit or running up an
 * Anthropic bill. It is deliberately *not* authentication: identity is settled
 * by `withAuth`, and these tests pin that separation.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { guardRequest, isRateLimited, resetRateLimits } =
  await import("../src/lib/rate-limit.ts");

/** A request carrying a client IP, the way Vercel's proxy sends it. */
function requestFrom(ip) {
  return new Request("http://localhost/api/prs", {
    headers: { "x-forwarded-for": ip },
  });
}

// ---------------------------------------------------------------------------
// The limit itself
// ---------------------------------------------------------------------------

test("requests under the limit pass", () => {
  resetRateLimits();

  for (let i = 0; i < 30; i++) {
    assert.equal(
      guardRequest(requestFrom("1.1.1.1"), { maxPerMinute: 30 }),
      null,
      `request ${i + 1} should pass`,
    );
  }
});

test("the request past the limit is refused with 429", () => {
  resetRateLimits();

  for (let i = 0; i < 30; i++) {
    guardRequest(requestFrom("2.2.2.2"), { maxPerMinute: 30 });
  }

  const limited = guardRequest(requestFrom("2.2.2.2"), { maxPerMinute: 30 });

  assert.ok(limited, "the 31st request must be refused");
  assert.equal(limited.status, 429);
  assert.equal(
    limited.headers.get("Retry-After"),
    "60",
    "a client needs to know when to come back",
  );
});

test("the 429 body is JSON a client can read", async () => {
  resetRateLimits();

  for (let i = 0; i < 6; i++) {
    guardRequest(requestFrom("3.3.3.3"), { maxPerMinute: 5 });
  }

  const limited = guardRequest(requestFrom("3.3.3.3"), { maxPerMinute: 5 });

  assert.equal(limited.headers.get("Content-Type"), "application/json");
  const body = await limited.json();
  assert.match(body.error, /too many requests/i);
});

// ---------------------------------------------------------------------------
// Isolation between clients
// ---------------------------------------------------------------------------

test("one client cannot exhaust another's allowance", () => {
  resetRateLimits();

  // Exhaust the first client entirely.
  for (let i = 0; i < 40; i++) {
    guardRequest(requestFrom("4.4.4.4"), { maxPerMinute: 30 });
  }

  assert.ok(guardRequest(requestFrom("4.4.4.4"), { maxPerMinute: 30 }));
  assert.equal(
    guardRequest(requestFrom("5.5.5.5"), { maxPerMinute: 30 }),
    null,
    "a different client starts with a full allowance",
  );
});

test("the first forwarded-for entry identifies the client", () => {
  resetRateLimits();

  // Proxies append; the original client is first.
  const chained = new Request("http://localhost/api/prs", {
    headers: { "x-forwarded-for": "6.6.6.6, 10.0.0.1, 10.0.0.2" },
  });

  for (let i = 0; i < 5; i++) {
    guardRequest(chained, { maxPerMinute: 5 });
  }

  assert.ok(
    guardRequest(requestFrom("6.6.6.6"), { maxPerMinute: 5 }),
    "the same origin IP shares one bucket however many proxies it passed",
  );
});

test("requests with no IP header share one bucket rather than escaping", () => {
  resetRateLimits();

  const anonymous = new Request("http://localhost/api/prs");

  for (let i = 0; i < 5; i++) {
    guardRequest(anonymous, { maxPerMinute: 5 });
  }

  assert.ok(
    guardRequest(anonymous, { maxPerMinute: 5 }),
    "unidentifiable traffic is throttled collectively, not exempted",
  );
});

// ---------------------------------------------------------------------------
// Memory safety
// ---------------------------------------------------------------------------

test("tracking many distinct clients does not grow without bound", () => {
  resetRateLimits();

  // Spoofed forwarded-for values would otherwise grow the map forever — a
  // memory-exhaustion vector inside the thing meant to prevent exhaustion.
  for (let i = 0; i < 12_000; i++) {
    isRateLimited(`10.0.${Math.floor(i / 256)}.${i % 256}`, 30);
  }

  // Still functioning, and a fresh client is still served.
  assert.equal(isRateLimited("172.16.0.1", 30), false);
});

// ---------------------------------------------------------------------------
// It is not authentication
// ---------------------------------------------------------------------------

test("the rate limiter makes no authentication decision", () => {
  resetRateLimits();

  // No credentials of any kind — the limiter must still let it through and
  // leave identity to `withAuth`. Conflating the two is how a shared-secret
  // check ends up 401'ing every browser request in production.
  const bare = new Request("http://localhost/api/prs");

  assert.equal(
    guardRequest(bare),
    null,
    "an unauthenticated request is not the rate limiter's business",
  );
});

test("a per-route limit overrides the default", () => {
  resetRateLimits();

  // Triage is a swipe-driven endpoint and gets a higher ceiling.
  for (let i = 0; i < 45; i++) {
    guardRequest(requestFrom("7.7.7.7"), { maxPerMinute: 60 });
  }

  assert.equal(
    guardRequest(requestFrom("7.7.7.7"), { maxPerMinute: 60 }),
    null,
    "45 requests is under a 60/min ceiling",
  );
});
