# Manual testing guide

> For a tester who has not built this. Work top to bottom; each section says
> what to do, what should happen, and what counts as a failure.
>
> **You do not need any credentials for Part 1.** Parts 2 and 3 need tokens.

---

## What this app is, in one paragraph

PocketReview triages pull requests. It scores each one 0–100 for how much
human attention it needs, orders the queue by what to open _right now_,
estimates how long each will take to review, and can pack the most important
ones into a time budget you give it. The scores are computed in code — no AI
produces a number. An optional AI layer writes prose _about_ the already
computed score.

**The single most important property to test: turn the AI off and everything
still works.** If any score, ranking or plan breaks without an API key, that is
a bug regardless of what else passes.

---

## Setup

```bash
npm install --legacy-peer-deps
npm run build          # must succeed
npm test               # must be 228/228 passing
npm run typecheck      # must print nothing
```

**Fail if:** any of those three commands errors.

---

# Part 1 — Offline (no credentials needed)

Everything here runs with the wifi off. Start the app in demo mode:

```bash
DEMO_MODE=1 npm run dev
```

Open **http://localhost:3000** in Chrome, then press `F12` → click the
**device toolbar** icon (or `Ctrl+Shift+M`) → choose **iPhone 14 Pro**
(390×844).

> This is a mobile-first app. Test it at phone size. A desktop-only pass will
> miss real problems.

### 1.1 — The deck loads

| Step                           | Expected                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Open the page                  | A stack of cards appears within ~2 seconds                                                             |
| Look at the top card           | Shows repo, PR number, title, author, a coloured risk badge with a score, and "Why this score" reasons |
| Look at the bar above the deck | Shows a coloured distribution bar and "Nh Nm of review"                                                |

**Fail if:** a spinner never resolves, the page is blank, or any card shows
`NaN`, `undefined`, or an empty score.

### 1.2 — Cards are ordered sensibly

Read the scores from top to bottom.

**Expected:** scores generally descend. A card lower in the deck may score
higher **only** if it is marked "CI failing — author still iterating".

**Fail if:** a `critical` card sits below several low-scoring cards.

### 1.3 — The breakdown screen ("show your working")

| Step                                                | Expected                                                  |
| --------------------------------------------------- | --------------------------------------------------------- |
| Tap **"See all 7 signals"** at the bottom of a card | A full-screen breakdown opens                             |
| Check the dimension list                            | Exactly 7 dimensions, each with a name, a bar, and points |
| Find **"How the score adds up"**                    | The listed contributions add to the final score           |
| Find the baseline comparison                        | Shows what a naive "lines changed" scorer would have said |
| Tap back                                            | Returns to the deck, same card on top                     |

**Fail if:** the contributions do not add up to the score shown on the card.
That is the app's central claim — treat any mismatch as critical.

### 1.4 — Swiping

| Gesture                          | Expected                                                         |
| -------------------------------- | ---------------------------------------------------------------- |
| Drag a card **right** past ~80px | Green "FAST TRACK" overlay appears, card flies off               |
| Drag a card **left**             | Red "NEEDS REVIEW" overlay, card flies off                       |
| Drag **up or down**              | Card does **not** move — vertical swipes are disabled on purpose |
| Tap the **←** button             | Same as swiping left                                             |
| Tap the **⚡** button            | Same as swiping right                                            |

After each swipe a small toast appears at the bottom naming the decision.

**Fail if:** a card leaves the deck with no toast, or the deck reorders itself
unexpectedly after a swipe.

### 1.5 — The refusal ⭐ _the important one_

Find a card marked **critical** or one whose title mentions auth, payments,
database, or security. Swipe it **right** (fast-track).

**Expected:** the card does **not** leave the deck. A red-bordered screen
appears titled **"Fast-track refused"**, listing reasons such as:

- Touches a critical path
- Risk above the fast-track ceiling
- CI is not green

If the reason list includes a critical path, you should also see a red box:
**"This cannot be overridden"**.

