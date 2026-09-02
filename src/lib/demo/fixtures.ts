/**
 * Demo fixtures.
 *
 * Hand-built signal sets covering the scenarios that matter for verification
 * and for the demo: a tiny critical change, a huge worthless diff, a genuine
 * emergency, and ordinary work in between.
 *
 * These run through the *real* risk engine — nothing here carries a
 * pre-computed score. Turning on `DEMO_MODE` swaps the data source, not the
 * scoring, so what you see offline is what the engine actually produces.
 */

import {
  emptyAvailability,
  type PRSignals,
  type FileSignal,
  type SignalAvailability,
} from "../signals/types";

function file(overrides: Partial<FileSignal> & { path: string }): FileSignal {
  return {
    additions: 0,
    deletions: 0,
    status: "modified",
    category: "other",
    categoryWeight: 0.4,
    isTest: false,
    isGenerated: false,
    churn: 0,
    owners: [],
    ...overrides,
  };
}

function availability(
  overrides: Partial<SignalAvailability> = {},
): SignalAvailability {
  return {
    ...emptyAvailability(),
    metadata: true,
    patches: true,
    history: true,
    ci: true,
    reviews: true,
    codeowners: true,
    authorHistory: true,
    ...overrides,
  };
}

/** Fill the derived fields so fixtures stay readable. */
function build(
  base: {
    number: number;
    title: string;
    body: string;
    author: string;
    ageHours: number;
    files: FileSignal[];
  },
  overrides: Partial<PRSignals> = {},
): PRSignals {
  const { files } = base;

  const production = files.filter((f) => !f.isTest && !f.isGenerated);
  const tests = files.filter((f) => f.isTest);

  const productionLinesAdded = production.reduce((n, f) => n + f.additions, 0);
  const productionLinesDeleted = production.reduce((n, f) => n + f.deletions, 0);
  const testLinesAdded = tests.reduce((n, f) => n + f.additions, 0);
  const testLinesDeleted = tests.reduce((n, f) => n + f.deletions, 0);

  const createdAt = new Date(
    Date.now() - base.ageHours * 3_600_000,
  ).toISOString();

  return {
    repo: "acme/payments-api",
    number: base.number,
    title: base.title,
    body: base.body,
    author: base.author,
    url: `https://github.com/acme/payments-api/pull/${base.number}`,
    headSha: `sha${base.number}`,
    baseBranch: "main",
    headBranch: `feature/${base.number}`,
    createdAt,
    updatedAt: createdAt,

    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    changedFiles: files.length,
    files,
    largestFileChange: Math.max(
      0,
      ...files.map((f) => f.additions + f.deletions),
    ),
    diffEntropy: production.length > 2 ? 0.75 : 0.1,
    distinctCategories: new Set(production.map((f) => f.category)).size,

    touchesAuth: files.some((f) => f.category === "auth"),
    touchesPayments: files.some((f) => f.category === "payments"),
    touchesDatabase: files.some((f) => f.category === "database"),
    touchesInfra: files.some((f) => f.category === "infra"),
    touchesPublicAPI: files.some((f) => f.category === "api"),
    touchesConfig: files.some((f) => f.category === "config"),
    criticalPaths: files
      .filter((f) => f.categoryWeight >= 0.7 && !f.isGenerated)
      .map((f) => f.path),

    testFilesChanged: tests.length,
    testLinesAdded,
    testLinesDeleted,
    productionLinesAdded,
    productionLinesDeleted,
    testRatio:
      productionLinesAdded > 0 ? testLinesAdded / productionLinesAdded : 0,
    hasNoTests: productionLinesAdded > 0 && testLinesAdded === 0,
    testsRemoved: false,

    dependencyFilesChanged: [],
    dependenciesAdded: 0,
    dependenciesRemoved: 0,
    lockfileOnly: false,

    fileChurn: Object.fromEntries(files.map((f) => [f.path, f.churn])),
    fileRevertRate: {},
    hotspotScore: 0,
    priorIncidentFiles: [],

    ciStatus: "passing",
    failingChecks: [],
    reviewState: "none",
    existingApprovals: 0,
    commentCount: 0,
    reviewRounds: 0,

    authorPriorPRs: 30,
    authorRevertRate: 0,
    authorIsFirstTimeContributor: false,
    authorIsBot: false,

    aiAuthorshipHints: {
      botAuthor: false,
      coAuthoredByTrailer: false,
      branchNamePattern: false,
      commitCadence: false,
      templatedBody: false,
    },
    likelyAIAuthored: false,

    ageHours: base.ageHours,
    isBlockingOthers: false,
    linkedIssueLabels: [],
    labels: [],
    isDraft: false,
    isHotfix: false,

    availability: availability(),
    ...overrides,
  };
}

/**
 * The demo queue.
 *
 * Ordered here as GitHub would return them — by recency, not by risk — so the
 * reordering the engine performs is visible.
 */
