/**
 * Test fixtures for PRSignals.
 *
 * `makeSignals` returns a neutral, fully-populated signal set; tests override
 * only the fields they care about. Keeping the baseline neutral means a test
 * asserting "auth changes score high" is genuinely testing criticality rather
 * than accidentally testing some other field left at an extreme value.
 */

/** A file signal with sensible defaults. */
export function makeFile(overrides = {}) {
  return {
    path: "src/thing.ts",
    additions: 10,
    deletions: 2,
    status: "modified",
    category: "other",
    categoryWeight: 0.4,
    isTest: false,
    isGenerated: false,
    churn: 0,
    owners: [],
    patch: undefined,
    ...overrides,
  };
}

/** Every signal group available — the "full information" case. */
export function fullAvailability(overrides = {}) {
  return {
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

/**
 * A neutral PR: small, uncritical, tested, stable, from an established author.
 * Should score low. Tests move one thing at a time from here.
 */
export function makeSignals(overrides = {}) {
  const files = overrides.files ?? [makeFile()];

  const productionFiles = files.filter((f) => !f.isTest && !f.isGenerated);
  const testFiles = files.filter((f) => f.isTest);

  const productionLinesAdded = productionFiles.reduce(
    (n, f) => n + f.additions,
    0,
  );
  const productionLinesDeleted = productionFiles.reduce(
    (n, f) => n + f.deletions,
    0,
  );
  const testLinesAdded = testFiles.reduce((n, f) => n + f.additions, 0);
  const testLinesDeleted = testFiles.reduce((n, f) => n + f.deletions, 0);

  const base = {
    repo: "acme/api",
    number: 100,
    title: "Update thing",
    body: "Routine change.",
    author: "alice",
    url: "https://github.com/acme/api/pull/100",
    headSha: "abc1234",
    baseBranch: "main",
    headBranch: "feature/thing",
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    updatedAt: new Date().toISOString(),

    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    changedFiles: files.length,
    files,
    largestFileChange: Math.max(
      0,
      ...files.map((f) => f.additions + f.deletions),
    ),
    diffEntropy: 0.2,
    distinctCategories: new Set(
      productionFiles.map((f) => f.category),
    ).size,

    touchesAuth: files.some((f) => f.category === "auth"),
    touchesPayments: files.some((f) => f.category === "payments"),
    touchesDatabase: files.some((f) => f.category === "database"),
    touchesInfra: files.some((f) => f.category === "infra"),
    touchesPublicAPI: files.some((f) => f.category === "api"),
    touchesConfig: files.some((f) => f.category === "config"),
    criticalPaths: files
      .filter((f) => f.categoryWeight >= 0.7 && !f.isGenerated)
      .map((f) => f.path),

    testFilesChanged: testFiles.length,
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

    fileChurn: {},
    fileRevertRate: {},
    hotspotScore: 0,
    priorIncidentFiles: [],

    ciStatus: "passing",
    failingChecks: [],
    reviewState: "none",
    existingApprovals: 0,
    commentCount: 0,
    reviewRounds: 0,

    authorPriorPRs: 25,
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

    ageHours: 1,
    isBlockingOthers: false,
    linkedIssueLabels: [],
    labels: [],
    isDraft: false,
    isHotfix: false,

    availability: fullAvailability(),
  };

  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Named scenarios used across tests and the demo
// ---------------------------------------------------------------------------

/**
 * The demo centrepiece: a three-line change to an auth file.
 *
 * Any size-based scorer ranks this trivial. It must score high.
 */
export function oneLineAuthChange() {
  return makeSignals({
    title: "Simplify admin check",
    files: [
      makeFile({
        path: "src/auth/permissions.ts",
        category: "auth",
        categoryWeight: 1.0,
        additions: 1,
        deletions: 1,
        patch: `@@ -12,7 +12,7 @@
 function canDelete(user) {
-  if (user.isAdmin()) {
+  if (true) {
     return true;
   }`,
      }),
    ],
    diffEntropy: 0,
  });
}

/**
 * The classic false positive: a regenerated lockfile, thousands of lines.
 *
 * Must score low.
 */
export function lockfileOnlyChange() {
  return makeSignals({
    title: "Regenerate lockfile",
    files: [
      makeFile({
        path: "package-lock.json",
        category: "generated",
        categoryWeight: 0,
        isGenerated: true,
        additions: 3800,
        deletions: 1200,
      }),
    ],
    dependencyFilesChanged: ["package-lock.json"],
    lockfileOnly: true,
    diffEntropy: 0,
  });
}

/** A documentation-only PR. Must score low. */
export function docsOnlyChange() {
  return makeSignals({
    title: "Fix typos in README",
    files: [
      makeFile({
        path: "README.md",
        category: "docs",
        categoryWeight: 0.05,
        additions: 6,
        deletions: 4,
      }),
    ],
    diffEntropy: 0,
  });
}

/** A large, critical, untested, unstable change. Must score critical. */
export function dangerousChange() {
  const files = [
    makeFile({
      path: "src/auth/token.ts",
      category: "auth",
      categoryWeight: 1.0,
      additions: 180,
      deletions: 140,
      churn: 22,
      patch: `@@ -1,10 +1,40 @@
+  if (a) {
+    if (b) {
+      for (const x of y) {
+        while (z) {
+          try { run(); } catch (e) { handle(e); }
+        }
+      }
+    }
+  }`,
    }),
    makeFile({
      path: "src/payments/charge.ts",
      category: "payments",
      categoryWeight: 1.0,
      additions: 90,
      deletions: 60,
      churn: 18,
    }),
    makeFile({
      path: "src/api/routes.ts",
      category: "api",
      categoryWeight: 0.7,
      additions: 70,
      deletions: 30,
      churn: 9,
    }),
    makeFile({
      path: "src/database/schema.sql",
      category: "database",
      categoryWeight: 0.85,
      additions: 40,
      deletions: 10,
      churn: 6,
    }),
    makeFile({
      path: "infra/deploy.yaml",
      category: "infra",
      categoryWeight: 0.75,
      additions: 25,
      deletions: 15,
      churn: 4,
    }),
  ];

  return makeSignals({
    title: "Rewrite authentication and payment flow",
    files,
    diffEntropy: 0.9,
    fileChurn: {
      "src/auth/token.ts": 22,
      "src/payments/charge.ts": 18,
      "src/api/routes.ts": 9,
      "src/database/schema.sql": 6,
      "infra/deploy.yaml": 4,
    },
    fileRevertRate: { "src/auth/token.ts": 0.18 },
    priorIncidentFiles: ["src/auth/token.ts", "src/payments/charge.ts"],
    hotspotScore: 0.8,
    ciStatus: "failing",
    failingChecks: ["unit-tests"],
    authorIsFirstTimeContributor: true,
    authorPriorPRs: 0,
    likelyAIAuthored: true,
    aiAuthorshipHints: {
      botAuthor: true,
      coAuthoredByTrailer: true,
      branchNamePattern: true,
      commitCadence: false,
      templatedBody: false,
    },
    dependenciesAdded: 3,
    dependencyFilesChanged: ["package.json"],
  });
}
