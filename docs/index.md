# PocketReview — Documentation

> **Intelligent PR triage for AI-accelerated engineering teams.**
> *We don't review your code. We decide where your attention goes.*

---

## Quick Start

```bash
npm install --legacy-peer-deps
cp .env.example .env.local   # Add GITHUB_TOKEN
npm run dev                  # → http://localhost:3000
```

Open in Chrome DevTools → device toolbar → iPhone 14 Pro. PocketReview is a mobile-first triage tool designed for dead-time use: commutes, queues, between meetings.

```bash
# No GitHub account? Run offline:
DEMO_MODE=1 npm run dev
```

---

## Documentation Map

### 🏗️ System Design

| Document | What it covers |
|---|---|
| [Architecture](./architecture.md) | Full system design, layer-by-layer breakdown, data flow diagrams, design principles |
| [Risk Scoring](./risk-scoring.md) | The 7 scoring dimensions, modifier system, floor rules, confidence model, scoring formula |

### 🔌 Integration & Reference

| Document | What it covers |
|---|---|
| [API Reference](./api-reference.md) | REST endpoints, TypeScript interfaces, request/response shapes, internal function signatures |
| [Configuration](./configuration.md) | Environment variables, `.pocketreview.yml` schema, path rules, policy gate, per-repo customization |

### 🎨 Frontend

| Document | What it covers |
|---|---|
| [UI Components](./ui-components.md) | Component inventory, props tables, swipe gestures, risk color system, hooks reference |

### 🔒 Security & Quality

| Document | What it covers |
|---|---|
| [Security](./security.md) | Token scopes, data flow, LLM opt-out, no-persistence guarantee, AI approval prohibition |
| [Testing](./testing.md) | Test runner setup, test categories, key demo test cases, fixture factories, CI guidance |

### 🤝 Contributing

| Document | What it covers |
|---|---|
| [Contributing](./contributing.md) | Dev setup, workflow, adding dimensions, adding path rules, PR checklist |

---

## Core Concept in 30 Seconds

```
GitHub · git history · CI · CODEOWNERS
               │
               ▼
      ┌──────────────────┐
      │   SIGNAL LAYER   │  measurement only — no judgement
      └────────┬─────────┘
               │  PRSignals
    ┌──────────┼──────────┐
    ▼          ▼          ▼
  RISK      REVIEWER    EFFORT
  ENGINE    SUGGEST.    ESTIMATE
    │
    ▼
  87/100  ←── deterministic arithmetic
    │
    └──▶  LLM writes prose about 87   (optional, can be disabled)
```

The **score is computed in code**. The LLM only narrates it. Disable the LLM and every score, ranking, and review plan still works — you lose the English, not the system.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Deterministic scoring | "Why 87?" always has the same answer — a table of contributions that sums to 87 |
| Domain criticality is size-independent | A one-line auth change is as critical as a 400-line one |
| Generated files excluded from size scoring | A 4,000-line lockfile diff must not read as high risk |
| LLM narrates, never decides | No LLM output ever merges code or affects scores |
| Missing signals degrade confidence | A repo without CI still gets scored — with a lower confidence label |
| Mobile-first | Senior reviewers' free moments happen on commutes, not at desks |

---

## Project Structure

```text
src/
├── app/
│   ├── api/
│   │   ├── prs/route.ts        # GET /api/prs — scored queue
│   │   └── chat/route.ts       # POST /api/chat — Claude chat
│   ├── page.tsx                # Main triage UI
│   └── layout.tsx
├── components/
│   ├── SwipeDeck.tsx           # Card stack with swipe gestures
│   ├── PRCard.tsx              # Individual PR card
│   ├── SwipeActions.tsx        # Action buttons
│   ├── ChatScreen.tsx          # Claude chat interface
│   ├── QueueSummaryBar.tsx     # Queue risk distribution
│   └── risk/
│       ├── DimensionBreakdown.tsx  # Full audit view
│       ├── RiskBadge.tsx
│       └── RiskReasons.tsx
├── hooks/
│   ├── usePRs.ts               # Queue data fetching
│   ├── useChat.ts              # Per-PR chat state
│   └── useSwipeHistory.ts      # Triage decision log
└── lib/
    ├── types.ts                # Shared types
    ├── config.ts               # .pocketreview.yml loader
    ├── claude.ts               # Explanation layer
    ├── math.ts                 # Pure numeric helpers
    ├── risk-display.ts         # UI tokens (colors, labels)
    ├── engines/
    │   ├── risk-engine.ts      # assessRisk(), baselineScore()
    │   ├── types.ts            # RiskAssessment, DimensionResult
    │   └── dimensions/         # 7 pure scoring functions
    └── signals/
        ├── types.ts            # PRSignals, FileSignal
        ├── collect.ts          # Signal orchestration
        ├── classify.ts         # Path classification
        ├── path-rules.ts       # Category rules
        ├── github.ts           # Octokit client
        ├── diff.ts             # Diff analysis
        └── history.ts          # Git history analysis
tests/
├── risk-engine.test.mjs
├── signals.test.mjs
├── risk-display.test.mjs
├── demo-queue.test.mjs
└── helpers/
    └── signals.mjs             # Fixture factories
```

---

*PocketReview is a hackathon project. See [README.md](../README.md) for the full project description.*
