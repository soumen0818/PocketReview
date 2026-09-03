# Contributing

> How to work on PocketReview without breaking the properties that make it defensible.
>
> Read [architecture.md](../ARCHITECTURE.md) first — particularly §2 (the thesis) and §6 (the risk engine). This guide assumes it.

---

## The four invariants

Every change is measured against these. Breaking one is not a bug to fix later — it invalidates the project's central claim.

### 1. The score is computed in code. The LLM only narrates it.

No model output may ever influence a number, a rank, or a decision. If an LLM produced the score, _"why 87?"_ has no answer.

**Test:** turn the LLM off. Every score, ranking and breakdown must still work.

### 2. Every point traces to a named signal.

`dimensions[].contribution` sums to `baseScore`. Modifiers and floors account for the rest. A new dimension must populate `signalsUsed`, or the audit view lies.

### 3. Nothing writes to GitHub.

No merge, no approve, no review submission. The approve endpoint existed and was **deliberately deleted** (Decision Log #3). Do not reintroduce it.

### 4. Missing data lowers confidence — it never becomes zero silently.

If a signal cannot be measured, record it in `availability`. A repo without history gets a lower-confidence score, never a false-clean one.

---

## Setup

```bash
git clone <repo> && cd LGTM
npm install --legacy-peer-deps
cp .env.example .env.local        # add GITHUB_TOKEN

npm run dev                       # → localhost:3000
DEMO_MODE=1 npm run dev           # offline, no token needed
```

`--legacy-peer-deps` is required: `react-tinder-card` has not declared React 19 support.

Test on a phone viewport — Chrome DevTools → device toolbar → iPhone 14 Pro. This is a mobile product; a desktop-only check will miss real problems.

---

## Before every commit

```bash
npm run typecheck   # tsc --noEmit
npm test            # 74 tests, offline
npm run build       # production build
npm run format      # prettier
```

All four must pass. A phase task is only `[x]` when it is written, typechecking, tested where testable, and building. _"Written but unverified" is `[~]`._

---

## Where things live

```
src/lib/signals/     measurement only — no scores, no judgement
src/lib/engines/     pure functions: PRSignals → assessments
src/lib/claude.ts    the only external egress for diff content
src/components/      presentation; no business logic
src/app/api/         thin route handlers over the layers above
tests/               node:test, no network, no env vars
```

**The layer boundary is the design.** Signals measure; engines judge; components render. A component computing a score, or a signal module deciding something is "risky", breaks the property that makes the system testable and explainable.

---

## Adding a risk dimension

Dimensions are pure functions in [src/lib/engines/dimensions/](../src/lib/engines/dimensions/).

### 1. Rebalance the weights first

Weights must sum to **exactly 1.00** — asserted at module load, so a mistake fails the whole suite immediately. Adding a dimension means taking weight from existing ones. Decide that deliberately.

### 2. Write it

```ts
import { clamp, saturate } from "../../math";
import type { PRSignals } from "../../signals/types";
import type { Dimension, DimensionOutput } from "../types";

export const myDimension: Dimension = {
  id: "my-dimension", // add to DimensionId in engines/types.ts
  name: "My dimension",
  weight: 0.05,

  evaluate(signals: PRSignals): DimensionOutput {
    const raw = clamp(/* your 0..1 assessment */);
    return {
      raw,
      reasons: ["Something a reviewer would actually say"],
      signalsUsed: ["theFieldsIRead"],
    };
  },
};
```

### 3. Register it

Add to `DIMENSIONS` in [risk-engine.ts](../src/lib/engines/risk-engine.ts) — the array order is the display order.

### 4. Rules

- **`raw` in `[0,1]`.** The orchestrator clamps defensively; don't rely on it.
- **Use `saturate(x, k)` for magnitudes.** Diminishing returns: a 5,000-line PR is not 10× a 500-line one.
- **Exclude generated files** from anything size-based.
- **Exclude test files** from criticality — otherwise adding tests raises risk.
- **`signalsUsed` must be accurate.** It is the audit trail.
- **Reasons are user-facing.** They appear verbatim on the card. Concrete and quotable beats generic: _"`src/payments/charge.ts` was reverted twice in the last 90 days"_ — not _"file has history."_
- **Never read the network or the clock.** Determinism is tested across 50 runs.

### 5. Test it

```js
test("my-dimension fires on X", () => {
  const signals = makeSignals({
    /* only what this dimension reads */
  });
  const output = myDimension.evaluate(signals);
  assert.ok(output.raw > 0.8);
  assert.ok(output.reasons.length > 0);
});
```

Then re-run the structural tests — they catch weight-sum mistakes instantly.

---

## Adding a modifier or a floor

**Modifier** — a bounded ± adjustment for a fact that is _not a matter of degree_ (CI either fails or it does not). Add to `MODIFIER_RULES`. The aggregate stays capped at ±30, so no combination can dominate.

**Floor** — a minimum score for a categorical fact that averaging would dilute. Add to `FLOOR_RULES`. A floor may only **raise** a score, must state its reason, and must be suppressed for drafts and approved PRs.

> Prefer a modifier. Reach for a floor only when a weighted average genuinely produces the wrong answer — the one-line auth change being the canonical case (Decision Log #11).

---

## Adding a path rule

Usually configuration, not code — see [configuration.md](./configuration.md#paths--path-rules). Change the built-in table in [path-rules.ts](../src/lib/signals/path-rules.ts) only when the default is wrong for _most_ repos.

Order matters. `generated` must stay first; `test` must stay ahead of domain rules.

---

## Adding a signal

1. Add the field to `PRSignals` in [signals/types.ts](../src/lib/signals/types.ts), grouped with its neighbours.
2. Populate it in [collect.ts](../src/lib/signals/collect.ts), with a neutral fallback (`0`, `false`, `[]`) if the source fails.
3. If it comes from a source that can be unavailable, make sure the relevant `availability` flag is set.
4. **Add it to `makeSignals()`** in [tests/helpers/signals.mjs](../tests/helpers/signals.mjs) with a neutral default — otherwise existing tests break or, worse, silently change meaning.

Signals **measure**. If you find yourself writing `isRisky` or `shouldReview`, that judgement belongs in an engine.

---

## Working on the LLM layer

- The model receives the **already-computed** assessment. It never computes.
- **Every number in the output must have been passed in as input.**
- Diff content is the only thing that leaves the process, and only when `llm.enabled`.
- Run `redactSecrets()` before dispatch.
- Rank hunks by consequence before truncating — naive truncation sends the lockfile, alphabetically first.
- **Never block the deck on a model call.**

Treat diffs as attacker-controllable. Model output is displayed, never executed or parsed into control flow.

---

## Style

Match the surrounding code — it has a consistent voice worth preserving.

- **Comments explain _why_, not _what_.** The existing modules are the reference: they justify decisions rather than narrating syntax.
- British spelling in prose and comments (`normalised`, `behaviour`).
- Prettier decides formatting; don't hand-format.
- Named exports for functions, default exports for components.
- No `any` — `PRSignals` is fully typed for a reason.

---

## Documentation

**[architecture.md](../ARCHITECTURE.md) is the source of truth for the design.** It describes the complete system, including parts not yet built. Do not edit it to match the code — the code is what moves toward it.

**[PROGRESS.md](./PROGRESS.md) is the source of truth for status.** Update it in the same commit as the work.

The reference docs in this folder describe **what is shipped** and mark planned work explicitly:

```markdown
> 🕐 **Planned — Phase N.** Not yet implemented.
```

Rules:

1. **Never document an unbuilt feature in the present tense.** A contributor coding against a documented endpoint that does not exist is a real cost, and a judge who finds one stops trusting the rest.
2. **Never present illustrative numbers as measured.** Placeholder figures must stay marked as placeholders until `eval/results.md` has real output.
3. **Verify before you write.** Read the source. Every claim in these docs was checked against the code, and it should stay that way.
4. **Update the Decision Log** in PROGRESS.md when you make a call a judge might question.

---

## PR checklist

- [ ] `npm run typecheck` clean
- [ ] `npm test` passes (74+)
- [ ] `npm run build` succeeds
- [ ] `npm run format` applied
- [ ] Dimension weights still sum to 1.00
- [ ] New signals added to `makeSignals()`
- [ ] `signalsUsed` accurate on any new/changed dimension
- [ ] No new GitHub write calls
- [ ] No LLM output influencing a number
- [ ] PROGRESS.md updated
- [ ] Docs updated, with 🕐 markers on anything not yet built
- [ ] Checked at 390×844

---

## Things deliberately not built

Proposing these means arguing against a decision already made — which is fine, but bring the argument (architecture §22):

- Line-level review comments — solved space, and it worsens the bottleneck
- Auto-merge / auto-approve — the trust problem we exist to address
- A full mobile diff viewer — the phone should show less, not the same thing smaller
- Multi-forge support — architecturally trivial, demo-irrelevant
- A trained ML risk model — unexplainable at this data scale
- Calendar integration — plausible-sounding, adds no technical depth

---

## The four sentences

If everything else is forgotten:

1. **AI multiplied code output. It did not multiply reviewer attention.**
2. **We do not judge whether code is correct. We decide where a human should look first.**
3. **The score is computed in code; the LLM only narrates it.**
4. **We never let an AI approve code written by an AI.**
