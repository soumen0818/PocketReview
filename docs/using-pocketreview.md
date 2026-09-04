# Using PocketReview

> What the screen is telling you, and what each action actually does.
>
> For deploying it, see [deployment.md](./deployment.md). For testing it, see
> [manual-testing.md](./manual-testing.md).

---

## What this tool is for

You have more pull requests than review time. PocketReview does not review code
— it decides **where your attention should go**, and in what order.

It never merges, approves or comments on anything. Every GitHub call it makes
is a read.

---

## Getting your PRs in

**On a deployed instance:** click _Sign in with GitHub_. You see exactly the
pull requests your own GitHub account can see — your permissions, your repos,
your rate limit. Nobody else's data is ever in your queue.

**Running it yourself:** put a read-only personal access token in `.env.local`
as `GITHUB_TOKEN`. No sign-in needed.

**Just looking around:** `DEMO_MODE=1` runs on sample pull requests with no
credentials at all.

### Which PRs appear

By default: **pull requests where you are a requested reviewer**, across every
repository your token can see.

To triage one repository instead, add `?repo=owner/name` to the URL.

**Hidden on purpose:** drafts, already-approved PRs, and your own PRs — you
cannot review your own work.

---

## Reading a card

```
  ACREDIA-STELLAR                              #259     ← repo and PR number
  chore(deps): bump the frontend-production group        ← title
  @dependabot[bot] · 4d ago                              ← author, age

  ┌──────────────────────────────────────────────┐
  │  🟡  MEDIUM RISK                    46/100   │       ← the score
  └──────────────────────────────────────────────┘

  + 565   − 672   📄 2 files          ⏱ ~44 min          ← size, and review cost

  CI failing — author still iterating                    ← why it sank in the queue

  WHY THIS SCORE                                         ← the top reasons
  ▸ 17 lines of production code added with no tests
  ▸ 17 new dependencies added
    +1 more reason

  See the full breakdown · vs baseline 100               ← show your working
```

**The score (0–100)** is how much careful human attention this PR needs — _not_
a prediction that it is buggy. It comes from arithmetic over seven measured
dimensions. No AI produced it.

| Band        | Score  | Meaning                    |
| ----------- | ------ | -------------------------- |
| 🔴 Critical | 75–100 | Read this carefully, first |
| 🟠 High     | 50–74  | Needs real attention       |
| 🟡 Medium   | 25–49  | Worth a proper look        |
| 🟢 Low      | 0–24   | A skim is probably enough  |

**`⏱ ~44 min`** is the estimated review cost — a transparent linear model
(lines, files, critical domains, test coverage), not a measurement. Hover it to
see the breakdown.

**`+1 more reason`** means the card is showing the top 4 of 5 reasons. Tap _See
the full breakdown_ for everything.

**`vs baseline 100`** is what a naive "risk = lines changed" scorer would have
said. When the two disagree sharply, that disagreement is the point.

### The full breakdown

Tap it. You get all seven dimensions with the points each contributed, the
modifiers, any floor that applied, and the arithmetic showing they sum to the
score. This is the screen to open when someone asks _"why 46?"_

---

## The three actions

| Gesture         | Button | What it means                                 |
| --------------- | ------ | --------------------------------------------- |
| **Swipe left**  | ←      | **Needs review** — open this properly later   |
| **Swipe right** | ⚡     | **Fast-track** — a quick look is enough       |
| **Swipe up**    | ↑      | **Explain** — ask for a plain-English summary |

### What fast-track actually does — read this

**It sorts your own to-do list. It does nothing on GitHub.**

Nothing is approved, merged, labelled or commented on. There is no write path
in the codebase at all. Your decisions are notes kept in your browser.

When the queue is empty you see both lanes, each PR linked to GitHub and sorted
by the risk it scored when you decided. That list is the output: _these three
need real attention, these five are quick_.

**Why not have it approve things?** That is the product thesis. AI-accelerated
review created a trust problem; solving it by having an AI approve AI-written
code argues against itself. A human still opens every PR.

### When fast-track is refused

