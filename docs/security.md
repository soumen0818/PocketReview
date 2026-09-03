# Security & Privacy

> Corresponds to [architecture.md §18](../ARCHITECTURE.md#18-security--privacy) and §11 (the Policy Gate).
>
> **Status convention.** ✅ **Shipped** means verified against the code at the path given. 🕐 **Planned (Phase N)** means the control is designed but **not yet enforced** — do not rely on it.

> **The pitch line:** _"We never let an AI approve code written by an AI. We only decide which human sees it first."_

---

## Read-only by construction ✅

| Token               | Scope       | Purpose                                                |
| ------------------- | ----------- | ------------------------------------------------------ |
| `GITHUB_TOKEN`      | `repo:read` | PR metadata, file lists, diffs, CI status, git history |
| `ANTHROPIC_API_KEY` | —           | Optional. Explanation layer only.                      |

**No write endpoint exists.** There is no call to `pulls.merge` or `pulls.createReview` anywhere in the repository — verified by grep across `src/`. The application structurally cannot merge code or submit approvals.

This is not merely unused capability. An approve endpoint **existed and was deliberately deleted** in Phase 0 (Decision Log #3): the product thesis is that AI-accelerated review created a trust deficit, and solving it by having an AI approve AI-authored code argues against the project.

Triage decisions are recorded in client-side session state to drive the UI. They are never pushed to GitHub.

---

## Server-side token guarantee ✅

`GITHUB_TOKEN` and `ANTHROPIC_API_KEY` are read only in API route handlers, never prefixed `NEXT_PUBLIC_`, and are absent from the client bundle. All GitHub and Anthropic calls originate server-side. Clients send no `Authorization` header.

Tokens live in `.env.local`, which is gitignored.

---

## What leaves the process

### With the LLM disabled — nothing ✅

Set `llm.enabled: false` (or simply omit `ANTHROPIC_API_KEY`) and **no code ever leaves the process.** Every score, ranking and breakdown still works — you lose the prose, not the system.

This is a real differentiator for regulated teams, and it is a direct consequence of the core design decision: the score is computed in code, so the LLM is removable.

### With the LLM enabled ✅

Transmitted to the Anthropic API:

- PR title and body
- The unified diff, truncated
- The user's chat messages

Nothing else. Signals, scores and history stay local.

### Secret redaction ✅

`redactSecrets()` in [src/lib/signals/diff.ts](../src/lib/signals/diff.ts) scrubs known key patterns and high-entropy assignments to variables named like `password` or `secret`, replacing them with `[REDACTED:<label>]` before any diff is dispatched. Covered by a test.

_Redaction is a backstop, not a licence to commit secrets._

---

## Persistence ✅

PocketReview uses no database.

| What             | Where it lives                                       | Survives restart?    |
| ---------------- | ---------------------------------------------------- | -------------------- |
| Config           | Parsed from `.pocketreview.yml`, memoised in-process | No                   |
| Diff text (chat) | In-memory `Map` in the chat route                    | No                   |
| Triage history   | Browser memory (`useSwipeHistory`)                   | No — lost on refresh |
| Signals, scores  | Recomputed per request                               | No                   |

**Nothing is written to disk.** No signals cache, no explanation cache, no expertise matrix on disk today.

> ⚠️ **Correction to a claim in earlier drafts.** Diff content _is_ cached — in memory, in the chat route, keyed `repo:number`. It is not persisted to disk, but "never cached" was wrong. Two consequences:
>
> 1. Diff text for a reviewed PR stays in process memory for the lifetime of the server.
> 2. The key omits `headSha`, so a PR that receives a push serves a **stale diff** until restart. Architecture §17 requires `headSha` keying — tracked for Phase 6/9.

🕐 **Phase 9** introduces `cache/store.ts` with an L2 disk cache. Per architecture §18 it must store **signals and explanations only, never diff content** — that constraint is what keeps this section true once disk caching exists.

---

## The Policy Gate 🕐 Phase 8 — NOT YET ENFORCED

> **This control is designed but not implemented. Do not describe it as an active protection.**
>
> **What exists today:** `PolicyConfig` is defined in [src/lib/config.ts](../src/lib/config.ts) with defaults (`fastTrackMaxRisk: 25`, `neverFastTrack: ["auth", "payments", "database"]`, `requireCiPassing: true`, `blockOnDependencyChange: true`, `blockOnTestRemoval: true`) and is parsed from `.pocketreview.yml`.
>
> **What does not exist:** any code that reads it. `src/lib/policy/gate.ts` is unwritten. A right-swipe in [page.tsx](../src/app/page.tsx) records a `TriageAction` with no eligibility check. **A critical-path PR can currently be marked fast-track.**

### Why the risk is bounded today

Fast-track is a **queue-lane label held in browser memory**. It approves nothing, merges nothing, and is never sent to GitHub. The gate's absence changes which card a reviewer sees first — it cannot cause an unreviewed merge, because no merge path exists at all (§ _Read-only by construction_).

### The target contract — architecture §11

The gate can only **remove** eligibility; it can never grant it. All conditions must hold for a fast-track to be eligible:

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

**Critical-path protection is structural.** The prohibition on fast-tracking auth, payments and database changes is intended to be unconditional — not overridable by a low risk score or by configuration.

Even when built, fast-track produces a marked queue and at most an optional GitHub _comment_. It will not call the approve or merge API. That is a deliberate product decision.

**Required test (Phase 8):** _critical paths can never be fast-tracked at any score._

---

## Defence in depth — what protects you today

With the gate unbuilt, three shipped properties carry the safety argument:

1. **No write capability.** The worst outcome of a wrong score is a misordered queue. The reviewer still sees every PR.
2. **The score is not LLM-generated.** A prompt-injected diff cannot move a risk score — scores come from arithmetic over measured signals. The LLM only writes prose, and prose cannot change a ranking.
3. **Floors resist dilution.** A one-line auth change cannot be averaged into looking trivial: `critical-path` floors it at 40 and `critical-path-untested` at 55, and the reason is surfaced. This is scoring, not access control — but it is why the dangerous PR surfaces rather than sinking.

---

## Treat LLM output as untrusted ✅

Diff content reaches the model, and diffs are attacker-controllable on a public repo. The mitigations are architectural:

- Model output is **displayed, never executed** and never parsed into control flow.
- No number the model emits is trusted: the score is computed before the model is called, and the Phase 6 contract requires every number in the output to have been passed in as input.
- The prompt instructs the model not to invent or alter scores — but the guarantee rests on the score being computed independently, not on prompt compliance.

---

## Contributor checklist

1. **Never add write scopes.** No GitHub API call may mutate state. The approve endpoint was deleted on purpose; do not reintroduce it.
2. **Never send diffs elsewhere.** The only external egress for diff content is the Anthropic client, gated behind `llm.enabled`.
3. **Preserve the Policy Gate once built.** No bypass for critical-path checks, at any score.
4. **No persistent storage of source.** When the Phase 9 disk cache lands, it stores signals and explanations — never diff content.
5. **Keep the score deterministic.** If an LLM ever influences a number, every guarantee on this page collapses.

---

_Verified against the codebase on 2026-09-03 — Phase 3 complete. The Policy Gate is Phase 8 and is not yet enforced._
