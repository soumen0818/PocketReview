# Contributing to PocketReview

Welcome, and thank you for your interest in PocketReview! We're building intelligent PR triage tooling for AI-accelerated engineering teams, and we'd love your help making it better.

This guide will walk you through everything you need to get a development environment running, understand the architecture, and make a high-quality contribution.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Development Setup](#development-setup)
- [Running the App Locally](#running-the-app-locally)
- [Demo Mode](#demo-mode)
- [Development Workflow](#development-workflow)
- [Running Tests](#running-tests)
- [Code Style](#code-style)
- [Adding a New Risk Dimension](#adding-a-new-risk-dimension)
- [Adding New Path Rules](#adding-new-path-rules)
- [Architecture Decisions to Respect](#architecture-decisions-to-respect)
- [Pull Request Checklist](#pull-request-checklist)

---

## Code of Conduct

PocketReview is an open, welcoming project. We expect all contributors to:

- **Be respectful** — Disagreements happen; personal attacks don't.
- **Be constructive** — Critique the idea, never the person.
- **Be inclusive** — We welcome contributors of all backgrounds and experience levels.
- **Be honest** — If you're unsure about something, say so. We'd rather have a good question than a bad assumption.

Violations of these norms may result in removal from the project at the maintainers' discretion.

---

## Development Setup

### Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | >= 20.x LTS | Use [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm) to manage versions |
| npm | >= 10.x | Ships with Node 20 |
| Git | any modern | |
| GitHub Personal Access Token | — | `repo:read` scope is sufficient; see below |
| Anthropic API Key | — | **Optional.** Only required for the LLM explanation layer |

> [!IMPORTANT]
> PocketReview is **read-only** by design. Your GitHub token only needs `repo:read` scope. Do not grant write or admin permissions.

### 1 — Clone the Repository

```bash
git clone https://github.com/your-org/PocketReview.git
cd PocketReview
```

### 2 — Install Dependencies

```bash
npm install
```

### 3 — Configure Environment Variables

Copy the example env file and fill in your values:

```bash
cp .env.example .env.local
```

Then edit `.env.local`:

```dotenv
# Required — GitHub Personal Access Token (repo:read scope only)
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx

# Optional — Anthropic API Key for LLM narration
# Leave blank to disable the explanation layer entirely
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxx

# Optional — Set to 1 to run in offline demo mode (no GitHub API calls)
DEMO_MODE=
```

> [!TIP]
> Running without `ANTHROPIC_API_KEY` is fully supported. The risk score and all dimension data will still be calculated deterministically; only the natural-language explanation card will be absent.

### 4 — Configure the Project (Optional)

PocketReview reads a `.pocketreview.yml` file from the project root to customise path weights, thresholds, and policy gates. A sensible set of defaults is built in, so this file is optional for getting started.

See [`docs/configuration.md`](./configuration.md) for the full reference.

---

## Running the App Locally

```bash
# Start the Next.js development server (hot-reload)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser. The swipe deck will load your open PRs from GitHub via `/api/prs`.

### Other Useful Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot-reload |
| `npm run build` | Production build |
| `npm run start` | Start the production server (requires a prior `build`) |
| `npm run lint` | Run ESLint across the project |
| `npm run typecheck` | TypeScript type-check without emitting |
| `npm test` | Run the full test suite |
| `npm run format` | Auto-format with Prettier |
| `npm run format:check` | Check formatting (CI-safe, no writes) |

---

## Demo Mode

Demo mode lets you run the full application **without any GitHub credentials or network access**. It serves a set of pre-captured signal fixtures so you can develop and iterate on the UI and scoring logic in isolation.

```bash
# Enable demo mode
DEMO_MODE=1 npm run dev
```

In demo mode:

- `/api/prs` returns the fixtures defined in [`src/demo/fixtures.ts`](../src/demo/fixtures.ts).
- No GitHub API calls are made.
- `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` are not required.
- The full swipe deck, risk badges, dimension breakdowns, and chat screen all work normally.

> [!NOTE]
> When adding a new feature that touches the signal collection or scoring path, update `src/demo/fixtures.ts` to include representative fixtures that exercise the new code path. This keeps demo mode representative and allows CI to catch regressions without live credentials.

---

## Development Workflow

### Branches

We follow a straightforward branching model:

| Branch pattern | Purpose |
|----------------|---------|
| `main` | Stable, releasable code |
| `feat/<short-description>` | New features |
| `fix/<short-description>` | Bug fixes |
| `chore/<short-description>` | Tooling, dependencies, refactors |
| `docs/<short-description>` | Documentation-only changes |

### Commits

We use **Conventional Commits**. This is enforced by CI:

```
<type>(<optional scope>): <short imperative description>

<optional body>

<optional footer>
```

Common types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`.

Examples:

```
feat(risk-engine): add author-provenance dimension
fix(signals): handle missing CODEOWNERS gracefully
docs(contributing): add dimension authoring guide
test(risk-engine): cover floor interactions with modifiers
```

### Opening a Pull Request

1. Push your branch to the remote.
2. Open a PR against `main`.
3. Fill in the PR template (auto-populated).
4. Complete the [PR Checklist](#pull-request-checklist) before requesting review.
5. At least one maintainer approval is required to merge.

---

## Running Tests

The test suite uses Node's built-in test runner (`node:test`) via `tsx`:

```bash
npm test
```

Tests are located in the `tests/` directory:

| Test file | What it covers |
|-----------|---------------|
| `tests/risk-engine.test.mjs` | Core scoring arithmetic: dimensions, modifiers, floors, floor-modifier interactions, edge cases (empty signals, missing fields) |
| `tests/signals.test.mjs` | Signal collection helpers: `collectSignals()`, `classifyPath()`, `parseCodeowners()`, diff parsing |
| `tests/risk-display.test.mjs` | Presentation token correctness: colour mapping, label strings, badge variants for each risk level |
| `tests/demo-queue.test.mjs` | Integration smoke test: runs the full scoring pipeline over `DEMO_SIGNALS` and asserts expected risk levels |

### Test Helpers

`tests/helpers/signals.mjs` exports factory functions to keep tests DRY:

```js
import { makeSignals, makeFile, fullAvailability } from './helpers/signals.mjs';

const signals = makeSignals({
  files: [makeFile({ path: 'src/auth/session.ts', linesAdded: 5, linesRemoved: 2 })],
  availability: fullAvailability(),
});
```

Use these helpers when writing new tests rather than constructing raw objects.

### Writing New Tests

- Tests live in `tests/` as `.test.mjs` files.
- Keep tests **pure and fast**: no network calls, no file system access.
- Use `makeSignals` / `makeFile` from the helpers for signal construction.
- Aim for unit-level isolation; assert on the return value of single functions.
- For a new dimension, add at least: a zero-input test, a maximum-score test, and the documented edge-case tests.

---

## Code Style

### TypeScript

- **Strict mode is enabled.** All code must type-check with `npm run typecheck` before merging.
- Prefer explicit return types on exported functions.
- Avoid `any`; use `unknown` and narrow it, or define a proper type in `src/lib/types.ts` or the relevant `types.ts`.
- Use `satisfies` where appropriate to get inference without widening.

### ESLint

We use the Next.js ESLint config with a few project-specific rules. Run:

```bash
npm run lint
```

Fix lint errors before opening a PR. Lint is enforced in CI.

### Prettier

All code is formatted with Prettier. The config lives in `.prettierrc`. Run:

```bash
npm run format        # format in-place
npm run format:check  # check only (used in CI)
```

> [!TIP]
> Install the Prettier VS Code extension and enable **Format on Save** to avoid formatting surprises at PR time.

### Naming Conventions

| Construct | Convention | Example |
|-----------|-----------|---------|
| Files/directories | kebab-case | `risk-engine.ts`, `domain-criticality.ts` |
| React components | PascalCase | `PRCard.tsx`, `RiskBadge.tsx` |
| Functions / variables | camelCase | `assessRisk()`, `baselineScore` |
| Types / interfaces | PascalCase | `RiskAssessment`, `DimensionResult` |
| Constants | SCREAMING_SNAKE or camelCase | `DEFAULT_PATH_RULES`, `MAX_CONCURRENT` |
| Test files | `*.test.mjs` | `risk-engine.test.mjs` |

---

## Adding a New Risk Dimension

The risk engine is designed to be extended. Each dimension is a **pure function** that takes `PRSignals` and returns a `DimensionResult`. Follow these steps:

### Step 1 — Create the Dimension File

Create a new file in `src/lib/engines/dimensions/`:

```
src/lib/engines/dimensions/my-new-dimension.ts
```

Implement the scoring function:

```typescript
import type { PRSignals } from '../../signals/types';
import type { DimensionResult } from '../types';
import { saturate } from '../../math';

/**
 * my-new-dimension
 *
 * Measures <what this dimension captures and why it matters>.
 *
 * Weight: 0.XX (must be reflected in risk-engine.ts)
 */
export function scoreMyNewDimension(signals: PRSignals): DimensionResult {
  // 1. Handle missing-signal case gracefully — degrade, never throw.
  if (!signals.someRequiredField) {
    return { score: 0, confidence: 0, reasons: [] };
  }

  // 2. Compute a raw score in [0, 100].
  const raw = /* your logic here */;
  const score = saturate(raw); // clamp to [0, 100]

  // 3. Return human-readable reasons for the UI.
  const reasons: string[] = [];
  if (raw > 50) reasons.push('High <signal> detected');

  return { score, confidence: 1, reasons };
}
```

**Rules for dimension functions:**

- Must be **pure** — no side effects, no I/O, no random numbers.
- Must handle `undefined` / missing signal fields without throwing.
- `score` must be in the range `[0, 100]`. Use `saturate()` from `src/lib/math.ts`.
- `confidence` should be `0` when the signal is absent, `1` when fully available, or a fraction for partial data.
- `reasons` must be human-readable strings suitable for the `RiskReasons` component.

### Step 2 — Register the Dimension in the Risk Engine

Open `src/lib/engines/risk-engine.ts` and:

1. Import your new function.
2. Add it to the `DIMENSIONS` array with its weight.
3. Ensure the weights in `DIMENSIONS` still sum to `1.00`.

```typescript
import { scoreMyNewDimension } from './dimensions/my-new-dimension';

const DIMENSIONS = [
  // ... existing dimensions ...
  { id: 'my-new-dimension', weight: 0.XX, score: scoreMyNewDimension },
];
```

> [!IMPORTANT]
> The weights of all dimensions **must sum to exactly 1.00**. Adjust other dimension weights proportionally if you are adding a genuinely new axis of risk rather than splitting an existing one. Document your reasoning in the PR description.

### Step 3 — Update the Display Layer

If your dimension needs custom display tokens (colour, icon, label), update `src/lib/risk-display.ts`.

### Step 4 — Add Tests

Create `tests/dimensions/my-new-dimension.test.mjs` (or add cases to `risk-engine.test.mjs` for smaller dimensions). At minimum, cover:

- Zero-signal / missing-data path → `confidence: 0`, score doesn't blow up.
- Minimum score boundary.
- Maximum score boundary.
- The primary documented edge case for your dimension.

### Step 5 — Update `docs/risk-scoring.md`

Add a section for your new dimension under **The 7 Dimensions** (or adjust the heading count). Explain what it measures, how the score is derived, and any notable edge cases.

---

## Adding New Path Rules

Path rules control how file paths are classified into categories (e.g., `auth`, `payments`), which drives the **domain-criticality** dimension.

Default rules are defined in `src/lib/signals/path-rules.ts`. Users can extend these via `.pocketreview.yml`.

### Via `.pocketreview.yml` (User-Facing)

```yaml
paths:
  - category: payments
    weight: 1.0
    patterns: ["stripe", "billing", "invoice", "checkout"]
  - category: ml-pipeline
    weight: 0.8
    patterns: ["training", "inference", "model", "embedding"]
```

Rules are evaluated in **declaration order** — the first match wins. Place more specific patterns before broader ones.

### In Code (Default Rules)

To add a default rule that ships with the product, add an entry to the `DEFAULT_PATH_RULES` array in `src/lib/signals/path-rules.ts`:

```typescript
export const DEFAULT_PATH_RULES: PathRule[] = [
  // ... existing rules ...
  {
    category: 'ml-pipeline',
    weight: 0.8,
    patterns: ['training', 'inference', 'model', 'embedding'],
  },
];
```

**Always** add tests in `tests/signals.test.mjs` asserting that the new patterns classify correctly. Test both positive matches and that nearby-but-not-matching paths are unaffected.

---

## Architecture Decisions to Respect

These are the key invariants that the project is built around. Please read them before making architectural changes. If you believe one should be revisited, open a discussion issue first.

### 1. Score is Deterministic Arithmetic; LLM Only Narrates

The risk score is computed purely from signals using arithmetic. The LLM (`claude.ts`) is only ever called to produce a natural-language explanation of a score that has already been computed. **The LLM must never influence the score.**

### 2. Missing Signals Degrade Confidence, Never Fail

Every signal collection path (`src/lib/signals/collect.ts`) must return a result even if upstream calls fail. Missing data reduces the `confidence` field in `DimensionResult`; it does not cause an error or an undefined score.

### 3. Generated Files Are Excluded from Size Scoring

Files classified as `generated` (weight `0.0`) are excluded from `blast-radius` line-count and entropy calculations. Do not add generated files to size metrics.

### 4. Domain Criticality Is Size-Independent

The `domain-criticality` dimension measures *what* a file touches, not *how much* it changes. A 1-line change to `src/auth/session.ts` must score the same on this dimension as a 500-line change to the same file. Do not introduce any line-count signal into this dimension.

### 5. Floors Raise Scores; Weighted Averages Would Dilute

Floors (e.g., `critical-path-untested: floor=55`) are applied *after* the weighted average. This is intentional — if a PR deletes all tests for a critical-path file, the final score must reflect that categorical risk regardless of how benign the other dimensions look.

### 6. MAX_CONCURRENT = 6 Parallel GitHub Fetches

The signal collector runs up to 6 concurrent Octokit requests. Do not increase this without verifying rate-limit headroom against GitHub's secondary rate limits.

### 7. First Matching Path Rule Wins

Path classification uses ordered precedence. The first rule whose patterns match any segment of a file path wins. Never change this to "best match" semantics without a migration plan for existing `.pocketreview.yml` configs.

### 8. Tokens Are Server-Side Only

`GITHUB_TOKEN` and `ANTHROPIC_API_KEY` live in `process.env` and are only accessed inside `src/app/api/` route handlers. They must never be referenced from client components or hooks that run in the browser.

---

## Pull Request Checklist

Before requesting review, confirm all of the following:

```
[ ] npm run typecheck passes with zero errors
[ ] npm run lint passes with zero errors
[ ] npm run format:check passes (no unformatted files)
[ ] npm test passes (all tests green)
[ ] New code paths have corresponding test coverage
[ ] demo/fixtures.ts updated if new signal fields were added
[ ] docs updated if behaviour visible to users has changed
[ ] Dimension weights still sum to 1.00 (if touching risk-engine.ts)
[ ] No credentials, tokens, or secrets in committed code
[ ] PR title follows Conventional Commits format
[ ] PR description explains *why*, not just *what*
```

> [!CAUTION]
> Never commit `.env.local` or any file containing real tokens. `.env.local` is in `.gitignore`, but double-check before pushing if you have made any changes to environment handling.

---

*Thank you for contributing to PocketReview. If you have questions not covered here, open a GitHub Discussion or ping a maintainer in the issue thread.*