Swipe right on something risky and the card **does not leave the deck** — it
flips and tells you why:

- Touches a critical path (auth, payments, database)
- Risk above the fast-track ceiling
- CI is not green
- Dependencies changed, or tests were removed

Auth, payments and database changes **can never be fast-tracked**, at any score,
under any configuration. That rule is in code, not settings.

---

## The review plan

Tap the calendar icon. This answers: _"I have 30 minutes — what should I do?"_

**Queue load** shows the total review time sitting in your queue against the
time you have. The gap is the deficit — the whole problem, stated as a number.

**Pick a budget** (15/30/45/60/90 min) and you get an ordered plan:

```
  budget 45 min → 4 PRs, 45m used, covers 27% of queue risk

    1. high   14m   cum 14m   #142
    2. high   14m   cum 28m   #143
    3. high   14m   cum 42m   #155
    4. low     3m   cum 45m   #152
```

This is **not** "the top 4 by score". It is a 0/1 knapsack solved exactly by
dynamic programming, maximising risk coverage within your budget — which is why
a 3-minute low-risk PR made the list: it fit the last gap. A greedy sort would
have left those minutes unused.

Two guarantees:

- **Critical PRs are always included** if any single one fits. If none does, a
  warning says so rather than quietly dropping it.
- **Highest risk first**, so the hardest read happens while you are freshest.

Anything that did not fit appears under _Not this session_ with the reason
(_"needs 24 min, 6 remaining"_).

---

## How files are categorised

The score depends heavily on _where_ a change lands. Paths are matched in
order — **first match wins**:

| Category    |   Weight | Matches                                               |
| ----------- | -------: | ----------------------------------------------------- |
| `generated` | **0.00** | lockfiles, `.snap`, `dist/`, `build/`                 |
| `test`      |     0.10 | `*.test.*`, `*_test.go`, `__tests__/`                 |
| `docs`      |     0.05 | `*.md`, `docs/`, `LICENSE`, `CHANGELOG`               |
| `auth`      | **1.00** | `auth`, `session`, `login`, `token`, `oauth`, `rbac`  |
| `payments`  | **1.00** | `payment`, `billing`, `checkout`, `invoice`, `stripe` |
| `database`  |     0.85 | `migrations/`, `schema`, `*.sql`, `prisma/`           |
| `infra`     |     0.75 | `Dockerfile`, `.github/workflows`, `terraform`, `k8s` |
| `api`       |     0.70 | `routes/`, `controllers/`, `handlers/`, `graphql`     |
| `config`    |     0.55 | `config`, `settings`, `.env`, `package.json`          |
| `ui`        |     0.30 | `components/`, `views/`, `pages/`, `styles/`          |
| `other`     |     0.40 | everything else                                       |

Three ordering rules are load-bearing:

1. **`generated` is first.** A lockfile is a lockfile even inside `src/auth/`.
   This is what stops a 4,000-line dependency bump reading as high risk.
2. **`test` beats domain rules.** Otherwise adding tests to auth code would
   _raise_ its risk — backwards.
3. **Weight ≥ 0.70 is a "critical path"** — auth, payments, database, api.
   These trigger the score floors and the fast-track veto.

**Customising for your repo:** add a `.pocketreview.yml` with your own patterns.
Your rules slot in after the built-in generated/test/docs rules and before the
domain ones — see [configuration.md](./configuration.md).

---

## Things worth knowing

**Your decisions persist in this browser** for 30 days. Clearing site data, or
using a different browser or device, starts fresh. There is no server-side
store — which is also why nobody else can see what you decided.

**"Start over"** on the cleared-queue screen wipes those decisions and reloads
the full queue.

**The bar at the top is triage progress**, not queue composition. The coloured
counts beneath it (`4 high · 4 medium`) are the composition.

**Explanations need an `ANTHROPIC_API_KEY`.** Without one the deck, scores,
ordering, effort estimates and review plan all work exactly the same — you lose
the prose, nothing else.

**A stale-data banner** means GitHub was unreachable or rate-limited and you are
seeing the last good queue. It says how old.
