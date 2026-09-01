# PocketReview — Implementation Tracker

Single source of truth for what is built, what is pending, and what was deliberately cut.

**Rule:** a task is only `[x]` when it is written, typechecking, tested where testable, and the build passes. "Written but unverified" is `[~]`.

---

## Status

```
  Phase 0  Foundation & branding      ██████████  100%   ✅ done
  Phase 1  Signal Layer               ██████████  100%   ✅ done
  Phase 2  Risk Engine                ░░░░░░░░░░    0%   ⬅ NEXT
  Phase 3  Deck & risk UI             ░░░░░░░░░░    0%
  Phase 4  Priority & effort          ░░░░░░░░░░    0%
  Phase 5  Review plan                ░░░░░░░░░░    0%
  Phase 6  Explanation layer          ░░░░░░░░░░    0%
  Phase 7  Reviewer engine            ░░░░░░░░░░    0%   ⚠ first to cut
  Phase 8  Policy gate & eval         ░░░░░░░░░░    0%
  Phase 9  Hardening & demo           ░░░░░░░░░░    0%
```

**Health:** 29/29 tests pass · typecheck clean · production build succeeds

### Never cut — these three *are* the project

| | Phase | Why |
|---|---|---|
| 🔴 | **Risk Engine** (2) | Without it this is a list with a swipe gesture |
| 🔴 | **Review Plan** (5) | The only feature no competitor has |
| 🔴 | **Eval harness** (8) | Turns an assertion into a measured result |

---

## Phase 0 — Foundation & branding ✅

- [x] Remove prior branding from UI, metadata and package identity
- [x] `package.json` → `pocketreview` with description
- [x] App metadata and title — [layout.tsx](src/app/layout.tsx)
- [x] Header rebrand + "Triage queue" subtitle — [Header.tsx](src/components/Header.tsx)
- [x] Empty state → "Queue cleared / Your attention is free" — [EmptyState.tsx](src/components/EmptyState.tsx)
- [x] Swipe overlays → `FAST TRACK` / `NEEDS REVIEW` — [SwipeDeck.tsx](src/components/SwipeDeck.tsx)
- [x] Action buttons → needs-review / explain / fast-track — [SwipeActions.tsx](src/components/SwipeActions.tsx)
- [x] README rewritten from the architecture — [README.md](README.md)
- [x] `ARCHITECTURE.md` — full system design
- [x] `JUDGE-QA.md` — Q&A prep, gitignored
- [x] `.gitignore` — cache dir + prep file excluded
- [x] Delete stale demo assets

---

## Phase 1 — Signal Layer ✅

Measurement only. No judgement, no scores.

### Core modules
- [x] [math.ts](src/lib/math.ts) — `clamp`, `saturate`, `normalisedEntropy`, `weightedMean`, `decay`
- [x] [signals/types.ts](src/lib/signals/types.ts) — `PRSignals` (~70 fields), `SignalAvailability`, confidence model
- [x] [signals/path-rules.ts](src/lib/signals/path-rules.ts) — ordered rule table, weights 0.0–1.0
- [x] [signals/classify.ts](src/lib/signals/classify.ts) — path→category, CODEOWNERS parse + match
- [x] [signals/diff.ts](src/lib/signals/diff.ts) — patch parsing, complexity, dependency counting, redaction
- [x] [signals/github.ts](src/lib/signals/github.ts) — Octokit client, `mapLimit`, all fetchers
- [x] [signals/history.ts](src/lib/signals/history.ts) — churn, revert rate, incidents, expertise matrix
- [x] [signals/collect.ts](src/lib/signals/collect.ts) — orchestrator with per-source failure isolation
- [x] [config.ts](src/lib/config.ts) — `.pocketreview.yml` loader with defaults

### Infrastructure migration
- [x] Replace `gh` CLI subprocess layer with Octokit HTTP
- [x] Bounded concurrency (6 parallel) on all fan-out
- [x] Delete `src/lib/gh.ts`
- [x] Delete the approve endpoint — contradicted the product thesis
- [x] Remove approve call from [page.tsx](src/app/page.tsx)
- [x] Route diff fetch through Octokit
- [x] Consolidate routes under `[repo]/[number]/`
- [x] [.env.example](.env.example)

### Signals implemented
- [x] Size & shape — additions, deletions, files, entropy, largest change
- [x] Classification — auth / payments / database / infra / api / config / ui / test / docs / generated
- [x] Test posture — ratio, `hasNoTests`, `testsRemoved`
- [x] Dependencies — manifest vs lockfile, added/removed counts
- [x] History — churn, revert rate, prior incident files, hotspot score
- [x] CI — check runs + legacy commit statuses, worse-case wins
- [x] Review state — approvals, rounds, comments
- [x] Author context — prior PRs, revert rate, first-time flag
- [x] AI provenance — 5 hints, requires ≥2 to fire
- [x] Urgency — age, labels, draft, hotfix branch, blocking

### Endpoint
- [x] `GET /api/prs/:repo/:number/signals` — the "show your working" data
- [x] `GET /api/prs` migrated off the CLI

