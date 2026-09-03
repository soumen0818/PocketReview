# Testing Guide

PocketReview uses the Node.js built-in test runner (`node:test`) and assertions (`node:assert`). No external testing framework like Jest or Vitest is required. 

This approach keeps the toolchain light, dependency footprint small, and test execution extremely fast.

---

## Table of Contents

1. [Running Tests](#running-tests)
2. [Test Categories](#test-categories)
3. [The Key Demo Tests](#the-key-demo-tests)
4. [Test Helpers & Fixtures](#test-helpers--fixtures)
5. [Testing a New Dimension](#testing-a-new-dimension)
6. [CI Integration](#ci-integration)

---

## Running Tests

Tests are executed using `tsx` (TypeScript Execute) to handle TS/ESM transpilation on the fly.

**Run all tests:**
```bash
npm test
```
*(Under the hood, this runs: `tsx --test tests/*.test.mjs`)*

---

## Test Categories

The test suite is organized into distinct categories, verifying different layers of the application.

| File | What it Covers |
|---|---|
| `risk-engine.test.mjs` | The scoring formula, dimension weights, modifier caps, floor rules, structural guarantees, and the core demo claims. |
| `signals.test.mjs` | Path classification (`classifyPath`), CODEOWNERS parsing (`parseCodeowners`), generated/test file detection, entropy calculations, and pure signal derivation. |
| `risk-display.test.mjs` | Presentation utilities: `timeAgo` formatting, `shortRepo` extraction, and color token completeness (`LEVEL_STYLES`). |
| `demo-queue.test.mjs` | Runs the full demo queue (`fixtures.ts`) through the risk engine to ensure all demo PRs map to the expected risk bands without crashing. |

---

## The Key Demo Tests

PocketReview makes two core claims about its scoring system over naive "lines-changed" models. These claims are strictly enforced in `risk-engine.test.mjs`.

### 1. "A one-line auth change scores HIGH"
*Size is not risk; domain criticality is size-independent.*

This test creates a fixture with exactly 1 addition and 1 deletion in `src/auth/session.ts` and asserts that:
- `risk.score >= 50` (Medium or High)
- The `domain-criticality` dimension contributes the vast majority of points.
- The `baselineScore` (lines-changed) rates it near 0.

### 2. "A 4,000-line lockfile scores LOW"
*Large diffs are not inherently risky if they are generated.*

This test creates a fixture with 4,000+ additions in `package-lock.json` and asserts that:
- `risk.score < 25` (Low)
- The size dimensions appropriately ignore the generated file.
- The `baselineScore` maxes out at 100 (proving the naive model fails here).

> **Important:** If either of these tests fails, the core value proposition of the engine is broken. Do not merge changes that break these assertions.

---

## Test Helpers & Fixtures

**Path:** `tests/helpers/signals.mjs`

Because the engine requires a deeply nested `PRSignals` object, writing tests manually would be tedious. We use factory functions to generate predictable signals.

### `makeSignals(overrides)`
Returns a complete, valid `PRSignals` object with safe neutral defaults (e.g., 0 additions, no files, empty strings). Use the `overrides` parameter to specify the exact state you are testing.

```javascript
import { makeSignals } from './helpers/signals.mjs';

const signals = makeSignals({
  isDraft: true,
  files: [ ... ]
});
```

### `makeFile(overrides)`
Generates a `FileSignal` object. By default, returns a trivial `other` file with 0 additions.

```javascript
import { makeFile } from './helpers/signals.mjs';

const authFile = makeFile({
  path: 'src/auth/login.ts',
  category: 'auth',
  categoryWeight: 1.0,
  additions: 10
});
```

### Pre-built Fixtures
- `oneLineAuthChange()`: 1-line change to auth/session.
- `lockfileOnlyChange()`: 4000-line package-lock change.
- `docsOnlyChange()`: README change.
- `dangerousChange()`: Auth file + no tests + failing CI.

---

## Testing a New Dimension

When adding a new dimension to `src/lib/engines/dimensions/`, you must update the test suite to ensure structural guarantees are maintained.

1. **Weight sum:** The sum of weights in `DIMENSIONS` must exactly equal `1.00`. If you add a dimension, you must reduce weights elsewhere. The engine throws at module load if this is violated, which will instantly fail the entire test suite.
2. **Bounds checking:** Ensure your dimension strictly returns a `raw` value between `0` and `1`. (The engine `clamp`s this defensively, but your logic should be sound).
3. **Write specific dimension tests:** Create fixtures that isolate your dimension's logic (e.g., maximizing its inputs while zeroing others) and assert the `raw` score output.

```javascript
test("new-dimension handles X correctly", () => {
  const signals = makeSignals({ /* specific setup */ });
  const output = myNewDimension.evaluate(signals);
  
  assert.ok(output.raw > 0.8);
  assert.equal(output.reasons.length, 1);
});
```

---

## CI Integration

Tests should run on every pull request. Since the test suite does not require any environment variables (like `GITHUB_TOKEN` or `ANTHROPIC_API_KEY`) and performs no network I/O, it can run trivially in GitHub Actions.

Example `.github/workflows/test.yml`:

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
