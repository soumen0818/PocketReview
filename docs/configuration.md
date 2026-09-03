# Configuration

> Environment variables and `.pocketreview.yml`.
>
> **Status:** ✅ **Shipped** — verified against [src/lib/config.ts](../src/lib/config.ts) and [path-rules.ts](../src/lib/signals/path-rules.ts). The `policy` block is parsed but **not yet enforced** (Phase 8) — flagged inline below.

PocketReview runs with no configuration file. Every default is production-quality, and configuration is **additive** — you extend the defaults, you do not replace them.

---

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | **Yes** | Read-only token (`repo:read`). No merge or approve call exists in the codebase. |
| `ANTHROPIC_API_KEY` | No | Powers the explanation chat. Every score, ranking and breakdown works without it. |
| `DEMO_MODE` | No | `1` or `true` serves fixtures instead of live GitHub data. No network needed. |

```bash
# .env.local — minimal
GITHUB_TOKEN=ghp_your_token_here
```

```bash
# .env.local — full
GITHUB_TOKEN=ghp_your_token_here
ANTHROPIC_API_KEY=sk-ant-your_key_here
# DEMO_MODE=1
```

`DEMO_MODE` is matched **exactly** against `"1"` or `"true"`. Any other value is off.

> Both tokens are server-side only, never prefixed `NEXT_PUBLIC_`, and absent from the client bundle. See [security.md](./security.md).

---

## `.pocketreview.yml`

Optional. Read from the **process working directory** at startup and memoised for the process lifetime — edits require a restart.

Every field is optional; omit any section to keep its defaults. A missing, empty or unparseable file falls back to defaults silently, because defaults are a complete configuration.

```yaml
# .pocketreview.yml

paths:
  - category: payments
    weight: 1.0
    patterns: ["billing", "invoice", "ledger"]

thresholds:
  low: 25
  medium: 50
  high: 75

policy:                        # ⚠️ parsed, not yet enforced — Phase 8
  fastTrackMaxRisk: 25
  neverFastTrack: [auth, payments, database]
  requireCiPassing: true
  blockOnDependencyChange: true
  blockOnTestRemoval: true

llm:
  enabled: true
  maxDiffChars: 12000

historyWindowDays: 90
```

---

## `paths` — path rules

Maps file paths to a category and a criticality weight `0.0–1.0`. This table drives the **domain criticality** dimension, which is the highest-leverage thing you can tune.

```yaml
paths:
  - category: auth           # a FileCategory (see below)
    weight: 1.0              # 0.0-1.0; 1.0 = maximum criticality
    patterns:                # case-insensitive regex strings
      - "identity"
      - "sso"
```

### Precedence — read this before adding rules

Rules are evaluated **in order; first match wins**. Your rules are inserted after the first three built-ins:

```
1. generated   ← built-in, always first
2. test        ← built-in
3. docs        ← built-in
   ─────────────────────────────
4. YOUR RULES  ← inserted here
   ─────────────────────────────
5. auth, payments, database, infra, api, config, ui   ← remaining built-ins
```

This ordering is deliberate and load-bearing:

- **`generated` is unconditionally first.** A lockfile is a lockfile even if its path contains "auth". This is what keeps a 4,000-line lockfile out of the high-risk band.
- **`test` beats your domain rules.** Otherwise adding tests to auth code would *raise* its risk — backwards, and visible (Decision Log #4).
- **Your rules outrank the built-in domain rules**, so you can reclassify `src/api/legacy/` without restating the generated-file and test detection.

An invalid regex is skipped rather than failing the whole config.

### Categories

`auth` · `payments` · `database` · `infra` · `api` · `config` · `test` · `docs` · `ui` · `generated` · `other`

`other` is the fallback for anything unmatched.

### Default weights

| Category | Weight | Matches |
|---|---:|---|
| `auth` | **1.00** | auth, session, token, login, oauth, permission, rbac |
| `payments` | **1.00** | payment, billing, checkout, stripe, invoice, subscription |
| `database` | 0.85 | migration, schema, `.sql`, prisma, `models/` |
| `infra` | 0.75 | Dockerfile, `.github/workflows`, terraform, k8s, helm, deploy |
| `api` | 0.70 | `routes/`, `controllers/`, `api/`, `handlers/`, graphql |
| `config` | 0.55 | config, `.env`, settings |
| `ui` | 0.30 | components, pages, styles |
| `test` | 0.10 | `.test.`, `.spec.`, `__tests__`, `tests/` |
| `docs` | 0.05 | `.md`, `docs/` |
| `generated` | **0.00** | `*.lock`, `*-lock.json`, `.snap`, `dist/`, `build/` |

**Weight 0.7 is the critical threshold.** At or above it, a file counts toward the `criticalLines` mass term and triggers the `critical-path` floor. That makes `auth`, `payments`, `database` and `api` "critical paths" by default.

**Generated files at 0.00 are excluded from size scoring entirely** — the single rule that kills the most common naive-scoring false positive.

---

## `thresholds` — risk bands

```yaml
thresholds:
  low: 25      # score <  25            → low
  medium: 50   # score >= 25, < 50      → medium
  high: 75     # score >= 50, < 75      → high
               # score >= 75            → critical
```

Note the mapping in `toLevel()`: `score >= thresholds.high` is **critical**, `>= thresholds.medium` is **high**. The key names the lower bound of the band *above* the one it is named for.

A payments monorepo and a docs site should not share a scale:

```yaml
# High-stakes — surface more, earlier
thresholds: { low: 15, medium: 35, high: 60 }

# Low-stakes — reserve attention for genuine outliers
thresholds: { low: 30, medium: 55, high: 80 }
```

Thresholds change **banding only**, never the score. A PR scoring 55 always scores 55.

---

## `policy` — the fast-track gate ⚠️ Phase 8

> **Parsed and available on the config object, but no code reads it yet.** `src/lib/policy/gate.ts` is unwritten and a right-swipe performs no eligibility check. **Setting these values changes nothing today.**

```yaml
policy:
  fastTrackMaxRisk: 25                     # max score still eligible
  neverFastTrack: [auth, payments, database]  # categories that never qualify
  requireCiPassing: true
  blockOnDependencyChange: true
  blockOnTestRemoval: true
```

When built, the gate can only **remove** eligibility, never grant it — all conditions must hold. `neverFastTrack` is intended to be unconditional: not overridable by a low score. See [security.md](./security.md#the-policy-gate--phase-8--not-yet-enforced).

---

## `llm` — the explanation layer

```yaml
llm:
  enabled: true
  maxDiffChars: 12000
```

**`enabled: false` means no code ever leaves the process.** Every score, ranking and breakdown still works — you lose the prose, not the system. This is the answer for regulated teams.

> ⚠️ **Known gap:** `maxDiffChars` is not yet read. [claude.ts](../src/lib/claude.ts) hardcodes `MAX_DIFF_CHARS = 8000`. Wiring config through is tracked for Phase 6.

---

## `historyWindowDays`

```yaml
historyWindowDays: 90   # default
```

Lookback for churn, revert rate and incident detection — the **historical instability** dimension.

- **Shorter (30–60):** reacts faster to recent instability; noisier on low-traffic repos.
- **Longer (180):** more stable, slower to forget a file that has since settled.

A repo with no readable history scores 0 on instability **and** reports lower confidence — the absence never reads as safety.

---

## Demo mode

```bash
DEMO_MODE=1 npm run dev
```

Serves 7 hand-built fixtures from [demo/fixtures.ts](../src/lib/demo/fixtures.ts). No `GITHUB_TOKEN` needed, no network.

**Demo mode swaps the data source, never the scoring** (Decision Log #13). Fixtures run through the real engine, so the offline demo shows what the scorer genuinely produces — and it survives a judge asking to change an input.

---

## Tuning recipes

### A monorepo where `src/api/` is genuinely critical

```yaml
paths:
  - category: api
    weight: 0.95
    patterns: ["^src/api/"]
```

### A service with a non-standard test layout

```yaml
paths:
  - category: test
    weight: 0.1
    patterns: ["^verification/", "_check\\.py$"]
```

Add a `test` rule rather than fighting the built-in — it keeps the "tests must not raise risk" invariant.

### Treat a vendored directory as generated

```yaml
paths:
  - category: generated
    weight: 0.0
    patterns: ["^vendor/", "^third_party/", "\\.pb\\.go$"]
```

> Careful: weight `0.0` excludes these files from size scoring entirely. Correct for machine-generated output, wrong for code anyone reviews.

### Verifying a change

```bash
npm test                                            # invariants still hold
curl 'localhost:3000/api/prs/owner%2Frepo/123/risk' # inspect one PR
```

The breakdown screen shows `signalsUsed` per dimension — the fastest way to confirm a file classified the way you intended.

---

*Verified against the source on 2026-09-03.*