### Tests — 29 passing
- [x] Path classification incl. precedence (test beats auth, generated beats all)
- [x] CODEOWNERS parsing and last-match-wins
- [x] Diff splitting, complexity, dependency counting
- [x] Patch ranking — **caught a real bug**, see Decision Log
- [x] Secret redaction
- [x] Math primitives

---

## Phase 2 — Risk Engine ⬅ NEXT · 🔴 never cut

**Goal:** every PR carries an explainable 0–100 score whose contributions sum exactly to the total.

**Done when:** the one-line auth change scores high, the 4,000-line lockfile scores near zero, and the breakdown is inspectable.

### Scaffolding
- [ ] `lib/engines/types.ts` — `RiskAssessment`, `DimensionResult`, `Modifier`
- [ ] `lib/engines/risk-engine.ts` — orchestrator, weighted sum, clamping

### The seven dimensions
- [ ] `dimensions/blast-radius.ts` (0.20) — file spread, volume, entropy, cross-cutting
- [ ] `dimensions/domain-criticality.ts` (0.20) — **must be size-independent**
- [ ] `dimensions/test-posture.ts` (0.15) — ratio tiers; removal forces 1.0
- [ ] `dimensions/historical-instability.ts` (0.15) — churn, reverts, incidents
- [ ] `dimensions/change-complexity.ts` (0.12) — control flow, nesting, deletion-heavy
- [ ] `dimensions/dependencies.ts` (0.10) — new deps, major bumps, lockfile-only
- [ ] `dimensions/author-provenance.ts` (0.08) — first-timer, revert rate, AI hints

### Modifiers — bounded, ±30 total
- [ ] CI failing `+8` · already approved `−15` · draft `−20`
- [ ] Hotfix branch `+10` · generated-only `−25` · docs-only `−30`
- [ ] Assert the cap holds and the result clamps to `[0,100]`

### Output
- [ ] Confidence from `SignalAvailability`
- [ ] Level thresholds from config (low/medium/high/critical)
- [ ] `topReasons` ranked by contribution
- [ ] Contributions verifiably sum to the score

### Tests
- [ ] **One-line auth change scores HIGH** ← demo centrepiece
- [ ] **4,000-line lockfile scores LOW** ← the classic false positive
- [ ] Contributions sum to the total (property test)
- [ ] Score always within `[0,100]` across random inputs
- [ ] Docs-only PR lands in LOW
- [ ] Removed tests force the test dimension to maximum
- [ ] Deterministic — same input, same score, 100 runs
- [ ] No single dimension can exceed its weight cap

---

## Phase 3 — Deck & risk UI

**Goal:** the demo is visually complete and technically defensible.

- [ ] `components/risk/RiskBadge.tsx` — score + level chip
- [ ] `components/risk/RiskReasons.tsx` — ranked contributing reasons
- [ ] `components/risk/DimensionBreakdown.tsx` — **the credibility screen**
- [ ] Rebuild [PRCard.tsx](src/components/PRCard.tsx) as the triage card
- [ ] Confidence indicator when `< 0.6` — "limited signals"
- [ ] Wire risk into `/api/prs`
- [ ] Deck renders deterministic data with zero loading state
- [ ] Mobile layout verified at 390×844

---

## Phase 4 — Priority & effort

**Goal:** the queue is ordered by what to open next, with a cost attached to each item.

- [ ] `engines/priority-engine.ts` — risk 0.40 · urgency 0.20 · age 0.15 · blocking 0.15 · availability 0.10
- [ ] Age decay `(h/72)^1.5` — anti-starvation
- [ ] Suppression: drafts, approved, own PRs; demote failing CI
- [ ] `engines/effort-estimator.ts` — linear model, clamp `[2,90]`
- [ ] Stable ordering — same queue, same order, every load
- [ ] Tests: starvation, stability, suppression, effort bounds

---

## Phase 5 — Review plan · 🔴 never cut

**Goal:** the closing moment of the demo exists.

- [ ] `engines/review-plan.ts` — exact 0/1 knapsack DP, `O(n·budget)`
- [ ] Force-include criticals when a single one fits
- [ ] Order highest-risk first within the plan
- [ ] `coveredRisk` percentage
- [ ] `deferred[]` with per-item reason
- [ ] `warnings[]` when a critical PR cannot fit
- [ ] `POST /api/review-plan`
- [ ] `GET /api/capacity` — the deficit panel
- [ ] `components/plan/ReviewPlan.tsx` + `BudgetPicker` + `CapacityPanel`
- [ ] `app/plan/page.tsx`
- [ ] **Test: DP result matches brute force on small inputs** ← proves exactness
- [ ] Test: budget never exceeded

---

## Phase 6 — Explanation layer

**Goal:** cards speak plain English. The LLM narrates numbers it did not produce.

