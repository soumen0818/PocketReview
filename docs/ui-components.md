# UI Components

> Corresponds to [architecture.md §14](../ARCHITECTURE.md#14-frontend-architecture).
>
> **Status convention.** ✅ **Shipped** — props verified against the source. 🕐 **Planned (Phase N)** — specified in the architecture, not yet built.

Next.js 16 App Router, React 19, Tailwind. Mobile-first, developed against a 390×844 viewport.

---

## The principle

> **The phone must show _less_, not the same thing smaller.**

GitHub-on-mobile already exists and it is unpleasant. Our advantage is that the reviewer sees a **decision-shaped summary** instead of a diff. Every element on the card must serve a triage decision; anything that does not is removed.

- **Triage, not review.** No line-level diff viewer. The goal is to route the PR, not to read it.
- **Glanceability.** A decision should take under 2 seconds from score, colour and top reasons.
- **Gestures over clicks.** One-handed, muscle-memory driven.
- **Never a loading state for triage-critical information.** The deck paints from deterministic data. If the LLM is down, the degradation is a missing sentence — not a broken product.

---

## Screen map

```
✅ SHIPPED                                    🕐 PLANNED

┌──────────────┐   ┌──────────────┐          ┌──────────────┐
│ ① TRIAGE     │──▶│ ② BREAKDOWN  │          │ ④ PLAN       │
│    DECK      │   │              │          │              │
│ swipe cards  │   │ "show your   │          │ time budget  │
│ risk + why   │   │  working"    │          │ ordered plan │
│ summary bar  │   │ ← credibility│          │ coverage %   │
└──────┬───────┘   └──────────────┘          └──────────────┘
       │                                      Phase 5
       ▼
┌──────────────┐                             ┌──────────────┐
│ ③ CHAT       │  interim — becomes          │ ⑤ REVIEWER   │
│ ask Claude   │  ExplainScreen in Phase 6   │    CARD      │
└──────────────┘                             └──────────────┘
                                              Phase 7
```

The **queue/capacity landing screen** (architecture §14 screen ①) is Phase 5 — today the app opens directly on the deck with a summary bar at the top.

---

## Component tree ✅

```
app/page.tsx                    ← state orchestrator
 │
 ├── Header
 ├── QueueSummaryBar            ← risk distribution + progress
 │
 ├── SwipeDeck
 │    ├── SwipeOverlayCard      ← top card, drag intent overlays
 │    │    └── PRCard
 │    └── PRCard ×N             ← background cards, scaled for depth
 │
 ├── SwipeActions               ← button fallback for the gestures
 │
 ├── DimensionBreakdown         ← conditional, full-screen
 └── ChatScreen                 ← conditional, full-screen
```

State lives in `page.tsx` and is pushed down. Data fetching and side effects live in hooks.

> Architecture §15 specifies `components/deck/`, `components/plan/`, `components/explain/` subdirectories. Today only `components/risk/` is nested; deck components sit at the top level. Cosmetic — worth aligning when Phase 5 adds `plan/`.

---

## Triage gestures ✅

Powered by `react-tinder-card`.

| Gesture     | Button        | Action         | Effect                                                       |
| ----------- | ------------- | -------------- | ------------------------------------------------------------ |
| **→ right** | ⚡ Fast-track | `fast-track`   | Records a queue-lane decision. **Never approves or merges.** |
| **← left**  | Needs review  | `needs-review` | Marks for deep review.                                       |
| **↑ up**    | Explain       | —              | Opens the chat screen. Not a recorded triage action.         |
| **↓ down**  | —             | 🕐 `defer`     | **Not reachable.** See below.                                |

**Thresholds:** overlay appears past `30px` of drag; the swipe commits at `swipeThreshold={80}`.

**Vertical swipes are disabled** — `preventSwipe={["up", "down"]}` in [SwipeDeck.tsx](../src/components/SwipeDeck.tsx). Explain is reached via the ↑ button in `SwipeActions`, not by swiping.

> 🕐 **Defer is defined but not wired.** `TriageAction` includes `"defer"` and architecture §14 specifies swipe-down-to-snooze resurfacing via age decay. Age decay is Phase 4, so defer lands with it.

> 🕐 **The veto flip is Phase 8.** Architecture §14 specifies that when the policy gate vetoes a right-swipe, the card **does not leave the deck** — it flips to show the reason. The gate does not exist yet, so today every right-swipe is accepted. This is the intended live-demo moment; it is not yet demonstrable.

---

## Risk colour system ✅

Centralised in [risk-display.ts](../src/lib/risk-display.ts) as `LEVEL_STYLES`, so the badge, card accent, breakdown bars and summary bar cannot drift.

| Level      | Score  | Dot | `bg`            | `text`             | `border`             | `bar`            | `accent`         |
| ---------- | ------ | --- | --------------- | ------------------ | -------------------- | ---------------- | ---------------- |
| `critical` | 75–100 | 🔴  | `bg-red-50`     | `text-red-700`     | `border-red-200`     | `bg-red-500`     | `bg-red-400`     |
| `high`     | 50–74  | 🟠  | `bg-orange-50`  | `text-orange-700`  | `border-orange-200`  | `bg-orange-500`  | `bg-orange-400`  |
| `medium`   | 25–49  | 🟡  | `bg-amber-50`   | `text-amber-700`   | `border-amber-200`   | `bg-amber-500`   | `bg-amber-400`   |
| `low`      | 0–24   | 🟢  | `bg-emerald-50` | `text-emerald-700` | `border-emerald-200` | `bg-emerald-500` | `bg-emerald-400` |

Emoji dots exist so level survives where colour alone is insufficient. A test asserts every level has a complete, visually distinct style.

> Score ranges reflect the default thresholds (25/50/75); they move with config.

---

## Component reference

### `SwipeDeck` ✅

[src/components/SwipeDeck.tsx](../src/components/SwipeDeck.tsx)

```ts
interface SwipeDeckProps {
  prs: TriagedPR[];
  onSwipeLeft: (pr: TriagedPR) => void;
  onSwipeRight: (pr: TriagedPR) => void;
  onShowBreakdown: (pr: TriagedPR) => void;
  triggerSwipe?: { direction: "left" | "right" } | null;
  onTriggerConsumed?: () => void;
}
```

`triggerSwipe` lets the button bar drive the same animation as a gesture — one code path for both inputs. The parent clears it via `onTriggerConsumed`.

### `PRCard` ✅

[src/components/PRCard.tsx](../src/components/PRCard.tsx)

```ts
interface PRCardProps {
  pr: TriagedPR;
  onShowBreakdown?: () => void;
  style?: React.CSSProperties;
}
```

Renders repo, number, title, author, age, `RiskBadge`, `RiskReasons`, and the "see all 7 signals" affordance. `style` positions background cards in the stack.

Every number on this card is measured or computed.

> 🕐 Architecture §14's card also shows **effort** (`⏱ ~24 min`) and **suggested reviewer** (`👤 @meera (91%)`). Those arrive in Phases 4 and 7.

### `SwipeActions` ✅

```ts
interface SwipeActionsProps {
  onNeedsReview: () => void;
  onExplain: () => void;
  onFastTrack: () => void;
  disabled?: boolean;
}
```

Accessible fallback: ← needs-review · ↑ explain · ⚡ fast-track. Each button carries `aria-label`.

### `QueueSummaryBar` ✅

```ts
interface QueueSummaryBarProps {
  summary: QueueSummary;
  remaining: number;
}
```

Risk composition across the queue plus triage progress. The seed of the Phase 5 capacity panel — once effort estimates exist, this is where the **deficit** is stated numerically.

### `RiskBadge` ✅

```ts
interface RiskBadgeProps {
  score: number;
  level: RiskLevel;
  lowConfidence?: boolean;
  size?: "sm" | "lg";
  className?: string;
}
```

Score, band label, proportional bar. When `lowConfidence` is set it renders the honest warning rather than hiding the gap.

### `RiskReasons` ✅

```ts
interface RiskReasonsProps {
  reasons: string[];
  max?: number;
  className?: string;
}
```

Renders `risk.topReasons` — already ranked by contribution — with a `+N more` overflow count.

### `DimensionBreakdown` ✅ — the credibility screen

[src/components/risk/DimensionBreakdown.tsx](../src/components/risk/DimensionBreakdown.tsx)

```ts
interface DimensionBreakdownProps {
  title: string;
  prNumber: number;
  risk: RiskAssessment;
  baseline: number;
  onClose: () => void;
}
```

**Open this when the score is challenged.** It shows:

- Per-dimension `raw`, `weight`, `contribution`, `reasons` and `signalsUsed`
- A fill bar per dimension, proportional to that dimension's own ceiling
- **"How the score adds up"** — dimensions → modifiers → floor → final
- The floor explained inline when it decided the score
- Side-by-side comparison against the lines-changed `baseline`
- A plain-English summary of where the two models disagree
- The signal-confidence panel

This screen is the reason `signals` ships with the card (`?signals=1`): it opens with **no round trip**.

### `ChatScreen` ✅ — interim

```ts
interface ChatScreenProps {
  pr: PullRequest;
  history: ChatMessage[];
  onSend: (message: string) => Promise<void>;
  sending: boolean;
  onClose: () => void;
}
```

Free-form conversation with Claude about the diff, via `POST /api/chat`.

> 🕐 **Phase 6 replaces this with `ExplainScreen`**, rendering the structured `Explanation` contract — `oneLine`, `whatChanged`, `whyItMatters`, `whereToLookFirst`, `questionsToAsk` — plus `VoiceButton` (Web Speech API) for hands-free triage on a commute.

### `Header` · `EmptyState` ✅

Branding and the "Queue cleared / Your attention is free" terminal state.

---

## Planned components

| Component                   | Phase | Purpose                                                        |
| --------------------------- | ----- | -------------------------------------------------------------- |
| `plan/ReviewPlan.tsx` ✅    | 5     | The knapsack result — ordered plan, coverage %, deferred items |
| `plan/BudgetPicker.tsx` ✅  | 5     | "I have 30 minutes"                                            |
| `plan/CapacityPanel.tsx` ✅ | 5     | Queue load vs capacity — the deficit                           |
| `app/plan/page.tsx` ✅      | 5     | Plan route                                                     |
| `explain/ExplainScreen.tsx` | 6     | Structured explanation                                         |
| `explain/VoiceButton.tsx`   | 6     | `speechSynthesis` playback                                     |
| `reviewer/ReviewerCard.tsx` | 7     | Suggested reviewer — **hidden when `confidence < 0.4`**        |

---

## Hooks ✅

### `usePRs`

[src/hooks/usePRs.ts](../src/hooks/usePRs.ts) — fetches `/api/prs`, exposes the queue, `QueueSummary`, loading and error state, and filters client-side as PRs are triaged.

### `useSwipeHistory`

[src/hooks/useSwipeHistory.ts](../src/hooks/useSwipeHistory.ts) — records a `TriageRecord` per decision, including **`riskAtDecision`**. That field is the audit trail: it lets the queue later say _"you fast-tracked this at 18; it now scores 61."_

In-memory only — lost on refresh. Persistence arrives with `POST /api/triage` in Phase 8.

### `useChat`

[src/hooks/useChat.ts](../src/hooks/useChat.ts) — per-PR chat history and send state. Becomes `useExplanation` in Phase 6.

> Architecture §15 names these `useTriageQueue` / `useTriageHistory`. The shipped names predate that rename; harmless, worth aligning opportunistically.

---

## Rendering strategy ✅

```
t=0ms     deterministic data renders  ← full card, all numbers, usable
t=~600ms  explanations stream in       ← Phase 6
```

The deck **never blocks on an LLM.** `/api/prs` returns scores, reasons and the breakdown in one deterministic response; explanation is strictly additive.

---

## Demo mode ✅

`DEMO_MODE=1 npm run dev` serves 7 hand-built fixtures from [demo/fixtures.ts](../src/lib/demo/fixtures.ts), covering tiny-critical, huge-worthless, emergency, well-tested, trivial and low-confidence cases.

**Demo mode swaps the data source, never the scoring** (Decision Log #13). Fixtures run through the real engine, so the offline demo shows what the scorer genuinely produces — and it survives a judge asking to change an input.

---

## Accessibility & verification

- Buttons carry `aria-label`; every gesture has a button equivalent.
- Risk level is conveyed by emoji dot and text label, not colour alone.
- `line-clamp-2` is defined in `globals.css` — no Tailwind plugin needed.

> ⚠️ **Outstanding:** mobile layout at 390×844 has **not** been eyeballed by a human ([PROGRESS.md](./PROGRESS.md) Phase 3). Automated tests cover logic, not layout. **Do this before the demo.**

---

_Verified against the source on 2026-09-03 — Phase 3 complete._
