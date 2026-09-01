/**
 * File classification.
 *
 * Turns a raw path into a category and criticality weight using the path
 * rules. Pure functions only — no I/O, fully unit-testable.
 */

import {
  DEFAULT_PATH_RULES,
  DEFAULT_CATEGORY,
  DEFAULT_WEIGHT,
  DEPENDENCY_MANIFESTS,
  LOCKFILES,
  CRITICAL_CATEGORIES,
  type PathRule,
} from "./path-rules";
import type { FileCategory } from "./types";

/** Classify a path against an ordered rule table. First match wins. */
export function classifyPath(
  path: string,
  rules: PathRule[] = DEFAULT_PATH_RULES,
): { category: FileCategory; weight: number } {
  const normalised = path.replace(/\\/g, "/");

  for (const rule of rules) {
    if (rule.patterns.some((pattern) => pattern.test(normalised))) {
      return { category: rule.category, weight: rule.weight };
    }
  }

  return { category: DEFAULT_CATEGORY, weight: DEFAULT_WEIGHT };
}

/** Criticality weight for a category, from the active rule table. */
export function categoryWeight(
  category: FileCategory,
  rules: PathRule[] = DEFAULT_PATH_RULES,
): number {
  const rule = rules.find((r) => r.category === category);
  return rule ? rule.weight : DEFAULT_WEIGHT;
}

/** True for lockfiles, snapshots and build output. */
export function isGeneratedPath(
  path: string,
  rules: PathRule[] = DEFAULT_PATH_RULES,
): boolean {
  return classifyPath(path, rules).category === "generated";
}

/** True for test, spec and fixture files. */
export function isTestPath(
  path: string,
  rules: PathRule[] = DEFAULT_PATH_RULES,
): boolean {
  return classifyPath(path, rules).category === "test";
}

/** True for a dependency manifest (package.json, Cargo.toml, ...). */
export function isDependencyManifest(path: string): boolean {
  const base = basename(path);
  return DEPENDENCY_MANIFESTS.includes(base);
}

/** True for a dependency lockfile. */
export function isLockfile(path: string): boolean {
  return LOCKFILES.includes(basename(path));
}

/** True for auth, payments or database — the never-fast-track set. */
export function isCriticalCategory(category: FileCategory): boolean {
  return CRITICAL_CATEGORIES.includes(category);
}

/** Final path segment, handling both separators. */
export function basename(path: string): string {
  const normalised = path.replace(/\\/g, "/");
  const index = normalised.lastIndexOf("/");
  return index === -1 ? normalised : normalised.slice(index + 1);
}

/** Directory portion of a path, "" for a root-level file. */
export function dirname(path: string): string {
  const normalised = path.replace(/\\/g, "/");
  const index = normalised.lastIndexOf("/");
  return index === -1 ? "" : normalised.slice(0, index);
}

/** File extension without the dot, "" when there is none. */
export function extension(path: string): string {
  const base = basename(path);
  const index = base.lastIndexOf(".");
  return index <= 0 ? "" : base.slice(index + 1);
}

/**
 * Match a path against a CODEOWNERS pattern.
 *
 * Supports the subset of gitignore syntax CODEOWNERS actually uses:
 * leading `/` anchors to root, trailing `/` matches a directory, `*` matches
 * within a segment, `**` matches across segments.
 */
export function matchesOwnerPattern(path: string, pattern: string): boolean {
  const normalisedPath = path.replace(/\\/g, "/");
  let p = pattern.trim();
  if (p === "" || p.startsWith("#")) return false;

  // "*" alone owns everything.
  if (p === "*") return true;

  const anchored = p.startsWith("/");
  if (anchored) p = p.slice(1);

  const directoryOnly = p.endsWith("/");
  if (directoryOnly) p = p.slice(0, -1);

  const regexSource = p
    .split("/")
    .map((segment) =>
      segment === "**"
        ? "__GLOBSTAR__"
        : segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
    )
    .join("/")
    .replace(/__GLOBSTAR__\//g, "(?:.*/)?")
    .replace(/__GLOBSTAR__/g, ".*");

  // An unanchored pattern may match at any depth; a directory pattern
  // matches everything beneath it.
  const prefix = anchored ? "^" : "^(?:.*/)?";
  const suffix = directoryOnly ? "(?:/.*)?$" : "(?:/.*)?$";

  try {
    return new RegExp(prefix + regexSource + suffix).test(normalisedPath);
  } catch {
    return false;
  }
}

/**
 * Parse a CODEOWNERS file into ordered rules.
 *
 * CODEOWNERS uses last-match-wins, so callers should scan in reverse.
 */
export function parseCodeowners(
  content: string,
): Array<{ pattern: string; owners: string[] }> {
  const rules: Array<{ pattern: string; owners: string[] }> = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const parts = line.split(/\s+/);
    const pattern = parts[0];
    const owners = parts
      .slice(1)
      .filter((o) => o.startsWith("@") || o.includes("@"))
      .map((o) => o.replace(/^@/, ""));

    if (pattern && owners.length > 0) rules.push({ pattern, owners });
  }

  return rules;
}

/** Owners for a path — last matching CODEOWNERS rule wins. */
export function ownersForPath(
  path: string,
  rules: Array<{ pattern: string; owners: string[] }>,
): string[] {
  for (let i = rules.length - 1; i >= 0; i--) {
    if (matchesOwnerPattern(path, rules[i].pattern)) return rules[i].owners;
  }
  return [];
}
