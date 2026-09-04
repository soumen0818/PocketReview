/**
 * Unified-diff analysis.
 *
 * Extracts structural facts from patch text without parsing the underlying
 * language. Everything here is language-agnostic on purpose: the signals must
 * work on a TypeScript repo, a Go repo and a Python repo without per-language
 * support. That trades some precision for breadth, which is the right trade
 * for a triage system — we need a useful ranking across every repo, not a
 * perfect analysis of one.
 */

/** Lines added and removed in a patch, ignoring headers. */
export interface PatchLineCounts {
  added: number;
  removed: number;
}

/** Control-flow density change implied by a patch. */
export interface ComplexityDelta {
  /** Net change in control-flow keyword occurrences. */
  controlFlowDelta: number;
  /** Deepest indentation increase observed in added lines. */
  maxNestingAdded: number;
  /** Function/method definitions added. */
  functionsAdded: number;
  /** Function/method definitions removed. */
  functionsRemoved: number;
  /** True when the patch removes substantially more than it adds. */
  deletionHeavy: boolean;
}

/** Keywords that introduce a branch or loop, across common languages. */
const CONTROL_FLOW = [
  /\bif\b/g,
  /\belse\b/g,
  /\bfor\b/g,
  /\bwhile\b/g,
  /\bswitch\b/g,
  /\bcase\b/g,
  /\bcatch\b/g,
  /\bexcept\b/g,
  /\btry\b/g,
  /\?\?/g,
  /&&/g,
  /\|\|/g,
  /\?[^.:]/g,
];

