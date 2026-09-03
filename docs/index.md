# PocketReview — Documentation

> **Intelligent PR triage for AI-accelerated engineering teams.**
> _We don't review your code. We decide where your attention goes._

---

## Quick start

```bash
npm install --legacy-peer-deps
cp .env.example .env.local   # add GITHUB_TOKEN
npm run dev                  # → http://localhost:3000
```

```bash
# No GitHub account, no network? Run offline:
DEMO_MODE=1 npm run dev
```

Open in Chrome DevTools → device toolbar → iPhone 14 Pro. PocketReview is mobile-first by design: senior reviewers' genuinely free moments happen on commutes and between meetings, not at a desk.

---

## Start here

| Document                               | What it covers                                                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **[Architecture](../ARCHITECTURE.md)** | **The source of truth for the design.** The problem, the thesis, all nine layers, the data model, validation strategy, build phases, judge Q&A. |
| **[PROGRESS.md](./PROGRESS.md)**       | **The source of truth for status.** What is built, what is pending, what was deliberately cut, and the decision log.                            |

Everything else in this folder is reference material for what is _shipped today_.

---

## Reference

| Document                            | What it covers                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| [Risk Scoring](./risk-scoring.md)   | The 7 dimensions with real formulas, modifiers, floors, confidence, the demo table |
| [API Reference](./api-reference.md) | Endpoints, TypeScript interfaces, internal signatures                              |
| [Configuration](./configuration.md) | Env vars, `.pocketreview.yml`, path rules and precedence, thresholds               |
| [UI Components](./ui-components.md) | Component props, gestures, colour system, hooks                                    |
| [Security](./security.md)           | Token scopes, LLM opt-out, persistence, the policy gate                            |
| [Testing](./testing.md)             | Test suites, the claims they defend, fixtures, the eval harness                    |
| [Contributing](./contributing.md)   | Setup, the four invariants, adding dimensions and signals                          |

**Status convention.** Reference docs mark every section ✅ **Shipped** (verified against source) or 🕐 **Planned — Phase N** (designed in the architecture, not yet built). The architecture document describes the complete target system; these describe the code as it exists.

---

## The idea in 30 seconds

Code review is the only stage of the software lifecycle that AI made _worse_. Writing accelerated 4–5×; review still runs at the speed of one human reading one diff. When arrival rate exceeds service rate, the queue grows without bound — and what gets silently dropped is review quality.

PocketReview treats **reviewer attention as a resource to allocate**, not a queue to drain.

```
GitHub · git history · CI · CODEOWNERS
               │
               ▼
      ┌──────────────────┐
      │   SIGNAL LAYER   │  measurement only — no judgement
      └────────┬─────────┘
               │  PRSignals
               ▼
      ┌──────────────────┐
      │   RISK ENGINE    │  7 weighted dimensions
      └────────┬─────────┘
               │
             87/100  ←── deterministic arithmetic
               │
               └──▶  LLM writes prose about 87   (optional)
```

**The score is computed in code. The LLM only narrates it.** Disable the LLM and every score, ranking and breakdown still works — you lose the English, not the system.

We do not answer _"is this code correct?"_ — that is unsolved. We answer:

> _"Given 17 open PRs and 30 minutes, which should this engineer open, in what order, and what should they look at first?"_

---

## The demo table — measured, reproducible

Reproduce with `npm test`:

| Scenario                | Lines |      PocketReview | Lines-changed baseline |
| ----------------------- | ----: | ----------------: | ---------------------: |
| One-line auth change    |     2 |     **55** · high |                      0 |
| 4,000-line lockfile     | 5,000 |       **0** · low |                    100 |
| Docs typo fix           |    10 |       **0** · low |                      1 |
| Auth + payments rewrite |   660 | **89** · critical |                     66 |

The baseline ranks the lockfile at 100 and the auth change at 0 — **exactly inverted.**

---

## Key design decisions