export const DEMO_SIGNALS: PRSignals[] = [
  // The centrepiece: two lines, catastrophic.
  build(
    {
      number: 147,
      title: "Simplify admin permission check",
      body: "Small cleanup in the permissions helper.",
      author: "dev-agent",
      ageHours: 4,
      files: [
        file({
          path: "src/auth/permissions.ts",
          category: "auth",
          categoryWeight: 1.0,
          additions: 1,
          deletions: 1,
          churn: 9,
          patch: `@@ -12,7 +12,7 @@
 function canDeleteAccount(user) {
-  if (user.isAdmin()) {
+  if (true) {
     return true;
   }`,
        }),
      ],
    },
    {
      likelyAIAuthored: true,
      aiAuthorshipHints: {
        botAuthor: true,
        coAuthoredByTrailer: true,
        branchNamePattern: true,
        commitCadence: false,
        templatedBody: false,
      },
      headBranch: "claude/simplify-permissions",
    },
  ),

  // The classic false positive: enormous, worthless.
  build(
    {
      number: 152,
      title: "Regenerate lockfile after dependency audit",
      body: "Routine lockfile refresh.",
      author: "renovate",
      ageHours: 9,
      files: [
        file({
          path: "package-lock.json",
          category: "generated",
          categoryWeight: 0,
          isGenerated: true,
          additions: 3841,
          deletions: 1205,
        }),
      ],
    },
    {
      lockfileOnly: true,
      dependencyFilesChanged: ["package-lock.json"],
      authorIsBot: true,
    },
  ),

  // A real emergency: large, critical, untested, failing CI.
  build(
    {
      number: 149,
      title: "Rewrite payment retry and settlement flow",
      body: "Replaces the retry queue with an idempotent settlement worker.",
      author: "priya",
      ageHours: 31,
      files: [
        file({
          path: "src/payments/settlement.ts",
          category: "payments",
          categoryWeight: 1.0,
          additions: 214,
          deletions: 168,
          churn: 21,
          patch: `@@ -1,20 +1,60 @@
+  if (attempt > max) {
+    for (const item of batch) {
+      while (pending(item)) {
+        try { settle(item); } catch (e) { requeue(e); }
+      }
+    }
+  }`,
        }),
        file({
          path: "src/payments/retry-queue.ts",
          category: "payments",
          categoryWeight: 1.0,
          additions: 96,
          deletions: 140,
          churn: 17,
        }),
        file({
          path: "src/database/migrations/0042_settlement.sql",
          category: "database",
          categoryWeight: 0.85,
          additions: 44,
          deletions: 0,
          churn: 2,
        }),
        file({
          path: "src/api/routes/webhooks.ts",
          category: "api",
          categoryWeight: 0.7,
          additions: 38,
          deletions: 12,
          churn: 8,
        }),
      ],
    },
    {
      ciStatus: "failing",
      failingChecks: ["integration-tests", "e2e"],
      fileRevertRate: { "src/payments/settlement.ts": 0.16 },
      priorIncidentFiles: ["src/payments/settlement.ts"],
      hotspotScore: 0.82,
      linkedIssueLabels: ["incident"],
      labels: ["incident", "payments"],
      dependenciesAdded: 2,
      dependencyFilesChanged: ["package.json"],
    },
  ),

  // Ordinary well-tested work.
  build({
    number: 154,
    title: "Add pagination to the transactions list",
    body: "Cursor-based pagination with tests.",
    author: "rahul",
    ageHours: 6,
    files: [
      file({
        path: "src/api/routes/transactions.ts",
        category: "api",
        categoryWeight: 0.7,
        additions: 62,
        deletions: 8,
        churn: 5,
      }),
      file({
        path: "src/api/routes/transactions.test.ts",
        category: "test",
        categoryWeight: 0.1,
        isTest: true,
        additions: 88,
        deletions: 0,
      }),
    ],
  }),

  // Genuinely trivial.
  build({
    number: 155,
    title: "Fix typo in onboarding docs",
    body: "",
    author: "meera",
    ageHours: 2,
    files: [
      file({
        path: "docs/onboarding.md",
        category: "docs",
        categoryWeight: 0.05,
        additions: 3,
        deletions: 3,
      }),
    ],
  }),

  // Config change, moderate.
  build({
    number: 151,
    title: "Raise rate limit for the reporting endpoint",
    body: "Reporting clients were hitting the ceiling during month-end.",
    author: "rahul",
    ageHours: 20,
    files: [
      file({
        path: "config/rate-limits.yml",
        category: "config",
        categoryWeight: 0.55,
        additions: 4,
        deletions: 2,
        churn: 3,
      }),
    ],
  }),

  // Untested UI work, no history available — exercises low confidence.
  build(
    {
      number: 156,
      title: "Redesign the settlement status badge",
      body: "Visual refresh of the status indicator.",
      author: "newcomer",
      ageHours: 1,
      files: [
        file({
          path: "src/components/StatusBadge.tsx",
          category: "ui",
          categoryWeight: 0.3,
          additions: 140,
          deletions: 60,
        }),
        file({
          path: "src/styles/badges.css",
          category: "ui",
          categoryWeight: 0.3,
          additions: 55,
          deletions: 20,
        }),
      ],
    },
    {
      authorIsFirstTimeContributor: true,
      authorPriorPRs: 0,
      // A brand-new repository: no history, no CI, no CODEOWNERS. Exercises
      // the low-confidence path so the UI warning is visible in the demo
      // rather than only in theory.
      availability: availability({
        history: false,
        ci: false,
        authorHistory: false,
        codeowners: false,
        reviews: false,
      }),
    },
  ),
];
