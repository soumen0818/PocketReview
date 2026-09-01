/**
 * Signal Layer tests.
 *
 * Run with: npm test
 *
 * These cover the pure classification and diff-analysis logic — the parts the
 * risk score is built on. Anything touching the network is excluded by design:
 * these must pass offline, in CI, on a plane.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  classifyPath,
  isGeneratedPath,
  isTestPath,
  isLockfile,
  isDependencyManifest,
  isCriticalCategory,
  basename,
  extension,
  matchesOwnerPattern,
  parseCodeowners,
  ownersForPath,
} = await import("../src/lib/signals/classify.ts");

const {
  splitPatch,
  countPatchLines,
  analyseComplexity,
  countDependencyChanges,
  detectTestRemoval,
  rankPatchesByConsequence,
  redactSecrets,
} = await import("../src/lib/signals/diff.ts");

const { clamp, saturate, normalisedEntropy, weightedMean, ratio } =
  await import("../src/lib/math.ts");

// ---------------------------------------------------------------------------
// Path classification
// ---------------------------------------------------------------------------

test("auth paths are classified critical regardless of depth", () => {
  for (const path of [
    "src/auth/session.ts",
    "packages/api/src/middleware/auth.ts",
    "internal/security/token.go",
    "app/models/permission.rb",
  ]) {
    const { category, weight } = classifyPath(path);
    assert.ok(
      weight >= 0.7,
      `${path} classified ${category} with weight ${weight}`,
    );
  }
});

test("payments paths score maximum criticality", () => {
  const { category, weight } = classifyPath("src/payments/charge.ts");
  assert.equal(category, "payments");
  assert.equal(weight, 1.0);
});

test("lockfiles are generated, not dependencies-as-code", () => {
  for (const path of [
    "package-lock.json",
    "yarn.lock",
    "apps/web/pnpm-lock.yaml",
    "Cargo.lock",
    "go.sum",
  ]) {
    assert.equal(isGeneratedPath(path), true, path);
    assert.equal(classifyPath(path).weight, 0, path);
  }
});

test("test files beat domain rules — auth tests are tests", () => {
  // Precedence matters: src/auth/session.test.ts must not be scored as a
  // critical auth change.
  const { category } = classifyPath("src/auth/session.test.ts");
  assert.equal(category, "test");
  assert.equal(isTestPath("src/auth/session.test.ts"), true);
});

test("generated beats every other rule", () => {
  // A lockfile inside an auth directory is still generated noise.
  assert.equal(classifyPath("src/auth/package-lock.json").category, "generated");
});

test("docs score near zero", () => {
  assert.ok(classifyPath("README.md").weight <= 0.1);
  assert.ok(classifyPath("docs/architecture.md").weight <= 0.1);
});

test("unknown paths get the neutral default", () => {
  const { category, weight } = classifyPath("src/widgets/thing.ts");
  assert.equal(category, "other");
  assert.equal(weight, 0.4);
});

test("critical categories are exactly auth, payments, database", () => {
  assert.equal(isCriticalCategory("auth"), true);
  assert.equal(isCriticalCategory("payments"), true);
  assert.equal(isCriticalCategory("database"), true);
  assert.equal(isCriticalCategory("ui"), false);
  assert.equal(isCriticalCategory("infra"), false);
});

test("dependency manifests are recognised across ecosystems", () => {
  assert.equal(isDependencyManifest("package.json"), true);
  assert.equal(isDependencyManifest("apps/api/Cargo.toml"), true);
  assert.equal(isDependencyManifest("go.mod"), true);
  assert.equal(isDependencyManifest("src/index.ts"), false);
});

test("lockfile detection is separate from manifest detection", () => {
  assert.equal(isLockfile("package-lock.json"), true);
  assert.equal(isLockfile("package.json"), false);
});

test("path helpers handle both separators", () => {
  assert.equal(basename("src/lib/thing.ts"), "thing.ts");
  assert.equal(basename("src\\lib\\thing.ts"), "thing.ts");
  assert.equal(extension("src/lib/thing.ts"), "ts");
  assert.equal(extension("Makefile"), "");
});

// ---------------------------------------------------------------------------
// CODEOWNERS
// ---------------------------------------------------------------------------

test("CODEOWNERS patterns match the way GitHub does", () => {
  assert.equal(matchesOwnerPattern("src/auth/token.ts", "src/auth/"), true);
  assert.equal(matchesOwnerPattern("src/auth/token.ts", "/src/auth/"), true);
  assert.equal(matchesOwnerPattern("src/ui/button.tsx", "src/auth/"), false);
  assert.equal(matchesOwnerPattern("anything/at/all.ts", "*"), true);
  assert.equal(matchesOwnerPattern("src/a/b/c.ts", "src/**/c.ts"), true);
});

test("CODEOWNERS parsing skips comments and blanks", () => {
  const rules = parseCodeowners(`
# ownership
*           @core-team
/src/auth/  @security-team @alice

  `);
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[1].owners, ["security-team", "alice"]);
});

test("CODEOWNERS is last-match-wins", () => {
  const rules = parseCodeowners("*  @everyone\n/src/auth/  @security");
  assert.deepEqual(ownersForPath("src/auth/token.ts", rules), ["security"]);
  assert.deepEqual(ownersForPath("src/ui/x.tsx", rules), ["everyone"]);
});

// ---------------------------------------------------------------------------
// Diff analysis
// ---------------------------------------------------------------------------

