/**
 * Policy gate — Phase 8.
 *
 * The headline test is the last one in the first block: **critical paths can
 * never be fast-tracked at any score, under any configuration.** That is the
 * claim the product's safety argument rests on, and it is checked against a
 * config actively trying to disable it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateFastTrack,
  resolveNeverFastTrack,
  describeVerdict,
  ALWAYS_BLOCKED,
} from "../src/lib/policy/gate.ts";
import { assessRisk } from "../src/lib/engines/risk-engine.ts";
import { makeSignals, makeFile } from "./helpers/signals.mjs";

/** A PR that should sail through: trivial, tested, green CI. */
function benign(overrides = {}) {
  return makeSignals({
    files: [
      makeFile({
        path: "src/ui/button.tsx",
        category: "ui",
        categoryWeight: 0.3,
        additions: 4,
        deletions: 1,
      }),
    ],
    productionLinesAdded: 4,
    testLinesAdded: 8,
    testRatio: 2,
    hasNoTests: false,
    ciStatus: "passing",
    ...overrides,
  });
}

function gate(signals, options) {
  return evaluateFastTrack(signals, assessRisk(signals), options);
}

// ---------------------------------------------------------------------------
// The critical-path guarantee
// ---------------------------------------------------------------------------

test("a trivial, tested, green-CI PR is eligible", () => {
  const verdict = gate(benign());

  assert.equal(verdict.eligible, true, JSON.stringify(verdict.vetoes));
  assert.deepEqual(verdict.vetoes, []);
  assert.equal(verdict.structurallyBlocked, false);
});

test("auth, payments and database are always blocked", () => {
  for (const category of ALWAYS_BLOCKED) {
    const signals = benign({
      files: [
        makeFile({
          path: `src/${category}/thing.ts`,
          category,
          categoryWeight: 1,
          additions: 1,
          deletions: 0,
        }),
      ],
      criticalPaths: [`src/${category}/thing.ts`],
      productionLinesAdded: 1,
      testLinesAdded: 4,
    });

    const verdict = gate(signals);
    assert.equal(verdict.eligible, false, `${category} must be blocked`);
    assert.ok(verdict.vetoes.some((v) => v.reason === "critical-path"));
    assert.equal(verdict.structurallyBlocked, true);
  }
});

test("a ONE-LINE auth change cannot be fast-tracked, however it scores", () => {
  // The canonical case. Tiny, well tested, green CI — everything a
  // size-based gate would wave through.
  const signals = benign({
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
    testLinesAdded: 10,
    testRatio: 10,
    hasNoTests: false,
  });

  const verdict = gate(signals);
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.structurallyBlocked, true);
});

test("CONFIG CANNOT DISABLE THE CRITICAL-PATH RULE", () => {
  // A configuration actively trying to switch off every protection.
  const permissive = {
    fastTrackMaxRisk: 100,
    neverFastTrack: [], // emptied on purpose
    requireCiPassing: false,
    blockOnDependencyChange: false,
    blockOnTestRemoval: false,
  };

  const signals = benign({
    files: [
      makeFile({
        path: "src/payments/charge.ts",
        category: "payments",
        categoryWeight: 1,
        additions: 2,
      }),
    ],
    criticalPaths: ["src/payments/charge.ts"],
    productionLinesAdded: 2,
    testLinesAdded: 10,
  });

  const verdict = gate(signals, { policy: permissive });

  assert.equal(
    verdict.eligible,
    false,
    "no configuration may make a payments change fast-trackable",
  );
  assert.equal(verdict.structurallyBlocked, true);
});

test("config may EXTEND the blocked set but never shrink it", () => {
  const blocked = resolveNeverFastTrack({ neverFastTrack: ["infra"] });

  for (const category of ALWAYS_BLOCKED) {
    assert.ok(blocked.has(category), `${category} must survive`);
  }
  assert.ok(blocked.has("infra"), "and the extension is honoured");

  // Emptying the list changes nothing.
  const emptied = resolveNeverFastTrack({ neverFastTrack: [] });
  for (const category of ALWAYS_BLOCKED) {
    assert.ok(emptied.has(category));
  }
});

test("a generated file in a critical directory does not trigger the veto", () => {
  // A lockfile under src/payments/ is still a lockfile.
  const signals = benign({
    files: [
      makeFile({
        path: "src/payments/package-lock.json",
        category: "generated",
        categoryWeight: 0,
        isGenerated: true,
        additions: 500,
      }),
    ],
  });

  const verdict = gate(signals);
  assert.ok(!verdict.vetoes.some((v) => v.reason === "critical-path"));
});

// ---------------------------------------------------------------------------
// The other rules
// ---------------------------------------------------------------------------

