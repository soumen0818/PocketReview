/**
 * Repository scoping.
 *
 * The queue defaults to every PR awaiting the viewer's review, across every
 * repository. Scoping to one repository is the fallback for when that search
 * returns nothing — a real state on a working account.
 *
 * The parsing matters more than it looks: people paste the address bar rather
 * than typing `owner/name`, and a field that rejects what they pasted is a
 * field that does not work. Every accepted form here is one a user could
 * plausibly arrive with; every rejected one could otherwise reach the GitHub
 * API as a malformed slug.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { normaliseRepoInput } from "../src/components/RepoScopeInput.tsx";
import { isRepoSlug } from "../src/hooks/useRepoScope.ts";

test("a plain owner/name slug passes through", () => {
  assert.equal(normaliseRepoInput("facebook/react"), "facebook/react");
});

test("surrounding whitespace is trimmed", () => {
  assert.equal(normaliseRepoInput("  facebook/react  "), "facebook/react");
});

test("a full GitHub URL is reduced to the slug", () => {
  assert.equal(
    normaliseRepoInput("https://github.com/facebook/react"),
    "facebook/react",
  );
});

test("a URL pointing at a specific pull request still yields the repo", () => {
  // The likeliest paste of all: someone copies the PR they were looking at.
  assert.equal(
    normaliseRepoInput("https://github.com/facebook/react/pull/28000"),
    "facebook/react",
  );
});

test("protocol and www are optional", () => {
  assert.equal(normaliseRepoInput("github.com/vercel/next.js"), "vercel/next.js");
  assert.equal(
    normaliseRepoInput("www.github.com/vercel/next.js"),
    "vercel/next.js",
  );
  assert.equal(
    normaliseRepoInput("http://github.com/vercel/next.js"),
    "vercel/next.js",
  );
});

test("a clone URL loses its .git suffix", () => {
  assert.equal(
    normaliseRepoInput("https://github.com/facebook/react.git"),
    "facebook/react",
  );
});

test("query strings and fragments are discarded", () => {
  assert.equal(
    normaliseRepoInput("https://github.com/facebook/react?tab=readme#install"),
    "facebook/react",
  );
});

test("dots, dashes and underscores survive — real repos use them", () => {
  assert.equal(normaliseRepoInput("vercel/next.js"), "vercel/next.js");
  assert.equal(normaliseRepoInput("my-org/my_repo.v2"), "my-org/my_repo.v2");
});

test("input that is not a repository is rejected rather than guessed at", () => {
  for (const bad of [
    "",
    "   ",
    "react", // no owner
    "facebook/", // no name
    "/react", // no owner
    "not a repo", // spaces are not valid in a slug
  ]) {
    assert.equal(normaliseRepoInput(bad), null, `should reject: ${bad}`);
  }
});

test("a path with extra segments keeps only owner and name", () => {
  // "owner/name/tree/main/src" is a browse URL, not three repositories.
  assert.equal(
    normaliseRepoInput("facebook/react/tree/main/packages"),
    "facebook/react",
  );
});

test("slug validation mirrors the server's shape check", () => {
  assert.equal(isRepoSlug("facebook/react"), true);
  assert.equal(isRepoSlug("vercel/next.js"), true);
  assert.equal(isRepoSlug("facebook"), false);
  assert.equal(isRepoSlug("facebook/react/extra"), false);
  assert.equal(isRepoSlug("has space/repo"), false);
});