const SAMPLE_PATCH = `@@ -1,5 +1,8 @@
 function check(user) {
-  if (user.isAdmin()) {
+  if (true) {
     return allow();
   }
+  if (user.banned) {
+    return deny();
+  }
   return deny();
 }`;

test("patch splitting ignores headers", () => {
  const { added, removed } = splitPatch(SAMPLE_PATCH);
  assert.equal(added.length, 4);
  assert.equal(removed.length, 1);
  assert.ok(!added.some((l) => l.startsWith("+")));
});

test("line counting matches the split", () => {
  const counts = countPatchLines(SAMPLE_PATCH);
  assert.equal(counts.added, 4);
  assert.equal(counts.removed, 1);
});

test("complexity detects added branching", () => {
  const result = analyseComplexity(SAMPLE_PATCH);
  assert.ok(
    result.controlFlowDelta > 0,
    `expected positive control-flow delta, got ${result.controlFlowDelta}`,
  );
});

test("deletion-heavy patches are flagged", () => {
  const removals = Array.from({ length: 40 }, (_, i) => `-  line ${i}`).join(
    "\n",
  );
  const result = analyseComplexity(`@@ -1,40 +1,1 @@\n${removals}\n+  done()`);
  assert.equal(result.deletionHeavy, true);
});

test("small patches are not deletion-heavy", () => {
  const result = analyseComplexity("@@ -1,2 +1,1 @@\n-  a()\n-  b()\n+  c()");
  assert.equal(result.deletionHeavy, false);
});

test("dependency changes are counted from manifest patches", () => {
  const patch = `@@ -10,6 +10,8 @@
   "dependencies": {
     "react": "^19.0.0",
+    "left-pad": "^1.3.0",
+    "lodash": "^4.17.21",
-    "moment": "^2.29.0"
   }`;
  const counts = countDependencyChanges(patch);
  assert.equal(counts.added, 2);
  assert.equal(counts.removed, 1);
});

test("test removal only counts alongside production changes", () => {
  // Removed tests + new production code: suspicious.
  assert.equal(detectTestRemoval(0, 50, 30), true);
  // Removed tests with no production change: probably deleting dead code.
  assert.equal(detectTestRemoval(0, 50, 0), false);
  // Added more tests than removed: healthy.
  assert.equal(detectTestRemoval(80, 20, 30), false);
});

test("criticality outranks size when ranking patches", () => {
  const files = [
    { path: "package-lock.json", categoryWeight: 0, additions: 4000, deletions: 0 },
    { path: "src/auth/token.ts", categoryWeight: 1.0, additions: 12, deletions: 3 },
    { path: "src/ui/button.tsx", categoryWeight: 0.3, additions: 200, deletions: 0 },
  ];

  const ranked = rankPatchesByConsequence(files);

  // A 15-line auth change must outrank both a 200-line UI file and a
  // 4000-line lockfile. This is what stops the LLM reading noise and never
  // seeing the change that matters.
  assert.equal(ranked[0].path, "src/auth/token.ts");
  assert.equal(ranked[1].path, "src/ui/button.tsx");
  assert.equal(ranked[2].path, "package-lock.json");
});

test("size breaks ties within a criticality tier", () => {
  const files = [
    { path: "src/auth/small.ts", categoryWeight: 1.0, additions: 5, deletions: 0 },
    { path: "src/auth/large.ts", categoryWeight: 1.0, additions: 300, deletions: 20 },
  ];

  const ranked = rankPatchesByConsequence(files);
  assert.equal(ranked[0].path, "src/auth/large.ts");
});

test("secrets are redacted before leaving the process", () => {
  const text = [
    "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345",
    'password: "hunter2istoolong"',
    "AWS: AKIAIOSFODNN7EXAMPLE",
  ].join("\n");

  const redacted = redactSecrets(text);

  assert.ok(!redacted.includes("ghp_abcdefghijklmnopqrstuvwxyz012345"));
  assert.ok(!redacted.includes("hunter2istoolong"));
  assert.ok(!redacted.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(redacted.includes("[REDACTED:"));
});

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

test("clamp bounds into range and survives NaN", () => {
  assert.equal(clamp(1.5), 1);
  assert.equal(clamp(-0.5), 0);
  assert.equal(clamp(0.5), 0.5);
  assert.equal(clamp(NaN), 0);
});

test("saturate has diminishing returns", () => {
  // A 10x larger input must not produce a 10x larger score.
  const small = saturate(500, 500);
  const huge = saturate(5000, 500);
  assert.ok(huge > small);
  assert.ok(huge - small < 0.4, "saturation should compress large inputs");
  assert.ok(saturate(0, 500) === 0);
});

test("entropy separates concentrated from scattered diffs", () => {
  const concentrated = normalisedEntropy([500, 1, 1]);
  const scattered = normalisedEntropy([50, 50, 50, 50]);
  assert.ok(scattered > concentrated);
  assert.equal(normalisedEntropy([100]), 0);
  assert.equal(normalisedEntropy([]), 0);
});

test("weighted mean respects weights", () => {
  assert.equal(weightedMean([1, 0], [1, 0]), 1);
  assert.equal(weightedMean([1, 0], [0, 1]), 0);
  assert.equal(weightedMean([], []), 0);
});

test("ratio is safe at zero", () => {
  assert.equal(ratio(5, 0), 0);
  assert.equal(ratio(1, 4), 0.25);
});