test("risk above the ceiling is vetoed", () => {
  const signals = benign({
    files: [
      makeFile({
        path: "src/api/routes.ts",
        category: "api",
        categoryWeight: 0.7,
        additions: 400,
        deletions: 200,
      }),
    ],
    productionLinesAdded: 400,
    testLinesAdded: 0,
    hasNoTests: true,
    testRatio: 0,
  });

  const verdict = gate(signals);
  const veto = verdict.vetoes.find((v) => v.reason === "risk-too-high");
  assert.ok(veto, JSON.stringify(verdict.vetoes));
  assert.match(veto.detail, /ceiling is 25/);
});

test("CI must be green — failing and pending are both refused", () => {
  for (const status of ["failing", "pending", "none"]) {
    const verdict = gate(benign({ ciStatus: status }));
    assert.ok(
      verdict.vetoes.some((v) => v.reason === "ci-not-passing"),
      `${status} must not fast-track`,
    );
  }
});

test("dependency changes are vetoed", () => {
  const verdict = gate(benign({ dependenciesAdded: 1 }));
  assert.ok(verdict.vetoes.some((v) => v.reason === "dependencies-changed"));
});

test("test removal is vetoed", () => {
  const verdict = gate(
    benign({ testsRemoved: true, testLinesDeleted: 40, testLinesAdded: 0 }),
  );
  assert.ok(verdict.vetoes.some((v) => v.reason === "tests-removed"));
});

test("repo-specific protected paths are vetoed", () => {
  const verdict = gate(benign(), {
    protectedPaths: [/^src\/ui\//],
  });

  const veto = verdict.vetoes.find((v) => v.reason === "protected-file");
  assert.ok(veto);
  assert.match(veto.detail, /button\.tsx/);
});

test("optional rules can be relaxed by config; the hard rule cannot", () => {
  const relaxed = {
    fastTrackMaxRisk: 100,
    neverFastTrack: [],
    requireCiPassing: false,
    blockOnDependencyChange: false,
    blockOnTestRemoval: false,
  };

  // Everything that IS configurable turns off cleanly.
  const noisy = benign({
    ciStatus: "failing",
    dependenciesAdded: 3,
    testsRemoved: true,
    testLinesDeleted: 20,
  });
  assert.equal(gate(noisy, { policy: relaxed }).eligible, true);

  // The hard rule survives the same config.
  const critical = benign({
    files: [
      makeFile({
        path: "src/auth/x.ts",
        category: "auth",
        categoryWeight: 1,
        additions: 1,
      }),
    ],
    criticalPaths: ["src/auth/x.ts"],
    ciStatus: "failing",
  });
  assert.equal(gate(critical, { policy: relaxed }).eligible, false);
});

// ---------------------------------------------------------------------------
// Shape and reporting
// ---------------------------------------------------------------------------

test("every veto that applies is reported, not just the first", () => {
  const verdict = gate(
    benign({
      files: [
        makeFile({
          path: "src/auth/x.ts",
          category: "auth",
          categoryWeight: 1,
          additions: 300,
          deletions: 100,
        }),
      ],
      productionLinesAdded: 300,
      testLinesAdded: 0,
      hasNoTests: true,
      testRatio: 0,
      ciStatus: "failing",
      dependenciesAdded: 2,
      testsRemoved: true,
      testLinesDeleted: 50,
    }),
  );

  const reasons = verdict.vetoes.map((v) => v.reason);
  assert.ok(reasons.includes("critical-path"));
  assert.ok(reasons.includes("risk-too-high"));
  assert.ok(reasons.includes("ci-not-passing"));
  assert.ok(reasons.includes("dependencies-changed"));
  assert.ok(reasons.includes("tests-removed"));
  assert.ok(verdict.vetoes.length >= 5, "a reviewer deserves every reason");
});

test("the gate can only remove eligibility, never grant it", () => {
  // Property check: across a spread of inputs, a verdict is eligible only when
  // it carries no vetoes. There is no path that clears an existing veto.
  const cases = [
    benign(),
    benign({ ciStatus: "failing" }),
    benign({ dependenciesAdded: 1 }),
    benign({ testsRemoved: true, testLinesDeleted: 10 }),
    benign({
      files: [
        makeFile({
          path: "src/auth/a.ts",
          category: "auth",
          categoryWeight: 1,
        }),
      ],
      criticalPaths: ["src/auth/a.ts"],
    }),
  ];

  for (const signals of cases) {
    const verdict = gate(signals);
    assert.equal(
      verdict.eligible,
      verdict.vetoes.length === 0,
      "eligibility must be exactly the absence of vetoes",
    );
  }
});

test("the gate is deterministic", () => {
  const signals = benign({ ciStatus: "failing", dependenciesAdded: 2 });
  const first = JSON.stringify(gate(signals));
  for (let i = 0; i < 20; i++) {
    assert.equal(JSON.stringify(gate(signals)), first);
  }
});

test("describeVerdict summarises for a toast", () => {
  assert.equal(
    describeVerdict({ eligible: true, vetoes: [], structurallyBlocked: false }),
    "Eligible for fast-track",
  );

  const many = gate(benign({ ciStatus: "failing", dependenciesAdded: 1 }));
  assert.match(describeVerdict(many), /\+\d+ more/);
});
