# Risk Scoring

> The deep reference for [architecture.md §6](../ARCHITECTURE.md#6-the-risk-engine).
>
> **Status:** ✅ **Shipped and verified** — Phase 2 complete, covered by 33 dedicated tests. Every formula on this page was read from the source, not from the design doc.

---

## The definition that makes this tractable

> **Risk = the probability this PR needs careful human attention.**
> **Not** the probability it contains a bug.

That distinction is the whole design. Predicting bugs is unsolved, and any system claiming to do it is lying. Ranking by _required attention_ is tractable, measurable against history, and closer to the actual bottleneck.

Lead with this sentence when the score is challenged.

---

## The non-negotiable property

```
        ┌──────────────────────────────────────┐
        │  THE SCORE IS COMPUTED IN CODE.      │
        │  THE LLM ONLY NARRATES IT.           │
        └──────────────────────────────────────┘
```

`assessRisk()` is a pure function. The same `PRSignals` yields the same `RiskAssessment` byte for byte — asserted across 50 runs by test. No network, no model, no clock.

This is what makes _"why 87?"_ answerable: the answer is a table of contributions that sums to 87 and is identical on every run.

---

## The pipeline

```
  PRSignals
      │
      ▼
  ① seven weighted dimensions ──────▶  baseScore     (0-100)
      │                                    │
      ▼                                    │
  ② bounded modifiers  ±30 cap ───────────▶│
      │                                    ▼
      │                              clamp to [0,100]
      ▼                                    │
  ③ floors — can only RAISE ──────────────▶│
                                           ▼
                                        score  (integer)
                                           │
                                           ▼
                                   ④ level, via thresholds
                                   ⑤ confidence, via availability
```

### The auditability guarantee

Enforced by tests in [tests/risk-engine.test.mjs](../tests/risk-engine.test.mjs):

```
dimensions[].contribution            sums to  baseScore
max(clamp(baseScore + modifierDelta, 0, 100), floor)  ==  score
no dimension contributes more than   weight × 100
score is always an integer in        [0, 100]
```

---

## ① The seven dimensions

Weights are asserted to sum to `1.00` **at module load** — a mistaken edit throws immediately rather than silently skewing every score.

```
                              weight    contribution range
 ① Blast Radius                 0.20     0-20
 ② Domain Criticality           0.20     0-20
 ③ Test Posture                 0.15     0-15
 ④ Historical Instability       0.15     0-15
 ⑤ Change Complexity            0.12     0-12
 ⑥ Dependencies                 0.10     0-10
 ⑦ Author & Provenance          0.08     0-8
                              ─────
                                1.00     0-100
```

Each dimension is a pure function returning `{ raw: 0..1, reasons: string[], signalsUsed: string[] }`. `contribution = raw × weight × 100`.

`saturate(x, k) = 1 - exp(-x/k)` gives diminishing returns throughout, so a 5,000-line PR is not 10× riskier than a 500-line one. Both are simply "large."

---

### ① Blast Radius — 0.20

[blast-radius.ts](../src/lib/engines/dimensions/blast-radius.ts) · _How much surface area does this touch?_

```
reviewable = files where !isGenerated && !isTest

fileSpread = saturate(reviewable.length, 12)
volume     = saturate(reviewableLines,  500)
spread     = diffEntropy                        // scattered > concentrated
crossCut   = distinctCategories / 5

raw = 0.35·fileSpread + 0.35·volume + 0.15·spread + 0.15·crossCut
```

Generated and test files are excluded from the count _and_ the line total.

---

### ② Domain Criticality — 0.20

[domain-criticality.ts](../src/lib/engines/dimensions/domain-criticality.ts) · _Where does the change land?_

```
relevant     = files where !isGenerated && !isTest
maxWeight    = max(categoryWeight of relevant)
criticalLines = lines in files with categoryWeight >= 0.7
mass         = saturate(criticalLines, 150)

raw = 0.70·maxWeight + 0.30·mass
```

**This dimension is size-independent, and that is the point.** A one-line change to `src/auth/session.ts` scores `0.70 × 1.0 = 0.70` here no matter how small it is.

The split is **additive, not multiplicative** — deliberately. Multiplying would let a tiny critical change score near zero, which is the exact failure being designed against:

```diff
- if (user.isAdmin()) {
+ if (true) {
```

Three lines. One file. Tests pass. Every size-based scorer calls this trivial.

Tests are excluded here because they have their own dimension — otherwise _adding tests to auth code would raise its risk_, which is backwards and visible (Decision Log #4).

When `criticalLines <= 10` the dimension emits an extra reason — _"Small diffs in critical paths still require careful review"_ — because size-independence is the property a reader is most likely to doubt.

---

### ③ Test Posture — 0.15

[test-posture.ts](../src/lib/engines/dimensions/test-posture.ts) · _Is this change defended by tests?_

Tiered, not continuous — the meaningful distinctions are coarse.

| Condition                    | `raw`                                |
| ---------------------------- | ------------------------------------ |
| `testsRemoved`               | **1.0** — overrides everything below |
| `productionLinesAdded === 0` | 0 — docs, config or test-only        |
| `hasNoTests`                 | **1.0**                              |
| `testRatio >= 0.5`           | 0.10 — well covered                  |
| `testRatio >= 0.25`          | 0.35 — moderately covered            |
| `testRatio >= 0.1`           | 0.60 — thin coverage                 |
| otherwise                    | 0.85 — minimal coverage              |

Test **removal** is a distinct signal from test **absence**, and it is checked first. It also triggers the `tests-removed` floor.

---

### ④ Historical Instability — 0.15

[historical-instability.ts](../src/lib/engines/dimensions/historical-instability.ts) · _What does this repo's own past say?_

```
churn    = weightedMean(saturate(fileChurn[path], 15) for each file)
reverts  = clamp(peakRevertRate / 0.20)
incident = priorIncidentFiles.length > 0 ? 1 : 0

raw = 0.45·churn + 0.35·reverts + 0.20·incident
```

The reason text is concrete and quotable: _"`src/payments/charge.ts` was reverted twice in the last 90 days."_

When git history is unavailable this dimension returns 0 **and** `availability.history` is false, so confidence drops rather than the absence reading as safety. Covered by a test.

---

### ⑤ Change Complexity — 0.12

[change-complexity.ts](../src/lib/engines/dimensions/change-complexity.ts) · Structural, language-agnostic, computed from patch text.

```
branching = saturate(max(0, controlFlowDelta), 12)   // if/for/while/catch/switch/&&/||/?
functions = saturate(functionsAdded, 8)
nesting   = clamp(maxNesting / 4)
deletions = deletionHeavyFiles / analysableFiles
```

Deletion-heavy changes score up: removed logic is under-reviewed and frequently riskier than added logic.

**Fallback:** when no patch text is available, `raw = saturate(lines, 800) × 0.5` — a deliberately damped size proxy, so a missing patch never masquerades as confident complexity analysis.

---

### ⑥ Dependencies — 0.10

[dependencies.ts](../src/lib/engines/dimensions/dependencies.ts)

```
added   = clamp(dependenciesAdded   / 4)
removed = clamp(dependenciesRemoved / 4)

raw = 0.7·added + 0.3·removed + (added > 0 ? 0.3 : 0)
```

The `+0.3` step exists because _any_ new dependency is a supply-chain event, not a matter of degree.

**Lockfile-only changes score near zero.** This is checked before the arithmetic and is the single most common false positive in naive diff scoring.

---

### ⑦ Author & Provenance — 0.08

[author-provenance.ts](../src/lib/engines/dimensions/author-provenance.ts) · The lowest weight, deliberately.

```
first-time contributor      +0.5
authorRevertRate > 0.15     +0.3
likelyAIAuthored            +0.4
established author          -0.15
```

**Why AI-authorship is capped at ~3.2 points of 100, and why that is correct.**

PocketReview is **source-agnostic**. We do not claim AI code is worse. We observe that AI-authored PRs have _different review characteristics_ — larger, more numerous, thinner descriptions — and dimensions ①–⑥ already capture those. Provenance is a corroborating nudge, never a verdict.

`likelyAIAuthored` requires **≥2 of 5** independent hints to fire (Decision Log #7). Two tests defend this: AI provenance moves the score by ≤4 points, and six of seven dimensions ignore authorship entirely.

This is the answer when a judge asks _"what about human-written PRs?"_ — and they will.

---

## ② Bounded modifiers

For facts that are not matters of degree. Applied after the weighted sum; every one that fires is reported in the UI.

| id                 |       Δ | Fires when                              |
| ------------------ | ------: | --------------------------------------- |
| `ci-failing`       |  **+8** | `ciStatus === "failing"`                |
| `hotfix-branch`    | **+10** | targets a release or hotfix branch      |
| `urgent-label`     |  **+6** | linked issue labelled incident/security |
| `already-approved` | **−15** | approved with ≥1 approval               |
| `draft`            | **−20** | `isDraft`                               |
| `generated-only`   | **−25** | every file is generated                 |
| `docs-only`        | **−30** | every file is docs or generated         |

```
modifierDelta = clamp(Σ deltas, -30, +30)      // MODIFIER_CAP
scored        = clamp(baseScore + modifierDelta, 0, 100)
```

**No combination of modifiers can dominate the dimensional score.** That property is what separates a scoring system from a pile of if-statements, and it is tested.

---

## ③ Floors — added during implementation

> **Not in the original architecture.** Floors were added in Phase 2 because the demo test failed at 30 (Decision Log #11). This section documents _why_, because it is the most likely thing a reviewer will challenge.

**The problem.** A weighted sum _averages_, and averaging is wrong for categorical facts. For a maximally critical one-line auth change, six of seven dimensions are structurally near-zero — tiny blast radius, no complexity, no dependencies. The weighted sum caps it near **35/100** and buries it mid-queue.

But "a one-line change to authentication" is not _"20% of a risky PR."_ It is a change a human must look at, full stop.

**The fix.** A floor can only _raise_ a score, is bounded, and names its reason.

| id                       |  Floor | Applies when                                                   |
| ------------------------ | -----: | -------------------------------------------------------------- |
| `critical-path-untested` | **55** | critical path touched **and** (`hasNoTests` or `testsRemoved`) |
| `critical-path`          | **40** | any critical path touched (auth, payments, database)           |
| `tests-removed`          | **35** | tests removed alongside production changes                     |

The highest applicable floor wins.

**Floors never apply to drafts or already-approved PRs** — both are explicitly outside the "needs attention now" question.

**Why not just raise the criticality weight instead?** That would inflate _every_ large PR touching a critical directory — a worse trade. The floor is surgical: it fixes exactly the diluted-small-change case and distorts nothing else.

Floors are set at band boundaries on purpose: _"this must be at least `high`"_ is a claim a reviewer can argue with, which is the point.

**Reporting.** When a floor decides the score, its reason is prepended to `topReasons` and exposed as `floor` / `floorReasons`. Otherwise the number and the stated reasons would not add up — exactly the opacity this engine exists to avoid.

---

## ④ Levels

```
  0 ─────── 25 ─────── 50 ─────── 75 ─────── 100
     LOW      MEDIUM      HIGH      CRITICAL
```

Configurable per repo — a payments monorepo and a docs site should not share a scale. See [configuration.md](./configuration.md#thresholds).

---

## ⑤ Confidence

Not every repo yields every signal. Rather than substituting zeros silently, `SignalAvailability` records what was measurable:

| Signal group    | Weight |
| --------------- | -----: |
| `metadata`      |   0.35 |
| `history`       |   0.20 |
| `patches`       |   0.15 |
| `ci`            |   0.10 |
| `authorHistory` |   0.07 |
| `reviews`       |   0.08 |
| `codeowners`    |   0.05 |

```
confidence = Σ weights of available groups / Σ all weights
```

Below **0.6**, `lowConfidence` is set and the UI says _"Limited signals — history unavailable."_

**Showing confidence honestly is a credibility feature, not a weakness** (Decision Log #8). A system caught hiding missing data is trusted about nothing else.

---

## The baseline — shipped, so the comparison is runnable

```ts
baselineScore(signals) = round(clamp((additions + deletions) / 1000) × 100)
```

The naive lines-changed model ships **inside the engine**, beside the real one, so the comparison is executable rather than asserted (Decision Log #12). It is what the Phase 8 eval measures against, and what the breakdown screen shows side by side.

---

## The demo table — measured, reproducible

Run `npm test` to reproduce ([tests/risk-engine.test.mjs](../tests/risk-engine.test.mjs)):

| Scenario                | Lines |      PocketReview | Lines-changed baseline |
| ----------------------- | ----: | ----------------: | ---------------------: |
| One-line auth change    |     2 |     **55** · high |                      0 |
| 4,000-line lockfile     | 5,000 |       **0** · low |                    100 |
| Docs typo fix           |    10 |       **0** · low |                      1 |
| Auth + payments rewrite |   660 | **89** · critical |                     66 |

**The baseline ranks the lockfile at 100 and the auth change at 0 — exactly inverted.** That inversion is the demo.

---

## What the tests defend

33 tests in `risk-engine.test.mjs`. The ones that encode the product claims:

- One-line auth change scores 55 (high) ← **demo centrepiece**
- 4,000-line lockfile scores 0 (low) ← the classic false positive
- Tiny auth change outranks huge lockfile; the baseline gets it backwards
- Contributions sum to `baseScore`; score fully accounted for by base + modifiers + floor
- Floors only raise; never fire on drafts or approved PRs
- Deterministic across 50 runs
- No dimension exceeds its weight cap; modifier aggregate cap holds
- Criticality is size-independent
- Missing history → zero instability **and** lower confidence
- AI provenance moves the score by ≤4 points; six dimensions ignore authorship

> If the first two fail, the core value proposition is broken. Do not merge past them.

---

## Adding or changing a dimension

1. Weights **must** still sum to `1.00` — the engine throws at load otherwise, failing the whole suite instantly.
2. Return `raw` in `[0,1]`. The orchestrator clamps defensively, but the logic should be sound.
3. Populate `signalsUsed` — it drives the audit view.
4. Write reasons a reviewer would actually say out loud. They surface verbatim on the card.

See [contributing.md](./contributing.md#adding-a-risk-dimension).

---

## Validation 🕐 Phase 8

Everything above is _internally_ consistent and tested. Whether the ranking is _correct_ is an empirical question answered by the eval harness — mine merged PRs, label attention-worthy outcomes from history, report Recall@K against the baseline.

See [architecture.md §16](../ARCHITECTURE.md#16-validation-strategy). **Until `eval/results.md` exists with real measured numbers, no accuracy claim should be made.**

---

_Verified against the source on 2026-09-03 — Phase 2 complete, 74/74 tests passing._
