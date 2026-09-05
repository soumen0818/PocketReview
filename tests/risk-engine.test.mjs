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

const {
  assessRisk,
  baselineScore,
  DIMENSIONS,
  MODIFIER_RULES,
  FLOOR_RULES,
  toLevel,
} = await import("../src/lib/engines/risk-engine.ts");

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
    makeSignals({
      isDraft: true,
      reviewState: "approved",
      existingApprovals: 3,
    }),
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
  assert.equal(risk.dimensions.find((d) => d.id === "test-posture").raw, 1);
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

// ---------------------------------------------------------------------------
// What the card actually shows
// ---------------------------------------------------------------------------

test("top reasons lead with distinct evidence, not restatements", () => {
  // The card shows the first four. Taking two reasons per dimension filled
  // those slots with near-duplicates and pushed the most useful line —
  // "reverted 3 times recently" — off the card entirely.
  const signals = makeSignals({
    files: [
      makeFile({
        path: "src/payments/settlement.ts",
        category: "payments",
        categoryWeight: 1,
        additions: 300,
        deletions: 200,
        churn: 40,
      }),
    ],
    criticalPaths: ["src/payments/settlement.ts"],
    productionLinesAdded: 300,
    hasNoTests: true,
    testRatio: 0,
    fileChurn: { "src/payments/settlement.ts": 40 },
    fileRevertRate: { "src/payments/settlement.ts": 0.3 },
    priorIncidentFiles: ["src/payments/settlement.ts"],
    dependenciesAdded: 2,
  });

  const visible = assessRisk(signals).topReasons.slice(0, 4);

  // No two visible reasons may come from the same dimension's follow-up line.
  assert.equal(
    new Set(visible).size,
    visible.length,
    "the visible reasons must not repeat",
  );

  assert.ok(
    visible.some((r) => /revert/i.test(r)),
    `revert history must survive into the visible four: ${JSON.stringify(visible)}`,
  );
});

test("only the highest floor is named, not every floor that fired", () => {
  // Two floors firing put two near-identical lines at the top of the card.
  const signals = makeSignals({
    files: [
      makeFile({
        path: "src/auth/session.ts",
        category: "auth",
        categoryWeight: 1,
        additions: 1,
        deletions: 1,
      }),
    ],
    criticalPaths: ["src/auth/session.ts"],
    productionLinesAdded: 1,
    hasNoTests: true,
    testRatio: 0,
  });

  const risk = assessRisk(signals);

  // Both floors fire here, but only the highest may be named — the lower one
  // ("Touches a critical path") says the same thing less precisely.
  const allFloorLabels = FLOOR_RULES.map((r) => r.label);
  const named = risk.topReasons.filter((r) => allFloorLabels.includes(r));

  assert.equal(
    named.length,
    1,
    `only one floor label belongs on the card: ${JSON.stringify(named)}`,
  );
  assert.equal(
    named[0],
    "Critical-path change with no test coverage",
    "the highest floor is the one that explains the score",
  );
});

test("reassuring lines do not displace risk evidence", () => {
  const signals = makeSignals({
    files: [
      makeFile({
        path: "src/auth/token.ts",
        category: "auth",
        categoryWeight: 1,
        additions: 40,
      }),
    ],
    criticalPaths: ["src/auth/token.ts"],
    productionLinesAdded: 40,
    hasNoTests: true,
    testRatio: 0,
  });

  const visible = assessRisk(signals).topReasons.slice(0, 4);

  assert.ok(
    !visible.some((r) => /^No recent instability/i.test(r)),
    `reassurance belongs in the breakdown, not the card: ${JSON.stringify(visible)}`,
  );
});

test("an unremarkable PR still explains itself", () => {
  // Filtering reassurance must not leave the "why this score" panel empty.
  const signals = makeSignals();
  const risk = assessRisk(signals);

  assert.ok(
    risk.topReasons.length > 0,
    "there must always be something to say",
  );
});

/**
 * Floors fire on auth, payments and database — not on every high-weight path.
 *
 * Found in the wild: a Dependabot bump of `actions/checkout` from v6 to v7,
 * four one-line edits under `.github/workflows/`, scored 55/100 and displayed
 * *"Critical-path change with no test coverage"*. The floor was keying off
 * `signals.criticalPaths`, which is every path at category weight ≥ 0.7 and so
 * includes `infra` (0.75) and `api` (0.70). A workflow file has no tests by
 * definition, so the untested floor fired on its own.
 *
 * Two things were wrong: the score, and a stated reason naming three domains
 * the PR never touched. The floors now use the same explicit category set the
 * policy gate blocks on, so one definition of "critical path" holds across the
 * whole system.
 */
test("a CI workflow bump does not hit the critical-path floor", () => {
  const workflow = (path) =>
    makeFile({
      path,
      category: "infra",
      categoryWeight: 0.75,
      additions: 1,
      deletions: 1,
    });

  const signals = makeSignals({
    files: [
      workflow(".github/workflows/ci.yml"),
      workflow(".github/workflows/codeql.yml"),
      workflow(".github/workflows/dependency-review.yml"),
      workflow(".github/workflows/secret-scan.yml"),
    ],
    // Still reported for explanation text — the signal itself is unchanged.
    criticalPaths: [
      ".github/workflows/ci.yml",
      ".github/workflows/codeql.yml",
      ".github/workflows/dependency-review.yml",
      ".github/workflows/secret-scan.yml",
    ],
    productionLinesAdded: 4,
    hasNoTests: true,
    testRatio: 0,
    authorIsBot: true,
  });

  const risk = assessRisk(signals);

  assert.equal(risk.floor, null, "no floor should fire on infra-only changes");
  assert.ok(
    risk.score < 50,
    `a four-line workflow bump must not read as high risk, got ${risk.score}`,
  );

  // The reason that made the card self-contradictory.
  assert.ok(
    !risk.topReasons.some((r) => /critical.path/i.test(r)),
    `must not claim a critical path: ${JSON.stringify(risk.topReasons)}`,
  );
});

test("auth still floors, so narrowing the rule did not disarm it", () => {
  // The guard on the fix above: the floor must still do its actual job.
  const signals = makeSignals({
    files: [
      makeFile({
        path: "src/auth/session.ts",
        category: "auth",
        categoryWeight: 1,
        additions: 3,
        deletions: 1,
      }),
    ],
    criticalPaths: ["src/auth/session.ts"],
    productionLinesAdded: 3,
    hasNoTests: true,
    testRatio: 0,
  });

  const risk = assessRisk(signals);
  assert.equal(risk.floor, 55);
  assert.ok(risk.score >= 55);
});

test("api paths report as critical for explanation but do not floor", () => {
  // `api` sits at 0.70 — inside the old threshold, outside the new rule.
  const signals = makeSignals({
    files: [
      makeFile({
        path: "src/app/api/health/route.ts",
        category: "api",
        categoryWeight: 0.7,
        additions: 2,
        deletions: 0,
      }),
    ],
    criticalPaths: ["src/app/api/health/route.ts"],
    productionLinesAdded: 2,
    hasNoTests: true,
    testRatio: 0,
  });

  const risk = assessRisk(signals);
  assert.equal(risk.floor, null, "an API route change must not force a floor");
});