- [ ] Install `@anthropic-ai/sdk`
- [ ] `llm/client.ts` — SDK + concurrency limiter (6)
- [ ] `llm/diff-prioritise.ts` — reuse `rankPatchesByConsequence` before truncation
- [ ] `llm/explain.ts` — `Explanation` contract
- [ ] `llm/cache.ts` — keyed on `repo:number:headSha`
- [ ] Model tiering — Haiku for card lines, Sonnet for the explain screen
- [ ] `GET /api/prs/:repo/:number/explain` — streamed
- [ ] `components/explain/ExplainScreen.tsx` — replaces ChatScreen
- [ ] `components/explain/VoiceButton.tsx` — Web Speech API
- [ ] **Verify: LLM off → every score, rank and plan still works**
- [ ] Verify: no number in output that wasn't passed in

---

## Phase 7 — Reviewer engine · ⚠️ FIRST TO CUT

Build only if 2, 5 and 8 are genuinely finished.

**Why it's first to cut:** needs multi-contributor history to produce distinct output. On a single-author repo every card names the same person, which reads as *broken* and casts doubt on the working components beside it.

- [ ] `engines/reviewer-engine.ts` — ownership 0.30 · recency 0.20 · review history 0.25 · codeowner 0.15 · load 0.10
- [ ] Cache the expertise matrix to `.pocketreview/expertise.json`
- [ ] `GET /api/reviewers`
- [ ] `components/reviewer/ReviewerCard.tsx`
- [ ] **Hide the card when `confidence < 0.4`** ← non-negotiable guard

---

## Phase 8 — Policy gate & eval · 🔴 eval never cut

### Policy gate
- [ ] `policy/gate.ts` — can only *remove* eligibility, never grant it
- [ ] Rules: risk threshold, CI, critical paths, deps, test removal, protected files
- [ ] `POST /api/triage` — persists the decision, performs no merge
- [ ] Card flip-state showing the veto reason
- [ ] **Test: critical paths can never be fast-tracked at any score**
- [ ] Live demo: swipe right on the auth PR → visible refusal

### Eval harness 🔴
- [ ] `eval/dataset.ts` — mine merged PRs, label from outcomes
- [ ] Labels: reverted · fix within 7d · changes-requested · >3 rounds · in later hotfix
- [ ] `eval/run-eval.ts` — Recall@K, Precision@K, NDCG
- [ ] Lines-changed baseline for comparison
- [ ] `npm run eval`
- [ ] **`eval/results.md` committed with real measured numbers**
- [ ] Effort calibration — MAE vs time-to-first-review
- [ ] Record which repo was tuned on vs tested on

---

## Phase 9 — Hardening & demo

- [ ] `cache/store.ts` — L1 memory + L2 disk, `headSha`-keyed
- [ ] `fixtures/` — capture real PRs from a real repo
- [ ] `DEMO_MODE=1` serves fixtures — **test with wifi physically off**
- [ ] Error states for every failure mode in ARCHITECTURE §17
- [ ] Rate-limit handling with staleness banner
- [ ] Stage the one-line auth PR for the demo
- [ ] End-to-end rehearsal on the actual demo device
- [ ] Fill every `[bracket]` in JUDGE-QA §10

---

## Decision log

Things a judge may ask about. Each is a deliberate choice, not an accident.

| # | Decision | Why |
|---|---|---|
| 1 | Score computed in code; LLM only narrates | Makes *"why 87?"* answerable. Turn the LLM off and the system still works. |
| 2 | Octokit replaces `gh` CLI | ~800ms per subprocess spawn; 90 fetches ≈ 72s serial vs ~2.3s parallel HTTP. Also removes the demo-machine setup dependency. |
| 3 | Approve endpoint deleted | Directly contradicted the thesis. Our pitch is a trust deficit; solving it by having AI approve AI code argues against ourselves. |
| 4 | Test files beat domain rules | Otherwise adding tests to auth code *raises* its risk. Backwards, and visible. |
| 5 | Generated files excluded from size scoring | A 4,000-line lockfile must never read as high risk. The most common naive-scoring false positive. |
| 6 | Patch ranking: criticality dominates, size breaks ties | Multiplying let a 200-line UI file (0.3×200) outrank a 15-line auth change (1.0×15). **Caught by a test.** |
| 7 | AI provenance needs ≥2 hints, weighted 0.08 | Max ~3 points of 100. Source-agnostic — answers *"what about human-written PRs?"* |
| 8 | Confidence reported honestly | A system hiding missing data can't be trusted about anything else. |
| 9 | Reviewer engine is first to cut | Same name on every card reads as broken and poisons the components next to it. |
| 10 | KPI is Recall@K, not "time saved" | Time saved needs a control group that doesn't exist. Recall@K is measurable from history that already happened. |

---

## Commands

```bash
npm run dev         # dev server, port 3000
npm test            # 29 tests, offline
npm run typecheck   # tsc --noEmit
npm run build       # production build
npm run eval        # Phase 8 — not yet implemented
```

---

## Definition of done

A phase is complete when:

1. Every task is `[x]`
2. `npm run typecheck` is clean
3. `npm test` passes
4. `npm run build` succeeds
5. The phase's "done when" is demonstrably true

---

*Last verified: 2026-09-02 — Phase 1 complete, 29/29 tests, build passing.*
