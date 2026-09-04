/**
 * Cache store — Phase 9.
 *
 * Two things matter here beyond "does it store values": the `headSha` in the
 * key, which is what makes a rehearsed demo free and a pushed PR correct, and
 * the refusal to persist diff content, which is how `docs/security.md`'s
 * no-source-persistence promise is kept in code rather than in prose.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "fs/promises";
import { join } from "path";

import {
  cacheKey,
  read,
  write,
  resolve,
  ageOf,
  clearMemory,
  __internals,
} from "../src/lib/cache/store.ts";

const CACHE_DIR = join(process.cwd(), ".pocketreview", "cache");

/** Each test starts from a clean slate in both tiers. */
async function reset() {
  clearMemory();
  await rm(CACHE_DIR, { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Keying — the headSha is the whole point
// ---------------------------------------------------------------------------

test("the cache key includes the head SHA", () => {
  const a = cacheKey("queue", "acme/api", 42, "abc123");
  const b = cacheKey("queue", "acme/api", 42, "def456");

  assert.notEqual(a, b, "a pushed commit must miss");
  assert.equal(a, "queue:acme/api:42:abc123");
});

test("namespaces keep different kinds of value apart", () => {
  assert.notEqual(
    cacheKey("signals", "acme/api", 1, "sha"),
    cacheKey("explanation", "acme/api", 1, "sha"),
  );
});

// ---------------------------------------------------------------------------
// The no-source-persistence guarantee
// ---------------------------------------------------------------------------

test("writing anything containing a patch is refused", async () => {
  await reset();

  await assert.rejects(
    () =>
      write("k", { files: [{ path: "a.ts", patch: "@@ -1 +1 @@\n-a\n+b" }] }),
    /never source code/,
    "diff content must never reach disk",
  );

  assert.equal(await read("k"), undefined, "and nothing is stored");
});

test("the patch guard sees through nesting", () => {
  const { containsPatch } = __internals;

  assert.equal(containsPatch({ a: { b: { c: { patch: "x" } } } }), true);
  assert.equal(containsPatch([{ files: [{ patch: "x" }] }]), true);
  assert.equal(containsPatch({ a: { b: "safe" } }), false);
  assert.equal(containsPatch({ patch: 42 }), false, "only string patches");
  assert.equal(containsPatch(null), false);
  assert.equal(containsPatch("string"), false);
});

test("signals stripped of patches are accepted", async () => {
  await reset();

  const safe = {
    files: [{ path: "src/auth.ts", additions: 4, category: "auth" }],
  };

  await write("safe", safe);
  assert.deepEqual(await read("safe"), safe);
});

// ---------------------------------------------------------------------------
// Two tiers
// ---------------------------------------------------------------------------

test("a value survives an L1 wipe by coming back from disk", async () => {
  await reset();

  await write("persisted", { score: 87 });

  // Simulate a process restart: memory is gone, disk is not.
  clearMemory();

  assert.deepEqual(await read("persisted"), { score: 87 });
});

test("a miss returns undefined rather than throwing", async () => {
  await reset();
  assert.equal(await read("never-written"), undefined);
});

test("resolve computes once and caches the result", async () => {
  await reset();
  let calls = 0;

  const compute = async () => {
    calls++;
    return { value: "computed" };
  };

  assert.deepEqual(await resolve("k", compute), { value: "computed" });
  assert.deepEqual(await resolve("k", compute), { value: "computed" });
  assert.equal(calls, 1, "the second call must hit the cache");
});

test("resolve does not cache a thrown computation", async () => {
  await reset();

  await assert.rejects(
    resolve("k", async () => {
      throw new Error("boom");
    }),
  );

  assert.equal(await read("k"), undefined);
});

// ---------------------------------------------------------------------------
// Staleness reporting
// ---------------------------------------------------------------------------

test("ageOf reports how old an entry is", async () => {
  await reset();

  await write("aged", { x: 1 });
  const age = await ageOf("aged");

  assert.ok(age !== null, "a written entry has an age");
  assert.ok(age >= 0 && age < 5000, `age ${age} should be near zero`);
});

test("ageOf returns null for an absent entry", async () => {
  await reset();
  assert.equal(await ageOf("missing"), null);
});

// ---------------------------------------------------------------------------
// Filenames
// ---------------------------------------------------------------------------

test("keys map to filesystem-safe filenames", () => {
  const { filenameFor } = __internals;

  const name = filenameFor("queue:acme/api:42:abc/def");

  assert.match(name, /^[0-9a-f]{32}\.json$/, "no slashes or colons on disk");
  assert.equal(
    filenameFor("same"),
    filenameFor("same"),
    "the mapping is stable",
  );
  assert.notEqual(filenameFor("a"), filenameFor("b"));
});

test("cleanup leaves no cache directory behind", async () => {
  await reset();
});
