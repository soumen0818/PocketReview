# Configuration Reference

PocketReview works without any configuration file. All defaults are production-quality and designed to work across most codebases. Configuration is additive — you extend the defaults, not replace them.

---

## Table of Contents

1. [Environment Variables](#environment-variables)
2. [The `.pocketreview.yml` File](#the-pocketreviewyml-file)
3. [Path Rules (`paths`)](#path-rules-paths)
4. [Thresholds (`thresholds`)](#thresholds-thresholds)
5. [Policy Gate (`policy`)](#policy-gate-policy)
6. [LLM Settings (`llm`)](#llm-settings-llm)
7. [History Window](#history-window-historywindowdays)
8. [Demo Mode](#demo-mode)
9. [Default Path Rules Reference](#default-path-rules-reference)
10. [Per-Repo Customization Patterns](#per-repo-customization-patterns)

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GITHUB_TOKEN` | **Yes** | — | Personal access token with `repo:read` scope. PocketReview never writes — no merge or approve call exists in the codebase. |
| `ANTHROPIC_API_KEY` | No | — | Powers the explanation chat. Every score, ranking, and review plan works without it; you lose the prose, not the system. |
| `DEMO_MODE` | No | `""` | Set to `1` or `true` to serve captured fixtures instead of live GitHub data. No network access required. |

### Minimal `.env.local`

```bash
GITHUB_TOKEN=ghp_your_token_here
```

### Full `.env.local`

```bash
# Required: GitHub read-only token
GITHUB_TOKEN=ghp_your_token_here

# Optional: enables the explanation chat (Claude)
ANTHROPIC_API_KEY=sk-ant-your_key_here

# Optional: offline demo mode
# DEMO_MODE=1
```

> **Security:** `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` are server-side only and never reach the client bundle. See [security.md](./security.md).

---

## The `.pocketreview.yml` File

Place `.pocketreview.yml` in the root of the repository being reviewed (or the root of your PocketReview installation). All fields are optional — omit any section to keep the defaults.

```yaml
# .pocketreview.yml

# Custom path rules (prepended to defaults — see "Path Rules" section)
paths:
  - category: auth
    weight: 1.0
    patterns: ["auth", "session", "token", "rbac"]

# Risk level thresholds
thresholds:
  low: 25
  medium: 50
  high: 75

# Policy gate settings
policy:
  fastTrackMaxRisk: 25
  neverFastTrack: [auth, payments, database]
  requireCiPassing: true
  blockOnDependencyChange: true
  blockOnTestRemoval: true

# LLM / explanation layer
llm:
  enabled: true
  maxDiffChars: 12000

# History window for churn and revert signals
historyWindowDays: 90
```

### Loading Behaviour

1. On first request, `loadConfig()` reads `.pocketreview.yml` from `process.cwd()`
2. User rules are **prepended** to defaults (not replacing them)
3. Result is cached for the lifetime of the server process
4. If the file is absent, unreadable, or empty — defaults are used
5. Invalid pattern strings are skipped silently (a bad regex never crashes the server)

---

## Path Rules (`paths`)

Path rules map file paths to categories and criticality weights. The weight determines how much a change to that file contributes to the Domain Criticality dimension.

### Rule Schema

```yaml
paths:
  - category: string      # FileCategory (see list below)
    weight: number        # 0.0 – 1.0, where 1.0 = maximum criticality
    patterns: string[]    # Case-insensitive regex patterns
```

### How Matching Works

1. Each file path is tested against rules **in order**
2. **First matching rule wins** — subsequent rules are not checked
3. User rules from `.pocketreview.yml` are prepended to defaults
4. If no rule matches, category is `other` (weight: 0.40)
5. Patterns are case-insensitive regular expressions (not globs)

> **Important:** `generated` and `test` rules appear first in the default list. This ensures `src/auth/session.test.ts` is classified as `test`, not `auth`.

### Available Categories

| Category | Meaning |
|---|---|
| `auth` | Authentication, authorization, sessions, credentials |
| `payments` | Payment processing, billing, financial transactions |
| `database` | Migrations, schemas, ORM models, raw SQL |
| `infra` | Deployment, CI/CD, containers, infrastructure-as-code |
| `api` | HTTP routes, controllers, middleware, GraphQL |
| `config` | Configuration files, environment, project settings |
| `ui` | Components, views, styles, assets |
| `test` | Test files, specs, fixtures, mocks |
| `docs` | Documentation, changelogs, licenses |
| `generated` | Lockfiles, build output, snapshots — excluded from size scoring |
| `other` | Default fallback |

### Example: Custom Auth Paths

```yaml
paths:
  - category: auth
    weight: 1.0
    patterns:
      - "passport"           # src/passport/ directory
      - "middleware/auth"    # auth middleware
      - "guards/"            # NestJS guards
```

### Example: Custom Payments Paths

```yaml
paths:
  - category: payments
    weight: 1.0
    patterns:
      - "braintree"
      - "adyen"
      - "ledger"
      - "wallet"
```

### Example: Marking a Directory as Generated

```yaml
paths:
  - category: generated
    weight: 0.0
    patterns:
      - "__generated__"   # GraphQL codegen output
      - "proto-gen"       # Protocol buffer generated files
```

---

## Thresholds (`thresholds`)

Risk level thresholds control how numeric scores map to the four named levels.

```yaml
thresholds:
  low: 25      # score < 25  → low
  medium: 50   # score ≥ 25  → medium; score < 50
  high: 75     # score ≥ 50  → high;   score < 75
               # score ≥ 75  → critical
```

### Adjusting for Your Team

**Stricter team** (want to see more things as high-risk):
```yaml
thresholds:
  low: 15
  medium: 35
  high: 60
```

**Larger, more experienced team** (less conservative):
```yaml
thresholds:
  low: 30
  medium: 55
  high: 80
```

> The thresholds affect *labels and colors* only. The underlying score calculation is not affected.

---

## Policy Gate (`policy`)

The policy gate runs when a reviewer swipes right (fast-track). All conditions must pass.

```yaml
policy:
  fastTrackMaxRisk: 25          # Maximum score eligible for fast-track
  neverFastTrack:               # Categories that can NEVER be fast-tracked
    - auth
    - payments
    - database
  requireCiPassing: true        # Block fast-track when CI is failing or pending
  blockOnDependencyChange: true # Block when new dependencies were added
  blockOnTestRemoval: true      # Block when tests were removed
```

### Schema Reference

| Field | Type | Default | Description |
|---|---|---|---|
| `fastTrackMaxRisk` | `number` | `25` | Maximum risk score for fast-track eligibility |
| `neverFastTrack` | `FileCategory[]` | `["auth","payments","database"]` | Categories that can never be fast-tracked, regardless of score |
| `requireCiPassing` | `boolean` | `true` | Require CI to be passing (not failing or pending) |
| `blockOnDependencyChange` | `boolean` | `true` | Block when new dependencies were added to a manifest |
| `blockOnTestRemoval` | `boolean` | `true` | Block when test lines were removed |

> **Structural impossibility:** The `neverFastTrack` check is enforced in code, not just by policy. A PR touching auth files structurally cannot be fast-tracked.

---

## LLM Settings (`llm`)

```yaml
llm:
  enabled: true      # false → no code ever leaves the process
  maxDiffChars: 12000 # character budget for diff sent to the model
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | When false, the chat feature is disabled and no data is sent to Anthropic |
| `maxDiffChars` | `number` | `12000` | Diff is truncated to this many characters before sending to the model |

### Fully Offline Mode

Set `llm.enabled = false` **and** omit `ANTHROPIC_API_KEY`:

```yaml
llm:
  enabled: false
```

The score, rankings, and triage deck all work normally. The "Explain" gesture (↑) will be unavailable or show an offline message.

---

## History Window (`historyWindowDays`)

```yaml
historyWindowDays: 90   # default
```

Controls how far back git history is scanned for churn and revert signals. Shorter windows respond faster to recent changes; longer windows provide a more stable signal.

| Window | Good for |
|---|---|
| 30 days | Fast-moving projects, recent team changes |
| 90 days | Most teams (default) |
| 180 days | Large, stable codebases |

---

## Demo Mode

Demo mode serves captured fixture PRs instead of live GitHub data. The full scoring engine runs on the fixtures — what you see offline is what the engine genuinely produces.

```bash
# Start in demo mode
DEMO_MODE=1 npm run dev
```

Or permanently in `.env.local`:
```bash
DEMO_MODE=1
```

**Demo mode:**
- Requires no `GITHUB_TOKEN`
- Runs the complete scoring pipeline on `src/lib/demo/fixtures.ts`
- Useful for development, screenshots, and demos
- Does NOT require any network access

---

## Default Path Rules Reference

The built-in rules cover the most common project structures. They are applied in this exact order (first match wins):

| Priority | Category | Weight | Key Patterns |
|---|---|---|---|
| 1 | `generated` | 0.00 | `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `Cargo.lock`, `poetry.lock`, `*.snap`, `*.min.js`, `dist/`, `build/`, `vendor/`, `node_modules/` |
| 2 | `test` | 0.10 | `*.test.ts`, `*.spec.js`, `_test.go`, `__tests__/`, `tests/`, `spec/`, `e2e/`, `fixtures/`, `mocks/` |
| 3 | `docs` | 0.05 | `*.md`, `*.mdx`, `docs/`, `LICENSE`, `CHANGELOG`, `CONTRIBUTING` |
| 4 | `auth` | 1.00 | `auth/`, `session/`, `login/`, `logout/`, `oauth/`, `jwt/`, `token/`, `password/`, `credential/`, `permission/`, `rbac/`, `acl/`, `identity/`, `security/`, `crypto/` |
| 5 | `payments` | 1.00 | `payment/`, `billing/`, `checkout/`, `invoice/`, `subscription/`, `stripe/`, `paypal/`, `refund/`, `transaction/`, `ledger/`, `pricing/` |
| 6 | `database` | 0.85 | `migrations/`, `schema/`, `*.sql`, `prisma/`, `models/`, `entities/`, `repositories/`, `*.prisma` |
| 7 | `infra` | 0.75 | `Dockerfile`, `docker-compose`, `.github/workflows/`, `.gitlab-ci`, `terraform/`, `*.tf`, `k8s/`, `kubernetes/`, `helm/`, `deploy/`, `infra/`, `Makefile` |
| 8 | `api` | 0.70 | `routes/`, `controllers/`, `handlers/`, `api/`, `endpoints/`, `graphql/`, `resolvers/`, `middleware/`, `route.ts` |
| 9 | `config` | 0.55 | `config/`, `settings/`, `.env`, `package.json`, `tsconfig*.json`, `next.config.*`, `*.yaml`, `*.toml`, `*.ini` |
| 10 | `ui` | 0.30 | `components/`, `views/`, `pages/`, `styles/`, `*.css`, `*.scss`, `*.svg`, `*.png`, `assets/`, `public/` |
| fallback | `other` | 0.40 | Anything that didn't match |

---

## Per-Repo Customization Patterns

### Monorepo with Multiple Services

```yaml
paths:
  # Service-specific critical paths
  - category: auth
    weight: 1.0
    patterns:
      - "services/identity"
      - "services/auth"
      - "packages/auth-client"

  - category: payments
    weight: 1.0
    patterns:
      - "services/billing"
      - "services/payment"

  # Mark generated API clients as generated
  - category: generated
    weight: 0.0
    patterns:
      - "generated/"
      - "api-client/"
```

### Mobile App (React Native)

```yaml
paths:
  - category: auth
    weight: 1.0
    patterns:
      - "src/auth"
      - "src/biometric"
      - "src/keychain"

  # Native bridge code is high-risk
  - category: infra
    weight: 0.75
    patterns:
      - "android/app/src"
      - "ios/"
      - "*.podspec"
```

### Data Pipeline / ML

```yaml
paths:
  - category: database
    weight: 0.85
    patterns:
      - "dags/"           # Airflow DAGs
      - "pipelines/"
      - "etl/"
      - "*.parquet"

  # Trained model artifacts are generated
  - category: generated
    weight: 0.0
    patterns:
      - "models/*.pkl"
      - "models/*.h5"
      - "checkpoints/"
```

### Strict Team (Raise All Thresholds)

```yaml
thresholds:
  low: 15
  medium: 30
  high: 55

policy:
  fastTrackMaxRisk: 15
  neverFastTrack: [auth, payments, database, infra, api]
  requireCiPassing: true
  blockOnDependencyChange: true
  blockOnTestRemoval: true
```