At the bottom: _"The PR stays in your queue. Nothing was approved or merged —
this app has no write access to GitHub."_

**Fail if:** a critical / auth / payments PR is accepted for fast-track. This
is the app's core safety claim.

### 1.6 — The review plan

| Step                                    | Expected                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| Tap the **calendar icon** in the header | The Review plan screen opens                                                      |
| Look at "Queue load"                    | Rows per risk level with minute totals, then "Total required" and "Your capacity" |
| Check the deficit                       | A red box showing a deficit, or a green box saying the queue fits                 |
| Tap **15m**                             | The plan shrinks; may show a warning that a critical PR does not fit              |
| Tap **90m**                             | The plan grows; more PRs, higher "covers N% of queue risk"                        |
| Check plan order                        | Highest risk first                                                                |
| Check the total                         | "N PRs · Xm of Ym" — **X must never exceed Y**                                    |

**Fail if:** the plan's total minutes exceed the budget you selected. Ever.

### 1.7 — Explanation without a key

Tap the **↑ (Explain)** button.

**Expected:** the screen opens, the **risk badge renders immediately**, and
below it an amber box: _"Explanation unavailable"_ with the reason
_"ANTHROPIC_API_KEY is not set"_ and the note that scores and plans are
unaffected.

**Fail if:** the screen is blank, or the score is missing. Prose is optional;
the number is not.

### 1.8 — Empty state

Swipe every card away.

**Expected:** "Queue cleared / Your attention is free."

### 1.9 — Mobile layout ⭐ _nothing automated covers this_

At **390×844**, check each screen for: text cut off, overlapping elements,
buttons too small to tap, or anything requiring **horizontal** scrolling.

- [ ] Deck + summary bar
- [ ] Dimension breakdown (scroll to the bottom)
- [ ] Explain screen
- [ ] Review plan (all five budget buttons reachable)
- [ ] Capacity panel
- [ ] Veto card (the refusal)
- [ ] Empty state

Also try **iPhone SE (375×667)** — the smallest screen worth supporting.

**Fail if:** any screen scrolls sideways, or any button is smaller than roughly
your fingertip.

---

# Part 2 — With a GitHub token

Create `.env.local` in the project root:

```bash
GITHUB_TOKEN=github_pat_...
```

**Token scopes** — a fine-grained token with **read-only** on: Contents,
Pull requests, Checks, Commit statuses, Metadata. Nothing else. See
[configuration.md](./configuration.md).

Restart without demo mode:

```bash
npm run dev
```

### 2.1 — Real PRs load

**Expected:** your actual open PRs appear, scored. First load may take 10–30
seconds (it fetches a lot); afterwards it is faster.

**Fail if:** you see a 500 error, or the queue is empty while GitHub shows PRs
awaiting your review.

### 2.2 — Nothing is ever written to GitHub ⭐

Swipe several PRs both ways, then open those PRs on github.com.

**Expected:** **no** new comments, **no** approvals, **no** merges, no labels,
no change of any kind. PocketReview is strictly read-only.

**Fail if:** anything at all changed on GitHub. Stop testing and report it
immediately — this is the most serious possible failure.

### 2.3 — Your own PRs are hidden

If you have an open PR of your own, it should **not** appear in the deck. You
cannot review your own work.

### 2.4 — Reviewer suggestions

Tap **Explain** on a PR.

**Expected — one of two correct behaviours:**

- A "Suggested reviewer" box naming someone with a percentage and a concrete
  reason ("14 commits to src/auth/ in the history window"), **or**
- **No box at all** — correct when the repo has too little history to be sure.

**Fail if:** a reviewer is suggested with no reason given, or the PR's own
author is suggested as their own reviewer.

---

# Part 3 — With an Anthropic API key

Add to `.env.local`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

Restart. **Cost: well under $1 for a full test pass.**

### 3.1 — Explanations

Tap **Explain** on a PR.

