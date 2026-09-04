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

**Rate limiting is separate from authentication.** `guardRequest`
(`src/lib/rate-limit.ts`) throttles by IP and makes no identity decision;
`withAuth` (`src/lib/auth/guard.ts`) decides who the caller is. An earlier
version also checked a shared `API_SECRET` header — that was removed, because a
browser cannot send an `Authorization` header on a normal page load, so setting
it would have 401'd every real user while leaving `curl` working.

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

> **`.npmrc` must be committed.** `react-tinder-card` declares a peer
> dependency on `@react-spring/web@^9` and has not been updated for v10, which
> this project uses. Locally that is masked by `npm install --legacy-peer-deps`;
> Vercel runs a plain `npm install` and the build fails with `ERESOLVE`. The
> committed `.npmrc` sets `legacy-peer-deps=true` so both environments behave
> the same. If you see `ERESOLVE` in a Vercel build log, check that file exists
> in the repo.

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
cold start refetches from GitHub. That is a few seconds, not a failure — the
app works fine without this.

There are two ways to add one, and the app accepts either.

### Option A — your own Upstash account

Use this if you already have an Upstash database, or want it independent of
Vercel.

1. At [console.upstash.com](https://console.upstash.com) open your database
2. In **REST API**, copy **`UPSTASH_REDIS_REST_URL`** and
   **`UPSTASH_REDIS_REST_TOKEN`**
3. Add both in **Vercel → Settings → Environment Variables**
4. **Redeploy** — Vercel does not apply new variables to an existing build

Pick a region close to your Vercel deployment; a cache round trip across
continents can cost more than the fetch it replaces.

### Option B — the Vercel Marketplace

**Vercel → Storage → Marketplace → Upstash for Redis.** Vercel provisions the
database and injects the credentials for you — you add nothing by hand, but you
still need to **redeploy**.

### Either way

| How you connected  | Variables                                            |
| ------------------ | ---------------------------------------------------- |
| Your own Upstash   | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| Vercel Marketplace | `KV_REST_API_URL`, `KV_REST_API_TOKEN`               |

The Marketplace names are inherited from the sunset Vercel KV product. Reading
only one pair would leave the cache silently disabled with no error — the app
would keep working, just slower on every cold start — so both are supported,
and a test pins that.

The free tier (500K commands/month, 256MB) is ample: the app caches PR signals
and explanations, keyed per user and expiring after 24 hours.

**Confirming it works:** Upstash's console shows a command counter. It is
non-zero once the cache is live. You should also notice the first load after a
cold start dropping from a few seconds to near-instant.

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
| `ERESOLVE` during install           | `.npmrc` is missing from the repo — it carries `legacy-peer-deps=true` for a stale peer range |
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

- **Rate limiting is a backstop, not a quota.** Every API route is capped per
  client IP (30/min by default; 10/min for explanations, which cost tokens;
  60/min for triage, which is swipe-driven). The counter lives in process
  memory, so on Vercel each function instance counts separately — a limit of
  30/min is really "30/min per warm instance". That is enough to stop a runaway
  client, not enough to be a precise quota. Moving the counter to Upstash would
  make it exact; the per-user GitHub rate limit is the ceiling that actually
  matters.
- **No audit log.** Triage decisions live in browser memory and are lost on
  refresh. Nothing is recorded server-side.
- **No team features.** Every user sees their own queue; there is no shared
  state, no org view, no assignment.
- **Sessions last 7 days** and cannot be revoked centrally. A user revokes
  access from their own GitHub settings.

None of these block a demo or personal use. All of them would need addressing
before calling this production software for a team.
