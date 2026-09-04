/**
 * Configuration validation.
 *
 * `.pocketreview.yml` is hand-written, so the expected failure is a typo, not
 * an attack. Silently accepting a bad value is the dangerous outcome: a weight
 * of 99 breaks the 0..1 contract every dimension assumes and quietly corrupts
 * every score in the queue.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { loadConfig, resetConfig, DEFAULT_CONFIG } =
  await import("../src/lib/config.ts");

/** Write a config file to a scratch directory and load it. */
async function withConfig(yaml) {
  const dir = mkdtempSync(join(tmpdir(), "pocketreview-cfg-"));
  writeFileSync(join(dir, ".pocketreview.yml"), yaml);
  resetConfig();
  try {
    return await loadConfig(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetConfig();
  }
}

test("a missing config file yields working defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pocketreview-empty-"));
  resetConfig();
  const config = await loadConfig(dir);
  rmSync(dir, { recursive: true, force: true });
  resetConfig();

  assert.deepEqual(config.thresholds, DEFAULT_CONFIG.thresholds);
  assert.ok(config.rules.length > 0);
});

test("out-of-range path weights are clamped into 0..1", async () => {
  const config = await withConfig(`
paths:
  - category: auth
    weight: 99
    patterns: ["custom-auth"]
  - category: ui
    weight: -5
    patterns: ["custom-ui"]
`);

  for (const rule of config.rules) {
    assert.ok(
      rule.weight >= 0 && rule.weight <= 1,
      `${rule.category} weight ${rule.weight} out of range`,
    );
  }
});

test("unknown categories are dropped, not silently used", async () => {
  const config = await withConfig(`
paths:
  - category: not-a-real-category
    weight: 0.5
    patterns: ["foo"]
`);

  assert.ok(
    !config.rules.some((r) => r.category === "not-a-real-category"),
    "an unknown category would classify files into a bucket nothing reads",
  );
});

test("non-ascending thresholds fall back wholesale", async () => {
  // low > medium would let a score be two bands at once.
  const config = await withConfig(`
thresholds:
  low: 900
  medium: -3
  high: 10
`);

  assert.deepEqual(config.thresholds, DEFAULT_CONFIG.thresholds);
});

test("a non-numeric threshold falls back", async () => {
  const config = await withConfig(`
thresholds:
  low: 25
  medium: 50
  high: "abc"
`);

  assert.deepEqual(config.thresholds, DEFAULT_CONFIG.thresholds);
});

test("valid ascending thresholds are honoured", async () => {
  const config = await withConfig(`
thresholds:
  low: 15
  medium: 35
  high: 60
`);

  assert.deepEqual(config.thresholds, { low: 15, medium: 35, high: 60 });
});

test("negative numeric settings clamp to their minimum", async () => {
  const config = await withConfig(`
llm:
  maxDiffChars: -1
historyWindowDays: -50
`);

  assert.ok(config.llm.maxDiffChars >= 1000);
  assert.ok(config.historyWindowDays >= 1);
});

test("policy categories are filtered to real ones", async () => {
  const config = await withConfig(`
policy:
  neverFastTrack: [auth, nonsense, payments]
  requireCiPassing: "yes"
`);

  assert.deepEqual(config.policy.neverFastTrack, ["auth", "payments"]);
  // A string is not a boolean — fall back rather than coerce truthiness.
  assert.equal(config.policy.requireCiPassing, true);
});

test("built-in generated and test rules survive user rules", async () => {
  const config = await withConfig(`
paths:
  - category: auth
    weight: 1.0
    patterns: ["my-auth"]
`);

  const categories = config.rules.map((r) => r.category);
  assert.ok(categories.includes("generated"), "lockfiles must stay excluded");
  assert.ok(categories.includes("test"), "tests must not raise risk");
  assert.ok(
    categories.indexOf("generated") < categories.indexOf("auth"),
    "generated must be evaluated first",
  );
});

test("malformed YAML falls back to defaults rather than throwing", async () => {
  const config = await withConfig("paths: [ unclosed\n  nonsense: :::");

  assert.deepEqual(config.thresholds, DEFAULT_CONFIG.thresholds);
  assert.ok(config.rules.length > 0);
});
