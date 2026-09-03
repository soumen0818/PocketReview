# Security & Privacy

PocketReview is designed to review code in environments with strict data privacy and security requirements. 

---

## Token Scopes (Read-Only)

PocketReview operates on a **strictly read-only** basis.

| Token | Scope Required | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | `repo:read` | Fetching PR metadata, file lists, diffs, CI status, and git history. |

**No write endpoints are wired.** There is zero code in this repository that calls `octokit.rest.pulls.merge` or `octokit.rest.pulls.createReview`. The application structurally cannot merge code or submit approvals on your behalf. 

Triage decisions (like Fast-Track) are recorded in local session state to update the UI; they are never pushed to GitHub.

---

## The AI Approval Prohibition

> **"We never let an AI approve code written by an AI."**

PocketReview does not auto-approve pull requests. A right-swipe (Fast-Track) routes the PR to a human's fast lane. A human reviewer still opens the PR and clicks "Approve". 

By keeping the final authorization step manual, we eliminate the risk of an LLM hallucinating a safe score for a malicious or buggy AI-authored pull request.

---

## What Data Leaves the Process?

PocketReview performs all risk scoring locally on your server using deterministic arithmetic. 

**If LLM integration is disabled (`llm.enabled: false`), NO data ever leaves the process.**

### When LLM is Enabled
If the Anthropic integration is active (for the "Explain" / Chat feature), the following data is transmitted to the Anthropic API:
- PR Title & Body
- The Unified Diff (truncated to `MAX_DIFF_CHARS`, default 12,000)
- The user's chat messages

### Secret Redaction
Before diffs are dispatched to the LLM, standard secret scanning patterns (e.g., AWS keys, Stripe tokens, generic high-entropy strings assigned to variables like `password` or `secret`) are scrubbed from the diff text. 

*Note: While redaction is implemented, it is best practice not to commit secrets to git in the first place.*

---

## No-Persistence Guarantee

PocketReview does not use a database. 

- **Cache:** The server caches `PRSignals` (metadata, stats) and LLM explanations in memory to prevent rate-limiting and redundant API calls.
- **Diff Content:** Diff content is NEVER persisted to disk or cached. It is fetched, analyzed for line counts/dependencies, optionally sent to the LLM, and discarded.
- **Client State:** The triage queue and session history (`useSwipeHistory`) live entirely in browser memory and are lost on refresh/close.

---

## Policy Gate (Structural Safety)

The Fast-Track gesture is protected by a Policy Gate that acts as a structural safety mechanism. 

The Policy Gate can **only remove eligibility; it can never grant it.**

Even if the risk engine scores a PR at 0/100, the Policy Gate will block Fast-Track if:
- CI is failing or pending.
- The PR touches **Critical Paths** (Auth, Payments, Database).
- Dependencies were modified.
- Test files were removed.

**Critical Path Protection:** The restriction against fast-tracking Auth, Payments, or Database code is hard-coded into the policy gate. It cannot be overridden by risk scores or configuration. 

---

## Server-Side Token Guarantee

Environment variables (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`) are accessed exclusively in Next.js Server Components and API Routes. 

They are never prefixed with `NEXT_PUBLIC_` and are completely absent from the client-side JavaScript bundle, ensuring your tokens cannot be extracted from the browser.

---

## Security Checklist for Contributors

If you are contributing to PocketReview, ensure you adhere to the following constraints:
1. **Never add write scopes.** Do not add GitHub API calls that mutate state.
2. **Never send diffs elsewhere.** The only external egress for diffs is the Anthropic client, and it must remain gated behind the `llm.enabled` config check.
3. **Preserve the Policy Gate.** Do not add bypass mechanisms for the Critical Path checks.
4. **No persistent storage.** Do not add database connections or write user code to the filesystem.
