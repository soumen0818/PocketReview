# Deploying PocketReview

> How to put this on the internet so other people can use it, without exposing
> your GitHub account.

---

## Three ways to run it

| Mode           | Who can use it               | What they see       | Credentials                                 |
| -------------- | ---------------------------- | ------------------- | ------------------------------------------- |
| **Multi-user** | Anyone with a GitHub account | **Their own** PRs   | Each user signs in; you supply an OAuth app |
| **Demo**       | Anyone                       | Captured sample PRs | None at all                                 |
| **Local**      | You                          | Your PRs            | Your `GITHUB_TOKEN` in `.env.local`         |

Multi-user is the one to deploy. The rest of this page assumes it.

---

## The security model, in one paragraph

**Every user brings their own GitHub token.** When someone signs in, GitHub
issues a token for _their_ account, and it is stored in an encrypted, httpOnly
cookie in _their_ browser. Every GitHub request made while handling their
request uses that token — so they see exactly the pull requests GitHub would
show them, and nothing else. There is no shared identity, no server-side token
store, and no user table to breach. Sign out and the credential is gone.

Two consequences worth knowing:

- **A leftover `GITHUB_TOKEN` in your Vercel env vars is ignored** once
  `GITHUB_CLIENT_ID` is set. That is deliberate: the alternative is anonymous
  visitors browsing your private repositories. Verified by test.
- **Caches are namespaced per user.** A cached explanation of a private PR
  cannot be served to a different account. Also verified by test.

---

## Step 1 — Register a GitHub OAuth App

Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
([direct link](https://github.com/settings/developers)).

| Field                      | Value                                           |
| -------------------------- | ----------------------------------------------- |
| Application name           | `PocketReview`                                  |
| Homepage URL               | `https://your-app.vercel.app`                   |
| Authorization callback URL | `https://your-app.vercel.app/api/auth/callback` |

You do not know your Vercel URL yet — deploy first with placeholders, then come
back and correct both URLs. The callback must match **exactly**, including
`https://` and the path.

Click **Generate a new client secret** and keep both values for the next step.

> **Why the app asks for the `repo` scope.** GitHub's OAuth apps have no
> read-only repository scope — `repo` is the narrowest option that can see a
> user's private pull requests. PocketReview makes no write calls at all (every
> GitHub call in the codebase is a `get` or a `list`), and the sign-in page says
> so before anyone grants it. If that trade is unacceptable for your users,
> deploy in demo mode instead.

---

## Step 2 — Deploy to Vercel

```bash
npm i -g vercel
vercel
```

Or push to GitHub and import the repo at [vercel.com/new](https://vercel.com/new).

Vercel detects Next.js automatically — no build configuration needed.

---

## Step 3 — Set environment variables

In **Vercel → your project → Settings → Environment Variables**:

| Variable                   | Required | Value                         |
| -------------------------- | -------- | ----------------------------- |
| `GITHUB_CLIENT_ID`         | **yes**  | From step 1                   |
| `GITHUB_CLIENT_SECRET`     | **yes**  | From step 1                   |
| `SESSION_SECRET`           | **yes**  | `openssl rand -base64 32`     |
| `ANTHROPIC_API_KEY`        | no       | Enables the explanation layer |
| `UPSTASH_REDIS_REST_URL`   | no       | Shared cache                  |
| `UPSTASH_REDIS_REST_TOKEN` | no       | Shared cache                  |

**`SESSION_SECRET` is not optional in production** — the app throws at startup
without it, rather than silently issuing sessions nobody can decrypt. Use a
different value per environment.

**Do not set `GITHUB_TOKEN`** on a multi-user deployment. It is ignored, but
leaving it there is a trap for whoever reads the config next.

Redeploy after adding variables — Vercel does not apply them to an existing
build.

---

## Step 4 — Correct the OAuth URLs

Now that you know the real URL, go back to the OAuth App settings and set both
the homepage and callback URLs correctly. Sign-in fails with
`redirect_uri_mismatch` until this matches.

---

## Optional — Add a shared cache

Without Redis the app keeps an in-memory cache per serverless instance, so a
cold start refetches from GitHub. That is a few seconds, not a failure.

To make it faster: **Vercel → Storage → Marketplace → Upstash for Redis**. The
free tier (500K commands/month, 256MB) is ample. Vercel injects
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` automatically.

> Vercel KV was sunset in December 2024 and migrated to Upstash — if a tutorial
> mentions `@vercel/kv`, it predates that change.

---

## Deploying in demo mode instead

To publish something anyone can try with no sign-in and no risk:

```
DEMO_MODE=1
```

Set that and nothing else. Every route serves the committed fixtures, no GitHub
call is made, and no credential exists to leak. Useful for a public link
alongside a real deployment.

---

## Verifying the deployment

```bash
# 1. Nobody can read data without signing in.
curl -s -o /dev/null -w "%{http_code}\n" https://your-app.vercel.app/api/prs
#    expect 401

# 2. Sign-in redirects to GitHub.
curl -s -D - -o /dev/null https://your-app.vercel.app/api/auth/signin | grep -i location
#    expect github.com/login/oauth/authorize

# 3. A forged callback is refused.
curl -s -D - -o /dev/null "https://your-app.vercel.app/api/auth/callback?code=x&state=forged" | grep -i location
#    expect /signin?error=state-mismatch
```

Then sign in through the browser and confirm you see **your own** PRs.

---

## Troubleshooting

| Symptom                             | Cause                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `redirect_uri_mismatch`             | Callback URL in the OAuth app does not exactly match `https://<host>/api/auth/callback`       |
| Throws on startup                   | `SESSION_SECRET` missing or under 32 characters                                               |
| Signed out on every request         | `SESSION_SECRET` differs between Vercel environments, or changed after users signed in        |
| `401` after signing in              | Cookie blocked — check the deployment is HTTPS                                                |
| Queue is empty but GitHub shows PRs | The queue defaults to _review-requested_ PRs. Add `?repo=owner/name` to scope to a repository |
| Explanations say "unavailable"      | `ANTHROPIC_API_KEY` not set. Everything else still works — by design                          |
| Slow first load                     | Cold start with no shared cache. Add Upstash, or accept a few seconds                         |

---

## What this deployment does **not** do

Stated plainly, because a reviewer will ask:

- **No rate limiting.** A signed-in user could hammer the API and exhaust
  _their own_ GitHub rate limit. They cannot affect anyone else, because limits
  are per-token — but there is no application-level throttle.
- **No audit log.** Triage decisions live in browser memory and are lost on
  refresh. Nothing is recorded server-side.
- **No team features.** Every user sees their own queue; there is no shared
  state, no org view, no assignment.
- **Sessions last 7 days** and cannot be revoked centrally. A user revokes
  access from their own GitHub settings.

None of these block a demo or personal use. All of them would need addressing
before calling this production software for a team.
