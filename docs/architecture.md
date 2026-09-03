# PocketReview — System Architecture

> **The score is computed in code. The LLM only narrates it.**

---

## Table of Contents

1. [Design Philosophy](#design-philosophy)
2. [System Overview](#system-overview)
3. [Layer Breakdown](#layer-breakdown)
4. [Data Flow](#data-flow)
5. [Risk Scoring Pipeline](#risk-scoring-pipeline)
6. [Signal Availability & Confidence](#signal-availability--confidence)
7. [Policy Gate & Triage Model](#policy-gate--triage-model)
8. [Mobile-First Design](#mobile-first-design)

---

## Design Philosophy

PocketReview is built around a single non-negotiable constraint:

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

If an LLM produced the number, "why 87?" has no answer. Because arithmetic produces it, the answer is a table of contributions that sums to 87 and is identical on every run.

Turn the LLM off entirely and every score, ranking, and review plan still works. You lose the English, not the system.

### What PocketReview is — and is not

| | |
|---|---|
| ❌ **Not** an AI code reviewer | No line-level review comments |
| ❌ **Not** an auto-approval bot | No LLM output ever merges code |
| ❌ **Not** GitHub-on-a-phone | Deliberately shows *less*, not the same thing smaller |
| ✅ **Is** a triage and attention-allocation system | Rank, explain, estimate, assign |
| ✅ **Is** deterministic at its core | Scores are arithmetic over measured signals |
| ✅ **Is** explainable end-to-end | Every point traces back to a named signal |

---

## System Overview

```
GitHub · git history · CI · CODEOWNERS
                 │
                 ▼
        ┌─────────────────┐
        │  SIGNAL LAYER   │  measurement only, no judgement
        └────────┬────────┘
                 │  PRSignals
     ┌───────────┼───────────┐
     ▼           ▼           ▼
  ┌──────┐  ┌────────┐  ┌────────┐
  │ RISK │  │REVIEWER│  │ EFFORT │
  └───┬──┘  └───┬────┘  └───┬────┘
      └─────────┼───────────┘
                ▼
        ┌───────────────┐
        │   PRIORITY    │  risk ≠ priority
        └───────┬───────┘
     ┌──────────┼──────────┐
     ▼          ▼          ▼
  ┌──────┐ ┌─────────┐ ┌────────┐
  │ PLAN │ │ EXPLAIN │ │ POLICY │
  │ (DP) │ │  (LLM)  │ │  GATE  │
  └───┬──┘ └────┬────┘ └───┬────┘
      └─────────┼──────────┘
                ▼
        MOBILE TRIAGE UI
```

Only the explanation layer is non-deterministic — and it can only produce words, never numbers, never decisions.

---

## Layer Breakdown

### Signal Layer

**Location:** `src/lib/signals/`

The signal layer measures everything that can be measured about a pull request and records it as a flat, typed `PRSignals` object. It makes no judgements — only observations.

#### Key Files

| File | Responsibility |
|---|---|
| `github.ts` | Octokit REST client. Shared singleton, `MAX_CONCURRENT=6` parallel fetches |
| `collect.ts` | Signal orchestration. `collectSignals()` assembles a full `PRSignals` from all sources |
| `classify.ts` | `classifyPath()` maps a file path to a category and criticality weight |
| `path-rules.ts` | `DEFAULT_PATH_RULES` ordered list. First matching rule wins |
| `diff.ts` | Diff text analysis — patch line counting, dependency change detection |
| `history.ts` | Git history analysis — file churn, revert rate, prior incident files |
| `types.ts` | `PRSignals`, `FileSignal`, `AIAuthorshipHints`, `SignalAvailability` interfaces |

#### Signal Collection Flow

```
collectSignals(repo, number)
  │
  ├── getPR()              [required] metadata, branch, author
  ├── getPRFiles()         [required] file list + patches
  │
  └── parallel:
      ├── getChecks()      [optional] CI status
      ├── getReviews()     [optional] review state, approvals
      ├── getCodeowners()  [optional] ownership rules
      ├── collectHistory() [optional] churn, reverts, incidents
      ├── getPRCommits()   [optional] commit messages, timestamps
      └── getAuthorHistory()[optional] author's prior PR track record
```

Every optional fetch is caught individually. A missing source records `availability[field] = false` rather than failing the entire collection.

#### File Categories and Weights

| Category | Weight | Example Patterns |
|---|---|---|
| `generated` | 0.00 | `package-lock.json`, `yarn.lock`, `*.snap`, `dist/`, `build/` |
| `test` | 0.10 | `*.test.ts`, `*.spec.js`, `__tests__/`, `tests/` |
| `docs` | 0.05 | `*.md`, `docs/`, `LICENSE`, `CHANGELOG` |
| `auth` | 1.00 | `auth/`, `session/`, `jwt/`, `rbac/`, `credential/` |
| `payments` | 1.00 | `payment/`, `billing/`, `checkout/`, `stripe/` |
| `database` | 0.85 | `migrations/`, `schema/`, `*.sql`, `*.prisma` |
| `infra` | 0.75 | `Dockerfile`, `.github/workflows/`, `*.tf`, `k8s/` |
| `api` | 0.70 | `routes/`, `controllers/`, `handlers/`, `middleware/` |
| `config` | 0.55 | `config/`, `.env`, `package.json`, `*.yaml` |
| `ui` | 0.30 | `components/`, `pages/`, `*.css`, `*.scss` |
| `other` | 0.40 | fallback for unmatched paths |

> **Rule precedence:** `generated` and `test` are checked before domain rules so `src/auth/session.test.ts` is classified as a test, not auth code.

---

### Engine Layer

**Location:** `src/lib/engines/`

The engine layer is **pure and deterministic**. Given the same `PRSignals`, it always produces the same `RiskAssessment`, byte for byte.

#### Seven Dimensions

Each dimension is a pure function `(PRSignals) → DimensionOutput` returning a `raw` score (0..1), `reasons[]`, and `signalsUsed[]`.

| Dimension | Weight | What it Captures |
|---|---|---|
| `blast-radius` | 0.20 | Files changed, lines changed, spread across subsystems (diffEntropy) |
| `domain-criticality` | 0.20 | Category weight of touched files — **size-independent** |
| `test-posture` | 0.15 | Coverage ratio; tests removed → forces maximum |
| `historical-instability` | 0.15 | File churn rate, revert rate, prior incident files |
| `change-complexity` | 0.12 | Control-flow indicators, deletion-heavy changes, nesting |
| `dependencies` | 0.10 | New packages, major version bumps, supply chain |
| `author-provenance` | 0.08 | First-time contributor, author revert history, AI authorship hints |

> Weights sum exactly to **1.00**. This is asserted at module load — a mistaken edit fails immediately rather than silently skewing every score.

#### Scoring Formula

```
baseScore     = Σ (dimension.raw × dimension.weight × 100)

modifierDelta = clamp(Σ modifiers.delta, −30, +30)   ← capped at ±MODIFIER_CAP

scored        = clamp(baseScore + modifierDelta, 0, 100)

floor         = max applicable floor rule
finalScore    = round(max(scored, floor))
```

#### Modifiers

Modifiers exist for boolean conditions — CI either fails or it doesn't.

| Modifier | Delta | Condition |
|---|---|---|
| `ci-failing` | +8 | CI status is failing |
| `hotfix-branch` | +10 | Targets a release or hotfix branch |
| `urgent-label` | +6 | Labelled incident, security, p0, p1, etc. |
| `already-approved` | −15 | Has existing reviewer approval |
| `draft` | −20 | PR is in draft state |
| `generated-only` | −25 | All files are generated |
| `docs-only` | −30 | All files are docs or generated |

All modifier deltas are summed and capped at **±30 points** in aggregate.

#### Floors

A weighted sum averages, and averaging is wrong for categorical facts. A one-line auth change is not "20% of a risky PR" — it is a change a human must look at. Floors fix this by ensuring a minimum score for categorical facts that averaging would dilute.

| Floor Rule | Floor | Condition |
|---|---|---|
| `critical-path-untested` | 55 | Critical path touched + no tests added |
| `critical-path` | 40 | Any critical path (auth/payments/database) touched |
| `tests-removed` | 35 | Tests removed alongside production changes |

Floors **never apply** to drafts or already-approved PRs. Floors can only **raise** a score, never lower it.

#### Risk Levels

| Level | Score Range | Emoji | Tailwind Color |
|---|---|---|---|
| `low` | 0 – 24 | 🟢 | `emerald` |
| `medium` | 25 – 49 | 🟡 | `amber` |
| `high` | 50 – 74 | 🟠 | `orange` |
| `critical` | 75 – 100 | 🔴 | `red` |

Thresholds are configurable per repository via `.pocketreview.yml`.

---

### Configuration Layer

**Location:** `src/lib/config.ts`

`loadConfig()` reads `.pocketreview.yml` from the working directory, merges user rules with defaults, and caches the result. If the file is absent or unreadable, defaults are a complete working configuration.

User path rules are **prepended** to defaults rather than replacing them, so a repo can add custom critical paths without restating built-in generated-file and test detection.

See [configuration.md](./configuration.md) for the full schema reference.

---

### AI / Explanation Layer

**Location:** `src/lib/claude.ts`

The explanation layer is the only non-deterministic part of the system. It can produce only **words**, never numbers or decisions.

```typescript
chatWithClaude({ prTitle, prBody, diff, history, message }): Promise<string>
```

- Calls the `claude` CLI with the Sonnet model
- Diff is truncated to `MAX_DIFF_CHARS = 8000` before sending
- 60-second timeout, 2MB output buffer
- Returns plain text — the score is not involved

**Disabling the LLM:** Set `llm.enabled = false` in `.pocketreview.yml` or omit `ANTHROPIC_API_KEY`. The scoring pipeline is completely unaffected.

---

### API Layer

**Location:** `src/app/api/`

| Route | Method | Purpose |
|---|---|---|
| `/api/prs` | `GET` | Returns the scored triage queue, highest risk first |
| `/api/chat` | `POST` | Proxies a question to Claude about a specific PR |

The PRs endpoint is **entirely deterministic** — no LLM is involved. The deck paints from this response alone and must never block on anything optional.

See [api-reference.md](./api-reference.md) for full endpoint documentation.

---

### UI Layer

**Location:** `src/components/`, `src/hooks/`, `src/app/page.tsx`

The UI is a mobile-first React application built with Next.js App Router.

#### Component Tree

```
page.tsx  (state orchestrator)
  ├── Header
  ├── QueueSummaryBar          ← risk distribution across queue
  ├── SwipeDeck                ← card stack, top 3 visible
  │   ├── TinderCard (top)     ← swipeable
  │   │   └── PRCard
  │   └── PRCard × 2 (bg)     ← depth illusion
  ├── SwipeActions             ← ← Needs Review │ ↑ Explain │ → Fast Track
  ├── DimensionBreakdown       ← full-screen audit view (conditional)
  └── ChatScreen               ← Claude chat (conditional)
```

#### Custom Hooks

| Hook | Manages |
|---|---|
| `usePRs` | Fetches the scored queue from `/api/prs`, filters triaged PRs client-side |
| `useChat` | Per-PR conversation state, sends messages to `/api/chat` |
| `useSwipeHistory` | In-session triage decision log with risk-at-decision audit trail |

---

## Data Flow

### Live Mode (Full Pipeline)

```
Browser                  Next.js Server              GitHub API
   │                          │                           │
   │── GET /api/prs ──────────▶│                           │
   │                          │── listReviewRequested() ──▶│
   │                          │◀── PR summaries ───────────│
   │                          │                           │
   │                          │── collectQueueSignals() ───┤
   │                          │   (parallel, ≤6 at once)  │
   │                          │   ├── getPR()              │
   │                          │   ├── getPRFiles()         │
   │                          │   ├── getChecks()          │
   │                          │   ├── getReviews()         │
   │                          │   ├── getCodeowners()      │
   │                          │   ├── collectHistory()     │
   │                          │   └── getAuthorHistory()  │
   │                          │◀── PRSignals[] ────────────│
   │                          │                           │
   │                          │── assessRisk() × N (pure, no I/O)
   │                          │
   │◀── { prs[], summary } ───│
   │
   │   (deck renders from this response alone — no LLM wait)
   │
   │── swipe right ──────────▶│ (client-side state only, no API call)
   │── swipe left  ──────────▶│ (client-side state only, no API call)
   │
   │── POST /api/chat ────────▶│── claude CLI ──────────────▶ Anthropic
   │◀── { reply } ────────────│◀──────────────────────────────────────│
```

### Demo Mode (`DEMO_MODE=1`)

```
Browser              Next.js Server
   │                      │
   │── GET /api/prs ──────▶│
   │                      │── DEMO_SIGNALS (src/lib/demo/fixtures.ts)
   │                      │── assessRisk() × N   ← same engine as live!
   │◀── { prs[], summary }│
```

Demo mode swaps the **data source**, never the scoring. Fixtures run through the same engine as live data, so what you see offline is what the engine genuinely produces.

---

## Risk Scoring Pipeline

Step-by-step trace of a one-line auth change through the engine:

```
Input: PRSignals {
  additions: 1, deletions: 1, changedFiles: 1,
  files: [{ path: 'src/auth/session.ts', category: 'auth', categoryWeight: 1.0 }],
  touchesAuth: true,
  criticalPaths: ['src/auth/session.ts'],
  hasNoTests: true,
  ...
}

Step 1: Evaluate 7 dimensions
  [blast-radius]         raw=0.01  × 0.20 × 100 =  0.20  (tiny change)
  [domain-criticality]   raw=0.95  × 0.20 × 100 = 19.00  (auth = weight 1.0)
  [test-posture]         raw=0.80  × 0.15 × 100 = 12.00  (no tests added)
  [historical-instab.]   raw=0.20  × 0.15 × 100 =  3.00
  [change-complexity]    raw=0.05  × 0.12 × 100 =  0.60
  [dependencies]         raw=0.00  × 0.10 × 100 =  0.00
  [author-provenance]    raw=0.10  × 0.08 × 100 =  0.80
                                                   ─────
  baseScore = 35.60

Step 2: Apply modifiers
  (none fire for this PR)
  modifierDelta = 0
  scored = 35.60

Step 3: Apply floors
  critical-path-untested (floor=55): auth touched + hasNoTests → APPLIES
  final = round(max(35.60, 55)) = 55

Result: RiskAssessment {
  score: 55,
  level: 'high',
  baseScore: 35.60,
  modifierDelta: 0,
  floor: 55,
  floorReasons: ['Critical-path change with no test coverage'],
  ...
}
```

Compare: `baselineScore(signals) = round(2/1000 × 100) = 0` — the naive lines-changed model rates this as zero risk. That gap is the product's core value.

---

## Signal Availability & Confidence

Not every repository yields every signal. Rather than failing or scoring on silent zeros, the system records what was available and reports reduced confidence:

| Signal Group | Weight | Notes |
|---|---|---|
| `metadata` | 0.35 | Always required — PR info and file list |
| `patches` | 0.15 | Per-file diff text |
| `history` | 0.20 | Git churn, reverts, incident files |
| `ci` | 0.10 | Check run status |
| `reviews` | 0.08 | Review state and approvals |
| `codeowners` | 0.05 | CODEOWNERS file |
| `authorHistory` | 0.07 | Author's prior PR track record |

```
confidence = Σ(available_weight) / Σ(total_weight)
```

When `confidence < 0.6`, the UI shows a "limited signals" warning. The score is still displayed — a lower-confidence score is more useful than no score.

---

## Policy Gate & Triage Model

A right swipe is a **recommendation, never a merge**. The policy gate can only *remove* eligibility — it can never grant it.

```
Fast-Track Eligibility Check:

  risk.score < policy.fastTrackMaxRisk      ✓ / ✗
  ciStatus === 'passing'                    ✓ / ✗   (if requireCiPassing)
  criticalPaths.length === 0               ✓ / ✗   auth · payments · database
  dependenciesAdded === 0                  ✓ / ✗   (if blockOnDependencyChange)
  testsRemoved === false                   ✓ / ✗   (if blockOnTestRemoval)

  ANY failure → card refuses to leave the deck; shows why
  ALL pass   → card is marked fast-lane
```

> **We never let an AI approve code written by an AI.**

Critical paths (auth, payments, database) can **never** be fast-tracked regardless of score. This is **structurally impossible**, not merely discouraged.

### Triage Actions

| Gesture | Action | Effect |
|---|---|---|
| → Right | Fast-track | Policy gate runs. Marked fast-lane. No merge, no approval. |
| ← Left | Needs review | Deep lane. Enters the review plan with an effort estimate. |
| ↑ Up | Explain | Opens Claude chat about this PR. |
| ↓ Down | Defer | Snoozed; resurfaces via age decay. |

### Triage Decision Model

```typescript
interface TriageRecord {
  repo: string;
  prNumber: number;
  action: "fast-track" | "needs-review" | "defer";
  riskAtDecision: number;  // audit trail
  timestamp: number;
}
```

`riskAtDecision` enables future alerts: "you fast-tracked this at risk 18; it has since changed and now scores 61."

---

## Mobile-First Design

PocketReview is designed for **dead time** — commutes, between meetings, waiting in a queue. The design constraints follow from this:

| Constraint | Rationale |
|---|---|
| Phone viewport (iPhone 14 Pro) | The reviewing moment happens on a phone, not at a desk |
| Swipe gestures (not clicks) | One-handed, glanceable, builds muscle memory quickly |
| Top 3 cards visible | Visual queue depth without cognitive load |
| Risk score visible without opening | Decision in < 2 seconds |
| No diff display | Triaging is routing — the diff is for the desk |
| Deterministic first load | Deck paints instantly; no LLM wait |

**Development target:** Chrome DevTools → device toolbar → iPhone 14 Pro (393×852 px).
