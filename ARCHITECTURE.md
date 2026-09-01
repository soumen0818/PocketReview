# PocketReview — Architecture

**Intelligent PR triage for AI-accelerated engineering teams.**

> PocketReview does not review your code. It decides where your reviewers' limited attention should go.

---

## Table of contents

1. [The problem](#1-the-problem)
2. [The thesis](#2-the-thesis)
3. [What PocketReview is — and is not](#3-what-pocketreview-is--and-is-not)
4. [System architecture](#4-system-architecture)
5. [The Signal Layer](#5-the-signal-layer)
6. [The Risk Engine](#6-the-risk-engine)
7. [The Priority Engine](#7-the-priority-engine)
8. [The Reviewer Engine](#8-the-reviewer-engine)
9. [The Review Plan Solver](#9-the-review-plan-solver)
10. [The Explanation Layer (LLM)](#10-the-explanation-layer-llm)
11. [The Policy Gate](#11-the-policy-gate)
12. [Data model](#12-data-model)
13. [API surface](#13-api-surface)
14. [Frontend architecture](#14-frontend-architecture)
15. [Repository layout](#15-repository-layout)
16. [Validation strategy](#16-validation-strategy)
17. [Performance, caching, resilience](#17-performance-caching-resilience)
18. [Security & privacy](#18-security--privacy)
19. [Build phases](#19-build-phases)
20. [Demo script](#20-demo-script)
21. [Judge Q&A defence](#21-judge-qa-defence)
22. [Deliberate non-goals](#22-deliberate-non-goals)

---

## 1. The problem

Code review is the only stage of the software lifecycle that AI has made *worse*.

Every other stage got faster. Writing code, generating tests, scaffolding services, drafting docs — all accelerated. But review still runs at exactly the speed of one human being reading one diff, and that speed has not moved.

The result is a queueing failure:

```
BEFORE AI                          AFTER AI

 2 PRs/day/dev                      8-10 PRs/day/dev
      │                                   │
      ▼                                   ▼
 ┌──────────┐                       ┌──────────┐
 │ reviewer │  4 PRs/day            │ reviewer │  4 PRs/day
 └──────────┘                       └──────────┘
      │                                   │
      ▼                                   ▼
   balanced                        ██████████████  unbounded backlog
```

In queueing terms: when arrival rate λ exceeds service rate μ, the queue length grows without bound. It does not stabilise. It does not "catch up on Friday." It grows until something is dropped — and what gets dropped is *review quality*, silently, because a reviewer facing 15 PRs starts skimming.

Three forces make this worse than a simple volume problem:

**The trust tax.** Reviewers cannot skim AI-authored code the way they skim a trusted colleague's. Every AI PR absorbs full scrutiny, so effective throughput μ *falls* at the same time λ rises. The gap widens from both sides.

**Existing tools optimise the wrong variable.** Automated review bots add more generated commentary to each PR. That may improve the quality of a review once a human sits down — but it increases the reading load per PR. They optimise review *quality*; the bottleneck is review *throughput*.

**The attention/location mismatch.** A senior reviewer's genuinely free moments — commute, between meetings, queuing for coffee — happen away from a laptop. Every review tool assumes a desk, a large screen, and an uninterrupted block. The available minutes and the usable minutes never overlap.

---

## 2. The thesis

> **Reviewer attention is the scarcest resource in modern software engineering. PocketReview treats it as a resource to be allocated, not a queue to be drained.**

Everything in this architecture follows from that one sentence.

We do not attempt to answer *"is this code correct?"* — that is an unsolved problem, and any system claiming to answer it is lying. We answer a strictly easier, strictly more useful question:

> **"Given 17 open PRs and 30 minutes of a senior engineer's time, which PRs should they open, in what order, and what should they look at first?"**

That question is answerable, measurable, and defensible.

---

## 3. What PocketReview is — and is not

| | |
|---|---|
| ❌ **Not** an AI code reviewer | We produce no line-level review comments. |
| ❌ **Not** an auto-approval bot | No LLM output ever merges code. |
| ❌ **Not** GitHub-on-a-phone | We deliberately show *less* than GitHub, not the same in a smaller window. |
| ✅ **Is** a triage and attention-allocation system | Rank, explain, estimate, assign, schedule. |
| ✅ **Is** deterministic at its core | Scores come from arithmetic over measured signals — never from an LLM. |
| ✅ **Is** explainable end-to-end | Every point of every score traces back to a named signal. |

### The single most important design decision

```
        ┌──────────────────────────────────────┐
        │  THE SCORE IS COMPUTED IN CODE.      │
        │  THE LLM ONLY NARRATES IT.           │
        └──────────────────────────────────────┘

  signals ──▶ deterministic arithmetic ──▶ 87/100
                                             │
                                             ├──▶ contribution breakdown (code)
                                             └──▶ LLM writes prose *about* it
```

If an LLM produced the number, the question *"why 87?"* has no answer. Because arithmetic produces it, the answer is a table of contributions that adds to 87 and is identical on every run.

This is the difference between a demo and an engineering system, and it is the axis on which this project should be judged.

---

## 4. System architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          SOURCES OF TRUTH                           │
│   GitHub REST · GitHub GraphQL · git history · CI checks · CODEOWNERS│
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         ① SIGNAL LAYER                              │
│   Normalises everything into a flat, typed PRSignals object.        │
│   No scoring, no opinions — measurement only.                       │
│                                                                     │
│   diff stats · file paths · path classification · test delta        │
│   dependency delta · churn/blame history · revert history           │
│   CI status · author stats · PR age · linked issues · review state  │
└────────────────────────────────┬────────────────────────────────────┘
                                 │  PRSignals
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
   ┌──────────────────┐ ┌────────────────┐ ┌──────────────────┐
   │  ② RISK ENGINE   │ │ ③ REVIEWER     │ │ ④ EFFORT         │
   │                  │ │    ENGINE      │ │    ESTIMATOR     │
   │  7 weighted      │ │                │ │                  │
   │  dimensions      │ │ expertise from │ │ minutes of human │
   │  → 0-100 + why   │ │ git history    │ │ reading time     │
   └────────┬─────────┘ └───────┬────────┘ └────────┬─────────┘
            │                   │                   │
            └───────────────────┼───────────────────┘
                                ▼
                  ┌──────────────────────────┐
                  │   ⑤ PRIORITY ENGINE      │
                  │   risk ≠ priority        │
                  │   + urgency + age        │
                  │   + blocking + load      │
                  └────────────┬─────────────┘
                               │  ranked queue
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
   ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
   │ ⑥ REVIEW PLAN  │ │ ⑦ EXPLANATION  │ │ ⑧ POLICY GATE  │
   │    SOLVER      │ │    LAYER (LLM) │ │                │
   │ knapsack over  │ │ narrates the   │ │ hard rules —   │
   │ the time budget│ │ computed score │ │ can VETO only  │
   └────────┬───────┘ └───────┬────────┘ └───────┬────────┘
            └─────────────────┼────────────────��─┘
                              ▼
              ┌───────────────────────────────┐
              │      ⑨ MOBILE TRIAGE UI       │
              │  deck · risk cards · explain  │
              │  reviewer · plan · capacity   │
              └───────────────────────────────┘
```

### Layer contract

Each layer has exactly one job and a typed boundary. This is not decoration — it is what makes the system testable and what lets you answer architecture questions on stage.

| Layer | Input | Output | Deterministic? |
|---|---|---|---|
| ① Signal | repo + PR number | `PRSignals` | yes |
| ② Risk | `PRSignals` | `RiskAssessment` | **yes** |
| ③ Reviewer | `PRSignals` + history | `ReviewerMatch[]` | **yes** |
| ④ Effort | `PRSignals` | minutes | **yes** |
| ⑤ Priority | all of the above | `PriorityScore` | **yes** |
| ⑥ Plan | ranked PRs + budget | ordered plan | **yes** |
| ⑦ Explanation | `RiskAssessment` + diff | prose | no (LLM) |
| ⑧ Policy | `PRSignals` + risk | allow / veto | **yes** |

**Only layer ⑦ is non-deterministic, and it can only produce words — never numbers, never decisions.**

---

## 5. The Signal Layer

`src/lib/signals/`

The signal layer is the foundation and the most under-appreciated part of the system. Every downstream engine is only as good as the measurements underneath it. It performs no judgement — it measures.

### Signal sources

```
GitHub REST                git log / GraphQL          Repo introspection
├── PR metadata            ├── file churn (90d)       ├── CODEOWNERS
├── files changed          ├── contributors/path      ├── path patterns
├── per-file patch         ├── revert detection       ├── lockfiles
├── CI check runs          ├── hotfix-follow          └── test dir layout
├── requested reviewers    └── author history
└── linked issues
```

### Collected signals

```ts
// src/lib/signals/types.ts
export interface PRSignals {
  // ---- identity
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  url: string;
  createdAt: string;
  updatedAt: string;

  // ---- size & shape
  additions: number;
  deletions: number;
  changedFiles: number;
  files: FileSignal[];
  largestFileChange: number;      // max lines touched in one file
  diffEntropy: number;            // 0-1: spread across files vs concentrated

  // ---- semantic classification
  touchesAuth: boolean;
  touchesPayments: boolean;
  touchesDatabase: boolean;       // migrations, schema
  touchesInfra: boolean;          // CI, Docker, deploy, IaC
  touchesPublicAPI: boolean;      // route handlers, exported contracts
  touchesConfig: boolean;
  criticalPaths: string[];        // which patterns matched, for explanation

  // ---- test posture
  testFilesChanged: number;
  testLinesAdded: number;
  productionLinesAdded: number;
  testRatio: number;              // testLines / productionLines
  hasNoTests: boolean;            // prod code changed, zero test lines

  // ---- dependencies
  dependencyFilesChanged: string[];
  dependenciesAdded: number;
  dependenciesRemoved: number;
  lockfileOnly: boolean;

  // ---- historical instability (the expensive, valuable signals)
  fileChurn: Record<string, number>;        // commits per file, 90d
  fileRevertRate: Record<string, number>;   // reverts / commits per file
  hotspotScore: number;                     // 0-1 aggregate instability
  priorIncidentFiles: string[];             // files in past revert/hotfix commits

  // ---- CI & review state
  ciStatus: "passing" | "failing" | "pending" | "none";
  failingChecks: string[];
  reviewState: "none" | "pending" | "changes_requested" | "approved";
  existingApprovals: number;
  commentCount: number;

  // ---- author context
  authorPriorPRs: number;
  authorRevertRate: number;
  authorIsFirstTimeContributor: boolean;
  authorIsBot: boolean;

  // ---- AI-authorship heuristics (source-agnostic, additive only)
  aiAuthorshipHints: {
    botAuthor: boolean;             // known agent account
    coAuthoredByTrailer: boolean;   // Co-Authored-By: <agent>
    branchNamePattern: boolean;     // codex/, claude/, cursor/, devin/...
    commitCadence: boolean;         // many files, single commit, seconds apart
    templatedBody: boolean;
  };
  likelyAIAuthored: boolean;

  // ---- urgency
  ageHours: number;
  isBlockingOthers: boolean;        // other PRs target this branch
  linkedIssueLabels: string[];      // bug, incident, P0, security
  isDraft: boolean;
  isHotfix: boolean;                // targets release/hotfix branch
}

export interface FileSignal {
  path: string;
  additions: number;
  deletions: number;
  status: "added" | "modified" | "removed" | "renamed";
  category: FileCategory;
  isTest: boolean;
  isGenerated: boolean;             // lockfiles, snapshots, build output
  churn90d: number;
  owners: string[];                 // from CODEOWNERS
}

export type FileCategory =
  | "auth" | "payments" | "database" | "infra" | "api"
  | "config" | "test" | "docs" | "ui" | "generated" | "other";
```

### Path classification

A configurable, repo-overridable pattern table — not hardcoded regex buried in the scorer:

```ts
// src/lib/signals/path-rules.ts
export const DEFAULT_PATH_RULES: PathRule[] = [
  { category: "auth",      weight: 1.00, patterns: [/auth/i, /session/i, /token/i, /login/i, /oauth/i, /permission/i, /rbac/i] },
  { category: "payments",  weight: 1.00, patterns: [/payment/i, /billing/i, /checkout/i, /stripe/i, /invoice/i, /subscription/i] },
  { category: "database",  weight: 0.85, patterns: [/migration/i, /schema/i, /\.sql$/, /prisma/i, /models?\//i] },
  { category: "infra",     weight: 0.75, patterns: [/Dockerfile/, /\.github\/workflows/, /terraform/i, /k8s/i, /helm/i, /deploy/i] },
  { category: "api",       weight: 0.70, patterns: [/routes?\//i, /controllers?\//i, /api\//i, /handlers?\//i, /graphql/i] },
  { category: "config",    weight: 0.55, patterns: [/config/i, /\.env/, /settings/i] },
  { category: "generated", weight: 0.00, patterns: [/lock\.json$/, /\.lock$/, /\.snap$/, /dist\//, /build\//] },
  { category: "docs",      weight: 0.05, patterns: [/\.md$/, /docs?\//i] },
  { category: "test",      weight: 0.10, patterns: [/\.(test|spec)\./i, /__tests__/, /tests?\//i] },
];
```

Repos override via `.pocketreview.yml`. **Generated files are excluded from size scoring** — a 4,000-line lockfile diff must never read as high risk. This single rule kills the most common false positive in naive diff scoring, and it's worth saying out loud to judges.

---

## 6. The Risk Engine

`src/lib/engines/risk-engine.ts`

**Definition of risk we use:** *the probability that this PR needs careful human attention* — **not** the probability that it is buggy. That distinction is deliberate, defensible, and it is the sentence to lead with if a judge challenges the score.

### Seven dimensions

```
                              weight    contribution range
 ① Blast Radius                 0.20     0-20
 ② Domain Criticality           0.20     0-20
 ③ Test Posture                 0.15     0-15
 ④ Historical Instability       0.15     0-15
 ⑤ Change Complexity            0.12     0-12
 ⑥ Dependency & Supply Chain    0.10     0-10
 ⑦ Author & Provenance          0.08     0-8
                              ─────
                                1.00     0-100
```

Each dimension returns a normalised `0..1` sub-score plus human-readable reasons. The final score is the weighted sum, then bounded modifiers are applied.

```ts
export interface RiskAssessment {
  score: number;                    // 0-100, integer
  level: "low" | "medium" | "high" | "critical";
  dimensions: DimensionResult[];    // always exactly 7, always sums to score
  topReasons: string[];             // 3-5, ranked by contribution
  modifiers: Modifier[];            // applied caps/boosts, each explained
  confidence: number;               // 0-1: how many signals were available
}

export interface DimensionResult {
  name: string;
  raw: number;          // 0-1
  weight: number;
  contribution: number; // raw * weight * 100
  reasons: string[];
  signalsUsed: string[];
}
```

### ① Blast Radius (0.20)

How much surface area does this change touch?

```ts
function blastRadius(s: PRSignals): number {
  const realFiles = s.files.filter(f => !f.isGenerated && !f.isTest);
  const realLines = realFiles.reduce((n, f) => n + f.additions + f.deletions, 0);

  const fileSpread = saturate(realFiles.length, 12);      // 12+ files → 1.0
  const volume     = saturate(realLines, 500);            // 500+ lines → 1.0
  const spread     = s.diffEntropy;                       // scattered > concentrated
  const crossCut   = distinctCategories(realFiles) / 5;   // touching many subsystems

  return clamp(0.35*fileSpread + 0.35*volume + 0.15*spread + 0.15*crossCut);
}
```

`saturate(x, k) = 1 - exp(-x/k)` — diminishing returns, so a 5,000-line PR is not 10× riskier than a 500-line one. Both are simply "large."

### ② Domain Criticality (0.20)

*Where* the change lands, weighted by the path rules. This is the dimension that catches the one-line `if (true)` in an auth file that a size-based scorer would rate as trivial.

```ts
function domainCriticality(s: PRSignals): number {
  const maxWeight = Math.max(0, ...s.files
    .filter(f => !f.isGenerated)
    .map(f => pathWeight(f.category)));

  // weighted mass, not just the max — many critical files > one critical file
  const criticalLines = s.files
    .filter(f => pathWeight(f.category) >= 0.7)
    .reduce((n, f) => n + f.additions + f.deletions, 0);
  const mass = saturate(criticalLines, 150);

  return clamp(0.70 * maxWeight + 0.30 * mass);
}
```

**Key property: this dimension is size-independent.** A 1-line change to `src/auth/session.ts` scores ~0.70 here regardless of how small it is. That is precisely the failure mode of naive "risk = lines changed" that we designed against, and it is the single best example to show a judge.

### ③ Test Posture (0.15)

```ts
function testPosture(s: PRSignals): number {
  if (s.productionLinesAdded === 0) return 0;           // docs/config-only
  if (s.hasNoTests) return 1.0;                          // prod code, zero tests
  const ratio = s.testRatio;                             // testLines / prodLines
  if (ratio >= 0.5) return 0.1;
  if (ratio >= 0.25) return 0.35;
  if (ratio >= 0.1) return 0.6;
  return 0.85;
}
```

Plus a modifier: **removed tests** (`testLinesDeleted > testLinesAdded` with prod lines added) forces this dimension to `1.0` and emits a loud reason.

### ④ Historical Instability (0.15)

The signal that makes this feel like real engineering rather than a hackathon heuristic — it uses the repo's own past.

```ts
function historicalInstability(s: PRSignals): number {
  const churn   = weightedMean(s.files.map(f => saturate(f.churn90d, 15)));
  const reverts = Math.max(0, ...s.files.map(f => s.fileRevertRate[f.path] ?? 0));
  const incident = s.priorIncidentFiles.length > 0 ? 1 : 0;

  return clamp(0.45*churn + 0.35*saturate(reverts * 10, 1) + 0.20*incident);
}
```

Reason text is concrete and quotable: *"`src/payments/charge.ts` was reverted twice in the last 90 days."*

### ⑤ Change Complexity (0.12)

Structural, language-agnostic, cheap to compute from the patch text:

- net change in control-flow keywords (`if`, `for`, `while`, `catch`, `switch`, `&&`, `||`, `?`)
- max nesting depth added
- new function/method count
- deletion-heavy changes (removed logic is under-reviewed and often riskier than added)
- rename/move detection (high churn, low semantic risk → *reduces* score)

### ⑥ Dependency & Supply Chain (0.10)

```
new dependency added         → 0.7 base
  ↳ major version bump       → +0.2
  ↳ transitive count > 20    → +0.1
lockfile-only change         → 0.15  (near-noise)
dependency removed           → 0.3
```

### ⑦ Author & Provenance (0.08)

The lowest weight, deliberately. This is where AI-authorship enters — as **one small, additive signal**, never as the headline.

```ts
function authorProvenance(s: PRSignals): number {
  let v = 0;
  if (s.authorIsFirstTimeContributor) v += 0.5;
  if (s.authorRevertRate > 0.15)      v += 0.3;
  if (s.likelyAIAuthored)             v += 0.4;   // additive, small weight
  return clamp(v);
}
```

**Why AI-authorship is weighted at 0.08 × 0.4 ≈ 3.2 points maximum, and why that is correct:**

PocketReview is **source-agnostic**. We do not claim AI code is worse. We observe that AI-authored PRs have *different review characteristics* — larger, more numerous, less context in the description — and those characteristics are already captured by dimensions ①–⑥. Provenance is a small corroborating nudge, not a verdict.

This is the answer when a judge asks *"what about human-written PRs?"* — and they will.

### Bounded modifiers

Applied after the weighted sum. Each is capped, logged, and shown in the UI:

```ts
const MODIFIERS: Modifier[] = [
  { when: s => s.ciStatus === "failing",          delta: +8,  label: "CI is failing" },
  { when: s => s.reviewState === "approved",      delta: -15, label: "Already approved by a reviewer" },
  { when: s => s.isDraft,                         delta: -20, label: "Draft PR" },
  { when: s => s.isHotfix,                        delta: +10, label: "Targets a hotfix/release branch" },
  { when: s => s.files.every(f => f.isGenerated), delta: -25, label: "Generated files only" },
  { when: s => s.files.every(f => f.category === "docs"), delta: -30, label: "Documentation only" },
];
```

Modifiers can never move the score by more than ±30 total, and the final value is clamped to `[0, 100]`. **No single signal can dominate the outcome** — a property worth stating explicitly, because it is what separates a scoring system from a pile of if-statements.

### Confidence

Not every repo yields every signal. A public repo without CI, or a shallow clone without history, degrades gracefully:

```
confidence = availableSignalWeight / totalSignalWeight
```

Below 0.6, the UI shows *"Limited signals — history unavailable"* rather than silently pretending. **Showing confidence honestly is a credibility feature, not a weakness.** A judge who spots a system hiding missing data trusts nothing else it says.

### Levels

```
  0 ─────── 25 ─────── 50 ─────── 75 ─────── 100
     LOW      MEDIUM      HIGH      CRITICAL
```

Thresholds are configurable per repo, because a payments monorepo and a docs site should not share a scale.

---

## 7. The Priority Engine

`src/lib/engines/priority-engine.ts`

**Risk answers "how much attention does this need?" Priority answers "what should I open right now?"** These are different questions, and conflating them is the most common mistake in this problem space.

A critical PR that is already approved and blocked on CI is *not* the thing to open next. A medium-risk PR blocking four other PRs and two days old *is*.

```ts
priority =
    0.40 * riskNormalised          // severity of attention needed
  + 0.20 * urgency                 // labels: incident, P0, security, hotfix
  + 0.15 * ageDecay                // staleness — anti-starvation
  + 0.15 * blockingImpact          // how many PRs/people are waiting
  + 0.10 * reviewerAvailability    // penalise if suggested reviewer is loaded
```

### Anti-starvation

A pure risk sort starves low-risk PRs forever — they sit at the bottom of the deck permanently and the team notices within a day. Age decay is superlinear so a stale PR eventually surfaces regardless:

```ts
function ageDecay(hours: number): number {
  return clamp(Math.pow(hours / 72, 1.5));   // 72h → 1.0, then clamped
}
```

### Suppression rules

Some PRs should not be in the deck at all:

```
isDraft                              → hidden (toggleable)
reviewState === "approved"           → hidden unless changes pushed after approval
ciStatus === "failing"               → demoted, labelled "author still iterating"
author === viewer                    → hidden (you can't review your own)
```

The output is a stable, ranked queue. **Stable matters:** the same 17 PRs produce the same order on every load. A deck that reshuffles between refreshes is a deck nobody trusts, and it is instantly visible during a demo.

---

## 8. The Reviewer Engine

`src/lib/engines/reviewer-engine.ts`

Answers: *given these files, who is the right human?*

```
                    ┌─────────────────────────┐
   PR files ───────▶│  expertise matrix       │
                    │  (built from git log)   │
                    └───────────┬─────────────┘
                                ▼
     for each candidate reviewer, over each changed path:

     ownership   = commits by reviewer to path / total commits to path
     recency     = exp(-daysSinceLastTouch / 60)
     reviewHist  = PRs reviewed by them touching this path
     codeowner   = CODEOWNERS match (hard signal)
     load        = 1 - (their open review requests / team max)

     match = 0.30*ownership + 0.20*recency + 0.25*reviewHist
           + 0.15*codeowner + 0.10*load
```

Result:

```ts
export interface ReviewerMatch {
  login: string;
  score: number;              // 0-1
  reasons: string[];          // "14 commits to src/auth/ in the last 90 days"
  currentLoad: number;        // open reviews assigned
  isCodeowner: boolean;
}
```

### Building the expertise matrix

```
git log --since=180.days --numstat --format="%H|%an|%ae|%ad"
        │
        ▼
  { author → { path → { commits, lastTouch } } }
        │
        ▼
  cached in .pocketreview/expertise.json, refreshed on demand
```

Built once per repo and cached — it is the most expensive computation in the system and must not run per-request.

### Honest limitation

On a single-contributor repository this engine returns one name with low confidence. **We surface that rather than fabricating a match**, and the UI hides the reviewer card when `confidence < 0.4`. Inventing a plausible-looking recommendation from thin data is exactly the kind of thing that collapses under a follow-up question.

---

## 9. The Review Plan Solver

`src/lib/engines/review-plan.ts`

**This is the feature that distinguishes PocketReview from every "PR dashboard" in existence, and it should be the last thing shown in the demo.**

Every other tool answers *"here are your PRs, sorted."* PocketReview answers a question a human actually has:

> *"I have 30 minutes before my next meeting. What should I do?"*

### Effort estimation

Priority ordering is useless without knowing what each item costs. The estimator is a transparent linear model:

```ts
minutes =
    3                                    // fixed context-switch cost
  + 0.045 * reviewableLines              // ~22 lines/min careful reading
  + 1.2   * realFilesChanged             // per-file orientation cost
  + 6     * criticalDomainsCount         // auth/payments demand slower reading
  + 4     * (hasNoTests ? 1 : 0)         // must reason about correctness unaided
  + 2     * newDependencies
  - 0.5   * (testRatio > 0.5 ? 1 : 0) * reviewableLines / 100   // good tests speed review
```

Clamped to `[2, 90]` and rounded to the nearest minute. Calibrated against real merged PRs (see [§16](#16-validation-strategy)).

### The solver

This is a **0/1 knapsack with a priority-weighted objective**, not a naive greedy sort:

```
maximise   Σ priority(pr) · x(pr)
subject to Σ minutes(pr) · x(pr) ≤ budget
           x(pr) ∈ {0, 1}
```

With `n ≤ 50` PRs and integer minutes, exact dynamic programming runs in `O(n · budget)` — microseconds. **No approximation needed, and "we solve it exactly with DP" is a much better answer than "we sort by ratio."**

Two guarantees layered on top:

1. **Critical PRs are force-included** if any single one fits the budget — safety beats optimality.
2. **Ordering within the plan** puts the highest-risk item first, while the reviewer is freshest. This is a real cognitive-load argument and it lands well.

```ts
export interface ReviewPlan {
  budgetMinutes: number;
  items: PlanItem[];
  totalMinutes: number;
  coveredRisk: number;        // % of total queue risk addressed
  deferred: DeferredItem[];   // with reason: "needs 24 min, 6 remaining"
  warnings: string[];         // "1 critical PR does not fit in this budget"
}
```

### Capacity analytics

The team-lead view, which reframes the whole problem:

```
  QUEUE LOAD                    TODAY

  🔴 Critical   2    ▓▓                48 min
  🟠 High       4    ▓▓▓▓              62 min
  🟡 Medium     5    ▓▓▓▓▓             41 min
  🟢 Low        6    ▓▓▓▓▓▓            16 min
                                     ───────
  Total required                      2h 47m
  Team capacity today                 1h 35m
                                     ───────
  ⚠  Deficit                          1h 12m
```

This single panel states the thesis numerically: **the queue is arriving faster than it can be served.** It is the strongest slide in the deck.

---

## 10. The Explanation Layer (LLM)

`src/lib/llm/`

The LLM has exactly one job: **turn computed facts into readable prose.** It never computes a score, never ranks, never decides.

### Contract

```ts
// Input is the ALREADY-COMPUTED assessment + the diff.
// Output is prose only. Any number in the output must
// have been passed in as input.
export async function explainRisk(
  signals: PRSignals,
  risk: RiskAssessment,
  diff: string,
): Promise<Explanation>;

export interface Explanation {
  oneLine: string;          // deck card summary, ≤ 90 chars
  whatChanged: string;      // 2-3 sentences, behavioural not textual
  whyItMatters: string;     // grounded in risk.topReasons
  whereToLookFirst: string[]; // ranked file:line pointers
  questionsToAsk: string[];   // what the reviewer should verify
}
```

### Prompt discipline

```
SYSTEM:
You explain pre-computed PR risk assessments. You must not
invent or alter numeric scores — every number you use is given
to you. If a signal is absent, say so; never speculate.
Describe behaviour, not diff mechanics. Be concise and concrete.

USER:
<risk score, level, dimension contributions, reasons — all computed>
<signals: files, categories, test posture, history>
<truncated, prioritised diff>
```

### Diff prioritisation before truncation

Naive truncation sends the first 8,000 characters — which in practice means the lockfile, alphabetically first. Instead we **rank hunks by the risk engine's own file weighting** and send the most consequential ones:

```
files sorted by (pathWeight × linesChanged), generated excluded
  → take hunks until char budget exhausted
  → append "N further files omitted: <names>"
```

The LLM therefore reads the auth change, not the lockfile. Small detail; enormous quality difference; excellent answer to *"how do you handle large PRs?"*

### Performance

- **Anthropic SDK** (`@anthropic-ai/sdk`), not a CLI subprocess. Parallelisable, streamable, no per-call process spawn.
- **Model tiering:** Haiku for one-line deck summaries (cheap, high volume), Sonnet for the full explain screen (on demand, one at a time).
- **Concurrency-limited fan-out:** 6 at a time across the queue.
- **Persistent cache** keyed on `repo:number:headSha` — explanations never recompute for an unchanged PR. Critical for demo reliability.
- **Lazy by default:** deck cards render from deterministic data instantly; explanations stream in. **The UI is never blocked on an LLM call** — the deck is usable in under a second even if every LLM request fails.

### Voice mode

Web Speech API (`speechSynthesis`) reads `oneLine + whatChanged + whyItMatters`. Zero backend cost, no extra dependency. Positioned as **hands-free triage on a commute** — a genuine accessibility and context feature, explicitly *not* the headline innovation.

---

## 11. The Policy Gate

`src/lib/policy/gate.ts`

The safety layer. Its existence is a technical argument, and it pre-empts the sharpest question a judge can ask.

**Rule: a fast-track swipe is a recommendation, never a merge.** The gate can only *remove* eligibility; it can never grant it.

```
     swipe right (fast-track)
              │
              ▼
   ┌──────────────────────┐
   │  POLICY GATE          │   ALL must hold:
   │                       │
   │  risk < threshold     │   default 25
   │  CI passing           │
   │  no critical paths    │   auth/payments/db never fast-track
   │  no dep changes       │
   │  tests not removed    │
   │  not a protected file │   from .pocketreview.yml
   │  branch rules allow   │   from GitHub branch protection
   └──────────┬───────────┘
              │
       ┌──────┴──────┐
       ▼             ▼
   ELIGIBLE       VETOED
       │             │
       ▼             ▼
  queued for    stays in queue
  fast-track    + shown reason
```

**In the hackathon build, fast-track produces a marked queue and an optional GitHub *comment* — it does not call the approve or merge API.** That is a deliberate product decision, not a missing feature, and saying so plainly is stronger than pretending otherwise.

The pitch line: *"We never let an AI approve code written by an AI. We only decide which human sees it first."*

---

## 12. Data model

```ts
// The object the frontend consumes — one per PR.
export interface TriagedPR {
  // identity
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  createdAt: string;

  // raw shape (deterministic, instant)
  additions: number;
  deletions: number;
  changedFiles: number;

  // engines (deterministic, instant)
  risk: RiskAssessment;
  priority: PriorityScore;
  effortMinutes: number;
  reviewers: ReviewerMatch[];
  policy: PolicyVerdict;

  // LLM (async, may be null on first paint)
  explanation: Explanation | null;

  // signals kept for the detail view
  signals: PRSignals;
}

export type TriageAction = "fast-track" | "needs-review" | "explain" | "defer";

export interface TriageRecord {
  repo: string;
  number: number;
  action: TriageAction;
  riskAtDecision: number;    // audit trail: what the score was when decided
  timestamp: number;
}
```

`riskAtDecision` exists so the queue can later surface *"you fast-tracked this at risk 18; it has since changed and is now 61."* Cheap to store, and it demonstrates that the system is designed for a real workflow rather than a single demo run.

---

## 13. API surface

```
GET  /api/prs
     → TriagedPR[], priority-ordered
     Query: ?repo=owner/name  ?budget=30  ?includeDrafts=false
     Deterministic engines only. p50 < 800ms warm. Never blocks on LLM.

GET  /api/prs/:repo/:number/signals
     → PRSignals — the raw measurements. Powers the "show your working" view.

GET  /api/prs/:repo/:number/explain
     → Explanation (streamed). Cached on repo:number:headSha.

GET  /api/prs/:repo/:number/diff
     → prioritised diff, risk-ranked hunks first.

GET  /api/reviewers?repo=owner/name
     → expertise matrix summary + current load per reviewer.

POST /api/review-plan
     { repo, budgetMinutes, reviewer? } → ReviewPlan
     Runs the knapsack DP. Pure function of cached data — instant.

POST /api/triage
     { repo, number, action } → persists TriageRecord, applies policy gate.
     Returns PolicyVerdict; performs NO merge and NO approval.

GET  /api/capacity?repo=owner/name
     → queue load vs available capacity (the deficit panel).
```

### Design rules

- **Deterministic endpoints never await the LLM.** The deck must paint from `/api/prs` alone.
- **Every endpoint degrades.** Missing git history → reduced `confidence`, not a 500.
- **Everything cacheable is cached on `headSha`.** A PR that has not changed is never recomputed.

---

## 14. Frontend architecture

### Principle: the phone must show *less*, not the same thing smaller

GitHub-on-mobile already exists and it is unpleasant. Our advantage is that the reviewer sees a **decision-shaped summary** instead of a diff. Every element on the card must serve a triage decision; anything that does not is removed.

### Screens

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│   ① QUEUE    │──▶│  ② TRIAGE    │──▶│  ③ EXPLAIN   │   │  ④ PLAN      │
│              │   │     DECK     │   │              │   │              │
│ load summary │   │ swipe cards  │   │ why risky    │   │ time budget  │
│ capacity gap │   │ risk + why   │   │ where to look│   │ ordered plan │
│ start triage │   │ effort + who │   │ questions    │   │ coverage %   │
└──────────────┘   └──────────────┘   │ 🔊 listen    │   └──────────────┘
                                      └──────────────┘
                          │
                          ▼
                   ┌──────────────┐
                   │ ⑤ SIGNALS    │  "show your working"
                   │ dimension    │  the credibility screen —
                   │ breakdown    │  open this when challenged
                   └──────────────┘
```

### The triage card

```
┌───────────────────────────────────────┐
│ acme/payments-api            #147     │
│                                       │
│ Refactor auth token validation        │
│ @dev-agent · 4h ago                   │
│                                       │
│ ╭─────────────────────────────────╮   │
│ │  🔴  CRITICAL          87/100   │   │
│ ╰─────────────────────────────────╯   │
│                                       │
│ ▸ Auth logic modified          +18    │
│ ▸ Test coverage removed        +15    │
│ ▸ 2 prior reverts in these files +13  │
│ ▸ 17 files across 4 subsystems  +14   │
│                    ↳ see all 7 signals│
│                                       │
│ ⏱  ~24 min      👤 @meera (91%)       │
│                                       │
│ "Replaces session validation with     │
│  JWT verification; removes the        │
│  expiry check in middleware."         │
│                                       │
│  ← NEEDS REVIEW    ↑ EXPLAIN    ⚡ →  │
└───────────────────────────────────────┘
```

Every number on this card is either measured or computed. The only generated text is the quoted summary, and it describes behaviour rather than asserting a verdict.

### Swipe semantics

| Gesture | Action | Effect |
|---|---|---|
| **→ right** | Fast-track | Policy gate evaluated. If eligible, queued as fast-track candidate. **Never merges.** |
| **← left** | Needs review | Marked for deep review, reviewer suggested, added to the plan. |
| **↑ up** | Explain | Opens the explanation screen; optional voice playback. |
| **↓ down** | Defer | Snoozed with a reason; resurfaces via age decay. |

If the policy gate vetoes a right-swipe, the card **does not leave the deck** — it flips to show the veto reason. The system visibly refusing its own recommendation is a strong live demo moment.

### Rendering strategy

```
t=0ms     deterministic data renders  ← full card, all numbers, usable
t=~600ms  explanations stream in       ← the quoted summary fades in
```

The interface is **never in a loading state for triage-critical information.** If the LLM is down, degradation is a missing sentence — not a broken product.

---

## 15. Repository layout

```
pocketreview/
├── ARCHITECTURE.md
├── README.md
├── .pocketreview.yml              # per-repo config: paths, thresholds, policy
│
├── src/
│   ├── app/
│   │   ├── page.tsx               # queue → deck shell
│   │   ├── plan/page.tsx          # review plan
│   │   ├── layout.tsx
│   │   ├── globals.css
│   │   │
│   │   └── api/
│   │       ├── prs/route.ts
│   │       ├── prs/[repo]/[number]/signals/route.ts
│   │       ├── prs/[repo]/[number]/explain/route.ts
│   │       ├── prs/[repo]/[number]/diff/route.ts
│   │       ├── reviewers/route.ts
│   │       ├── review-plan/route.ts
│   │       ├── capacity/route.ts
│   │       └── triage/route.ts
│   │
│   ├── components/
│   │   ├── deck/
│   │   │   ├── TriageDeck.tsx
│   │   │   ├── TriageCard.tsx
│   │   │   ├── SwipeOverlay.tsx
│   │   │   └── ActionBar.tsx
│   │   ├── risk/
│   │   │   ├── RiskBadge.tsx
│   │   │   ├── RiskReasons.tsx
│   │   │   └── DimensionBreakdown.tsx   # the credibility screen
│   │   ├── plan/
│   │   │   ├── ReviewPlan.tsx
│   │   │   ├── BudgetPicker.tsx
│   │   │   └── CapacityPanel.tsx
│   │   ├── reviewer/ReviewerCard.tsx
│   │   ├── explain/{ExplainScreen,VoiceButton}.tsx
│   │   └── shared/{Header,EmptyState,Toast}.tsx
│   │
│   ├── hooks/
│   │   ├── useTriageQueue.ts
│   │   ├── useExplanation.ts
│   │   ├── useReviewPlan.ts
│   │   └── useTriageHistory.ts
│   │
│   └── lib/
│       ├── signals/
│       │   ├── collect.ts          # orchestrates all sources
│       │   ├── github.ts           # Octokit: PR, files, checks, reviews
│       │   ├── history.ts          # git log: churn, reverts, expertise
│       │   ├── classify.ts         # path → category
│       │   ├── path-rules.ts
│       │   └── types.ts
│       │
│       ├── engines/
│       │   ├── risk-engine.ts      ⭐ core
│       │   ├── dimensions/         # one file per dimension, each unit-tested
│       │   ├── priority-engine.ts  ⭐ core
│       │   ├── reviewer-engine.ts  ⭐ core
│       │   ├── effort-estimator.ts
│       │   └── review-plan.ts      ⭐ core (knapsack DP)
│       │
│       ├── llm/
│       │   ├── client.ts           # Anthropic SDK, concurrency limiter
│       │   ├── explain.ts
│       │   ├── diff-prioritise.ts  # rank hunks before truncation
│       │   └── cache.ts
│       │
│       ├── policy/gate.ts
│       ├── cache/store.ts          # headSha-keyed persistent cache
│       ├── math.ts                 # clamp, saturate, weightedMean
│       └── types.ts
│
├── fixtures/                       # captured real PRs — offline demo safety
│   ├── prs/*.json
│   └── expertise.json
│
├── eval/                           # ⭐ the validation harness
│   ├── dataset.ts                  # historical PRs + revert/hotfix labels
│   ├── run-eval.ts
│   └── results.md                  # committed, quotable numbers
│
└── tests/
    ├── risk-engine.test.ts         # incl. the one-line-auth-change case
    ├── review-plan.test.ts         # incl. DP optimality vs brute force
    └── policy-gate.test.ts
```

`eval/` and `tests/` are not optional polish. **They are the difference between "we built a UI" and "we built a system", and they take under an hour each.**

---

## 16. Validation strategy

Judges will ask *"how do you know the score is right?"* Most teams answer *"the AI decides."* That answer ends the conversation badly. Ours is a number.

### Reframe the claim

We do **not** claim to predict bugs. We claim to **rank PRs by required human attention**. So we validate the ranking, not a classification.

### Ground truth from history

Mine a large public repository's merged PRs and label them from what actually happened afterwards:

```
A PR is labelled ATTENTION-WORTHY if any held:
  ├── it was reverted
  ├── a commit within 7 days referenced it as a fix
  ├── it received "changes requested"
  ├── it needed > 3 review rounds
  └── it touched files in a subsequent incident/hotfix commit
```

This is fully automatable from `git log` and the GitHub API — no manual labelling.

### Metrics

```
Recall@K       of the truly attention-worthy PRs,
               how many appear in our top K?              ← headline metric

Precision@K    of our top K, how many were justified?

NDCG           ranking quality across the whole queue

Lift vs        the naive "sort by lines changed" scorer   ← the money number
baseline
```

### The result to put on a slide

```
  Dataset:  412 merged PRs, 3 public repositories
  Labelled: 71 attention-worthy (17.2%)

  ───────────────────────────────────────────────
  Recall@10        Lines-changed baseline    41%
                   PocketReview              78%     ▲ +37pts
  ───────────────────────────────────────────────
  NDCG             baseline                 0.52
                   PocketReview             0.79
  ───────────────────────────────────────────────
```

> Numbers above are the template to fill from your own run — **run `eval/run-eval.ts` and paste the real output.** Never present illustrative figures as measured ones; that is the one mistake that cannot be recovered from if a judge probes.

### Effort calibration

Compare `effortMinutes` against real review durations (`PR created → first review submitted`, filtered for same-day reviews). Report MAE in minutes. Being honestly ±8 minutes is far better than claiming a precision you cannot support.

---

## 17. Performance, caching, resilience

### Budget

```
  /api/prs (warm cache, 20 PRs)      < 800 ms
  /api/prs (cold, 20 PRs)            < 6 s     ← parallel fan-out
  /api/review-plan                   < 20 ms   ← pure DP over cached data
  explanation (single, streamed)      < 3 s
  first meaningful paint              < 1 s
```

### Cache hierarchy

```
  L1  in-memory LRU        per process, 5 min TTL
  L2  .pocketreview/cache  headSha-keyed, survives restart
  L3  fixtures/            captured real PRs — demo fallback
```

**`headSha` keying is the crucial choice:** a PR that has not been pushed to is never recomputed, so a repeated demo run is instant and identical.

### Data access

- **Octokit over the `gh` CLI.** Real HTTP, parallelisable, no subprocess spawn per call, no dependency on a CLI being installed and authenticated on the demo machine. GraphQL for the batch PR list (one round trip instead of N).
- **Conditional requests (ETag)** so refreshes cost almost no rate limit.
- **Concurrency limiter** — 6 parallel GitHub calls, 6 parallel LLM calls.

### Failure modes — all designed for, none fatal

| Failure | Behaviour |
|---|---|
| GitHub rate limited | Serve from L2 cache, banner shows staleness |
| No network at venue | `DEMO_MODE=1` serves `fixtures/` — full app, real captured data |
| LLM unavailable | Deck fully functional; explanations show "unavailable" |
| Git history missing | Instability dimension drops out, `confidence` falls, UI says so |
| No CODEOWNERS | Reviewer engine falls back to commit history only |

**`DEMO_MODE` is not cheating — it is the difference between a demo and a story about a demo.** Capture real PRs from a real repo, commit them, and be able to run with the wifi unplugged.

---

## 18. Security & privacy

- **Token scope:** `repo:read` only. The app has no write capability beyond an optional comment, and the merge/approve endpoints are not wired in.
- **Diffs are sent to the LLM.** This is stated plainly in the README and gated behind an explicit config flag. A repo can set `llm.enabled: false` and the entire deterministic system still works — a real differentiator for regulated teams, and a good answer to a security-minded judge.
- **No source code is persisted.** The cache stores signals and explanations, never diff content.
- **Secret scanning before LLM dispatch:** high-entropy strings and known key patterns are redacted from diffs.
- **Tokens live in `.env.local` only** and are never sent to the client. All GitHub and Anthropic calls originate server-side.

---

## 19. Build phases

Ordered so that **every phase ends with something demonstrable.** If time runs out, you stop at a phase boundary and still have a coherent product.

### Phase 0 — Foundation
Branding, config schema, `math.ts`, types, Octokit client, `.env` wiring.
**Ends with:** PR list rendering from the GitHub API.

### Phase 1 — Signal Layer ⭐
`collect.ts`, `github.ts`, `classify.ts`, path rules. Generated-file exclusion.
**Ends with:** `/api/prs/:repo/:number/signals` returns a full measured object.

### Phase 2 — Risk Engine ⭐⭐⭐ *(the core)*
All 7 dimensions, modifiers, confidence. Unit tests including the one-line-auth-change case.
**Ends with:** every PR carries an explainable score. **This alone is a credible project.**

### Phase 3 — Deck & risk UI ⭐⭐
Rebuilt card, risk badge, ranked reasons, dimension breakdown screen.
**Ends with:** the demo is visually complete and technically defensible.

### Phase 4 — Priority + Effort ⭐⭐
Priority engine, anti-starvation, effort estimator.
**Ends with:** the queue is ordered by what to open next, with costs attached.

### Phase 5 — Review Plan ⭐⭐⭐ *(the differentiator)*
Knapsack DP, budget picker, capacity panel.
**Ends with:** the closing moment of the demo exists.

### Phase 6 — Explanation Layer ⭐⭐
Anthropic SDK, diff prioritisation, caching, streaming, voice.
**Ends with:** cards speak plain English; hands-free mode works.

### Phase 7 — Reviewer Engine ⭐
Expertise matrix from git history, load balancing.
**Ends with:** "who should review this" — *cut this first if time is short.*

### Phase 8 — Policy Gate + Eval ⭐⭐⭐
Gate rules, veto UI, `eval/run-eval.ts`, committed results.
**Ends with:** the numbers that win the Q&A.

### Phase 9 — Hardening
`DEMO_MODE`, fixtures, error states, mobile polish, README.

### Ruthless cut order if time runs short

```
  cut 1st  ▸ Reviewer Engine        (Phase 7)
  cut 2nd  ▸ Voice mode             (part of 6)
  cut 3rd  ▸ Capacity panel         (part of 5)
  ─────────────────────────────────────────────
  NEVER cut ▸ Risk Engine, Review Plan, Eval harness
```

The last line is the whole strategy. **Those three are the project; everything else is presentation.**

---

## 20. Demo script

Four minutes, in this order. The order is deliberate — build credibility *before* showing the flashy part, so the swipe reads as engineering rather than novelty.

**0:00 — The number.** Open on the capacity panel. *"17 PRs. 2 hours 47 minutes of review work. This reviewer has 1 hour 35. This deficit is the entire problem, and it grows every day."*

**0:30 — The deck.** Swipe two low-risk PRs in three seconds. *"That's the interaction. It isn't the innovation."*

**1:00 — The one that matters.** A **one-line** diff in an auth file, scored CRITICAL. *"Three lines. Tests pass. Any size-based tool ranks this trivial. Ours ranks it top of the queue."*

**1:30 — Show your working.** Open the dimension breakdown. Point at contributions summing exactly to the score. *"No LLM produced this number. It is arithmetic over measured signals, and it is identical on every run."*

**2:15 — The refusal.** Swipe right on a risky PR; the policy gate vetoes it live and the card flips. *"The system refuses its own fast-track. We never let an AI approve code written by an AI."*

**2:45 — The plan.** Set the budget to 30 minutes. *"Not a sorted list — a knapsack solved exactly, maximising risk coverage inside the time you actually have. Three PRs, 29 minutes, 71% of queue risk addressed."*

**3:30 — The evidence.** The eval slide. *"412 real merged PRs. Recall@10 of 78% versus 41% for a lines-changed baseline."*

**3:50 — The line.** *"We don't review your code. We decide where your attention goes."*

---

## 21. Judge Q&A defence

**"Why 87? Where does that number come from?"**
Seven weighted dimensions over measured signals. Open the breakdown — the contributions sum to 87. No LLM touches the number; it is the same on every run. *(This is why the dimension screen exists.)*

**"Isn't this just lines-changed with extra steps?"**
No — and here is the counter-example. Show the one-line auth change scoring 74. Domain criticality is size-independent by construction. Then the eval: +37 points of recall over exactly that baseline.

**"What if the AI is wrong?"**
It cannot approve anything. Worst case is a misordered queue — the reviewer still sees every PR. The policy gate makes critical-path fast-tracking structurally impossible, not merely discouraged.

**"GitHub could build this."**
GitHub optimises the *individual review*. We optimise *allocation across the queue*. Different problem, different data model — we need cross-PR history, expertise, and effort estimation, none of which live in a single PR view.

**"What about human-written PRs?"**
Fully source-agnostic. AI provenance is one signal at 8% weight contributing at most ~3 points. AI is what made the queue explode; it is not what the system judges.

**"Your risk model is just heuristics."**
Correct, and deliberately so. Heuristics are auditable, tunable per repo, and explainable to the human being asked to trust them. A learned model on hackathon-scale data would be less accurate *and* unexplainable. We validated the heuristics against real historical outcomes — that is what `eval/` is.

**"How does this scale to a 500-PR monorepo?"**
Signals are `headSha`-cached, so steady-state cost is only newly-pushed PRs. The expertise matrix is built once per repo. The plan solver is `O(n · budget)` — milliseconds at n=500.

**"What's the business model / who pays?"**
Team leads and engineering managers, priced per reviewer seat. The buying trigger is the deficit panel: it quantifies a problem they already feel but cannot currently measure.

---

## 22. Deliberate non-goals

Stated explicitly, because knowing what you refused to build is itself an engineering signal:

- ❌ Line-level review comments — solved space, and it worsens the bottleneck
- ❌ Auto-merge / auto-approve — the trust problem we exist to address
- ❌ A full mobile diff viewer — the phone should show less, not the same thing smaller
- ❌ Multi-forge support (GitLab, Bitbucket) — architecturally trivial, demo-irrelevant
- ❌ Real-time collaboration / notifications — scope trap
- ❌ A trained ML risk model — unexplainable at this data scale
- ❌ Calendar integration — a plausible-sounding integration that adds no technical depth

---

## Appendix — The four sentences

If everything else is forgotten, these carry the project:

1. **AI multiplied code output. It did not multiply reviewer attention.**
2. **We do not judge whether code is correct. We decide where a human should look first.**
3. **The score is computed in code; the LLM only narrates it.**
4. **We never let an AI approve code written by an AI.**
