/**
 * Priority engine and effort estimator — Phase 4.
 *
 * Priority answers "what should I open right now?", which is a different
 * question from risk's "how much attention does this need?". These tests pin
 * that distinction, the anti-starvation property, and the stability of the
 * queue order.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  priorityScore,
  rankQueue,
  ageDecay,
  PRIORITY_WEIGHTS,
} from "../src/lib/engines/priority-engine.ts";
import {
  estimateEffort,
  totalEffort,
  formatDuration,
} from "../src/lib/engines/effort-estimator.ts";
import { assessRisk } from "../src/lib/engines/risk-engine.ts";
import { makeSignals, makeFile } from "./helpers/signals.mjs";

/** Score a signal set end to end, the way the route does. */
function score(signals, options = {}) {
  const risk = assessRisk(signals);
  return priorityScore(signals, risk, options);
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test("priority weights sum to 1.00", () => {
  const sum = Object.values(PRIORITY_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}`);
});

test("term contributions sum to the score", () => {
  const signals = makeSignals({
    ageHours: 40,
    labels: ["incident"],
    isBlockingOthers: true,
  });
  const priority = score(signals);

  const sum = priority.terms.reduce((total, t) => total + t.contribution, 0);
  assert.equal(priority.score, Math.round(sum));
});

test("no term contributes more than its weight allows", () => {
  // Everything at maximum simultaneously.
  const signals = makeSignals({
    ageHours: 10_000,
    labels: ["incident", "security", "p0"],
    isBlockingOthers: true,
    files: [
      makeFile({
        path: "src/auth/session.ts",
        category: "auth",
        categoryWeight: 1,
        additions: 400,
      }),
    ],
    productionLinesAdded: 400,
    testLinesAdded: 0,
    criticalPaths: ["auth"],
  });
  const priority = score(signals, { blockedCount: 99 });

  for (const term of priority.terms) {
    assert.ok(
      term.contribution <= term.weight * 100 + 1e-6,
      `${term.id} contributed ${term.contribution}, cap ${term.weight * 100}`,
    );
  }
});

test("score is always an integer in [0,100]", () => {
  const cases = [
    makeSignals(),
    makeSignals({ ageHours: 0 }),
    makeSignals({ ageHours: 100_000, labels: ["p0"], isBlockingOthers: true }),
    makeSignals({ files: [] }),
  ];

  for (const signals of cases) {
    const { score: s } = score(signals);
    assert.ok(Number.isInteger(s), `${s} is not an integer`);
    assert.ok(s >= 0 && s <= 100, `${s} out of range`);
  }
});

test("priority is deterministic across 50 runs", () => {
  const signals = makeSignals({
    ageHours: 55,
    labels: ["security"],
    isBlockingOthers: true,
  });

  const first = JSON.stringify(score(signals));
  for (let i = 0; i < 49; i++) {
    assert.equal(JSON.stringify(score(signals)), first);
  }
});

// ---------------------------------------------------------------------------
// Anti-starvation
// ---------------------------------------------------------------------------

test("age decay is superlinear and caps below full weight", () => {
  assert.equal(ageDecay(0), 0);

  // Capped so age can lift a PR but never dominate risk.
  assert.equal(ageDecay(72), 0.7);
  assert.equal(ageDecay(100_000), 0.7, "capped however old it gets");

  // Superlinear below the cap: equal spans of time add increasing amounts.
  // Measured under 57h, where (h/72)^1.5 is still below the 0.7 ceiling.
  const firstThird = ageDecay(19) - ageDecay(0);
  const lastThird = ageDecay(57) - ageDecay(38);
  assert.ok(
    lastThird > firstThird,
    `expected superlinear growth, got ${firstThird} then ${lastThird}`,
  );

  // The cap binds before the nominal 72h ceiling — by ~57h the curve is flat.
  assert.ok(ageDecay(38) < ageDecay(50), "still climbing at 38h");
  assert.equal(ageDecay(57), ageDecay(72), "flat once capped");
});

test("a stale low-risk PR eventually outranks a fresh low-risk one", () => {
  const fresh = makeSignals({ number: 1, ageHours: 1 });
  const stale = makeSignals({ number: 2, ageHours: 72 });

  assert.ok(
    score(stale).score > score(fresh).score,
    "age must lift an otherwise identical PR",
  );
});

test("age alone cannot outrank a genuinely risky PR", () => {
  // The anti-starvation term must not become a starvation term of its own.
  const ancientTrivial = makeSignals({ number: 1, ageHours: 100_000 });

  const freshCritical = makeSignals({
    number: 2,
    ageHours: 1,
    files: [
      makeFile({
        path: "src/auth/session.ts",
        category: "auth",
        categoryWeight: 1,
        additions: 1,
        deletions: 1,
      }),
    ],
    productionLinesAdded: 1,
    testLinesAdded: 0,
    criticalPaths: ["auth"],
  });

  assert.ok(
    score(freshCritical).score > score(ancientTrivial).score,
    "risk is weighted highest for a reason",
  );
});

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

test("drafts are suppressed by default and included on request", () => {
  const draft = makeSignals({ isDraft: true });

  assert.equal(score(draft).suppressed, true);
  assert.ok(score(draft).suppressionReasons.includes("draft"));

  assert.equal(score(draft, { includeDrafts: true }).suppressed, false);
});

test("approved PRs are suppressed", () => {
  const approved = makeSignals({
    reviewState: "approved",
    existingApprovals: 1,
  });

  const priority = score(approved);
  assert.equal(priority.suppressed, true);
  assert.ok(priority.suppressionReasons.includes("approved"));
});

test("an approval with no approvers does not suppress", () => {
  const odd = makeSignals({ reviewState: "approved", existingApprovals: 0 });
  assert.equal(score(odd).suppressed, false);
});

test("the viewer's own PR is suppressed, case-insensitively", () => {
  const mine = makeSignals({ author: "Alice" });

  assert.equal(score(mine, { viewer: "alice" }).suppressed, true);
  assert.ok(
    score(mine, { viewer: "alice" }).suppressionReasons.includes("own-pr"),
  );

  assert.equal(score(mine, { viewer: "bob" }).suppressed, false);
  assert.equal(score(mine).suppressed, false, "no viewer means no own-PR rule");
});

test("failing CI demotes but does not suppress", () => {
  const failing = makeSignals({ ciStatus: "failing" });
  const priority = score(failing);

  assert.equal(priority.demoted, true);
  assert.equal(priority.suppressed, false, "the PR has not gone away");
  assert.ok(priority.suppressionReasons.includes("ci-failing"));
});

test("a critical PR is never demoted by failing CI", () => {
  // Demotion assumes "the author will push again, so don't spend attention
  // yet". That holds for a routine change and fails badly for a critical one:
  // burying a payments rewrite under six trivial PRs is the exact
  // misallocation this system exists to prevent.
  // Needs history and complexity too — criticality alone floors at 55 (high).
  const files = Array.from({ length: 14 }, (_, i) =>
    makeFile({
      path: `src/payments/f${i}.ts`,
      category: "payments",
      categoryWeight: 1,
      additions: 90,
      deletions: 40,
      churn: 40,
    }),
  );

  const criticalFailing = makeSignals({
    ciStatus: "failing",
    files,
    productionLinesAdded: 1260,
    hasNoTests: true,
    testRatio: 0,
    criticalPaths: files.map((f) => f.path),
    diffEntropy: 0.95,
    distinctCategories: 5,
    hotspotScore: 0.9,
    priorIncidentFiles: [files[0].path],
    fileChurn: Object.fromEntries(files.map((f) => [f.path, 40])),
    fileRevertRate: Object.fromEntries(files.map((f) => [f.path, 0.3])),
    dependenciesAdded: 4,
  });

  const risk = assessRisk(criticalFailing);
  assert.equal(risk.level, "critical", "fixture must actually be critical");

  const priority = priorityScore(criticalFailing, risk);
  assert.equal(priority.demoted, false, "critical stays in place");
  assert.ok(
    priority.suppressionReasons.includes("ci-failing"),
    "but the failing CI is still reported",
  );
});

test("a demoted PR sinks below a critical one with the same red CI", () => {
  const build = (n, signals) => ({
    number: n,
    priority: priorityScore(signals, assessRisk(signals)),
  });

  const routineFailing = build(
    1,
    makeSignals({ number: 1, ciStatus: "failing", ageHours: 200 }),
  );
  const criticalFailing = build(
    2,
    makeSignals({
      number: 2,
      ciStatus: "failing",
      ageHours: 1,
      files: [
        makeFile({
          path: "src/payments/charge.ts",
          category: "payments",
          categoryWeight: 1,
          additions: 300,
          deletions: 200,
        }),
      ],
      productionLinesAdded: 300,
      hasNoTests: true,
      testRatio: 0,
      criticalPaths: ["payments"],
    }),
  );

  assert.deepEqual(
    rankQueue([routineFailing, criticalFailing]).map((p) => p.number),
    [2, 1],
  );
});

test("suppression does not depend on the score", () => {
  // A maximally urgent draft is still a draft.
  const urgentDraft = makeSignals({
    isDraft: true,
    ageHours: 500,
    labels: ["incident", "p0"],
    isBlockingOthers: true,
  });

  const priority = score(urgentDraft);
  assert.ok(priority.score > 20, "should score highly on the terms");
  assert.equal(priority.suppressed, true, "and still be suppressed");
});

// ---------------------------------------------------------------------------
// Urgency and blocking
// ---------------------------------------------------------------------------

test("urgency labels raise priority", () => {
  const plain = makeSignals({ number: 1 });
  const urgent = makeSignals({ number: 2, labels: ["incident"] });

  assert.ok(score(urgent).score > score(plain).score);
});

test("urgency reads linked issue labels too, and is case-insensitive", () => {
  const viaIssue = makeSignals({ linkedIssueLabels: ["SECURITY"] });
  const term = score(viaIssue).terms.find((t) => t.id === "urgency");
  assert.ok(term.raw > 0, "SECURITY should match the security keyword");
});

test("a hotfix branch counts as urgent even without labels", () => {
  const hotfix = makeSignals({ isHotfix: true });
  const term = score(hotfix).terms.find((t) => t.id === "urgency");
  assert.ok(term.raw > 0);
});

test("blocking impact scales with the number of PRs blocked", () => {
  const signals = makeSignals();

  const none = score(signals, { blockedCount: 0 });
  const one = score(signals, { blockedCount: 1 });
  const three = score(signals, { blockedCount: 3 });

  assert.ok(one.score > none.score);
  assert.ok(three.score > one.score);
});

test("blocking saturates rather than growing without bound", () => {
  const signals = makeSignals();
  const three = score(signals, { blockedCount: 3 });
  const fifty = score(signals, { blockedCount: 50 });

  assert.equal(three.score, fifty.score, "blocking impact is capped");
});

// ---------------------------------------------------------------------------
// Risk vs priority — the distinction the engine exists for
// ---------------------------------------------------------------------------

test("an approved critical PR is not what you open next", () => {
  const criticalApproved = makeSignals({
    files: [
      makeFile({
        path: "src/auth/session.ts",
        category: "auth",
        categoryWeight: 1,
        additions: 200,
      }),
    ],
    productionLinesAdded: 200,
    testLinesAdded: 0,
    criticalPaths: ["auth"],
    reviewState: "approved",
    existingApprovals: 1,
  });

  // The risk engine already discounts an approved PR by -15 and suppresses
  // floors for it, so the score itself drops. Priority suppression is the
  // stronger, categorical statement: it does not belong in the deck at all.
  const risk = assessRisk(criticalApproved);
  assert.equal(
    priorityScore(criticalApproved, risk).suppressed,
    true,
    "an approved PR is not the thing to open next, whatever it scores",
  );
});

test("a medium-risk blocking PR can outrank a higher-risk idle one", () => {
  const idleHigher = makeSignals({
    number: 1,
    ageHours: 1,
    files: [
      makeFile({
        path: "src/api/routes.ts",
        category: "api",
        categoryWeight: 0.7,
        additions: 120,
      }),
    ],
    productionLinesAdded: 120,
    testLinesAdded: 60,
  });

  const blockingOlder = makeSignals({
    number: 2,
    ageHours: 72,
    isBlockingOthers: true,
    labels: ["incident"],
    files: [
      makeFile({
        path: "src/ui/button.tsx",
        category: "ui",
        categoryWeight: 0.3,
        additions: 30,
      }),
    ],
    productionLinesAdded: 30,
    testLinesAdded: 20,
  });

  const a = score(idleHigher);
  const b = score(blockingOlder, { blockedCount: 4 });

  assert.ok(
    b.score > a.score,
    `urgency + age + blocking should win: ${b.score} vs ${a.score}`,
  );
});

// ---------------------------------------------------------------------------
// Queue ordering
// ---------------------------------------------------------------------------

test("rankQueue is stable across shuffles of the same queue", () => {
  const build = (n, ageHours) => {
    const signals = makeSignals({ number: n, ageHours });
    return { number: n, priority: score(signals) };
  };

  const queue = [build(1, 5), build(2, 30), build(3, 60), build(4, 5)];

  const forward = rankQueue(queue).map((p) => p.number);
  const reversed = rankQueue([...queue].reverse()).map((p) => p.number);

  assert.deepEqual(forward, reversed, "input order must not affect output");
});

test("ties break on PR number, so the order is total", () => {
  const a = { number: 7, priority: score(makeSignals({ number: 7 })) };
  const b = { number: 3, priority: score(makeSignals({ number: 3 })) };

  assert.equal(a.priority.score, b.priority.score, "identical inputs tie");
  assert.deepEqual(
    rankQueue([a, b]).map((p) => p.number),
    [3, 7],
  );
});

test("demoted PRs sink below everything else", () => {
  const failingUrgent = {
    number: 1,
    priority: score(
      makeSignals({
        number: 1,
        ciStatus: "failing",
        ageHours: 500,
        labels: ["incident"],
      }),
    ),
  };
  const healthyDull = {
    number: 2,
    priority: score(makeSignals({ number: 2, ageHours: 1 })),
  };

  assert.ok(failingUrgent.priority.score > healthyDull.priority.score);
  assert.deepEqual(
    rankQueue([failingUrgent, healthyDull]).map((p) => p.number),
    [2, 1],
    "demotion outranks raw score",
  );
});

// ---------------------------------------------------------------------------
// Effort estimation
// ---------------------------------------------------------------------------

test("effort is an integer within [2,90]", () => {
  const cases = [
    makeSignals({ files: [] }),
    makeSignals(),
    makeSignals({
      files: Array.from({ length: 40 }, (_, i) =>
        makeFile({ path: `src/f${i}.ts`, additions: 300, deletions: 100 }),
      ),
      productionLinesAdded: 12_000,
    }),
  ];

  for (const signals of cases) {
    const { minutes } = estimateEffort(signals);
    assert.ok(Number.isInteger(minutes), `${minutes} is not an integer`);
    assert.ok(minutes >= 2 && minutes <= 90, `${minutes} out of range`);
  }
});

test("terms sum to the estimate when not clamped", () => {
  const signals = makeSignals();
  const estimate = estimateEffort(signals);

  if (!estimate.clamped) {
    const sum = estimate.terms.reduce((total, t) => total + t.minutes, 0);
    assert.ok(
      Math.abs(sum - estimate.minutes) <= 0.5,
      `terms sum to ${sum}, estimate is ${estimate.minutes}`,
    );
  }
});

test("a 4,000-line lockfile costs almost nothing to review", () => {
  const lockfile = makeSignals({
    files: [
      makeFile({
        path: "package-lock.json",
        category: "generated",
        categoryWeight: 0,
        isGenerated: true,
        additions: 4000,
        deletions: 800,
      }),
    ],
    additions: 4000,
    deletions: 800,
  });

  const { minutes } = estimateEffort(lockfile);
  assert.ok(minutes <= 5, `expected a trivial estimate, got ${minutes}`);
});

test("critical domains cost more than the same volume elsewhere", () => {
  const shape = (path, category, categoryWeight) =>
    makeSignals({
      files: [
        makeFile({
          path,
          category,
          categoryWeight,
          additions: 60,
          deletions: 20,
        }),
      ],
      productionLinesAdded: 60,
      testLinesAdded: 40,
    });

  const ui = estimateEffort(shape("src/ui/button.tsx", "ui", 0.3));
  const auth = estimateEffort(shape("src/auth/session.ts", "auth", 1));

  assert.ok(
    auth.minutes > ui.minutes,
    `auth ${auth.minutes} should exceed ui ${ui.minutes}`,
  );
});

test("distinct critical domains cost more than repeats of one", () => {
  const oneDomain = makeSignals({
    files: [
      makeFile({
        path: "src/auth/a.ts",
        category: "auth",
        categoryWeight: 1,
        additions: 30,
      }),
      makeFile({
        path: "src/auth/b.ts",
        category: "auth",
        categoryWeight: 1,
        additions: 30,
      }),
    ],
    productionLinesAdded: 60,
  });

  const twoDomains = makeSignals({
    files: [
      makeFile({
        path: "src/auth/a.ts",
        category: "auth",
        categoryWeight: 1,
        additions: 30,
      }),
      makeFile({
        path: "src/payments/b.ts",
        category: "payments",
        categoryWeight: 1,
        additions: 30,
      }),
    ],
    productionLinesAdded: 60,
  });

  assert.ok(
    estimateEffort(twoDomains).minutes > estimateEffort(oneDomain).minutes,
    "context switching between subsystems costs more",
  );
});

test("missing tests add cost; good tests reduce it", () => {
  // `hasNoTests` and `testRatio` are derived by the fixture, so set them
  // explicitly rather than relying on the derivation.
  const base = {
    files: [makeFile({ path: "src/thing.ts", additions: 200, deletions: 0 })],
    productionLinesAdded: 200,
  };

  const untested = estimateEffort(
    makeSignals({ ...base, hasNoTests: true, testRatio: 0 }),
  );
  const tested = estimateEffort(
    makeSignals({ ...base, hasNoTests: false, testRatio: 0.75 }),
  );

  assert.ok(
    untested.minutes > tested.minutes,
    `untested ${untested.minutes} should exceed tested ${tested.minutes}`,
  );
});

test("effort is deterministic", () => {
  const signals = makeSignals({
    files: [
      makeFile({
        path: "src/auth/x.ts",
        category: "auth",
        categoryWeight: 1,
        additions: 90,
      }),
    ],
    productionLinesAdded: 90,
  });

  const first = JSON.stringify(estimateEffort(signals));
  for (let i = 0; i < 20; i++) {
    assert.equal(JSON.stringify(estimateEffort(signals)), first);
  }
});

test("totalEffort sums a queue", () => {
  const estimates = [makeSignals(), makeSignals(), makeSignals()].map(
    estimateEffort,
  );
  const expected = estimates.reduce((t, e) => t + e.minutes, 0);
  assert.equal(totalEffort(estimates), expected);
});

test("formatDuration renders the capacity panel's strings", () => {
  assert.equal(formatDuration(0), "0 min");
  assert.equal(formatDuration(47), "47 min");
  assert.equal(formatDuration(60), "1h");
  assert.equal(formatDuration(95), "1h 35m");
  assert.equal(formatDuration(167), "2h 47m");
});