| Decision                                   | Rationale                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| Deterministic scoring                      | _"Why 87?"_ always has the same answer — a table of contributions summing to 87 |
| Domain criticality is size-independent     | A one-line auth change is as critical as a 400-line one                         |
| Generated files excluded from size scoring | A 4,000-line lockfile must not read as high risk                                |
| Floors on top of the weighted sum          | Averaging is wrong for categorical facts; a floor only ever raises              |
| LLM narrates, never decides                | No model output merges code or affects a score                                  |
| Missing signals degrade confidence         | A repo without CI still gets scored — with an honest label                      |
| AI provenance weighted at 0.08             | Source-agnostic: max ~3 points of 100                                           |
| Mobile-first                               | Free moments happen on commutes, not at desks                                   |

Full reasoning in the [Decision Log](./PROGRESS.md#decision-log).

---

## Where the project stands

```
  Phase 0  Foundation & branding      ██████████  100%   ✅
  Phase 1  Signal Layer               ██████████  100%   ✅
  Phase 2  Risk Engine                ██████████  100%   ✅
  Phase 3  Deck & risk UI             ██████████  100%   ✅
  Phase 4  Priority & effort          ██████████  100%   ✅
  Phase 5  Review plan                ██████████  100%   ✅
  Phase 6  Explanation layer          ██████████  100%   ✅
  Phase 7  Reviewer engine            ░░░░░░░░░░    0%   ⚠ first to cut
  Phase 8  Policy gate & eval         ░░░░░░░░░░    0%   ⬅ NEXT
  Phase 9  Hardening & demo           ░░░░░░░░░░    0%
```

**147/147 tests pass · typecheck clean · production build succeeds.**

Never cut: **Risk Engine** (2) ✅, **Review Plan** (5) ✅, **Eval harness** (8). Those three are the project; everything else is presentation.

---

## Project structure

```text
src/
├── app/
│   ├── api/
│   │   ├── prs/route.ts                        # GET — scored queue
│   │   ├── prs/[repo]/[number]/risk/route.ts   # GET — full assessment
│   │   ├── prs/[repo]/[number]/signals/route.ts# GET — raw measurements
│   │   ├── prs/[repo]/[number]/diff/route.ts   # GET — unified diff
│   │   └── chat/route.ts                       # POST — Claude chat
│   ├── page.tsx                                # triage UI orchestrator
│   └── layout.tsx
├── components/
│   ├── SwipeDeck.tsx · PRCard.tsx · SwipeActions.tsx
│   ├── QueueSummaryBar.tsx · Header.tsx · EmptyState.tsx
│   ├── ChatScreen.tsx
│   └── risk/
│       ├── DimensionBreakdown.tsx              # the credibility screen
│       ├── RiskBadge.tsx
│       └── RiskReasons.tsx
├── hooks/
│   ├── usePRs.ts · useChat.ts · useSwipeHistory.ts
└── lib/
    ├── types.ts · config.ts · claude.ts · math.ts · risk-display.ts
    ├── demo/fixtures.ts                        # DEMO_MODE data
    ├── engines/
    │   ├── risk-engine.ts                      # assessRisk(), baselineScore()
    │   ├── types.ts
    │   └── dimensions/                         # 7 pure scoring functions
    └── signals/
        ├── types.ts · collect.ts · classify.ts
        ├── path-rules.ts · github.ts · diff.ts · history.ts
tests/
├── risk-engine.test.mjs · signals.test.mjs
├── risk-display.test.mjs · demo-queue.test.mjs
└── helpers/signals.mjs
```

Directories in architecture §15 that do not exist yet: `lib/engines/reviewer-engine.ts`, `lib/policy/`, `lib/cache/`, `eval/`, `fixtures/`.

---

## The four sentences

1. **AI multiplied code output. It did not multiply reviewer attention.**
2. **We do not judge whether code is correct. We decide where a human should look first.**
3. **The score is computed in code; the LLM only narrates it.**
4. **We never let an AI approve code written by an AI.**

---

_PocketReview is a hackathon project. See [README.md](../README.md) for the project description._
