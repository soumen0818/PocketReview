/**
 * Explanation layer — Phase 6.
 *
 * These tests never call the API. Everything that matters here is testable
 * offline: the cache keying that makes rehearsals free, the diff prioritisation
 * that decides what the model reads, and the degradation guarantee that keeps
 * the deck working when the model is gone.
 *
 * The one thing tests cannot prove — that the prose is good — was verified by
 * running it against real fixtures during Phase 6.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ExplanationCache } from "../src/lib/llm/cache.ts";
import { prioritiseDiff } from "../src/lib/llm/diff-prioritise.ts";
import {
  classifyError,
  LLMUnavailable,
  MODELS,
} from "../src/lib/llm/client.ts";
import { makeFile } from "./helpers/signals.mjs";

// ---------------------------------------------------------------------------
// Cache — the headSha key is what makes a rehearsed demo free
// ---------------------------------------------------------------------------

test("the cache key includes the head SHA", () => {
  const a = ExplanationCache.key(7, "acme/api", 42, "abc123");
  const b = ExplanationCache.key(7, "acme/api", 42, "def456");

  assert.notEqual(a, b, "a pushed commit must miss the cache");
  assert.equal(a, "u7:acme/api:42:abc123");
});

test("the cache key includes the user — cross-account isolation", () => {
  // One user's explanation of a private PR must never reach another account.
  assert.notEqual(
    ExplanationCache.key(1, "acme/private", 42, "sha"),
    ExplanationCache.key(2, "acme/private", 42, "sha"),
  );
});

test("a push invalidates the explanation rather than serving stale prose", () => {
  const cache = new ExplanationCache();

  cache.set(ExplanationCache.key(1, "acme/api", 7, "sha-old"), "old prose");

  assert.equal(
    cache.get(ExplanationCache.key(1, "acme/api", 7, "sha-new")),
    undefined,
    "the new head must not read the old explanation",
  );
  assert.equal(
    cache.get(ExplanationCache.key(1, "acme/api", 7, "sha-old")),
    "old prose",
  );
});

test("same repo and number in different repos stay distinct", () => {
  const cache = new ExplanationCache();
  cache.set(ExplanationCache.key(1, "acme/api", 7, "sha"), "api prose");
  cache.set(ExplanationCache.key(1, "acme/web", 7, "sha"), "web prose");

  assert.equal(
    cache.get(ExplanationCache.key(1, "acme/api", 7, "sha")),
    "api prose",
  );
  assert.equal(
    cache.get(ExplanationCache.key(1, "acme/web", 7, "sha")),
    "web prose",
  );
});

test("entries expire once past their TTL", async () => {
  const cache = new ExplanationCache(20); // 20ms
  cache.set("k", "value");
  assert.equal(cache.get("k"), "value");

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(cache.get("k"), undefined, "stale entries are dropped");
});

test("the cache evicts least-recently-used beyond its ceiling", () => {
  const cache = new ExplanationCache(60_000, 3);

  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  cache.get("a"); // refresh a — b is now the coldest
  cache.set("d", 4);

  assert.equal(cache.get("b"), undefined, "coldest entry evicted");
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("d"), 4);
  assert.equal(cache.size, 3);
});

test("concurrent misses share one computation", async () => {
  const cache = new ExplanationCache();
  let calls = 0;

  const compute = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return "computed";
  };

  const [a, b, c] = await Promise.all([
    cache.resolve("k", compute),
    cache.resolve("k", compute),
    cache.resolve("k", compute),
  ]);

  assert.equal(calls, 1, "a queue fan-out must not fire N identical requests");
  assert.deepEqual([a, b, c], ["computed", "computed", "computed"]);
});

test("a failed computation is not cached", async () => {
  const cache = new ExplanationCache();

  await assert.rejects(
    cache.resolve("k", async () => {
      throw new Error("boom");
    }),
  );

  assert.equal(cache.get("k"), undefined);
  assert.equal(await cache.resolve("k", async () => "ok"), "ok");
});

// ---------------------------------------------------------------------------
// Diff prioritisation — the model must read the auth change, not the lockfile
// ---------------------------------------------------------------------------

test("the lockfile is excluded and the auth change is included", () => {
  const files = [
    makeFile({
      path: "package-lock.json",
      category: "generated",
      categoryWeight: 0,
      isGenerated: true,
      additions: 4000,
      deletions: 200,
      patch: "@@ lockfile noise @@\n" + "+  x\n".repeat(500),
    }),
    makeFile({
      path: "src/auth/session.ts",
      category: "auth",
      categoryWeight: 1,
      additions: 2,
      deletions: 1,
      patch: "@@ -1,3 +1,3 @@\n-if (user.isAdmin())\n+if (true)",
    }),
  ];

  const result = prioritiseDiff(files, 2000);

  assert.ok(
    result.text.includes("if (true)"),
    "the auth change must reach the model",
  );
  assert.ok(
    !result.text.includes("lockfile noise"),
    "the lockfile must not consume the budget",
  );
  assert.deepEqual(result.includedPaths, ["src/auth/session.ts"]);
  assert.ok(result.omittedPaths.includes("package-lock.json"));
});

test("criticality outranks size when filling the budget", () => {
  const files = [
    makeFile({
      path: "src/ui/button.tsx",
      category: "ui",
      categoryWeight: 0.3,
      additions: 200,
      deletions: 0,
      patch: "UI_PATCH " + "x".repeat(400),
    }),
    makeFile({
      path: "src/auth/token.ts",
      category: "auth",
      categoryWeight: 1,
      additions: 15,
      deletions: 3,
      patch: "AUTH_PATCH tiny",
    }),
  ];

  // Budget fits only one of them.
  const result = prioritiseDiff(files, 300);

  assert.equal(result.includedPaths[0], "src/auth/token.ts");
  assert.ok(result.text.includes("AUTH_PATCH"));
  assert.ok(!result.text.includes("UI_PATCH"));
});

test("omitted files are named, so the model can say what it did not see", () => {
  const files = [
    makeFile({ path: "src/a.ts", categoryWeight: 0.5, patch: "A".repeat(200) }),
    makeFile({ path: "src/b.ts", categoryWeight: 0.5, patch: "B".repeat(200) }),
    makeFile({ path: "src/c.ts", categoryWeight: 0.5, patch: "C".repeat(200) }),
  ];

  const result = prioritiseDiff(files, 260);

  assert.ok(result.truncated);
  assert.ok(
    /further files? not shown/.test(result.text),
    "the prompt must disclose what was withheld",
  );
  assert.ok(result.omittedPaths.length >= 1);
});

test("the single most consequential file is included even if oversized", () => {
  const files = [
    makeFile({
      path: "src/auth/huge.ts",
      category: "auth",
      categoryWeight: 1,
      additions: 900,
      patch: "AUTH " + "z".repeat(5000),
    }),
  ];

  const result = prioritiseDiff(files, 500);

  assert.equal(result.includedPaths.length, 1);
  assert.ok(result.text.includes("AUTH"));
  assert.ok(/truncated/.test(result.text), "and says it was clipped");
});

test("a generated-only PR yields an honest placeholder, not an empty prompt", () => {
  const files = [
    makeFile({
      path: "package-lock.json",
      category: "generated",
      categoryWeight: 0,
      isGenerated: true,
      additions: 4000,
      patch: "noise",
    }),
  ];

  const result = prioritiseDiff(files, 2000);

  assert.equal(result.includedPaths.length, 0);
  assert.match(result.text, /generated files/);
});

test("files without a patch are skipped rather than sent empty", () => {
  const files = [
    makeFile({ path: "src/a.ts", categoryWeight: 0.5, patch: undefined }),
    makeFile({ path: "src/b.ts", categoryWeight: 0.5, patch: "REAL" }),
  ];

  const result = prioritiseDiff(files, 2000);
  assert.deepEqual(result.includedPaths, ["src/b.ts"]);
});

// ---------------------------------------------------------------------------
// Degradation — the deck must survive a missing or broken model
// ---------------------------------------------------------------------------

test("model tiering uses the cheap model for the high-volume path", () => {
  assert.match(MODELS.summary, /haiku/, "deck lines are high volume");
  assert.match(MODELS.explain, /sonnet/, "the explain screen is on demand");
});

test("errors classify into states the UI can state honestly", () => {
  const passthrough = new LLMUnavailable("disabled", "off");
  assert.equal(classifyError(passthrough), passthrough);

  const unknown = classifyError(new Error("socket hang up"));
  assert.ok(unknown instanceof LLMUnavailable);
  assert.equal(unknown.kind, "api-error");
  assert.match(unknown.message, /socket hang up/);
});

test("LLMUnavailable carries a machine-readable kind", () => {
  const err = new LLMUnavailable("no-api-key", "not set");
  assert.equal(err.name, "LLMUnavailable");
  assert.equal(err.kind, "no-api-key");
  assert.ok(err instanceof Error, "must still be catchable as an Error");
});
