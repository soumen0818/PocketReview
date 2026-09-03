# Testing

> Corresponds to [architecture.md §16](../ARCHITECTURE.md#16-validation-strategy).
>
> **Status:** ✅ **74/74 passing**, verified 2026-09-03. The eval harness (§ *Validation*) is 🕐 Phase 8.

---

## Two different questions

Keep these separate — conflating them is how projects end up claiming accuracy they never measured.

| | Question | Answered by | Status |
|---|---|---|---|
| **Tests** | Does the engine do what it says? | `npm test` | ✅ 74 passing |
| **Eval** | Is what it says *correct*? | `npm run eval` | 🕐 Phase 8 |

Tests prove the arithmetic is sound, the guarantees hold, and the demo claims reproduce. They cannot prove the ranking is right — that needs ground truth from history.

---

## Running

```bash
npm test          # 74 tests, offline, ~1.6s
npm run typecheck # tsc --noEmit
npm run build     # production build
```

Node's built-in runner (`node:test` + `node:assert`) via `tsx` for TS/ESM transpilation. No Jest, no Vitest — light toolchain, tiny dependency surface, fast.

**No network, no environment variables.** The suite runs with the wifi off and needs neither `GITHUB_TOKEN` nor `ANTHROPIC_API_KEY`. That is a design property: the engines are pure functions over `PRSignals`, so they are testable without touching GitHub.

---

## Suites

| File | Tests | Covers |
|---|---:|---|
| [risk-engine.test.mjs](../tests/risk-engine.test.mjs) | 33 | Scoring formula, weights, modifier caps, floors, structural guarantees, demo claims |
| [signals.test.mjs](../tests/signals.test.mjs) | 29 | Path classification, CODEOWNERS, diff parsing, patch ranking, redaction, math |
| [demo-queue.test.mjs](../tests/demo-queue.test.mjs) | 12 | The full demo queue through the real engine |
| [risk-display.test.mjs](../tests/risk-display.test.mjs) | — | `LEVEL_STYLES` completeness, `timeAgo`, `shortRepo` |

---

## The claims the tests defend

These encode the product thesis. **If they fail, the value proposition is broken — do not merge past them.**

### 1. A one-line auth change scores high

Fixture: 1 addition, 1 deletion in `src/auth/session.ts`.

```
score        55  ·  high
baseline      0            ← lines-changed model
```

Asserts domain criticality dominates, and that the `critical-path` floor carries the score to the `high` band. *Size is not risk.*

### 2. A 4,000-line lockfile scores low

Fixture: 4,000+ additions in `package-lock.json`.

```
score         0  ·  low
baseline    100            ← lines-changed model maxes out
```

Asserts generated files are excluded from size scoring. *The classic false positive.*

### 3. The baseline gets both backwards

The decisive test: the tiny auth change **outranks** the huge lockfile in our engine, and the lines-changed baseline ranks them in exactly the opposite order.

That inversion is the demo.

### Structural guarantees

- Contributions sum to `baseScore`
- Score fully accounted for by base + modifiers + floor
- Floors only raise; never fire on drafts or approved PRs
- **Deterministic across 50 runs**
- No dimension exceeds `weight × 100`
- Modifier aggregate cap (±30) holds
- Score always an integer in `[0,100]`

### Behavioural guarantees

- Criticality is size-independent
- Test removal forces the dimension to maximum
- Missing history → zero instability **and** lower confidence
- AI provenance moves the score by ≤4 points
- Six of seven dimensions ignore authorship entirely
- Docs-only lands in `low`; an empty PR does not crash

---

## A test that caught a real bug

Patch ranking (`rankPatchesByConsequence`) originally **multiplied** criticality by size. That let a 200-line UI file (`0.3 × 200 = 60`) outrank a 15-line auth change (`1.0 × 15 = 15`) — so the LLM would have been sent the UI file and not the auth change.

The fix: criticality dominates, size breaks ties within a tier. Two tests now pin it (Decision Log #6).

This is the argument for testing pure functions: the bug was invisible in the UI and would have surfaced as *"the explanation talks about the wrong file."*

---

## Fixtures

### `tests/helpers/signals.mjs`

`PRSignals` has ~70 fields; building one by hand per test is unworkable.

```js
import { makeSignals, makeFile } from "./helpers/signals.mjs";

// Complete, valid PRSignals with neutral defaults — override what you test.
const signals = makeSignals({
  files: [makeFile({
    path: "src/auth/session.ts",
    category: "auth",
    categoryWeight: 1.0,
    additions: 1,
    deletions: 1,
  })],
  productionLinesAdded: 1,
  hasNoTests: true,
  criticalPaths: ["auth"],
});
```

`makeSignals(overrides)` returns neutral defaults — zero counts, empty collections, full availability. `makeFile(overrides)` returns a trivial `other` file.

**Neutral defaults matter:** a test for one dimension must not accidentally trip another. If a new required field lands on `PRSignals`, add it here with a neutral default.

### `src/lib/demo/fixtures.ts`

Seven hand-built PRs powering `DEMO_MODE=1`, exercised by `demo-queue.test.mjs`. They run through the **real engine** (Decision Log #13) — so the demo test and the demo itself cannot diverge.

Covers: tiny-critical, huge-worthless, emergency, well-tested, trivial, low-confidence.

---

## Testing a new dimension

1. **Weights must still sum to 1.00.** The engine throws at module load otherwise — the entire suite fails instantly, by design.
2. **`raw` must be in `[0,1]`.** The orchestrator clamps defensively; your logic should not rely on it.
3. **Isolate it.** Maximise your dimension's inputs, leave everything else neutral, assert on `raw`.
4. **Assert the reasons.** They surface verbatim on the card — an empty or unreadable reason is a bug.

```js
test("new-dimension fires on X", () => {
  const signals = makeSignals({ /* only what this dimension reads */ });
  const output = myNewDimension.evaluate(signals);

  assert.ok(output.raw > 0.8);
  assert.ok(output.reasons.length > 0);
  assert.ok(output.signalsUsed.includes("theFieldIRead"));
});
```

Then re-run the structural tests — they will catch a weight-sum mistake immediately.

---

## What is *not* covered

Honesty here is the point of the section.

| Gap | Why | Plan |
|---|---|---|
| **Component rendering** | No React test renderer installed | Manual; low value pre-demo |
| **Mobile layout at 390×844** | Needs human eyes | ⚠️ **Before the demo** |
| **API route handlers** | Would need Next request mocking | Logic lives in tested pure functions |
| **Live GitHub integration** | Deliberately no network in tests | `DEMO_MODE` + manual runs |
| **Ranking correctness** | Needs historical ground truth | 🕐 Phase 8 eval |

---

## Validation harness 🕐 Phase 8

> **Never cut.** Architecture §16. This is what turns *"we built a scoring system"* into *"our scoring system beats the naive approach by N points of recall."*

### Reframe the claim

We do **not** claim to predict bugs. We claim to **rank PRs by required human attention**. So we validate the *ranking*, not a classification.

### Ground truth, mined automatically

```
A merged PR is labelled ATTENTION-WORTHY if any held:
  ├── it was reverted
  ├── a commit within 7 days referenced it as a fix
  ├── it received "changes requested"
  ├── it needed > 3 review rounds
  └── it touched files in a subsequent incident/hotfix commit
```

Fully automatable from `git log` and the GitHub API — no manual labelling. `reviewRounds` already exists on `PRSignals` for exactly this.

### Metrics

| Metric | Meaning |
|---|---|
| **Recall@K** | Of the truly attention-worthy PRs, how many are in our top K? ← **headline** |
| Precision@K | Of our top K, how many were justified? |
| NDCG | Ranking quality across the whole queue |
| **Lift vs baseline** | Versus `baselineScore()` ← **the money number** |

Recall@K is the KPI rather than "time saved" because time saved needs a control group that does not exist (Decision Log #10).

### Rules

- `eval/results.md` is **committed with real measured output**.
- Record which repo was **tuned on** versus **tested on**.
- Effort calibration reports MAE against time-to-first-review. Honestly ±8 minutes beats a precision you cannot support.

> **Never present illustrative figures as measured ones.** The template numbers in architecture §16 are placeholders to fill from a real run. Presenting them as measured is the one mistake that cannot be recovered from when a judge probes.

---

## CI

The suite needs no secrets and no network, so CI is trivial:

```yaml
name: Test
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install --legacy-peer-deps
      - run: npm run typecheck
      - run: npm test
```

> Not yet committed — no `.github/workflows/` in the repo. Add when convenient.

---

## Definition of done

A phase is complete when:

1. Every task is `[x]`
2. `npm run typecheck` is clean
3. `npm test` passes
4. `npm run build` succeeds
5. The phase's "done when" is demonstrably true

*"Written but unverified" is `[~]`, not `[x]`.*

---

*Verified 2026-09-03 — 74/74 passing, typecheck clean, production build succeeds.*
