# PocketReview — API Reference

> Complete reference for HTTP endpoints, TypeScript interfaces, internal function signatures, and data models.

---

## Table of Contents

1. [HTTP Endpoints](#1-http-endpoints)
   - [GET /api/prs](#11-get-apiprs)
   - [POST /api/chat](#12-post-apichat)
2. [TypeScript Interfaces](#2-typescript-interfaces)
   - [TriagedPR](#21-triagedpr)
   - [RiskAssessment](#22-riskassessment)
   - [DimensionResult](#23-dimensionresult)
   - [Modifier](#24-modifier)
   - [PRSignals](#25-prsignals)
   - [QueueSummary](#26-queuesummary)
   - [ChatMessage](#27-chatmessage)
   - [AppConfig](#28-appconfig)
3. [Internal Function Signatures](#3-internal-function-signatures)
   - [Signal Layer](#31-signal-layer)
   - [Engine Layer](#32-engine-layer)
   - [AI Layer](#33-ai-layer)
   - [Config Layer](#34-config-layer)
   - [Math Utilities](#35-math-utilities)
4. [Enumerations & Literals](#4-enumerations--literals)
5. [Error Reference](#5-error-reference)

---

## 1. HTTP Endpoints

### 1.1 `GET /api/prs`

Returns the full scored and ranked PR queue for a repository.

**Route handler:** `src/app/api/prs/route.ts`

#### Query Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `repo` | `string` | **Yes** | — | Full repository slug in `owner/name` format, e.g. `acme/backend` |
| `limit` | `number` | No | `50` | Maximum number of PRs to return. Range: `1–200`. |
| `signals` | `boolean` | No | `false` | When `true`, includes the raw `PRSignals` object on each result for debugging. |

#### Example Request

```http
GET /api/prs?repo=acme/backend&limit=20 HTTP/1.1
Authorization: Bearer <GITHUB_TOKEN>
```

#### Response — `200 OK`

```jsonc
{
  "queue": [
    {
      "prNumber": 1042,
      "title": "feat: migrate auth to JWT RS256",
      "url": "https://github.com/acme/backend/pull/1042",
      "author": "alice",
      "isDraft": false,
      "labels": ["breaking-change"],
      "baseBranch": "main",
      "headBranch": "feat/jwt-rs256",
      "createdAt": "2026-08-30T14:22:00Z",
      "updatedAt": "2026-09-01T09:10:00Z",
      "assessment": {
        "score": 87,
        "riskLevel": "critical",
        "confidence": 0.94,
        "lowConfidence": false,
        "dimensions": [
          {
            "name": "domain-criticality",
            "rawScore": 0.95,
            "weight": 0.20,
            "contribution": 19.0,
            "rationale": "Changes touch auth/session/token paths (weight 1.0)"
          }
          // ...6 more dimensions
        ],
        "modifiers": [
          {
            "id": "ci-failing",
            "label": "CI Failing",
            "delta": 8,
            "active": true,
            "reason": "3 checks failing on head commit"
          }
        ],
        "activeFloors": ["critical-path"],
        "baseScore": 74,
        "adjustedScore": 82,
        "finalScore": 87
      }
    }
  ],
  "summary": {
    "total": 18,
    "returned": 18,
    "critical": 3,
    "high": 6,
    "medium": 7,
    "low": 2,
    "averageScore": 51.4,
    "generatedAt": "2026-09-03T08:00:00.000Z"
  }
}
```

When `signals=true` is passed, each item in `queue` additionally contains a `signals` key with the full `PRSignals` object (see [§2.5](#25-prsignals)).

#### Error Responses

| Status | Code | Description |
|---|---|---|
| `400` | `MISSING_REPO` | `repo` query parameter is absent or empty |
| `400` | `INVALID_REPO` | `repo` does not match `owner/name` format |
| `401` | `UNAUTHORIZED` | `GITHUB_TOKEN` environment variable is not set or is invalid |
| `403` | `FORBIDDEN` | Token lacks `repo:read` scope for the requested repository |
| `404` | `REPO_NOT_FOUND` | Repository does not exist or is not accessible |
| `429` | `RATE_LIMITED` | GitHub API rate limit exhausted |
| `500` | `INTERNAL_ERROR` | Unexpected server-side error |

```jsonc
// Error body shape
{
  "error": {
    "code": "MISSING_REPO",
    "message": "Query parameter 'repo' is required.",
    "status": 400
  }
}
```

---

### 1.2 `POST /api/chat`

Sends a question to Claude about a specific PR. Streams the response as Server-Sent Events.

**Route handler:** `src/app/api/chat/route.ts`

> [!IMPORTANT]
> This endpoint requires `ANTHROPIC_API_KEY` to be set. When the key is absent the endpoint returns `503 SERVICE_UNAVAILABLE`.

#### Request Body

```jsonc
{
  "repo": "acme/backend",
  "prNumber": 1042,
  "question": "Why is this PR scored so high? What should I focus on?",
  "history": [
    {
      "role": "user",
      "content": "Summarise the risk"
    },
    {
      "role": "assistant",
      "content": "This PR modifies the JWT signing logic in auth/..."
    }
  ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `repo` | `string` | **Yes** | Repository slug `owner/name` |
| `prNumber` | `number` | **Yes** | GitHub PR number |
| `question` | `string` | **Yes** | The reviewer's question. Max 2000 characters. |
| `history` | `ChatMessage[]` | No | Prior conversation turns. Max 20 entries. |

#### Response — `200 OK` (SSE Stream)

The response is a `text/event-stream`. Each event delivers an incremental text chunk:

```
data: {"delta": "This PR touches the JWT signing"}

data: {"delta": " key rotation logic, which carries"}

data: {"delta": " a domain-criticality score of 0.95..."}

data: [DONE]
```

The stream terminates with the literal `data: [DONE]` sentinel.

#### Error Responses

| Status | Code | Description |
|---|---|---|
| `400` | `MISSING_FIELDS` | `repo`, `prNumber`, or `question` is absent |
| `400` | `INVALID_QUESTION` | Question exceeds 2000 characters |
| `401` | `UNAUTHORIZED` | `GITHUB_TOKEN` is missing or invalid |
| `404` | `PR_NOT_FOUND` | PR does not exist in the specified repository |
| `503` | `LLM_UNAVAILABLE` | `ANTHROPIC_API_KEY` is not configured |
| `500` | `INTERNAL_ERROR` | Unexpected server-side error |

---

## 2. TypeScript Interfaces

### 2.1 `TriagedPR`

The top-level object returned in the `queue` array by `GET /api/prs`.

**Source:** `src/lib/types.ts`

```typescript
interface TriagedPR {
  // GitHub PR metadata
  prNumber: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  labels: string[];
  baseBranch: string;
  headBranch: string;
  createdAt: string;        // ISO 8601
  updatedAt: string;        // ISO 8601

  // Computed risk assessment
  assessment: RiskAssessment;

  // Raw signals — only present when ?signals=true
  signals?: PRSignals;
}
```

---

### 2.2 `RiskAssessment`

The complete output of the scoring pipeline for a single PR.

**Source:** `src/lib/engines/types.ts`

```typescript
interface RiskAssessment {
  /** Final score after all stages. Range: 0–100. */
  score: number;

  /** Human-readable risk level derived from the final score. */
  riskLevel: "low" | "medium" | "high" | "critical";

  /**
   * Fraction of signal sources that were available (0.0–1.0).
   * Computed as a weighted sum over SignalAvailability flags.
   */
  confidence: number;

  /** true when confidence < 0.6. Shown as a warning badge in the UI. */
  lowConfidence: boolean;

  /** Per-dimension breakdown. Always 7 entries. */
  dimensions: DimensionResult[];

  /** All modifiers evaluated; includes inactive ones with active: false. */
  modifiers: Modifier[];

  /** IDs of floor rules that were triggered and raised the score. */
  activeFloors: string[];

  /** Sum of (rawScore x weight x 100) before any modifiers. */
  baseScore: number;

  /** baseScore + clamped modifier sum. Pre-floor. */
  adjustedScore: number;

  /** Final score after floors applied. Equals assessment.score. */
  finalScore: number;
}
```

---

### 2.3 `DimensionResult`

One entry per scoring dimension, returned inside `RiskAssessment.dimensions`.

**Source:** `src/lib/engines/types.ts`

```typescript
interface DimensionResult {
  /** Unique dimension identifier. */
  name:
    | "blast-radius"
    | "domain-criticality"
    | "test-posture"
    | "historical-instability"
    | "change-complexity"
    | "dependencies"
    | "author-provenance";

  /** Normalised signal value before weighting. Range: 0.0–1.0. */
  rawScore: number;

  /** Fixed weight for this dimension. All weights sum to 1.0. */
  weight: number;

  /**
   * Points contributed to baseScore.
   * contribution = rawScore x weight x 100
   */
  contribution: number;

  /** Human-readable explanation of why this score was assigned. */
  rationale: string;
}
```

---

### 2.4 `Modifier`

Represents a bonus or penalty applied after base scoring.

**Source:** `src/lib/engines/types.ts`

```typescript
interface Modifier {
  /** Unique modifier identifier. */
  id:
    | "ci-failing"
    | "hotfix-branch"
    | "urgent-label"
    | "already-approved"
    | "draft"
    | "generated-only"
    | "docs-only";

  /** Display label for UI. */
  label: string;

  /**
   * Point delta. Positive = risk increase, negative = risk decrease.
   * The sum of all active modifier deltas is clamped to +-30 before application.
   */
  delta: number;

  /** Whether the modifier's condition was met for this PR. */
  active: boolean;

  /** Explanation of why this modifier is or is not active. */
  reason: string;
}
```

---

### 2.5 `PRSignals`

The complete measured state of a PR, as produced by the Signal Layer.

**Source:** `src/lib/signals/types.ts`

```typescript
interface PRSignals {
  // Metadata
  prNumber: number;
  title: string;
  author: string;
  authorType: "human" | "bot" | "unknown";
  isDraft: boolean;
  labels: string[];
  baseBranch: string;
  headBranch: string;
  createdAt: string;
  updatedAt: string;
  bodyLength: number;

  // Diff
  additions: number;
  deletions: number;
  changedFiles: string[];
  /**
   * Maps each changed file path to its detected category and weight.
   * e.g. { "src/auth/jwt.ts": { category: "auth", weight: 1.0 } }
   */
  fileCategories: Record<string, { category: FileCategory; weight: number }>;

  // CI
  ciStatus: "passing" | "failing" | "pending" | "unknown";
  ciCheckCount: number;
  ciFailingCount: number;

  // Reviews
  approvalCount: number;
  reviewerCount: number;
  changeRequestCount: number;

  // History
  /** Average commits per week for all touched files over the past 90 days. */
  fileChurnRate: number;
  /** Fraction of recent commits that reference a bug fix (0.0–1.0). */
  bugFixFrequency: number;
  /** Mean age of the touched files in days since first commit. */
  fileAgeDays: number;

  // Ownership
  hasCodeowners: boolean;
  /** Fraction of changed files that have at least one entry in CODEOWNERS. */
  ownersCoverage: number;

  // Dependencies
  hasLockfileChanges: boolean;
  hasManifestChanges: boolean;
  dependencyChangeCount: number;

  // AI Authorship
  authorProvenance: AuthorProvenance;

  // Signal Availability
  availability: SignalAvailability;
}

interface AuthorProvenance {
  /** True if 2 or more independent AI-authorship hints are detected. */
  likelyAIAuthored: boolean;
  hints: Array<
    | "botAuthor"
    | "coAuthoredByTrailer"
    | "branchNamePattern"
    | "commitCadence"
    | "templatedBody"
  >;
}

interface SignalAvailability {
  metadata: boolean;      // weight 0.35
  patches: boolean;       // weight 0.15
  history: boolean;       // weight 0.20
  ci: boolean;            // weight 0.10
  reviews: boolean;       // weight 0.08
  codeowners: boolean;    // weight 0.05
  authorHistory: boolean; // weight 0.07
}
```

---

### 2.6 `QueueSummary`

Top-level statistics for the scored queue.

**Source:** `src/lib/types.ts`

```typescript
interface QueueSummary {
  /** Total open PRs in the repository (before `limit` is applied). */
  total: number;

  /** Number of PRs returned in this response (<= limit). */
  returned: number;

  /** Count of PRs at each risk level in the returned set. */
  critical: number;
  high: number;
  medium: number;
  low: number;

  /** Mean final score across the returned set. */
  averageScore: number;

  /** ISO 8601 timestamp of when this response was generated. */
  generatedAt: string;
}
```

---

### 2.7 `ChatMessage`

A single turn in a conversation, used in the `history` field of `POST /api/chat`.

**Source:** `src/lib/types.ts`

```typescript
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
```

---

### 2.8 `AppConfig`

The parsed and merged configuration object produced by `loadConfig()`.

**Source:** `src/lib/config.ts`

```typescript
interface AppConfig {
  paths: PathRule[];

  thresholds: {
    low: number;       // default: 25
    medium: number;    // default: 50
    high: number;      // default: 75
  };

  policy: {
    /** Maximum score a PR may have to be fast-tracked. */
    fastTrackMaxRisk: number;       // default: 25
    /** File categories that can never be fast-tracked regardless of score. */
    neverFastTrack: FileCategory[]; // default: ["auth", "payments", "database"]
    /** Whether CI must be passing for fast-track to be allowed. */
    requireCiPassing: boolean;      // default: true
  };

  llm: {
    enabled: boolean;               // default: true
  };
}

interface PathRule {
  category: FileCategory;
  weight: number;        // 0.0–1.0
  patterns: string[];    // glob patterns
}
```

---

## 3. Internal Function Signatures

### 3.1 Signal Layer

#### `collectSignals`

```typescript
// src/lib/signals/collect.ts

/**
 * Fetches all available signals for a single pull request.
 *
 * @param repo     - Repository slug "owner/name"
 * @param prNumber - GitHub PR number
 * @param config   - Application config (used for path rules)
 * @returns        - Fully-populated PRSignals object
 * @throws         - GitHubError on network or API failure
 */
async function collectSignals(
  repo: string,
  prNumber: number,
  config: AppConfig,
): Promise<PRSignals>
```

#### `collectQueueSignals`

```typescript
/**
 * Fetches signals for an array of PRs in parallel.
 * Respects MAX_CONCURRENT = 6 at the Octokit layer.
 *
 * @param repo   - Repository slug
 * @param prs    - Array of PR stubs from the GitHub list endpoint
 * @param config
 * @returns      - Array of PRSignals in the same order as input
 */
async function collectQueueSignals(
  repo: string,
  prs: GitHubPRStub[],
  config: AppConfig,
): Promise<PRSignals[]>
```

#### `classifyPath`

```typescript
// src/lib/signals/classify.ts

/**
 * Determines the file category and risk weight for a given file path.
 * Rules are evaluated in order; first match wins.
 *
 * @param filePath - Relative path within the repository
 * @param rules    - Ordered list of PathRules (config overrides + defaults)
 * @returns        - { category, weight }
 */
function classifyPath(
  filePath: string,
  rules: PathRule[],
): { category: FileCategory; weight: number }
```

#### `parseCodeowners`

```typescript
/**
 * Parses a CODEOWNERS file into a structured ownership map.
 *
 * @param content - Raw text content of the CODEOWNERS file
 * @returns       - Map of glob pattern to owner handles
 */
function parseCodeowners(content: string): Map<string, string[]>
```

#### `ownersForPath`

```typescript
/**
 * Returns the set of owners responsible for a given file path.
 *
 * @param filePath - Relative repository path
 * @param ownerMap - Result of parseCodeowners()
 * @returns        - Array of owner handles (e.g. "@acme/auth-team")
 */
function ownersForPath(
  filePath: string,
  ownerMap: Map<string, string[]>,
): string[]
```

---

### 3.2 Engine Layer

#### `assessRisk`

```typescript
// src/lib/engines/risk-engine.ts

/**
 * Computes the complete risk assessment for a PR from its signals.
 * Pure function — no I/O, no side effects.
 *
 * Pipeline:
 *   1. Run all 7 dimension functions -> DimensionResult[]
 *   2. Compute baseScore = sum(rawScore x weight x 100)
 *   3. Evaluate all MODIFIER_RULES -> active Modifier[]
 *   4. clamp(sum(active deltas), -30, +30) -> clampedModifiers
 *   5. adjustedScore = clamp(baseScore + clampedModifiers, 0, 100)
 *   6. Evaluate FLOOR_RULES -> activeFloors
 *   7. finalScore = max(adjustedScore, max(activeFloors))
 *   8. Derive riskLevel from finalScore + thresholds
 *   9. Compute confidence from SignalAvailability weights
 *
 * @param signals - Fully-populated PRSignals
 * @param config  - Application config (thresholds, path rules, policy)
 * @returns       - Complete RiskAssessment
 */
function assessRisk(signals: PRSignals, config: AppConfig): RiskAssessment
```

#### `baselineScore`

```typescript
/**
 * Computes the unweighted baseline score from dimension results.
 * Exported for unit-testing purposes.
 *
 * @param dimensions - Array of DimensionResult (7 items)
 * @returns          - Sum of contributions (0–100)
 */
function baselineScore(dimensions: DimensionResult[]): number
```

#### Dimension Functions

Each dimension lives in `src/lib/engines/dimensions/` and shares the same signature:

```typescript
// Generic signature for all 7 dimension functions
type DimensionFn = (
  signals: PRSignals,
  config: AppConfig,
) => DimensionResult;

// Individual exports:
export function blastRadius(signals, config): DimensionResult           // weight: 0.20
export function domainCriticality(signals, config): DimensionResult     // weight: 0.20
export function testPosture(signals, config): DimensionResult           // weight: 0.15
export function historicalInstability(signals, config): DimensionResult // weight: 0.15
export function changeComplexity(signals, config): DimensionResult      // weight: 0.12
export function dependencies(signals, config): DimensionResult          // weight: 0.10
export function authorProvenance(signals, config): DimensionResult      // weight: 0.08
```

---

### 3.3 AI Layer

#### `chatWithClaude`

```typescript
// src/lib/claude.ts

/**
 * Sends a question to Claude with full PR context and streams the response.
 *
 * The assessment is serialised into the system prompt so that Claude
 * explains the pre-computed score — it does NOT recompute a score.
 *
 * @param assessment - Pre-computed RiskAssessment (becomes system context)
 * @param history    - Prior conversation turns (max 20)
 * @param question   - The reviewer's question
 * @returns          - AsyncIterable of text chunks (streamed tokens)
 * @throws           - LLMUnavailableError when ANTHROPIC_API_KEY is absent
 */
function chatWithClaude(
  assessment: RiskAssessment,
  history: ChatMessage[],
  question: string,
): AsyncIterable<string>
```

---

### 3.4 Config Layer

#### `loadConfig`

```typescript
// src/lib/config.ts

/**
 * Reads and parses .pocketreview.yml from the project root.
 * Merges user-provided values with built-in defaults.
 * Returns safe defaults if the file is absent or malformed.
 *
 * @param projectRoot - Absolute path to the project root (default: process.cwd())
 * @returns           - Validated AppConfig
 */
async function loadConfig(projectRoot?: string): Promise<AppConfig>
```

---

### 3.5 Math Utilities

**Source:** `src/lib/math.ts`

```typescript
/**
 * Clamps value to [min, max].
 * @default min=0, max=1
 */
function clamp(value: number, min?: number, max?: number): number

/**
 * Saturating curve: f(x) = 1 - e^(-x / knee)
 * Produces diminishing returns — useful for normalising unbounded counts.
 * @param knee - The x value at which f(x) is approximately 0.63
 */
function saturate(value: number, knee: number): number

/** Arithmetic mean of a number array. */
function mean(values: number[]): number

/**
 * Weighted mean.
 * @param pairs - Array of [value, weight] tuples
 */
function weightedMean(pairs: [number, number][]): number

/**
 * Shannon entropy of a probability distribution, normalised to 0..1.
 * Used by blast-radius to measure file-category spread.
 * @param distribution - Array of non-negative values (need not sum to 1)
 */
function normalisedEntropy(distribution: number[]): number

/**
 * Exponential decay.
 * f(age) = e^(-age / halfLife)
 * Used by historical-instability to down-weight old churn data.
 * @param age      - Age of the observation (e.g. days)
 * @param halfLife - Age at which weight = 0.5
 */
function decay(age: number, halfLife: number): number

/** Rounds value to the specified number of decimal places. */
function round(value: number, places: number): number

/**
 * Safe ratio. Returns 0 when whole is 0.
 * @param part  - Numerator
 * @param whole - Denominator
 */
function ratio(part: number, whole: number): number
```

---

## 4. Enumerations & Literals

### `FileCategory`

```typescript
type FileCategory =
  | "auth"        // weight 1.00 — authentication, sessions, tokens
  | "payments"    // weight 1.00 — billing, Stripe, checkout
  | "database"    // weight 0.85 — migrations, schema, ORM models
  | "infra"       // weight 0.75 — Terraform, k8s, Docker
  | "api"         // weight 0.70 — routes, controllers, handlers
  | "config"      // weight 0.55 — env files, app config
  | "ui"          // weight 0.30 — components, pages, views
  | "test"        // weight 0.10 — test files
  | "docs"        // weight 0.05 — markdown, README
  | "generated";  // weight 0.00 — auto-generated files
```

### `RiskLevel`

```typescript
type RiskLevel = "low" | "medium" | "high" | "critical";

const RISK_LEVEL_THRESHOLDS = {
  low:      { min: 0,  max: 24 },
  medium:   { min: 25, max: 49 },
  high:     { min: 50, max: 74 },
  critical: { min: 75, max: 100 },
} as const;
```

### `ModifierId`

```typescript
type ModifierId =
  | "ci-failing"       // +8  — CI checks are failing
  | "hotfix-branch"    // +10 — branch name matches hotfix/*
  | "urgent-label"     // +6  — PR has urgent/priority:critical label
  | "already-approved" // -15 — at least one approved review
  | "draft"            // -20 — PR is in draft state
  | "generated-only"   // -25 — all changed files are generated
  | "docs-only";       // -30 — all changed files are docs
```

### `FloorRuleId`

```typescript
type FloorRuleId =
  | "critical-path-untested" // floor: 55 — critical files + tests removed
  | "critical-path"          // floor: 40 — any auth/payments/database file touched
  | "tests-removed";         // floor: 35 — test files deleted, none added
```

### `TriageDecision`

```typescript
type TriageDecision =
  | "fast-track"    // swipe right — policy gate runs
  | "needs-review"  // swipe left  — deep review lane
  | "explain"       // swipe up    — open Claude chat
  | "defer";        // swipe down  — snooze to end of queue
```

---

## 5. Error Reference

### Error Classes

```typescript
// src/lib/errors.ts

class GitHubError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) { super(message); }
}

class LLMUnavailableError extends Error {
  // Thrown by chatWithClaude() when ANTHROPIC_API_KEY is absent
}

class ConfigError extends Error {
  // Thrown by loadConfig() on schema validation failure
}

class PolicyGateError extends Error {
  // Thrown when fast-track is blocked; includes reason
  constructor(
    message: string,
    public readonly reason: string,
    public readonly blockedBy: string,  // e.g. "neverFastTrack:auth"
  ) { super(message); }
}
```

### HTTP Error Codes

| Code | HTTP Status | Meaning |
|---|---|---|
| `MISSING_REPO` | 400 | `repo` query parameter not provided |
| `INVALID_REPO` | 400 | `repo` is not in `owner/name` format |
| `MISSING_FIELDS` | 400 | Required body fields absent in `/api/chat` |
| `INVALID_QUESTION` | 400 | Question exceeds 2000 character limit |
| `UNAUTHORIZED` | 401 | `GITHUB_TOKEN` missing or rejected |
| `FORBIDDEN` | 403 | Token lacks required scope |
| `REPO_NOT_FOUND` | 404 | Repository not accessible |
| `PR_NOT_FOUND` | 404 | PR does not exist in repository |
| `RATE_LIMITED` | 429 | GitHub API rate limit exceeded |
| `LLM_UNAVAILABLE` | 503 | `ANTHROPIC_API_KEY` not configured |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

### Error Response Body

All error responses share this shape:

```typescript
interface ErrorResponse {
  error: {
    code: string;
    message: string;
    status: number;
    details?: unknown;  // Additional context when available
  };
}
```

---

*For architectural context, see [architecture.md](./architecture.md).*
