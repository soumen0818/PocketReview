# PocketReview — API Reference

> HTTP endpoints, TypeScript interfaces, and internal function signatures.
>
> **Status convention.** Every section is marked either ✅ **Shipped** — verified against the code at the path given — or 🕐 **Planned (Phase N)**, in which case the shape shown is the target contract from [architecture.md](../ARCHITECTURE.md) and **the endpoint does not exist yet**. See [PROGRESS.md](./PROGRESS.md) for the live phase status.

---

## Table of contents

1. [Endpoint map](#1-endpoint-map)
2. [Shipped endpoints](#2-shipped-endpoints)
   - [GET /api/prs](#21-get-apiprs)
   - [GET /api/prs/:repo/:number/risk](#22-get-apiprsreponumberrisk)
   - [GET /api/prs/:repo/:number/signals](#23-get-apiprsreponumbersignals)
   - [GET /api/prs/:repo/:number/diff](#24-get-apiprsreponumberdiff)
   - [POST /api/chat](#25-post-apichat)
3. [Planned endpoints](#3-planned-endpoints)
4. [Core types](#4-core-types)
5. [Internal function signatures](#5-internal-function-signatures)
6. [Enumerations](#6-enumerations)
7. [Errors](#7-errors)

---

## 1. Endpoint map

| Endpoint | Status | Architecture § |
|---|---|---|
| `GET /api/prs` | ✅ Shipped | §13 |
| `GET /api/prs/:repo/:number/risk` | ✅ Shipped | §13 |
| `GET /api/prs/:repo/:number/signals` | ✅ Shipped | §13 |
| `GET /api/prs/:repo/:number/diff` | ✅ Shipped | §13 |
| `POST /api/chat` | ✅ Shipped (interim) | §10 |
| `GET /api/prs/:repo/:number/explain` | 🕐 Planned — Phase 6 | §10 |
| `GET /api/reviewers` | 🕐 Planned — Phase 7 | §8 |
| `POST /api/review-plan` | 🕐 Planned — Phase 5 | §9 |
| `GET /api/capacity` | 🕐 Planned — Phase 5 | §9 |
| `POST /api/triage` | 🕐 Planned — Phase 8 | §11 |

**Authentication.** All GitHub and Anthropic credentials are read server-side from the process environment. Clients send **no** `Authorization` header — see [security.md](./security.md).

**The deterministic guarantee.** `/api/prs`, `/risk`, `/signals` and `/diff` never await an LLM. The deck paints from `/api/prs` alone.

---

## 2. Shipped endpoints

### 2.1 `GET /api/prs`

Returns the scored triage queue, highest risk first.

**Handler:** [src/app/api/prs/route.ts](../src/app/api/prs/route.ts)

#### Query parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `repo` | `string` | No | — | Scope to one repository, `owner/name`. Omit to fetch review-requested PRs across every repo the token can see. |
| `limit` | `number` | No | `50` | Maximum PRs to consider. Clamped to `[1, 100]`. |
| `signals` | `"1"` | No | — | Pass exactly `1` to include the full `PRSignals` object per PR, so the breakdown view opens with no round trip. |

> `signals` is checked with `=== "1"`. `signals=true` does **not** enable it.

#### Example

```http
GET /api/prs?repo=acme/backend&limit=20&signals=1
```

#### Response — `200 OK`

```jsonc
{
  "prs": [
    {
      "number": 147,
      "title": "Refactor auth token validation",
      "body": "Replaces session validation with JWT verification.",
      "author": { "login": "dev-agent" },
      "repository": { "nameWithOwner": "acme/payments-api" },
      "createdAt": "2026-09-02T14:22:00Z",
      "additions": 412,
      "deletions": 248,
      "changedFiles": 17,
      "url": "https://github.com/acme/payments-api/pull/147",
      "headSha": "a1b2c3d4e5f6",
      "risk": {
        "score": 87,
        "level": "critical",
        "baseScore": 74.31,
        "modifierDelta": 8,
        "floor": null,
        "floorReasons": [],
        "dimensions": [ /* exactly 7 — see §4.3 */ ],
        "modifiers": [
          { "id": "ci-failing", "label": "CI is failing", "delta": 8 }
        ],
        "topReasons": [
          "Auth logic modified across 3 files",
          "Production code changed with no tests added"
        ],
        "confidence": 0.94,
        "lowConfidence": false
      },
      "baseline": 66,
      "signals": { /* present only when ?signals=1 */ }
    }
  ],
  "summary": {
    "total": 18,
    "byLevel": { "low": 2, "medium": 7, "high": 6, "critical": 3 },
    "hasLowConfidence": false
  }
}
```

The response key is **`prs`**, not `queue`. Each entry is a [`TriagedPR`](#41-triagedpr).

`baseline` is the naive lines-changed score from `baselineScore()`, shipped alongside the real score so the comparison in the breakdown view is *runnable* rather than asserted (Decision Log #12).

#### Ordering

Sorted by `risk.score` descending. **Full priority ordering — urgency, age, blocking impact — is Phase 4.** Until then risk order is the honest approximation, and the code says so at the sort site.

#### Empty queue

```jsonc
{ "prs": [], "summary": { "total": 0, "byLevel": { "low": 0, "medium": 0, "high": 0, "critical": 0 }, "hasLowConfidence": false } }
```

#### Errors

| Status | Condition |
|---|---|
| `400` | `repo` present but not `owner/name` → `{ "error": "Invalid repository \"x\" — expected \"owner/name\"." }` |
| `500` | Signal collection threw → `{ "error": "<message>" }` |

---

### 2.2 `GET /api/prs/:repo/:number/risk`

Full risk assessment for one PR, including the per-dimension breakdown that makes the score auditable.

**Handler:** [src/app/api/prs/[repo]/[number]/risk/route.ts](../src/app/api/prs/%5Brepo%5D/%5Bnumber%5D/risk/route.ts)

`:repo` is URL-encoded — `acme%2Fbackend`.

```http
GET /api/prs/acme%2Fbackend/1042/risk
```

```jsonc
{
  "repo": "acme/backend",
  "number": 1042,
  "title": "feat: migrate auth to JWT RS256",
  "author": "alice",
  "url": "https://github.com/acme/backend/pull/1042",
  "headSha": "a1b2c3d4",
  "risk": { /* RiskAssessment — see §4.2 */ }
}
```

| Status | Condition |
|---|---|
| `400` | Non-integer or non-positive PR number; malformed repo slug |
| `500` | Collection or scoring threw |

---

### 2.3 `GET /api/prs/:repo/:number/signals`

The raw measurements — the "show your working" data. Returns `PRSignals` plus the `risk` and `baseline` computed from them.

**Handler:** [src/app/api/prs/[repo]/[number]/signals/route.ts](../src/app/api/prs/%5Brepo%5D/%5Bnumber%5D/signals/route.ts)

Use this endpoint to answer *"where did that number come from?"* — every point of the score traces back to a field here.

---

### 2.4 `GET /api/prs/:repo/:number/diff`

Unified diff for one PR, fetched through Octokit.

**Handler:** [src/app/api/prs/[repo]/[number]/diff/route.ts](../src/app/api/prs/%5Brepo%5D/%5Bnumber%5D/diff/route.ts)

> 🕐 **Risk-ranked hunk ordering is Phase 6.** Architecture §10 specifies the diff be prioritised by `pathWeight × linesChanged` before truncation, so the model reads the auth change and not the lockfile. The ranking primitive (`rankPatchesByConsequence`) already exists and is tested in [diff.ts](../src/lib/signals/diff.ts); wiring it into this route is pending.

---

### 2.5 `POST /api/chat`

The current explanation surface: a per-PR conversation with Claude about the diff.

**Handler:** [src/app/api/chat/route.ts](../src/app/api/chat/route.ts)

```jsonc
// Request
{
  "repo": "acme/backend",
  "prNumber": 1042,
  "prTitle": "feat: migrate auth to JWT RS256",
  "prBody": "...",
  "message": "What should I look at first?",
  "history": [{ "role": "user", "content": "..." }]
}

// Response
{ "reply": "The expiry check in middleware.ts is removed without a replacement..." }
```

| Status | Condition |
|---|---|
| `400` | Missing `repo`, `prNumber`, or `message` |
| `500` | Anthropic call failed |

**Diff handling.** The route fetches the diff once and memoises it in a module-level `Map` keyed `repo:number`. Diffs are truncated to `MAX_DIFF_CHARS` before dispatch.

> ⚠️ **Two known deviations from architecture §10, both tracked for Phase 6:**
> 1. `MAX_DIFF_CHARS` is hardcoded to `8000` in [claude.ts](../src/lib/claude.ts) and ignores `llm.maxDiffChars` (default `12000`) from config.
> 2. The cache is keyed on `repo:number` only, **not** `headSha` — a PR that receives a push serves a stale diff until the process restarts. Architecture §17 requires `headSha` keying.
>
> This endpoint is superseded by the structured `Explanation` contract (§3.1) in Phase 6.

---

## 3. Planned endpoints

> None of the following exist in the codebase. Shapes are the target contracts from [architecture.md](../ARCHITECTURE.md).

### 3.1 `GET /api/prs/:repo/:number/explain` 🕐 Phase 6

Streamed. Cached on `repo:number:headSha`.

```ts
export interface Explanation {
  oneLine: string;            // deck card summary, ≤ 90 chars
  whatChanged: string;        // 2-3 sentences, behavioural not textual
  whyItMatters: string;       // grounded in risk.topReasons
  whereToLookFirst: string[]; // ranked file:line pointers
  questionsToAsk: string[];   // what the reviewer should verify
}
```

The LLM receives the **already-computed** assessment. Any number in the output must have been passed in as input.

### 3.2 `POST /api/review-plan` 🕐 Phase 5

`{ repo, budgetMinutes, reviewer? }` → `ReviewPlan`. Exact 0/1 knapsack DP over cached data, `O(n · budget)`.

```ts
export interface ReviewPlan {
  budgetMinutes: number;
  items: PlanItem[];
  totalMinutes: number;
  coveredRisk: number;      // % of total queue risk addressed
  deferred: DeferredItem[]; // with reason: "needs 24 min, 6 remaining"
  warnings: string[];       // "1 critical PR does not fit in this budget"
}
```

### 3.3 `GET /api/capacity` 🕐 Phase 5

Queue load versus available capacity — the deficit panel.

### 3.4 `GET /api/reviewers` 🕐 Phase 7

Expertise matrix summary and current load per reviewer.

```ts
export interface ReviewerMatch {
  login: string;
  score: number;        // 0-1
  reasons: string[];    // "14 commits to src/auth/ in the last 90 days"
  currentLoad: number;
  isCodeowner: boolean;
}
```

Phase 7 is **first to cut**. The UI must hide the reviewer card when `confidence < 0.4`.

### 3.5 `POST /api/triage` 🕐 Phase 8

`{ repo, number, action }` → persists a `TriageRecord`, applies the policy gate, returns a `PolicyVerdict`. **Performs no merge and no approval.**

---

## 4. Core types

### 4.1 `TriagedPR` ✅

[src/lib/types.ts](../src/lib/types.ts)

```ts
export interface PullRequest {
  number: number;
  title: string;
  body: string;
  author: { login: string };
  repository: { nameWithOwner: string };
  createdAt: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  url: string;
}

export interface TriagedPR extends PullRequest {
  headSha: string;
  risk: RiskAssessment;
  /** Score from the naive lines-changed model, for comparison. */
  baseline: number;
  /** Present when ?signals=1. */
  signals?: PRSignals;
}
```

> Note the nested shape: `author.login` and `repository.nameWithOwner`, not flat strings. Architecture §12 sketches a flat `TriagedPR` with `priority`, `effortMinutes`, `reviewers`, `policy` and `explanation` — those fields arrive in Phases 4–8.

### 4.2 `RiskAssessment` ✅

[src/lib/engines/types.ts](../src/lib/engines/types.ts)

```ts
export interface RiskAssessment {
  score: number;            // 0-100, integer — the final value
  level: RiskLevel;
  baseScore: number;        // weighted sum before modifiers
  modifierDelta: number;    // net modifier points, after the ±30 cap
  floor: number | null;     // the floor that decided the score, else null
  floorReasons: string[];   // empty unless floor is set
  dimensions: DimensionResult[];  // always exactly 7, fixed order
  modifiers: Modifier[];          // only those that fired
  topReasons: string[];           // ranked by contribution, max 5
  confidence: number;             // 0-1
  lowConfidence: boolean;         // confidence < 0.6
}
```

**Auditability guarantee, enforced by tests:**

```
dimensions[].contribution  sums to  baseScore
clamp(baseScore + modifierDelta, 0, 100)  then  max(·, floor)  ==  score
```

There is no `rawScore`, `adjustedScore`, `finalScore`, or `activeFloors` field. The final value is `score`.

### 4.3 `DimensionResult` ✅

```ts
export interface DimensionResult {
  id: DimensionId;
  name: string;
  raw: number;          // the dimension's own 0..1 assessment
  weight: number;       // fixed, from the dimension table
  contribution: number; // raw * weight * 100 — points on the board
  reasons: string[];
  signalsUsed: string[]; // which PRSignals fields were read
}

export type DimensionId =
  | "blast-radius" | "domain-criticality" | "test-posture"
  | "historical-instability" | "change-complexity"
  | "dependencies" | "author-provenance";
```

`signalsUsed` is what powers the audit view: it names the measurements behind each dimension.

### 4.4 `Modifier` ✅

```ts
export interface Modifier {
  id: string;
  label: string;
  delta: number;  // points added or removed
}

export const MODIFIER_CAP = 30;             // aggregate, either direction
export const LOW_CONFIDENCE_THRESHOLD = 0.6;
```

### 4.5 `PRSignals` ✅

[src/lib/signals/types.ts](../src/lib/signals/types.ts) — ~70 fields grouped by identity, size & shape, semantic classification, test posture, dependencies, historical instability, CI & review state, author context, provenance, urgency, and `availability`.

Matches architecture §5 with these additions made during implementation:

| Field | Why it was added |
|---|---|
| `headSha`, `baseBranch`, `headBranch` | Cache keying and hotfix detection |
| `distinctCategories` | Precomputed for blast radius rather than recomputed per call |
| `testLinesDeleted`, `productionLinesDeleted`, `testsRemoved` | Test *removal* is a distinct signal from test *absence* |
| `reviewRounds` | Eval labelling (>3 rounds ⇒ attention-worthy) |
| `labels` | Alongside `linkedIssueLabels` |
| `availability` | See §4.6 |

`FileSignal` carries `categoryWeight` and optional `patch`; churn is `churn`, not `churn90d`.

### 4.6 `SignalAvailability` ✅

Records which signal groups could actually be measured, so missing data degrades confidence instead of silently becoming zero.

```ts
export const AVAILABILITY_WEIGHTS = {
  metadata: 0.35, patches: 0.15, history: 0.20,
  ci: 0.10, reviews: 0.08, codeowners: 0.05, authorHistory: 0.07,
};

export function signalConfidence(a: SignalAvailability): number;
export function emptyAvailability(): SignalAvailability;
```

### 4.7 `QueueSummary` ✅

```ts
export interface QueueSummary {
  total: number;
  byLevel: { low: number; medium: number; high: number; critical: number };
  hasLowConfidence: boolean;
}
```

No `averageScore` or `returned` field.

### 4.8 `TriageRecord` ✅

```ts
export type TriageAction = "fast-track" | "needs-review" | "defer";

export interface TriageRecord {
  repo: string;
  prNumber: number;
  action: TriageAction;
  riskAtDecision: number;  // audit trail
  timestamp: number;
}
```

`riskAtDecision` lets the queue later surface *"you fast-tracked this at 18; it now scores 61."*

> `"defer"` is defined but not yet reachable from the UI — see [ui-components.md](./ui-components.md#triage-gestures). Architecture §12 also lists `"explain"` as an action; in the shipped code explain is a screen transition, not a recorded triage decision.

### 4.9 `PocketReviewConfig` ✅

See [configuration.md](./configuration.md). `PolicyConfig` is defined and loaded but **not yet consumed** — the gate is Phase 8.

---

## 5. Internal function signatures

### 5.1 Signal layer ✅ — [src/lib/signals/](../src/lib/signals/)

```ts
// collect.ts — orchestration with per-source failure isolation
collectSignals(repo: string, number: number, opts: { rules: PathRule[] }): Promise<PRSignals>
collectQueueSignals(prs: { repo: string; number: number }[], opts): Promise<PRSignals[]>

// classify.ts
classifyPath(path: string, rules: PathRule[]): { category: FileCategory; weight: number }
parseCodeowners(text: string): CodeownersRule[]
matchOwners(path: string, rules: CodeownersRule[]): string[]

// diff.ts
rankPatchesByConsequence(files: FileSignal[]): FileSignal[]  // criticality dominates; size breaks ties
redactSecrets(text: string): string

// github.ts — Octokit, bounded concurrency (6)
listRepoPRs(repo: string, limit: number)
listReviewRequested(limit: number)
getPRDiff(repo: string, number: number): Promise<string>
mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]>
```

### 5.2 Engine layer ✅ — [src/lib/engines/](../src/lib/engines/)

```ts
assessRisk(signals: PRSignals, options?: { thresholds?: Thresholds }): RiskAssessment
baselineScore(signals: PRSignals): number   // the lines-changed model, to be beaten
toLevel(score: number, thresholds: Thresholds): RiskLevel

export const DIMENSIONS: Dimension[]        // 7, weights asserted to sum to 1.00 at load
export const MODIFIER_RULES: ModifierRule[] // 7
export const FLOOR_RULES: FloorRule[]       // 3
```

Each dimension is a pure `Dimension` with `evaluate(signals) => { raw, reasons, signalsUsed }`.

> 🕐 `priority-engine.ts` (Phase 4), `effort-estimator.ts` (Phase 4), `review-plan.ts` (Phase 5) and `reviewer-engine.ts` (Phase 7) are not yet written.

### 5.3 Math ✅ — [src/lib/math.ts](../src/lib/math.ts)

```ts
clamp(v: number, min?: number, max?: number): number   // NaN-safe
saturate(x: number, k: number): number                 // 1 - exp(-x/k)
normalisedEntropy(values: number[]): number            // 0..1
weightedMean(values: number[], weights?: number[]): number
decay(days: number, halfLife: number): number
round(v: number, dp: number): number
ratio(a: number, b: number): number                    // safe at zero
```

### 5.4 Config ✅ — [src/lib/config.ts](../src/lib/config.ts)

```ts
loadConfig(): Promise<PocketReviewConfig>  // cached after first call
isDemoMode(): boolean
export const DEFAULT_CONFIG: PocketReviewConfig
```

### 5.5 AI layer ✅ (interim) — [src/lib/claude.ts](../src/lib/claude.ts)

```ts
chatWithClaude(args: {
  prTitle: string; prBody: string; diff: string;
  history: ChatMessage[]; message: string;
}): Promise<string>
```

Replaced by `explainRisk(signals, risk, diff) => Promise<Explanation>` in Phase 6.

### 5.6 Display ✅ — [src/lib/risk-display.ts](../src/lib/risk-display.ts)

```ts
export const LEVEL_STYLES: Record<RiskLevel, LevelStyle>
timeAgo(iso: string): string
shortRepo(nameWithOwner: string): string
```

---

## 6. Enumerations

| Type | Values |
|---|---|
| `RiskLevel` | `"low"` · `"medium"` · `"high"` · `"critical"` |
| `DimensionId` | the 7 ids in §4.3 |
| `FileCategory` | `"auth"` `"payments"` `"database"` `"infra"` `"api"` `"config"` `"test"` `"docs"` `"ui"` `"generated"` `"other"` |
| `FileStatus` | `"added"` `"modified"` `"removed"` `"renamed"` `"copied"` `"changed"` `"unchanged"` |
| `CIStatus` | `"passing"` `"failing"` `"pending"` `"none"` |
| `ReviewState` | `"none"` `"pending"` `"commented"` `"changes_requested"` `"approved"` |
| `TriageAction` | `"fast-track"` `"needs-review"` `"defer"` |
| `SwipeDirection` | `"left"` `"right"` |

`FileStatus` and `ReviewState` carry more members than architecture §5 lists, because GitHub emits them.

---

## 7. Errors

Every endpoint returns `{ "error": string }` with an appropriate status.

| Status | Meaning |
|---|---|
| `400` | Malformed `repo` slug or PR number — validated before any network call |
| `500` | Upstream failure (GitHub, Anthropic) or unexpected throw |

**Degradation over failure.** Within signal collection, a failing *source* does not fail the request: `collect.ts` isolates each source, records the gap in `availability`, and the assessment returns with reduced `confidence`. Missing git history yields a lower confidence score, never a `500`.

---

*Verified against the codebase on 2026-09-03 — Phase 3 complete, 74/74 tests passing.*
