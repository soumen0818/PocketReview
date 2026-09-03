/**
 * Presentation-layer tests.
 *
 * The UI itself is verified by running it, but the pure functions behind it —
 * level styling, relative time, the queue summary — are worth pinning down.
 * A level silently missing a style would render an unstyled badge, which is
 * exactly the kind of thing that only shows up mid-demo.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { LEVEL_STYLES, levelStyle, timeAgo, shortRepo } =
  await import("../src/lib/risk-display.ts");

test("every risk level has a complete style", () => {
  for (const level of ["low", "medium", "high", "critical"]) {
    const style = levelStyle(level);
    assert.ok(style, `${level} has no style`);
    for (const key of [
      "label",
      "dot",
      "bg",
      "text",
      "border",
      "bar",
      "accent",
    ]) {
      assert.ok(
        typeof style[key] === "string" && style[key].length > 0,
        `${level}.${key} is missing`,
      );
    }
  }
});

test("levels are visually distinct", () => {
  const bars = Object.values(LEVEL_STYLES).map((s) => s.bar);
  assert.equal(
    new Set(bars).size,
    bars.length,
    "two levels share a bar colour",
  );
});

test("relative time reads naturally at each scale", () => {
  const now = Date.now();
  const at = (ms) => new Date(now - ms).toISOString();

  assert.equal(timeAgo(at(30_000)), "just now");
  assert.equal(timeAgo(at(5 * 60_000)), "5m ago");
  assert.equal(timeAgo(at(3 * 3_600_000)), "3h ago");
  assert.equal(timeAgo(at(2 * 86_400_000)), "2d ago");
  assert.ok(timeAgo(at(60 * 86_400_000)).endsWith("mo ago"));
});

test("repo names are shortened to the name only", () => {
  assert.equal(shortRepo("acme/payments-api"), "payments-api");
  assert.equal(shortRepo("no-slash"), "no-slash");
});
