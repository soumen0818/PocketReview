/**
 * Demo queue tests.
 *
 * These pin the behaviour the demo depends on. A future change to a weight or
 * a dimension that quietly reorders the queue would break the presentation
 * without breaking any other test — so the ordering itself is asserted here.
 *
 * They also serve as an end-to-end check of the engine over realistic input:
 * the fixtures run through the real scorer, nothing is pre-computed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { DEMO_SIGNALS } = await import("../src/lib/demo/fixtures.ts");
const { assessRisk, baselineScore } =
  await import("../src/lib/engines/risk-engine.ts");

/** Score the fixtures the way the queue endpoint does. */
function scoreQueue() {
  return DEMO_SIGNALS.map((signals) => ({
    number: signals.number,
    title: signals.title,
    lines: signals.additions + signals.deletions,
    risk: assessRisk(signals),
    baseline: baselineScore(signals),
  })).sort((a, b) => b.risk.score - a.risk.score);
}

test("the demo queue has a usable spread of levels", () => {
  const queue = scoreQueue();
  const levels = new Set(queue.map((pr) => pr.risk.level));

  // A demo where everything scores the same proves nothing.
  assert.ok(
    levels.size >= 3,
    `expected at least 3 distinct levels, got ${[...levels].join(", ")}`,
  );
  assert.ok(levels.has("critical"), "no critical PR to demonstrate");
  assert.ok(levels.has("low"), "no low-risk PR to demonstrate");
});

test("DEMO: the two-line auth change outranks the 5000-line lockfile", () => {
  const queue = scoreQueue();
  const auth = queue.find((pr) => pr.number === 147);
  const lockfile = queue.find((pr) => pr.number === 152);

  assert.ok(auth.lines <= 5, `auth fixture should be tiny, is ${auth.lines}`);
  assert.ok(
    lockfile.lines > 4000,
    `lockfile fixture should be huge, is ${lockfile.lines}`,
  );

  assert.ok(
    auth.risk.score > lockfile.risk.score,
    `auth ${auth.risk.score} must beat lockfile ${lockfile.risk.score}`,
  );

  // The naive model gets this exactly backwards, which is the whole point.
  assert.ok(
    lockfile.baseline > auth.baseline,
    "the lines-changed baseline should rank these the wrong way round",
  );
});

test("DEMO: the auth change reaches at least the high band", () => {
  const auth = scoreQueue().find((pr) => pr.number === 147);
  assert.ok(auth.risk.score >= 50, `expected >= 50, got ${auth.risk.score}`);
  assert.ok(auth.risk.floor !== null, "a floor should be carrying this score");
});

test("DEMO: the payments rewrite is the top of the queue", () => {
  const queue = scoreQueue();
  assert.equal(queue[0].number, 149);
  assert.equal(queue[0].risk.level, "critical");
});

test("DEMO: trivial changes sink to the bottom", () => {
  const queue = scoreQueue();
  const bottom = queue
    .slice(-2)
    .map((pr) => pr.number)
    .sort();

  // The lockfile and the docs typo.
  assert.deepEqual(bottom, [152, 155]);
});

test("DEMO: one PR exercises the low-confidence path", () => {
  const queue = scoreQueue();
  const limited = queue.filter((pr) => pr.risk.lowConfidence);

  assert.ok(
    limited.length >= 1,
    "no fixture triggers the limited-signals warning, so that UI is untested in the demo",
  );
});

test("every demo PR produces a complete, renderable assessment", () => {
  for (const pr of scoreQueue()) {
    assert.ok(Number.isInteger(pr.risk.score));
    assert.ok(pr.risk.score >= 0 && pr.risk.score <= 100);
    assert.equal(pr.risk.dimensions.length, 7);
    assert.ok(pr.risk.topReasons.length > 0, `#${pr.number} has no reasons`);

    // The card renders these directly; an empty string would show as a gap.
    for (const reason of pr.risk.topReasons) {
      assert.ok(typeof reason === "string" && reason.trim().length > 0);
    }
  }
});

test("demo scoring is deterministic", () => {
  const first = scoreQueue().map((pr) => `${pr.number}:${pr.risk.score}`);
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(
      scoreQueue().map((pr) => `${pr.number}:${pr.risk.score}`),
      first,
    );
  }
});
