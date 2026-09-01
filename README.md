<div align="center">

# PocketReview

**Intelligent PR triage for AI-accelerated engineering teams.**

*We don't review your code. We decide where your attention goes.*

</div>

---

## The problem

Code review is the only stage of the software lifecycle that AI has made **worse**.

Writing code got faster. Generating tests got faster. Scaffolding, drafting, refactoring — all faster. Review still runs at exactly the speed of one human reading one diff, and that speed has not moved.

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

When arrival rate exceeds service rate, the queue does not stabilise. It grows until something is dropped — and what gets dropped is review *quality*, silently, because a reviewer facing 15 PRs starts skimming.

Three things make it worse than a volume problem:

- **The trust tax.** Reviewers can't skim AI-authored code the way they skim a trusted colleague's. Every AI PR absorbs full scrutiny, so throughput *falls* while arrival rate *rises*.
- **Existing tools optimise the wrong variable.** Automated reviewers add generated commentary to each PR. That improves review quality — and increases reading load per PR. The bottleneck is throughput.
- **The attention mismatch.** A senior reviewer's genuinely free moments happen on a commute, between meetings, in a queue. Every review tool assumes a desk and an uninterrupted block.

## What PocketReview does

PocketReview treats **reviewer attention as a resource to be allocated**, not a queue to be drained.

It does not try to answer *"is this code correct?"* — that's unsolved, and any system claiming otherwise is lying. It answers a strictly easier, strictly more useful question:

> **Given 17 open PRs and 30 minutes of a senior engineer's time — which PRs should they open, in what order, and what should they look at first?**

Every PR is scored, ranked, costed, and explained. The reviewer triages the queue from their phone in dead time, then spends their focused hours on the PRs that actually earned them.

**A human still reviews every pull request.** What changes is depth and order — and that's the entire saving. Deciding *whether* a PR needs deep thought costs 30 seconds of judgement; today it costs a 15-minute context switch, because the only way to learn a PR was a typo fix is to open it and read it.

## What it is — and is not

| | |
|---|---|
| ❌ **Not** an AI code reviewer | No line-level review comments. |
| ❌ **Not** an auto-approval bot | No LLM output ever merges code. |
| ❌ **Not** GitHub-on-a-phone | Deliberately shows *less*, not the same thing smaller. |
| ✅ **Is** a triage and attention-allocation system | Rank, explain, estimate, assign, schedule. |
| ✅ **Is** deterministic at its core | Scores are arithmetic over measured signals. |
| ✅ **Is** explainable end-to-end | Every point traces back to a named signal. |

### The core design decision

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

If an LLM produced the number, *"why 87?"* has no answer. Because arithmetic produces it, the answer is a table of contributions that sums to 87 and is identical on every run.

Turn the LLM off entirely and every score, ranking, and review plan still works. You lose the English, not the system.

## How it works

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

### Risk scoring

Seven weighted dimensions, each returning a normalised sub-score plus human-readable reasons:

| Dimension | Weight | What it captures |
|---|---|---|
| Blast radius | 0.20 | Files, lines, spread across subsystems |
| Domain criticality | 0.20 | Auth, payments, database, infra — **size-independent** |
| Test posture | 0.15 | Coverage ratio; removed tests force maximum |
| Historical instability | 0.15 | Churn, revert rate, prior incident files |
| Change complexity | 0.12 | Control-flow delta, nesting, deletion-heavy changes |
| Dependencies | 0.10 | New packages, major bumps, supply chain |
| Author & provenance | 0.08 | First-time contributor, revert history, AI hints |

Domain criticality being **size-independent** is the point. A one-line change to `src/auth/session.ts` scores high there regardless of size — which is exactly the failure mode of naive "risk = lines changed" scoring.

Generated files (lockfiles, snapshots, build output) are excluded from size scoring. A 4,000-line lockfile diff must never read as high risk.

### Review planning

Priority ordering is useless without knowing what each item costs. PocketReview estimates review minutes per PR, then solves:

```
maximise   Σ priority(pr) · x(pr)
subject to Σ minutes(pr) · x(pr) ≤ budget
```

