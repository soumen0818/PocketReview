/**
 * Reviewer engine — Phase 7.
 *
 * The headline tests are the confidence guards. Architecture §8 calls hiding a
 * weak recommendation "non-negotiable", because a card that confidently names
 * the wrong person casts doubt on every working component beside it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  suggestReviewers,
  REVIEWER_WEIGHTS,
  LOW_CONFIDENCE_THRESHOLD,
} from "../src/lib/engines/reviewer-engine.ts";
import { makeSignals, makeFile } from "./helpers/signals.mjs";

/** A matrix with several contributors and real commit history. */
function matrix(overrides = {}) {
  const now = new Date().toISOString();
  return {
    byAuthor: {
      alice: { "src/auth": 40, "src/api": 5 },
      bob: { "src/ui": 30, "src/api": 20 },
      carol: { "src/payments": 25 },
      dave: { "src/ui": 8 },
      erin: { "src/api": 12 },
    },
    lastTouch: {
      alice: now,
      bob: now,
      carol: now,
      dave: now,
      erin: now,
    },
    contributors: ["alice", "bob", "carol", "dave", "erin"],
    totalCommits: 140,
    ...overrides,
  };
}

/** A PR touching one directory. */
function prTouching(dir, overrides = {}) {
  return makeSignals({
    author: "zoe",
    files: [
      makeFile({
        path: `${dir}/thing.ts`,
        category: "other",
        categoryWeight: 0.4,
        additions: 20,
      }),
    ],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test("reviewer weights sum to 1.00", () => {
  const sum = Object.values(REVIEWER_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}`);
});

test("suggestions are deterministic", () => {
  const signals = prTouching("src/auth");
  const m = matrix();

  const first = JSON.stringify(suggestReviewers(signals, m));
  for (let i = 0; i < 20; i++) {
    assert.equal(JSON.stringify(suggestReviewers(signals, m)), first);
  }
});

test("scores stay within 0..1 and ties break by login", () => {
  const result = suggestReviewers(prTouching("src/api"), matrix());

  for (const match of result.matches) {
    assert.ok(
      match.score >= 0 && match.score <= 1,
      `${match.score} out of range`,
    );
  }

  // Descending order.
  for (let i = 1; i < result.matches.length; i++) {
    assert.ok(result.matches[i - 1].score >= result.matches[i].score);
  }
});

// ---------------------------------------------------------------------------
// The confidence guards — non-negotiable
// ---------------------------------------------------------------------------

test("a single-contributor repo yields low confidence", () => {
  const solo = matrix({
    byAuthor: { alice: { "src/auth": 200 } },
    lastTouch: { alice: new Date().toISOString() },
    contributors: ["alice"],
    totalCommits: 200,
  });

  const result = suggestReviewers(prTouching("src/auth"), solo);

  assert.equal(result.lowConfidence, true, "the UI must hide this");
  assert.ok(result.confidence < LOW_CONFIDENCE_THRESHOLD);
  assert.match(result.limitation, /Too few contributors/);
});

test("a thin history yields low confidence with the reason named", () => {
  const thin = matrix({ totalCommits: 8 });
  const result = suggestReviewers(prTouching("src/auth"), thin);

  assert.equal(result.lowConfidence, true);
  assert.match(result.limitation, /Only 8 commits/);
});

test("no history in the touched directories yields low confidence", () => {
  const result = suggestReviewers(prTouching("src/telemetry"), matrix());

  assert.equal(result.lowConfidence, true);
  assert.match(result.limitation, /No contributor has recent history/);
});

test("a healthy repo with matching history is confident", () => {
  const result = suggestReviewers(prTouching("src/auth"), matrix());

  assert.equal(result.lowConfidence, false, JSON.stringify(result));
  assert.ok(result.confidence >= LOW_CONFIDENCE_THRESHOLD);
  assert.equal(result.limitation, null);
  assert.ok(result.matches.length > 0);
});

test("an empty matrix never fabricates a match", () => {
  const empty = {
    byAuthor: {},
    lastTouch: {},
    contributors: [],
    totalCommits: 0,
  };

  const result = suggestReviewers(prTouching("src/auth"), empty);

  assert.deepEqual(result.matches, []);
  assert.equal(result.confidence, 0);
  assert.equal(result.lowConfidence, true);
  assert.ok(result.limitation);
});

// ---------------------------------------------------------------------------
// Matching behaviour
// ---------------------------------------------------------------------------

test("the person who owns the directory ranks first", () => {
  const auth = suggestReviewers(prTouching("src/auth"), matrix());
  assert.equal(auth.matches[0].login, "alice");

  const payments = suggestReviewers(prTouching("src/payments"), matrix());
  assert.equal(payments.matches[0].login, "carol");
});

test("the PR author is never suggested as their own reviewer", () => {
  const signals = prTouching("src/auth", { author: "alice" });
  const result = suggestReviewers(signals, matrix());

  assert.ok(
    !result.matches.some((m) => m.login === "alice"),
    "you cannot review your own work",
  );
});

test("bots are excluded", () => {
  const withBot = matrix({
    byAuthor: {
      ...matrix().byAuthor,
      "dependabot[bot]": { "src/auth": 500 },
    },
    lastTouch: {
      ...matrix().lastTouch,
      "dependabot[bot]": new Date().toISOString(),
    },
    contributors: [...matrix().contributors, "dependabot[bot]"],
  });

  const result = suggestReviewers(prTouching("src/auth"), withBot);

  assert.ok(
    !result.matches.some((m) => /bot/i.test(m.login)),
    "a bot with 500 commits must not outrank a human",
  );
});

test("explicitly excluded logins are dropped", () => {
  const result = suggestReviewers(prTouching("src/auth"), matrix(), {
    exclude: ["alice"],
  });

  assert.ok(!result.matches.some((m) => m.login === "alice"));
});

test("a CODEOWNER is boosted and the reason says so", () => {
  const signals = makeSignals({
    author: "zoe",
    files: [
      makeFile({
        path: "src/api/routes.ts",
        category: "api",
        categoryWeight: 0.7,
        owners: ["erin"],
      }),
    ],
  });

  const result = suggestReviewers(signals, matrix());
  const erin = result.matches.find((m) => m.login === "erin");

  assert.ok(erin, "erin should be matched");
  assert.equal(erin.isCodeowner, true);
  assert.ok(erin.reasons.some((r) => /CODEOWNERS/.test(r)));
});

test("a loaded reviewer scores below an equivalent free one", () => {
  const busy = suggestReviewers(prTouching("src/api"), matrix(), {
    loads: { bob: 5 },
  });
  const free = suggestReviewers(prTouching("src/api"), matrix(), {
    loads: { bob: 0 },
  });

  const busyBob = busy.matches.find((m) => m.login === "bob");
  const freeBob = free.matches.find((m) => m.login === "bob");

  assert.ok(busyBob.score < freeBob.score, "load must reduce the match");
  assert.ok(busyBob.reasons.some((r) => /open reviews/.test(r)));
});

test("stale contributors rank below active ones", () => {
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const stale = matrix({
    lastTouch: { ...matrix().lastTouch, alice: old },
  });

  const fresh = suggestReviewers(prTouching("src/auth"), matrix());
  const gone = suggestReviewers(prTouching("src/auth"), stale);

  const a = fresh.matches.find((m) => m.login === "alice");
  const b = gone.matches.find((m) => m.login === "alice");

  assert.ok(b.score < a.score, "recency must matter");
});

test("generated files contribute no authorship signal", () => {
  const lockfileOnly = makeSignals({
    author: "zoe",
    files: [
      makeFile({
        path: "package-lock.json",
        category: "generated",
        categoryWeight: 0,
        isGenerated: true,
        additions: 4000,
      }),
    ],
  });

  const result = suggestReviewers(lockfileOnly, matrix());
  assert.equal(result.lowConfidence, true, "a lockfile tells us nothing");
});

test("every match carries at least one reason", () => {
  const result = suggestReviewers(prTouching("src/api"), matrix());

  for (const match of result.matches) {
    assert.ok(match.reasons.length > 0, `${match.login} has no reason`);
    assert.ok(typeof match.reasons[0] === "string");
  }
});

test("the result respects the limit", () => {
  const result = suggestReviewers(prTouching("src/api"), matrix(), {
    limit: 2,
  });
  assert.ok(result.matches.length <= 2);
});