/** Function/method definition forms across common languages. */
const FUNCTION_DEFS = [
  /\bfunction\s+\w+/g,
  /\bconst\s+\w+\s*=\s*(?:async\s*)?\(/g,
  /\bdef\s+\w+/g,
  /\bfunc\s+\w+/g,
  /\bfn\s+\w+/g,
  /\b(?:public|private|protected)\s+\w+\s+\w+\s*\(/g,
  /=>\s*\{/g,
];

/** Split a patch into added and removed content lines. */
export function splitPatch(patch: string): {
  added: string[];
  removed: string[];
} {
  const added: string[] = [];
  const removed: string[] = [];

  for (const line of patch.split("\n")) {
    // Skip file and hunk headers — "+++", "---", "@@".
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("@@")
    ) {
      continue;
    }
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }

  return { added, removed };
}

/** Count added and removed lines in a patch. */
export function countPatchLines(patch: string): PatchLineCounts {
  const { added, removed } = splitPatch(patch);
  return { added: added.length, removed: removed.length };
}

/** Count occurrences of every pattern across a set of lines. */
function countMatches(lines: string[], patterns: RegExp[]): number {
  const text = lines.join("\n");
  let total = 0;
  for (const pattern of patterns) {
    const matches = text.match(new RegExp(pattern.source, pattern.flags));
    if (matches) total += matches.length;
  }
  return total;
}

/** Leading whitespace width, treating a tab as four columns. */
function indentWidth(line: string): number {
  const match = line.match(/^[ \t]*/);
  if (!match) return 0;
  return match[0].replace(/\t/g, "    ").length;
}

/** Structural complexity change implied by a patch. */
export function analyseComplexity(patch: string): ComplexityDelta {
  const { added, removed } = splitPatch(patch);

  const controlAdded = countMatches(added, CONTROL_FLOW);
  const controlRemoved = countMatches(removed, CONTROL_FLOW);

  const functionsAdded = countMatches(added, FUNCTION_DEFS);
  const functionsRemoved = countMatches(removed, FUNCTION_DEFS);

  // Nesting proxy: deepest indentation among added non-blank lines, relative
  // to the shallowest. Crude, but language-agnostic and stable.
  const indents = added
    .filter((line) => line.trim().length > 0)
    .map(indentWidth);
  const maxNestingAdded =
    indents.length > 0 ? Math.max(...indents) - Math.min(...indents) : 0;

  return {
    controlFlowDelta: controlAdded - controlRemoved,
    maxNestingAdded: Math.max(0, Math.floor(maxNestingAdded / 2)),
    functionsAdded,
    functionsRemoved,
    // Removed logic is under-reviewed and often riskier than added logic:
    // deletions are easy to skim and hard to reason about the absence of.
    deletionHeavy: removed.length > added.length * 2 && removed.length > 20,
  };
}

/**
 * Count dependency entries added and removed in a manifest patch.
 *
 * Matches `"name": "version"` (JSON manifests) and `name = "version"`
 * (TOML manifests) inside added/removed lines.
 */
export function countDependencyChanges(patch: string): {
  added: number;
  removed: number;
} {
  const { added, removed } = splitPatch(patch);

  const entry = /^\s*["']?[\w@/.-]+["']?\s*[:=]\s*["'][^"']+["']/;
  const isDependencyLine = (line: string) =>
    entry.test(line) &&
    !/^\s*["']?(name|version|description)["']?\s*[:=]/.test(line);

  return {
    added: added.filter(isDependencyLine).length,
    removed: removed.filter(isDependencyLine).length,
  };
}

/**
 * Detect a net removal of test code.
 *
 * Only meaningful when production code changed in the same PR — removing
 * tests alongside removing the feature they covered is normal.
 */
export function detectTestRemoval(
  testLinesAdded: number,
  testLinesDeleted: number,
  productionLinesAdded: number,
): boolean {
  return testLinesDeleted > testLinesAdded && productionLinesAdded > 0;
}

/**
 * Rank file patches by review consequence.
 *
 * Used before truncating a diff for the LLM. Naive truncation sends the first
 * N characters, which in practice means the lockfile — alphabetically first
 * and semantically worthless.
 *
 * Criticality dominates and size only breaks ties *within* a tier. Multiplying
 * the two would let a 200-line UI file (0.3 x 200) outrank a 15-line auth
 * change (1.0 x 15), which is the same failure as ranking by size alone: the
 * model would read the button component and never see the auth change.
 */
export function rankPatchesByConsequence<
  T extends {
    path: string;
    categoryWeight: number;
    additions: number;
    deletions: number;
  },
>(files: T[]): T[] {
  // Bucket weights into coarse tiers so that near-equal criticality (0.70 vs
  // 0.75) is settled by size rather than by an arbitrary rule ordering.
  const tier = (weight: number) => Math.round(weight * 4) / 4;

  return [...files].sort((a, b) => {
    const tierDelta = tier(b.categoryWeight) - tier(a.categoryWeight);
    if (tierDelta !== 0) return tierDelta;
    return b.additions + b.deletions - (a.additions + a.deletions);
  });
}

/**
 * Redaction patterns for values that must never reach an external service.
 *
 * Ordered most-specific first: a vendor-shaped token is labelled precisely,
 * and the generic assignment rules at the end catch what the specific ones
 * miss. Overlapping coverage is deliberate — a secret caught twice is fine, a
 * secret caught zero times is not.
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // --- vendor-shaped tokens ---
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, label: "GITHUB_TOKEN" },
  // Fine-grained PATs: `github_pat_` then base62 and underscores. This is the
  // format GitHub now issues by default, so omitting it left the most likely
  // token in a modern repo unredacted.
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, label: "GITHUB_TOKEN" },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, label: "ANTHROPIC_KEY" },
  // Stripe and similar use `sk_live_` / `rk_test_` with an underscore, which
  // the `sk-` rule below does not match.
  { pattern: /\b[a-z]{2}_(?:live|test)_[A-Za-z0-9]{16,}/g, label: "API_KEY" },
  { pattern: /\bsk-[A-Za-z0-9]{32,}/g, label: "API_KEY" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, label: "SLACK_TOKEN" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: "AWS_KEY" },
  { pattern: /\bASIA[0-9A-Z]{16}\b/g, label: "AWS_KEY" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: "GOOGLE_KEY" },
  // JWTs: three base64url segments. Frequently a live session or service token.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    label: "JWT",
  },
  // Credentials embedded in a connection string — `scheme://user:secret@host`.
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s:@/]{3,}@/gi,
    label: "URL_CREDENTIAL",
  },
  {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    label: "PRIVATE_KEY",
  },
  // --- generic assignments, quoted ---
  {
    pattern:
      /\b(?:password|passwd|secret|api[_-]?key|token|auth|credential|private[_-]?key|access[_-]?key)\s*[:=]\s*["'][^"']{6,}["']/gi,
    label: "CREDENTIAL",
  },
  // --- generic assignments, unquoted ---
  // `.env` files and Dockerfiles rarely quote values, so the rule above missed
  // the single most common way a secret appears in a diff. Requires a
  // non-trivial value and stops at whitespace to avoid eating whole lines.
  {
    pattern:
      /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|API[_-]?KEY|TOKEN|CREDENTIAL|ACCESS[_-]?KEY)[A-Z0-9_]*)\s*=\s*(?!["'\s])(\S{6,})/g,
    label: "CREDENTIAL",
  },
];

/**
 * Patterns whose replacement keeps a leading capture group.
 *
 * A URL credential should redact the password while leaving the scheme and
 * user visible — `postgres://user:[REDACTED]@host` is far more useful to a
 * reviewer than an opaque blank, and just as safe. Same for a named env
 * assignment: the variable name is the informative half.
 */
const KEEPS_PREFIX = new Set(["URL_CREDENTIAL", "CREDENTIAL"]);

/**
 * Redact credentials from diff text before it leaves the process.
 *
 * Best-effort, not a guarantee — but it removes every format we have seen in
 * practice, and the LLM layer is optional anyway. Covered by a test that
 * exercises each vendor format directly, so a regression is visible.
 */
export function redactSecrets(text: string): string {
  let result = text;

  for (const { pattern, label } of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, prefix?: string) => {
      // Keep the informative prefix (variable name, or scheme://user) where one
      // was captured, and redact only the value after it.
      if (KEEPS_PREFIX.has(label) && typeof prefix === "string") {
        // A URL credential match ends at the `@` that separates it from the
        // host, so that `@` has to be put back or the URL is mangled.
        if (match.endsWith("@")) return `${prefix}:[REDACTED:${label}]@`;

        const separator = match.slice(prefix.length).match(/^\s*[:=]\s*/)?.[0];
        return `${prefix}${separator ?? "="}[REDACTED:${label}]`;
      }
      return `[REDACTED:${label}]`;
    });
  }

  return result;
}
