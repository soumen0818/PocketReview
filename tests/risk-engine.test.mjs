/**
 * Risk engine tests.
 *
 * Two of these matter more than the rest, because they are what the product
 * claims on stage:
 *
 *   - a one-line auth change must score HIGH   (criticality is size-independent)
 *   - a 4,000-line lockfile must score LOW     (size alone is not risk)
 *
 * The remainder enforce the structural guarantees that make the score
 * auditable: contributions sum to the base, modifiers are bounded, the result
 * is always in range, and the same input always produces the same output.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeSignals,
  makeFile,
  fullAvailability,
  oneLineAuthChange,
  lockfileOnlyChange,
  docsOnlyChange,
  dangerousChange,
} from "./helpers/signals.mjs";

const { assessRisk, baselineScore, DIMENSIONS, MODIFIER_RULES, toLevel } =
  await import("../src/lib/engines/risk-engine.ts");

const { MODIFIER_CAP } = await import("../src/lib/engines/types.ts");
const { DEFAULT_CONFIG } = await import("../src/lib/config.ts");

const THRESHOLDS = DEFAULT_CONFIG.thresholds;

// ---------------------------------------------------------------------------
// The two demo cases
// ---------------------------------------------------------------------------

test("DEMO: a one-line auth change scores HIGH despite being tiny", () => {
  const signals = oneLineAuthChange();
  const risk = assessRisk(signals);

  // Two lines changed, one file. Any size-based scorer calls this trivial.
  assert.equal(signals.additions + signals.deletions, 2);
  assert.equal(signals.changedFiles, 1);

  assert.ok(
    risk.score >= THRESHOLDS.medium,
    `expected >= ${THRESHOLDS.medium}, got ${risk.score}`,
  );

  // And the reason must be criticality, not something incidental.
  const criticality = risk.dimensions.find(
    (d) => d.id === "domain-criticality",
  );
  assert.ok(
    criticality.contribution >= 13,
    `criticality should dominate, contributed ${criticality.contribution}`,
  );

  // The naive baseline must disagree — that gap is the pitch.
  assert.ok(
    baselineScore(signals) < 5,
    "lines-changed baseline should rate this near zero",
  );
});

test("DEMO: a 4,000-line lockfile scores LOW", () => {
  const signals = lockfileOnlyChange();
  const risk = assessRisk(signals);

  assert.ok(
    signals.additions + signals.deletions > 4000,
    "fixture should be enormous",
  );

  assert.ok(
    risk.score < THRESHOLDS.low,
    `expected < ${THRESHOLDS.low}, got ${risk.score}`,
  );

  // Blast radius must not fire: generated files are excluded from size terms.
  const blast = risk.dimensions.find((d) => d.id === "blast-radius");
  assert.equal(blast.raw, 0);
});

test("DEMO: the tiny auth change outranks the huge lockfile", () => {
  const auth = assessRisk(oneLineAuthChange()).score;
  const lockfile = assessRisk(lockfileOnlyChange()).score;

  assert.ok(
    auth > lockfile,
    `auth (${auth}) must outrank lockfile (${lockfile})`,
  );

  // The baseline gets this exactly backwards, which is the point.
  const baselineAuth = baselineScore(oneLineAuthChange());
  const baselineLock = baselineScore(lockfileOnlyChange());
  assert.ok(
    baselineLock > baselineAuth,
    "the naive baseline should rank these the wrong way round",
  );
});

// ---------------------------------------------------------------------------
// Structural guarantees — what makes "why 87?" answerable
// ---------------------------------------------------------------------------

test("contributions sum exactly to the base score", () => {
  for (const signals of [
    makeSignals(),
    oneLineAuthChange(),
    lockfileOnlyChange(),
    docsOnlyChange(),
    dangerousChange(),
  ]) {
    const risk = assessRisk(signals);
    const sum = risk.dimensions.reduce((t, d) => t + d.contribution, 0);
    assert.ok(
      Math.abs(sum - risk.baseScore) < 0.01,
      `contributions ${sum} != baseScore ${risk.baseScore}`,
    );
  }
});

test("the score is fully accounted for by base, modifiers and floor", () => {
  for (const signals of [
    makeSignals(),
    oneLineAuthChange(),
    dangerousChange(),
    docsOnlyChange(),
    makeSignals({ isDraft: true }),
  ]) {
    const risk = assessRisk(signals);
    const summed = Math.max(
      0,
      Math.min(100, risk.baseScore + risk.modifierDelta),
    );

    if (risk.floor === null) {
      // No floor: the arithmetic alone explains the score.
      assert.equal(risk.score, Math.round(summed));
    } else {
      // A floor applied: it must have raised the score, and it must be the
      // value that decided it.
      assert.ok(risk.floor > summed, "a floor must only ever raise a score");
      assert.equal(risk.score, Math.round(risk.floor));
      assert.ok(risk.floorReasons.length > 0, "a floor must state its reason");
    }
  }
});

test("floors only raise, never lower", () => {
  // A large critical change already scores above every floor, so the floor
  // must not pull it down.
  const risk = assessRisk(dangerousChange());
  assert.equal(risk.floor, null);
  assert.ok(risk.score > 55);
});

test("floors do not apply to drafts or approved PRs", () => {
  // Both are outside the "needs attention now" question the score answers.
  const draft = assessRisk({ ...oneLineAuthChange(), isDraft: true });
  assert.equal(draft.floor, null);

  const approved = assessRisk({
    ...oneLineAuthChange(),
    reviewState: "approved",
    existingApprovals: 1,
  });
  assert.equal(approved.floor, null);
});

test("when a floor decides the score it is named in the reasons", () => {
  const risk = assessRisk(oneLineAuthChange());
  assert.ok(risk.floor !== null);
  assert.ok(
    risk.topReasons.some((r) => /critical.path/i.test(r)),
    `expected a critical-path reason, got: ${risk.topReasons.join(" | ")}`,
  );
});

test("every dimension is present, in fixed order", () => {
  const risk = assessRisk(makeSignals());
  assert.equal(risk.dimensions.length, 7);
  assert.deepEqual(
    risk.dimensions.map((d) => d.id),
    DIMENSIONS.map((d) => d.id),
  );
});

test("dimension weights sum to exactly 1.00", () => {
  const total = DIMENSIONS.reduce((t, d) => t + d.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
});

test("no dimension can contribute more than its weight allows", () => {
  const risk = assessRisk(dangerousChange());
  for (const dimension of risk.dimensions) {
    assert.ok(
      dimension.contribution <= dimension.weight * 100 + 0.01,
      `${dimension.id} contributed ${dimension.contribution}, cap is ${dimension.weight * 100}`,
    );
    assert.ok(dimension.raw >= 0 && dimension.raw <= 1);
  }
});

test("modifiers are capped in aggregate", () => {
  // Stack every negative modifier at once.
  const signals = makeSignals({
    isDraft: true,
    reviewState: "approved",
    existingApprovals: 2,
    files: [
      makeFile({
        path: "README.md",
        category: "docs",
        categoryWeight: 0.05,
        additions: 1,
        deletions: 0,
      }),
    ],
  });

  const risk = assessRisk(signals);
  const rawSum = risk.modifiers.reduce((t, m) => t + m.delta, 0);

  assert.ok(
    Math.abs(rawSum) > MODIFIER_CAP,
    "fixture should exceed the cap before clamping",
  );
  assert.ok(Math.abs(risk.modifierDelta) <= MODIFIER_CAP);
});

test("scores are always within 0..100", () => {
  const extremes = [
    dangerousChange(),
    makeSignals({ isDraft: true, reviewState: "approved", existingApprovals: 3 }),
    makeSignals({ files: [] }),
    lockfileOnlyChange(),
  ];

  for (const signals of extremes) {
    const risk = assessRisk(signals);
    assert.ok(risk.score >= 0 && risk.score <= 100, `got ${risk.score}`);
    assert.ok(Number.isInteger(risk.score));
  }
});

test("the engine is deterministic", () => {
  const signals = dangerousChange();
  const first = assessRisk(signals);

  for (let i = 0; i < 50; i++) {
    const next = assessRisk(signals);
    assert.equal(next.score, first.score);
    assert.deepEqual(
      next.dimensions.map((d) => d.contribution),
      first.dimensions.map((d) => d.contribution),
    );
  }
});

// ---------------------------------------------------------------------------
// Dimension behaviour
// ---------------------------------------------------------------------------

test("criticality is size-independent", () => {
  // The same auth file at 1 line and at 200 lines: criticality must barely
  // move, because *where* the change lands does not depend on how big it is.
  const small = assessRisk(
    makeSignals({
      files: [
        makeFile({
          path: "src/auth/session.ts",
          category: "auth",
          categoryWeight: 1.0,
          additions: 1,
          deletions: 0,
        }),
      ],
    }),
  ).dimensions.find((d) => d.id === "domain-criticality");

  const large = assessRisk(
    makeSignals({
      files: [
        makeFile({
          path: "src/auth/session.ts",
          category: "auth",
          categoryWeight: 1.0,
          additions: 200,
          deletions: 0,
        }),
      ],
    }),
  ).dimensions.find((d) => d.id === "domain-criticality");

  // The mass term allows some movement, but the floor stays high.
  assert.ok(small.raw >= 0.7, `small auth change raw = ${small.raw}`);
  assert.ok(large.raw - small.raw <= 0.31);
});

test("removing tests forces the test dimension to maximum", () => {
  const risk = assessRisk(
    makeSignals({
      testsRemoved: true,
      testLinesAdded: 0,
      testLinesDeleted: 120,
      productionLinesAdded: 80,
    }),
  );

  const tests = risk.dimensions.find((d) => d.id === "test-posture");
  assert.equal(tests.raw, 1);
  assert.ok(tests.reasons.some((r) => /removed/i.test(r)));
});

test("untested production code scores maximum on test posture", () => {
  const risk = assessRisk(
    makeSignals({
      files: [makeFile({ additions: 120, deletions: 0 })],
    }),
  );
  assert.equal(
    risk.dimensions.find((d) => d.id === "test-posture").raw,
    1,
  );
});

test("well-tested code scores low on test posture", () => {
  const risk = assessRisk(
    makeSignals({
      files: [
        makeFile({ path: "src/thing.ts", additions: 100, deletions: 0 }),
        makeFile({
          path: "src/thing.test.ts",
          category: "test",
          categoryWeight: 0.1,
          isTest: true,
          additions: 80,
          deletions: 0,
        }),
      ],
    }),
  );
  assert.ok(risk.dimensions.find((d) => d.id === "test-posture").raw <= 0.2);
});

test("missing history yields zero instability and lower confidence", () => {
  const risk = assessRisk(
    makeSignals({
      availability: fullAvailability({ history: false }),
    }),
  );

  const instability = risk.dimensions.find(
    (d) => d.id === "historical-instability",
  );
  assert.equal(instability.raw, 0);
  assert.ok(instability.reasons.some((r) => /unavailable/i.test(r)));
  assert.ok(risk.confidence < 1);
});

test("low confidence is flagged when most signals are missing", () => {
  const risk = assessRisk(
    makeSignals({
      availability: {
        metadata: true,
        patches: false,
        history: false,
        ci: false,
        reviews: false,
        codeowners: false,
        authorHistory: false,
      },
    }),
  );

  assert.ok(risk.lowConfidence);
  assert.ok(risk.confidence < 0.6);
});

test("AI provenance moves the score by at most ~3 points", () => {
  const human = makeSignals();
  const agent = makeSignals({
    likelyAIAuthored: true,
    aiAuthorshipHints: {
      botAuthor: true,
      coAuthoredByTrailer: true,
      branchNamePattern: true,
      commitCadence: true,
      templatedBody: true,
    },
  });

  const delta = assessRisk(agent).score - assessRisk(human).score;

  // 0.08 weight x 0.4 contribution x 100 = 3.2 points.
  assert.ok(
    delta >= 0 && delta <= 4,
    `AI authorship moved the score by ${delta} points; expected <= 4`,
  );
});

test("six of seven dimensions ignore authorship entirely", () => {
  const human = assessRisk(makeSignals());
  const agent = assessRisk(makeSignals({ likelyAIAuthored: true }));

  for (const dimension of human.dimensions) {
    if (dimension.id === "author-provenance") continue;
    const other = agent.dimensions.find((d) => d.id === dimension.id);
    assert.equal(
      other.contribution,
      dimension.contribution,
      `${dimension.id} should not depend on authorship`,
    );
  }
});

test("lockfile-only dependency changes are near-noise", () => {
  const risk = assessRisk(lockfileOnlyChange());
  const deps = risk.dimensions.find((d) => d.id === "dependencies");
  assert.ok(deps.raw <= 0.2);
  assert.ok(deps.reasons.some((r) => /lockfile/i.test(r)));
});

test("new dependencies register on the dependency dimension", () => {
  const risk = assessRisk(
    makeSignals({
      dependenciesAdded: 3,
      dependencyFilesChanged: ["package.json"],
    }),
  );
  const deps = risk.dimensions.find((d) => d.id === "dependencies");
  assert.ok(deps.raw >= 0.5, `got ${deps.raw}`);
});

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------

test("drafts are demoted", () => {
  const normal = assessRisk(dangerousChange()).score;
  const draft = assessRisk({ ...dangerousChange(), isDraft: true }).score;
  assert.ok(draft < normal);
});

test("approval demotes, failing CI promotes", () => {
  const base = makeSignals({ files: [makeFile({ additions: 200 })] });

  const approved = assessRisk({
    ...base,
    reviewState: "approved",
    existingApprovals: 1,
  }).score;
  const failing = assessRisk({ ...base, ciStatus: "failing" }).score;
  const neutral = assessRisk(base).score;

  assert.ok(approved < neutral);
  assert.ok(failing > neutral);
});

test("docs-only PRs land in the low band", () => {
  const risk = assessRisk(docsOnlyChange());
  assert.equal(risk.level, "low");
  assert.ok(risk.modifiers.some((m) => m.id === "docs-only"));
});

test("every modifier rule has a unique id", () => {
  const ids = MODIFIER_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ---------------------------------------------------------------------------
// Levels and output shape
// ---------------------------------------------------------------------------

test("level thresholds map correctly", () => {
  assert.equal(toLevel(0, THRESHOLDS), "low");
  assert.equal(toLevel(24, THRESHOLDS), "low");
  assert.equal(toLevel(25, THRESHOLDS), "medium");
  assert.equal(toLevel(49, THRESHOLDS), "medium");
  assert.equal(toLevel(50, THRESHOLDS), "high");
  assert.equal(toLevel(74, THRESHOLDS), "high");
  assert.equal(toLevel(75, THRESHOLDS), "critical");
  assert.equal(toLevel(100, THRESHOLDS), "critical");
});

test("a dangerous change scores critical", () => {
  const risk = assessRisk(dangerousChange());
  assert.equal(risk.level, "critical");
  assert.ok(risk.score >= THRESHOLDS.high, `got ${risk.score}`);
});

test("top reasons are ranked by contribution and never empty", () => {
  const risk = assessRisk(dangerousChange());
  assert.ok(risk.topReasons.length > 0);
  assert.ok(risk.topReasons.length <= 5);
  for (const reason of risk.topReasons) {
    assert.equal(typeof reason, "string");
    assert.ok(reason.length > 0);
  }
});

test("every dimension reports which signals it read", () => {
  const risk = assessRisk(dangerousChange());
  for (const dimension of risk.dimensions) {
    assert.ok(
      dimension.signalsUsed.length > 0,
      `${dimension.id} reported no signals`,
    );
    assert.ok(dimension.reasons.length > 0, `${dimension.id} gave no reasons`);
  }
});

test("an empty PR does not crash the engine", () => {
  const risk = assessRisk(makeSignals({ files: [], changedFiles: 0 }));
  assert.ok(risk.score >= 0 && risk.score <= 100);
  assert.equal(risk.dimensions.length, 7);
});
