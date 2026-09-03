# Risk Scoring — Deep Dive

PocketReview assigns every open PR a **risk score from 0 to 100**. This document explains exactly how that score is computed, why the design choices were made, and how to reason about the output you see in the UI.

---

## Table of Contents

- [Why Deterministic Scoring?](#why-deterministic-scoring)
- [The Core Scoring Formula](#the-core-scoring-formula)
- [The 7 Dimensions](#the-7-dimensions)
  - [1. Blast Radius (0.20)](#1-blast-radius-020)
  - [2. Domain Criticality (0.20)](#2-domain-criticality-020)
  - [3. Test Posture (0.15)](#3-test-posture-015)
  - [4. Historical Instability (0.15)](#4-historical-instability-015)
  - [5. Change Complexity (0.12)](#5-change-complexity-012)
  - [6. Dependencies (0.10)](#6-dependencies-010)
  - [7. Author Provenance (0.08)](#7-author-provenance-008)
- [The Modifier System](#the-modifier-system)
- [The Floor System](#the-floor-system)
- [Signal Availability and Confidence](#signal-availability-and-confidence)
- [The Baseline Comparison Model](#the-baseline-comparison-model)
- [The Policy Gate](#the-policy-gate)
- [Math Functions Reference](#math-functions-reference)
- [Demo Cases](#demo-cases)
- [How to Read the Dimension Breakdown UI](#how-to-read-the-dimension-breakdown-ui)

---

## Why Deterministic Scoring?

AI-assisted coding dramatically accelerates PR throughput. That acceleration breaks down if the review tooling itself behaves as a black box — reviewers stop trusting scores they cannot explain, and "just merge it" becomes the default path.

PocketReview is built on three principles:

1. **Explainability over accuracy.** A score a reviewer can interrogate and disagree with is more valuable than a slightly more accurate score they cannot understand.
2. **Determinism over stochasticity.** Given identical signals, the score must be identical — across machines, time zones, and team members. This allows calibration: when the model is wrong, it is *systematically* wrong, and you can fix the weights.
3. **LLM as narrator, not judge.** Claude (if enabled) narrates a score that has already been computed from arithmetic. It cannot influence the outcome. This keeps the audit trail clean.

---

## The Core Scoring Formula

```
weightedAverage = sum(dimension.score * dimension.weight)   # weights sum to 1.00

withModifiers    = weightedAverage + sum(applicable modifiers)  # capped at +/-30 total
withModifiers    = clamp(withModifiers, 0, 100)

finalScore       = max(withModifiers, applicable floors)
```

In plain terms:

1. Score each of the 7 dimensions independently on a 0–100 scale.
2. Compute a weighted average (weights sum to exactly 1.00).
3. Apply additive modifiers (e.g., CI failing adds points; already-approved subtracts). The total modifier adjustment is capped at ±30 to prevent any single contextual signal from dominating.
4. Apply floors: if a categorical fact (e.g., "critical path with no tests") mandates a minimum score, raise the result to that floor. Floors only ever raise scores — they never lower them.

---

## The 7 Dimensions

Dimension weights are fixed in `src/lib/engines/risk-engine.ts`. Each dimension is a pure function in `src/lib/engines/dimensions/`.

### 1. Blast Radius (0.20)

**What it measures:** The spread and scale of a change — how many files, how many lines, how many independent subsystems are touched, and how evenly the diff is distributed.

**Why it matters:** Large, widely-spread changes are statistically more likely to introduce unexpected interactions. A 10-file change spanning 6 subsystems is riskier than a 100-line change in one file.

**Signals used:**

| Signal | Contribution |
|--------|-------------|
| `files.length` | Raw file count, saturated on a log curve |
| `linesAdded + linesRemoved` | Total diff size, saturated |
| Subsystem spread | Number of distinct top-level directories touched |
| `diffEntropy` | Shannon entropy of the line-change distribution across files |

**Edge cases:**

- **Lockfiles and generated files are excluded.** `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, and any file classified as `generated` are stripped from the file list before computing blast radius. A 4,000-line lockfile bump does not inflate this score.
- **Single-file changes are scored leniently.** A 200-line change in one file saturates slowly — the subsystem spread and entropy components are near zero.
- **Deletion-heavy diffs.** Removed lines count toward total size, but they also raise the `change-complexity` dimension separately.

---

### 2. Domain Criticality (0.20)

**What it measures:** Whether the files touched belong to high-stakes categories (auth, payments, database, infrastructure) — **independent of how many lines changed**.

**Why it matters:** A 1-line change to a JWT signing key is categorically more dangerous than a 1,000-line change to a marketing copy file. Size is irrelevant here.

**Key design insight:** This dimension is **intentionally size-independent.** The weighted average of file-category weights is computed over the *set* of files, not their line counts. Adding more lines to an auth file does not increase this dimension's score.

**Signals used:**

| Signal | Contribution |
|--------|-------------|
| File categories (from path rules) | Weighted average of per-file category weights |
| CODEOWNERS coverage | Unclaimed critical-path files raise the score |
| Category weight table | See [Default Path Rules Catalogue](./configuration.md#default-path-rules-catalogue) |

**Scoring logic (simplified):**

```
domainScore = mean(categoryWeight(f) for f in nonGeneratedFiles) * 100
```

If a PR touches 3 files — one `auth` (weight 1.0), one `ui` (weight 0.3), one `docs` (weight 0.05) — the domain score is approximately `(1.0 + 0.3 + 0.05) / 3 * 100 = 45`.

---

### 3. Test Posture (0.15)

**What it measures:** The adequacy of test coverage relative to the scope of the change. It combines a coverage ratio with a hard penalty for test removal.

**Signals used:**

| Signal | Contribution |
|--------|-------------|
| Test file count / total file count | Coverage ratio |
| Net test line delta | Removed tests force maximum score |
| Test files modified alongside source files | Positive signal (co-modification) |

**Scoring logic:**

```
If testLinesRemoved > 0 AND testLinesAdded <= testLinesRemoved:
  score = 100   # Forces the floor (see Floor System below)
Else:
  coverageRatio = testFilesModified / max(sourceFilesModified, 1)
  score = saturate(100 - (coverageRatio * 100))
```

**Edge cases:**

- **Tests added independently of source changes** (e.g., a PR that only adds tests) receive a near-zero score on this dimension — correctly, since they improve posture.
- **A PR that only removes tests** will score 100 here and trigger the `tests-removed` floor of 35, regardless of other dimensions.
- **Test-only files** (category `test`, weight 0.1) are identified by path classification, not file extension, to handle repos with non-standard test layouts.

---

### 4. Historical Instability (0.15)

**What it measures:** How historically troublesome the files in this PR have been — measured by commit churn rate, revert frequency, and association with prior incidents.

**Why it matters:** Files that have been edited frequently, reverted, or implicated in incidents are disproportionately likely to cause future problems. History is a strong predictor.

**Signals used:**

| Signal | Contribution |
|--------|-------------|
| Commit frequency | Churn per file over `historyWindowDays` |
| Revert rate | Proportion of commits that are reverts |
| Incident file set | Whether a file appears in the configured incident list |
| Author's revert history | See `author-provenance` dimension |

**Decay function:** Older commits are weighted less. The decay formula is:

```
weight(commit) = exp(-lambda * daysAgo)   where lambda = ln(2) / halfLifeDays
```

With `historyWindowDays: 90`, commits from 45 days ago have half the weight of commits from today. This prevents a messy sprint from 6 months ago from permanently tainting a file's score.

**Edge cases:**

- **New files** (no Git history) score 0 on this dimension with `confidence: 0`. Missing history is not penalised.
- **Reverts of reverts** are counted as neutral commits to avoid double-penalising.

---

### 5. Change Complexity (0.12)

**What it measures:** The structural complexity of the diff itself — independent of size. A small but deeply nested control-flow change is more complex than a large block of added documentation.

**Signals used:**

| Signal | Contribution |
|--------|-------------|
| Control-flow delta | Net change in `if`, `for`, `while`, `switch`, `catch` lines |
| Nesting depth increase | Maximum nesting depth added |
| Deletion-heavy ratio | Lines removed / total lines changed |
| Mixed add/delete ratio | High churn within small diff (rewrite pattern) |

**Why deletion-heavy diffs are flagged:** Deleting code is higher risk than adding it. A reviewer can see what was added; they must infer what removing code breaks.

**Edge cases:**

- **Purely additive diffs** (only additions, no deletions) score lower on this dimension.
- **Comment-only changes** or whitespace diffs are recognised and score near zero.
- **Minified or generated code** is excluded via the `generated` category, preventing entropy spikes from machine-generated output.

---

### 6. Dependencies (0.10)

**What it measures:** Changes to the dependency graph — new packages added, major version bumps, and supply-chain risk indicators.

**Signals used:**

| Signal | Contribution |
|--------|-------------|
| New packages in `package.json` | Each new dependency adds to the score |
| Major version bump (`^1.x` to `^2.x`) | Higher risk than minor/patch bumps |
| Lockfile changed | Binary signal; lockfile diffs are not scored for size (see blast-radius) |
| Known supply-chain indicators | Package names matching known patterns (e.g., `post-install` scripts) |

**Scoring logic (simplified):**

```
score = (newPackages * 15) + (majorBumps * 10) + (lockfileChanged ? 5 : 0)
score = saturate(score)
```

**Edge cases:**

- **Lockfile-only PRs** (no `package.json` change) receive a low score on this dimension, but may trigger the `blockOnDependencyChange` policy gate.
- **Removing a dependency** scores lower than adding one — fewer unknown unknowns.

---

### 7. Author Provenance (0.08)

**What it measures:** Contextual risk signals about the author of the PR: first-time contributors, authors with a revert history, and hints that the code was AI-generated.

**Why it matters (carefully):** This is the lowest-weighted dimension for a reason. Contribution history is a weak signal, and it must never become a proxy for bias. It functions as a mild tiebreaker, not a judgement on the person.

**Signals used (`AIAuthorshipHints`):**

| Signal | Contribution |
|--------|-------------|
| First-time contributor to this repo | Moderate increase |
| Author has prior reverts in this repo | Small increase |
| AI authorship hints in commit message | Small increase (e.g., "co-authored by", "generated by copilot") |
| Author is a known bot account | Moderate increase |

**Edge cases:**

- **Bot accounts** (e.g., `dependabot`, `renovate`) that exclusively change lockfiles or generated files are commonly offset by the `generated-only` modifier (−25), resulting in a very low final score.
- **First-time contributors** who are already collaborators (e.g., GitHub Collaborator status) may be excluded depending on signal availability.
- **Missing author history** scores 0 with `confidence: 0`. No author data is never punished.

---

## The Modifier System

Modifiers are **additive adjustments** applied to the weighted-average score before floors. They represent contextual facts about the PR state that are not captured by the dimension signals.

The **total modifier adjustment is capped at ±30** — no combination of modifiers can move the score by more than 30 points. This prevents a perfect storm of modifiers from overriding meaningful dimension signals.

### Positive Modifiers (raise risk)

| Modifier | Adjustment | Trigger Condition |
|----------|-----------|-------------------|
| `hotfix-branch` | +10 | Branch name matches `hotfix/`, `hotfix-`, `fix/urgent`, etc. |
| `ci-failing` | +8 | GitHub Checks API reports any required check as failed |
| `urgent-label` | +6 | PR has a label matching `urgent`, `critical`, `p0`, `incident` |

### Negative Modifiers (lower risk)

| Modifier | Adjustment | Trigger Condition |
|----------|-----------|-------------------|
| `already-approved` | −15 | PR has at least one approving review from a codeowner |
| `draft` | −20 | PR is marked as Draft |
| `generated-only` | −25 | All changed files are classified as `generated` (weight 0.0) |
| `docs-only` | −30 | All changed files are classified as `docs` (weight 0.05) |

**Cap example:**

If a PR triggers `hotfix-branch` (+10), `ci-failing` (+8), and `urgent-label` (+6), the raw adjustment is +24, which is within the ±30 cap. If a hypothetical combination would reach +35, it is clamped to +30.

---

## The Floor System

Floors are **minimum score guarantees** for categorical facts. After the weighted average and modifiers are applied, if the result falls below an applicable floor, it is raised to the floor value.

**Why floors, not just higher weights?**

Consider a PR that deletes all tests for a critical-path file. The `test-posture` dimension would score near 100, but it has a weight of only 0.15. If all other dimensions are low (e.g., it is a tiny PR touching one file), the weighted average might still land at 35 — below the `high` threshold. A floor of 55 ensures this categorical risk is surfaced regardless of how benign the PR looks on every other axis.

A floor is a statement: *"This categorical fact is serious enough that no combination of low dimension scores should hide it."*

### Floor Table

| Floor Name | Minimum Score | Trigger Condition |
|------------|--------------|-------------------|
| `critical-path-untested` | 55 | PR touches a critical-path file AND has a net-negative test delta |
| `critical-path` | 40 | PR touches any file classified as `auth`, `payments`, or `database` |
| `tests-removed` | 35 | PR has a net-negative change in test lines |

**Floor interaction with modifiers:**

Floors are applied **after** modifiers. However, negative modifiers cannot push a score below an applicable floor.

```
# Example:
weightedAverage     = 20
modifiers           = -20   (draft PR)
withModifiers       = 0
floor               = 40    (critical-path)
finalScore          = 40    <- floor wins
```

A draft PR touching auth code still surfaces as a 40 (MEDIUM), not a 0. The draft modifier communicates "not ready for merge", which is correct — but it cannot hide the categorical risk.

---

## Signal Availability and Confidence

Not all signals are always available. The GitHub API may be unavailable, a repo may have no CODEOWNERS file, or history may be shallow. PocketReview is designed to **degrade gracefully** rather than fail.

Each `DimensionResult` includes a `confidence` field:

| Confidence | Meaning |
|-----------|---------|
| `1.0` | All signals for this dimension were available and used |
| `0.5` | Partial signal — some data was missing; score is a best estimate |
| `0.0` | No signal data available; score is 0 (not penalised) |

The UI surfaces confidence in the `DimensionBreakdown` component. A dimension shown with a low-confidence indicator means "this score is uncertain — we didn't have enough data to be sure."

**The invariant:** A missing signal can reduce confidence but never inflates a score. If we don't know, we don't penalise.

---

## The Baseline Comparison Model

In addition to the absolute score, PocketReview computes a **baseline score** via `baselineScore()` in `src/lib/engines/risk-engine.ts`. The baseline represents the expected score for a typical PR in this repository, computed from the queue-level signals (`collectQueueSignals()`).

The baseline enables relative comparisons:

- A score of 60 in a repo where the average PR scores 55 is unremarkable.
- A score of 60 in a repo where the average PR scores 20 is a significant outlier.

The delta `score - baseline` is displayed in the UI as a contextual indicator (e.g., "+18 above your team average").

---

## The Policy Gate

The policy gate is evaluated **after** the final score is computed. It applies additional rules defined in `.pocketreview.yml` (or their defaults) to determine whether a PR is eligible for fast-track review.

```
fastTrackEligible = true

if finalScore > policy.fastTrackMaxRisk:           fastTrackEligible = false
if any file.category in policy.neverFastTrack:     fastTrackEligible = false
if policy.requireCiPassing AND ciIsFailing:        fastTrackEligible = false
if policy.blockOnDependencyChange AND depsChanged: fastTrackEligible = false
if policy.blockOnTestRemoval AND testsRemoved:     fastTrackEligible = false
```

The policy gate is a **UI advisory** — it surfaces a confirmation dialog when you swipe right on a non-fast-trackable PR. PocketReview never interacts with GitHub's merge or approval API.

---

## Math Functions Reference

Pure helpers live in `src/lib/math.ts`.

### `saturate(value: number, min = 0, max = 100): number`

Clamps a value to the range `[min, max]`. Every dimension score passes through `saturate()` before being returned to ensure no dimension can produce an out-of-range result.

```typescript
saturate(120)   // -> 100
saturate(-5)    // -> 0
saturate(42)    // -> 42
```

### `normalisedEntropy(distribution: number[]): number`

Computes the **Shannon entropy** of a distribution, normalised to `[0, 1]`. Used in the `blast-radius` dimension to measure how evenly line changes are spread across files.

```
H(p) = -sum(p_i * log2(p_i))
normalisedEntropy = H(p) / log2(n)   where n = distribution.length
```

A value of `1.0` means changes are perfectly evenly distributed across all files. A value near `0` means one file contains almost all the changes.

```typescript
// 5 files, all equal -> maximum entropy -> 1.0
normalisedEntropy([20, 20, 20, 20, 20])  // -> 1.0

// 5 files, one dominates -> low entropy -> ~0.29
normalisedEntropy([95, 1, 1, 2, 1])      // -> ~0.29
```

### `decay(daysAgo: number, halfLifeDays: number): number`

Exponential decay weight for time-series signals. Used in `historical-instability` to down-weight older commits.

```
decay(daysAgo, halfLifeDays) = exp(-ln(2) / halfLifeDays * daysAgo)
```

```typescript
decay(0, 45)    // -> 1.00  (today)
decay(45, 45)   // -> 0.50  (45 days ago, at half-life)
decay(90, 45)   // -> 0.25  (90 days ago, at quarter weight)
```

---

## Demo Cases

These two contrived examples illustrate that **size and risk are orthogonal**.

### Case 1 — 1-Line Auth Change -> HIGH Risk

**PR:** Modifies a single line in `src/auth/session.ts` to change the JWT expiry from `7d` to `30d`.

| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| Blast Radius | 2 | 1 file, 1 line — near-zero spread and entropy |
| Domain Criticality | 95 | `auth` category, weight 1.0 |
| Test Posture | 40 | No test file modified alongside the source change |
| Historical Instability | 30 | `session.ts` has moderate churn history |
| Change Complexity | 5 | Single line change, no control-flow delta |
| Dependencies | 0 | No lockfile or package.json changes |
| Author Provenance | 0 | Known team member, no revert history |

```
weightedAverage = (2*0.20) + (95*0.20) + (40*0.15) + (30*0.15) + (5*0.12) + (0*0.10) + (0*0.08)
                = 0.4 + 19.0 + 6.0 + 4.5 + 0.6 + 0 + 0
                = 30.5

modifiers       = 0   (no applicable modifiers)
withModifiers   = 30.5

floor           = 40  (critical-path — auth file touched)
finalScore      = 40  -> MEDIUM/HIGH boundary
```

**Conclusion:** A tiny change to auth code is correctly surfaced at 40 (MEDIUM, trending HIGH). The floor ensures the categorical risk is not hidden by the low blast-radius and low complexity scores. If thresholds are the default (`high: 75`), this is MEDIUM — correctly prompting a human review without screaming "critical".

---

### Case 2 — 4,000-Line Lockfile Bump -> LOW Risk

**PR:** `dependabot` bumps `lodash` from `4.17.20` to `4.17.21` via a PR that only modifies `package.json` (1 line) and `package-lock.json` (4,000 lines).

| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| Blast Radius | 3 | Lockfile excluded from size scoring; `package.json` is 1 line |
| Domain Criticality | 5 | `config` category (package.json), weight 0.55; lockfile is `generated` (0.0) |
| Test Posture | 0 | No source or test files changed |
| Historical Instability | 0 | No history signal for lockfile paths |
| Change Complexity | 2 | Minimal control-flow in package.json format |
| Dependencies | 20 | Patch-level bump; lockfile changed (low risk) |
| Author Provenance | 15 | Bot account (dependabot) |

```
weightedAverage = (3*0.20) + (5*0.20) + (0*0.15) + (0*0.15) + (2*0.12) + (20*0.10) + (15*0.08)
                = 0.6 + 1.0 + 0 + 0 + 0.24 + 2.0 + 1.2
                = 5.04

modifiers       = -25  (generated-only: lockfile is generated)
withModifiers   = max(5.04 - 25, 0) = 0

floors          = none (no auth/payments/database files, no test removal)
finalScore      = 0 -> LOW
```

**Conclusion:** Despite the enormous diff size, the PR correctly scores near zero. The lockfile is excluded from blast-radius, the `generated-only` modifier applies, and no floors are triggered. This is safe to fast-track.

---

## How to Read the Dimension Breakdown UI

The `DimensionBreakdown` component (rendered in `src/components/risk/DimensionBreakdown.tsx`) provides a full audit view of a PR's score.

```
+-------------------------------------------------------+
|  Risk Score: 62  *  HIGH                              |
|  Baseline: +18 above your team average                |
+----------------------+----------+--------------------+
| Dimension            | Score    | Weight             |
+----------------------+----------+--------------------+
| Blast Radius         |  45  ### | 0.20               |
| Domain Criticality   |  95  ####| 0.20  <- highest   |
| Test Posture         |  60  ### | 0.15               |
| Historical Instab.   |  30  ##  | 0.15               |
| Change Complexity    |  40  ##  | 0.12               |
| Dependencies         |   0      | 0.10               |
| Author Provenance    |  10  #   | 0.08               |
+----------------------+----------+--------------------+
| Modifiers            | +8 (CI failing)               |
| Floors               | 40 (critical-path) -> n/a     |
|                      |   (final score exceeds floor) |
+----------------------+-------------------------------+
| Reasons                                              |
|  * auth/session.ts matches 'auth' category           |
|  * 3 test files missing for modified source          |
|  * CI check 'build' is failing                       |
+------------------------------------------------------+
```

**Reading the breakdown:**

- **Score bar:** Visual proportion of each dimension's contribution. Longer bar = higher raw score on that dimension.
- **Weight:** How much this dimension contributes to the final weighted average. Domain Criticality and Blast Radius (both 0.20) have the most leverage.
- **Modifiers section:** Lists each modifier that applied, with its adjustment value. The cap is noted if reached.
- **Floors section:** Lists any applicable floor. If the floor was superseded by a higher score, it is shown but noted as not applied.
- **Reasons:** Human-readable strings from each dimension's `reasons` array — the same strings used to populate the Claude prompt for narration. These are the "receipts" for the score.

> [!TIP]
> If you disagree with a score, start with the dimension that has the highest contribution. Check its `reasons` to understand what signal drove it. If the signal is wrong (e.g., a false positive on a path rule), fix the path rule in `.pocketreview.yml` rather than adjusting weights globally.
