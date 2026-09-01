/**
 * Path classification rules.
 *
 * Maps a file path to a category and a criticality weight. This table is the
 * single source of truth for "where does this change land?" — it is what lets
 * the risk engine treat a one-line change to `src/auth/session.ts` as more
 * consequential than a 400-line change to a lockfile.
 *
 * Rules are ordered: the first matching rule wins. `generated` and `test`
 * are checked before domain rules so that `src/auth/session.test.ts` is
 * classified as a test, not as auth code.
 *
 * Repositories override these in `.pocketreview.yml`.
 */

import type { FileCategory } from "./types";

export interface PathRule {
  category: FileCategory;
  /** Criticality weight, 0..1. Feeds the domain-criticality dimension. */
  weight: number;
  patterns: RegExp[];
}

/**
 * Default rules, ordered by precedence.
 *
 * Weights encode "how much does a mistake here cost?", not "how complex is
 * this code?". Auth and payments sit at 1.0 because a defect there is a
 * security or financial incident; docs sit near zero because a defect there
 * is a typo.
 */
export const DEFAULT_PATH_RULES: PathRule[] = [
  // --- checked first: these override domain classification ---
  {
    category: "generated",
    weight: 0,
    patterns: [
      /(^|\/)package-lock\.json$/,
      /(^|\/)yarn\.lock$/,
      /(^|\/)pnpm-lock\.yaml$/,
      /(^|\/)bun\.lockb$/,
      /(^|\/)Cargo\.lock$/,
      /(^|\/)poetry\.lock$/,
      /(^|\/)Gemfile\.lock$/,
      /(^|\/)composer\.lock$/,
      /(^|\/)go\.sum$/,
      /\.snap$/,
      /\.min\.(js|css)$/,
      /\.(pb|generated)\.(go|ts|js|py)$/,
      /(^|\/)(dist|build|out|vendor|node_modules)\//,
      /(^|\/)__generated__\//,
      /\.lock$/,
    ],
  },
  {
    category: "test",
    weight: 0.1,
    patterns: [
      /\.(test|spec)\.[jt]sx?$/,
      /_test\.(go|py|rb)$/,
      /(^|\/)test_[^/]+\.py$/,
      /(^|\/)__tests__\//,
      /(^|\/)tests?\//,
      /(^|\/)spec\//,
      /(^|\/)e2e\//,
      /(^|\/)fixtures?\//,
      /(^|\/)mocks?\//,
    ],
  },
  {
    category: "docs",
    weight: 0.05,
    patterns: [
      /\.mdx?$/,
      /(^|\/)docs?\//,
      /(^|\/)LICENSE$/,
      /(^|\/)CHANGELOG/i,
      /(^|\/)CONTRIBUTING/i,
    ],
  },

  // --- domain rules, highest criticality first ---
  {
    category: "auth",
    weight: 1.0,
    patterns: [
      /(^|\/)auth/i,
      /(^|\/)session/i,
      /(^|\/)login/i,
      /(^|\/)logout/i,
      /(^|\/)oauth/i,
      /(^|\/)jwt/i,
      /(^|\/)token/i,
      /(^|\/)password/i,
      /(^|\/)credential/i,
      /(^|\/)permission/i,
      /(^|\/)rbac/i,
      /(^|\/)acl/i,
      /(^|\/)identity/i,
      /(^|\/)security/i,
      /(^|\/)crypto/i,
    ],
  },
  {
    category: "payments",
    weight: 1.0,
    patterns: [
      /(^|\/)payment/i,
      /(^|\/)billing/i,
      /(^|\/)checkout/i,
      /(^|\/)invoice/i,
      /(^|\/)subscription/i,
      /(^|\/)stripe/i,
      /(^|\/)paypal/i,
      /(^|\/)refund/i,
      /(^|\/)transaction/i,
      /(^|\/)ledger/i,
      /(^|\/)pricing/i,
    ],
  },
  {
    category: "database",
    weight: 0.85,
    patterns: [
      /(^|\/)migrations?\//i,
      /(^|\/)schema/i,
      /\.sql$/,
      /(^|\/)prisma\//i,
      /(^|\/)models?\//i,
      /(^|\/)entities\//i,
      /(^|\/)repositories\//i,
      /\.prisma$/,
    ],
  },
  {
    category: "infra",
    weight: 0.75,
    patterns: [
      /(^|\/)Dockerfile/,
      /(^|\/)docker-compose/,
      /(^|\/)\.github\/workflows\//,
      /(^|\/)\.gitlab-ci/,
      /(^|\/)terraform\//i,
      /\.tf$/,
      /(^|\/)k8s\//i,
      /(^|\/)kubernetes\//i,
      /(^|\/)helm\//i,
      /(^|\/)deploy/i,
      /(^|\/)infra/i,
      /(^|\/)ansible\//i,
      /(^|\/)Makefile$/,
    ],
  },
  {
    category: "api",
    weight: 0.7,
    patterns: [
      /(^|\/)routes?\//i,
      /(^|\/)controllers?\//i,
      /(^|\/)handlers?\//i,
      /(^|\/)api\//i,
      /(^|\/)endpoints?\//i,
      /(^|\/)graphql\//i,
      /(^|\/)resolvers?\//i,
      /(^|\/)middleware/i,
      /route\.[jt]s$/,
    ],
  },
  {
    category: "config",
    weight: 0.55,
    patterns: [
      /(^|\/)config/i,
      /(^|\/)settings/i,
      /(^|\/)\.env/,
      /(^|\/)package\.json$/,
      /(^|\/)tsconfig.*\.json$/,
      /(^|\/)next\.config\./,
      /\.ya?ml$/,
      /\.toml$/,
      /\.ini$/,
    ],
  },
  {
    category: "ui",
    weight: 0.3,
    patterns: [
      /(^|\/)components?\//i,
      /(^|\/)views?\//i,
      /(^|\/)pages?\//i,
      /(^|\/)styles?\//i,
      /\.(css|scss|sass|less)$/,
      /\.(svg|png|jpe?g|gif|webp|ico)$/,
      /(^|\/)assets?\//i,
      /(^|\/)public\//,
    ],
  },
];

/** Fallback for paths matching no rule. */
export const DEFAULT_CATEGORY: FileCategory = "other";
export const DEFAULT_WEIGHT = 0.4;

/** Files whose changes indicate dependency churn. */
export const DEPENDENCY_MANIFESTS = [
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
];

/** Lockfiles — dependency changes with no authored content. */
export const LOCKFILES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
];

/** Categories treated as critical for the policy gate and risk scoring. */
export const CRITICAL_CATEGORIES: FileCategory[] = [
  "auth",
  "payments",
  "database",
];

/** Human-readable label for a category, used in explanation text. */
export const CATEGORY_LABELS: Record<FileCategory, string> = {
  auth: "authentication",
  payments: "payments",
  database: "database",
  infra: "infrastructure",
  api: "public API",
  config: "configuration",
  test: "tests",
  docs: "documentation",
  ui: "user interface",
  generated: "generated files",
  other: "application code",
};