| Check        | Expected                                                                               |
| ------------ | -------------------------------------------------------------------------------------- |
| Risk badge   | Appears **immediately**, before any prose                                              |
| After ~5–20s | "What changed", "Why it matters", "Where to look first", "Questions to ask"            |
| Content      | Describes _behaviour_ ("removes the expiry check"), not mechanics ("modified 3 lines") |
| Footer       | "Prose by claude-…. The score above was computed in code — no model produced it."      |

**Fail if:** the risk score waits for the prose, or the prose cites a score
different from the badge.

### 3.2 — The cache

Close the explanation and reopen the same PR.

**Expected:** the text appears **instantly** and is **identical** word for word.

**Fail if:** it regenerates (slow), or the wording changes. Both mean the cache
is not working and the demo would cost tokens on every rehearsal.

### 3.3 — Voice

Tap **Listen** in the top right of the explanation.

**Expected:** the explanation is read aloud; the button becomes **Stop**.
Tapping Stop halts it. Leaving the screen also stops it.

_(The button is correctly absent in browsers without speech support.)_

### 3.4 — Graceful degradation ⭐ _repeat of 1.7, and worth repeating_

Stop the server, temporarily blank the key, restart:

```bash
ANTHROPIC_API_KEY=
```

**Expected:** deck, scores, ordering, effort estimates, review plan, capacity
panel and the policy gate **all still work**. Only the prose is missing, and it
says so.

**Fail if:** anything other than the explanation breaks.

---

# Part 4 — Failure modes

### 4.1 — No network

Disconnect wifi entirely, then:

```bash
DEMO_MODE=1 npm run dev
```

**Expected:** the full app works on captured real PRs. This is how the demo
runs if the venue wifi fails.

### 4.2 — Stale data banner

Hard to trigger deliberately (needs a GitHub rate limit). If you ever see an
amber banner reading _"GitHub rate limit reached — showing the queue as of N
minutes ago"_, that is **correct behaviour**, not a bug.

### 4.3 — Bad input

| Try                                     | Expected                                         |
| --------------------------------------- | ------------------------------------------------ |
| `localhost:3000/api/prs?repo=nonsense`  | `400` with a clear message                       |
| `localhost:3000/api/prs?repo=../etc`    | `400` — traversal-shaped input is rejected       |
| `localhost:3000/api/prs/bad/1/risk`     | `400`, not a crash                               |
| A PR number that does not exist         | `404`, not a crash                               |
| `/api/prs/<repo>/<n>/diff` in demo mode | `409` — fixtures carry no source code, by design |

**Fail if:** any of these returns a raw stack trace, a `500`, or a message
containing a GitHub URL or internal path.

---

# Reporting a problem

Include:

1. **Which section** (e.g. "1.5 — The refusal")
2. **What you did** — exact steps
3. **What you expected** vs **what happened**
4. **A screenshot**, especially for layout issues
5. **Which mode** — `DEMO_MODE`, GitHub token, or with the AI key
6. **Any red text** in the terminal running `npm run dev`

### Severity

| Level           | Meaning                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 🔴 **Critical** | Anything written to GitHub · a critical/auth PR accepted for fast-track · score not matching its breakdown · plan exceeding its budget |
| 🟠 **High**     | A screen fails to load · scores obviously wrong · the app breaks without the AI key                                                    |
| 🟡 **Medium**   | Layout broken on mobile · confusing wording · missing explanation                                                                      |
| ⚪ **Low**      | Cosmetic                                                                                                                               |

---

## Known limitations — not bugs

- **The eval result is negative.** `eval/results.md` reports the naive
  lines-changed baseline outperforming PocketReview on the sampled repos. That
  is published deliberately with its diagnosis; see the file.
- **Demo mode shows no reviewer suggestions** — there is no git history to
  learn from, so the engine correctly declines to guess.
- **First live load is slow** (10–30s) — it fetches a lot from GitHub. Later
  loads are cached.
- **Effort estimates are approximate.** "~24 min" is a transparent linear
  model, not a measurement.