This is 0/1 knapsack. With integer minutes and n ≤ 50, exact dynamic programming runs in `O(n · budget)` — microseconds, no approximation. Critical PRs are force-included when any single one fits, and the plan orders highest-risk first, while the reviewer is freshest.

```
  YOU HAVE 30 MINUTES

  🔴 #147  Auth token rewrite      22 min
  🟠 #152  Rate limiter change      5 min
  🟢 #155  Config update            2 min
  ─────────────────────────────────────
  29 min · 71% of queue risk covered
```

### The policy gate

A right swipe is a **recommendation, never a merge**. The gate can only *remove* eligibility — never grant it.

```
  risk < threshold      ✓/✗
  CI passing            ✓/✗
  no critical paths     ✓/✗     auth · payments · database
  no dependency changes ✓/✗
  tests not removed     ✓/✗
  branch rules allow    ✓/✗
```

Fail any check and the card refuses to leave the deck — it flips and shows why. Critical paths can never be fast-tracked regardless of score. Structurally impossible, not discouraged.

> **We never let an AI approve code written by an AI.**

## Triage gestures

| Gesture | Action | Effect |
|---|---|---|
| **→ right** | Fast-track | Policy gate runs. Marked fast-lane. No merge, no approval. |
| **← left** | Needs review | Deep lane. Enters the review plan with an effort estimate. |
| **↑ up** | Explain | Summary, where-to-look-first, questions to ask. Optional voice. |
| **↓ down** | Defer | Snoozed; resurfaces via age decay. |

## Validation

We don't claim to predict bugs. We claim to **rank PRs by required human attention** — so we validate the ranking.

Ground truth comes from history that already happened. A merged PR is labelled attention-worthy if it was reverted, followed by a fix commit within 7 days, received "changes requested", needed more than 3 review rounds, or its files appear in a later hotfix. All scriptable from git history and the GitHub API — no manual labelling.

```bash
npm run eval
```

Metrics: **Recall@K** (headline), Precision@K, NDCG, and lift over a lines-changed baseline. Results are committed to `eval/results.md`.

## Getting started

**Requirements:** Node.js 18+, a GitHub token with `repo:read`, and optionally an Anthropic API key.

```bash
npm install --legacy-peer-deps

cp .env.example .env.local
# GITHUB_TOKEN=ghp_...
# ANTHROPIC_API_KEY=sk-ant-...   (optional — omit to run deterministic-only)

npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Designed for a phone viewport — in Chrome devtools, toggle the device toolbar and pick iPhone 14 Pro.

### Offline / demo mode

```bash
DEMO_MODE=1 npm run dev
```

Serves captured real PRs from `fixtures/`. The full application runs with no network.

## Configuration

Per-repo settings live in `.pocketreview.yml`:

```yaml
paths:
  - category: auth
    weight: 1.0
    patterns: ["auth", "session", "token", "rbac"]

thresholds:
  low: 25
  medium: 50
  high: 75

policy:
  fastTrackMaxRisk: 25
  neverFastTrack: [auth, payments, database]
  requireCiPassing: true

llm:
  enabled: true      # false → deterministic-only, no code leaves your network
```

## Security & privacy

- **Token scope is `repo:read`.** No merge or approve endpoint is wired.
- **Diffs are sent to the LLM** when it's enabled — stated plainly, gated behind a flag, and fully optional.
- **No source code is persisted.** The cache stores signals and explanations, never diff content.
- **Secrets are redacted** from diffs before dispatch.
- **Tokens are server-side only** and never reach the client.

## Tech stack

| | |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS |
| GitHub | Octokit (REST + GraphQL) |
| AI | Anthropic SDK — explanation layer only |
| Cards | react-tinder-card + @react-spring/web |
| Voice | Web Speech API |

## Documentation

Full system design, engine specifications, data model, API surface, and build phases: **[ARCHITECTURE.md](ARCHITECTURE.md)**.



<div align="center">

**AI multiplied code output. It did not multiply reviewer attention.**

</div>
