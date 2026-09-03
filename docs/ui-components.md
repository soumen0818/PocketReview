# UI Components Reference

PocketReview is a mobile-first Next.js 16 (App Router) application. It is designed to be used on a phone during dead time — commutes, queues, between meetings. 

---

## Table of Contents

1. [Design Philosophy](#design-philosophy)
2. [Component Hierarchy](#component-hierarchy)
3. [Triage Gestures](#triage-gestures)
4. [Risk Color System](#risk-color-system)
5. [State Management & Hooks](#state-management--hooks)
6. [Component Reference](#component-reference)
   - [SwipeDeck](#swipedeck)
   - [PRCard](#prcard)
   - [SwipeActions](#swipeactions)
   - [ChatScreen](#chatscreen)
   - [QueueSummaryBar](#queuesummarybar)
   - [DimensionBreakdown](#dimensionbreakdown)
   - [RiskBadge & RiskReasons](#riskbadge--riskreasons)

---

## Design Philosophy

- **Mobile-first:** Developed against an iPhone 14 Pro viewport.
- **Triage, not review:** Deliberately shows *less* than GitHub. We do not show code diffs here. The goal is to route the PR (needs review vs fast-track), not to do line-by-line review.
- **Glanceability:** Decisions should take < 2 seconds based on the risk score, risk level color, and top reasons.
- **Gestures over clicks:** Swipe-based interface (`react-tinder-card`) builds muscle memory and requires only one hand.

---

## Component Hierarchy

```
app/page.tsx (State Orchestrator)
 │
 ├── Header
 │
 ├── QueueSummaryBar (Risk distribution across queue)
 │
 ├── SwipeDeck (Card stack, handles swipe gestures)
 │    │
 │    ├── SwipeOverlayCard (Top interactive card, shows drag intent)
 │    │    └── PRCard
 │    │
 │    └── PRCard (Background cards, scaled/translated for depth)
 │
 ├── SwipeActions (Fallback button controls: ←, ↑, →)
 │
 ├── (Conditional) DimensionBreakdown (Full-screen audit view)
 │
 └── (Conditional) ChatScreen (Claude chat interface)
```

---

## Triage Gestures

The UI uses a gesture-based model powered by `react-tinder-card`.

| Gesture | Button | Action | Effect |
|---|---|---|---|
| **Swipe Right** (→) | Fast Track | `fast-track` | Runs policy gate. Marks PR for the fast-lane. Does NOT approve/merge. |
| **Swipe Left** (←) | Needs Review | `needs-review` | Marks PR for deep-lane review. |
| **Swipe Up** (↑) | Explain | opens chat | Opens Claude chat for this PR. (Swipe prevent: up) |
| **Swipe Down** (↓) | Defer | `defer` | Snoozes PR. (Swipe prevent: down) |

During a drag, `SwipeOverlayCard` reveals large colored text overlays ("FAST TRACK" or "NEEDS REVIEW") when the drag distance exceeds `30px`. The swipe triggers at a `80px` threshold.

---

## Risk Color System

Colors map strictly to Risk Levels. This mapping is centralized in `src/lib/risk-display.ts` to ensure the badge, summary bar, and audit views never drift.

| Level | Score Range | Tailwind Color | Emoji | CSS Classes |
|---|---|---|---|---|
| `critical` | 75-100 | Red | 🔴 | `text-red-700`, `bg-red-50`, `border-red-200`, `bg-red-500` |
| `high` | 50-74 | Orange | 🟠 | `text-orange-700`, `bg-orange-50`, `border-orange-200`, `bg-orange-500` |
| `medium` | 25-49 | Amber | 🟡 | `text-amber-700`, `bg-amber-50`, `border-amber-200`, `bg-amber-500` |
| `low` | 0-24 | Emerald | 🟢 | `text-emerald-700`, `bg-emerald-50`, `border-emerald-200`, `bg-emerald-500` |

---

## State Management & Hooks

State is orchestrated in `app/page.tsx` and pushed down to components. Business logic and API calls are encapsulated in custom hooks.

### `usePRs(hasReviewed)`
Fetches and manages the scored PR queue.
- **Returns:** `{ prs, summary, loading, error, refetch, removePR }`
- **Behavior:** Fetches from `GET /api/prs`. Uses the `hasReviewed` callback to filter out PRs that have already been triaged in this session.

### `useSwipeHistory()`
Manages the in-memory session log of triage decisions.
- **Returns:** `{ history, addTriage, hasReviewed, clearHistory }`
- **Behavior:** Stores `TriageRecord` objects containing the `action` and the `riskAtDecision` (providing an audit trail).

### `useChat()`
Manages per-PR conversation state with the AI explanation layer.
- **Returns:** `{ getHistory, sendMessage, sending }`
- **Behavior:** Optimistically appends the user message, calls `POST /api/chat`, and then appends the assistant reply. History is keyed by `repo:prNumber`.

---

## Component Reference

### `SwipeDeck`
**Path:** `src/components/SwipeDeck.tsx`

Renders the top three PRs in the queue to create a visual stack with depth (using scale and Y translation). Only the top card is wrapped in a `TinderCard`.

**Props:**
| Prop | Type | Description |
|---|---|---|
| `prs` | `TriagedPR[]` | The queue to render. |
| `onSwipeLeft` | `(pr: TriagedPR) => void` | Callback for "needs review". |
| `onSwipeRight` | `(pr: TriagedPR) => void` | Callback for "fast-track". |
| `onShowBreakdown` | `(pr: TriagedPR) => void` | Callback to open the audit view. |
| `triggerSwipe` | `{ direction: 'left' \| 'right' } \| null` | Imperative swipe trigger (used by buttons). |
| `onTriggerConsumed`| `() => void` | Clears the imperative swipe intent. |

### `PRCard`
**Path:** `src/components/PRCard.tsx`

The visual presentation of a single PR. Displays metadata (title, repo, author, age, line additions/deletions, labels), the `RiskBadge`, and the `RiskReasons` list.

**Props:**
| Prop | Type | Description |
|---|---|---|
| `pr` | `TriagedPR` | The PR data to display. |
| `onShowBreakdown`| `() => void` | Optional. Renders the "View breakdown" button. |

### `SwipeActions`
**Path:** `src/components/SwipeActions.tsx`

Bottom button bar providing accessible/tap alternatives to swiping.

**Props:**
| Prop | Type | Description |
|---|---|---|
| `onNeedsReview` | `() => void` | Triggers a left swipe. |
| `onExplain` | `() => void` | Opens the chat interface. |
| `onFastTrack` | `() => void` | Triggers a right swipe. |
| `disabled` | `boolean` | True when the queue is empty. |

### `ChatScreen`
**Path:** `src/components/ChatScreen.tsx`

Full-screen overlay for conversing with Claude about the PR.

**Props:**
| Prop | Type | Description |
|---|---|---|
| `pr` | `TriagedPR` | Context PR. |
| `history` | `ChatMessage[]` | Array of `{ role, content }`. |
| `onSend` | `(msg: string) => void` | Callback when user submits a message. |
| `sending` | `boolean` | True while waiting for the LLM. |
| `onClose` | `() => void` | Returns to the deck view. |

### `QueueSummaryBar`
**Path:** `src/components/QueueSummaryBar.tsx`

Top bar showing the count of remaining PRs and the distribution of risk levels across the queue.

**Props:**
| Prop | Type | Description |
|---|---|---|
| `summary` | `QueueSummary` | Counts of PRs by risk level. |
| `remaining` | `number` | Count of un-triaged PRs. |

### `DimensionBreakdown`
**Path:** `src/components/risk/DimensionBreakdown.tsx`

The "Audit View". A full-screen component that answers "Why this score?". It shows:
- The `baseline` vs `actual` score comparison.
- Progress bars for all 7 dimensions showing `contribution / (weight * 100)`.
- Fired modifiers and their point deltas.
- Applied floor rules, if any.
- The signal availability/confidence score.

**Props:**
| Prop | Type | Description |
|---|---|---|
| `title` | `string` | PR title. |
| `prNumber`| `number` | PR number. |
| `risk` | `RiskAssessment` | The complete deterministic score output. |
| `baseline`| `number` | The naive lines-changed score. |
| `onClose` | `() => void` | Closes the view. |

### `RiskBadge` & `RiskReasons`
**Path:** `src/components/risk/RiskBadge.tsx`, `src/components/risk/RiskReasons.tsx`

- **RiskBadge:** Renders the rounded badge showing the risk dot, level label, and numeric score. Color-coded based on level. If `risk.lowConfidence` is true, shows a warning icon.
- **RiskReasons:** Renders an un-ordered list of the top reasons provided by the risk engine, truncated to the top 3-5 most impactful reasons.
