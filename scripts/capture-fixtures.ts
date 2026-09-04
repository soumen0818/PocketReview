/**
 * Capture real PRs as offline demo fixtures.
 *
 * `DEMO_MODE` is not cheating — it is the difference between a demo and a story
 * about a demo. This script captures genuine PRs from a real repository so the
 * app can run with the wifi physically unplugged, showing what the engine
 * actually produces rather than pre-computed answers.
 *
 * Usage:
 *   npm run capture -- --repo owner/name --limit 12
 *
 * Writes `fixtures/prs.json`. Diff patches are stripped: the fixtures carry
 * measurements, never source code, so committing them leaks nothing.
 */

import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { listRepoPRs } from "../src/lib/signals/github";
import { collectQueueSignals } from "../src/lib/signals/collect";
import { assessRisk } from "../src/lib/engines/risk-engine";
import { loadConfig } from "../src/lib/config";
import { stripPatch } from "../src/lib/signals/types";
import type { PRSignals } from "../src/lib/signals/types";

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const limit = Number(get("--limit") ?? 12);
  return {
    repo: get("--repo"),
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 30)) : 12,
  };
}

async function main() {
  const { repo, limit } = parseArgs(process.argv.slice(2));

  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    console.error("Usage: npm run capture -- --repo owner/name [--limit 12]");
    process.exit(1);
  }

  if (!process.env.GITHUB_TOKEN) {
    console.error("GITHUB_TOKEN is not set. Add it to .env.local.");
    process.exit(1);
  }

  console.log(`Capturing up to ${limit} open PRs from ${repo}…`);

  const config = await loadConfig();
  const summaries = await listRepoPRs(repo, limit);

  if (summaries.length === 0) {
    console.error(`No open PRs found in ${repo}.`);
    process.exit(1);
  }

  const signals = await collectQueueSignals(
    summaries.map((pr) => ({ repo: pr.repo, number: pr.number })),
    { rules: config.rules },
  );

  // Strip patches. The fixtures are committed, and diff content must not be.
  const safe: PRSignals[] = signals.map((s) => ({
    ...s,
    files: s.files.map((file) => stripPatch(file)),
  }));

  await mkdir(join(process.cwd(), "fixtures"), { recursive: true });
  await writeFile(
    join(process.cwd(), "fixtures", "prs.json"),
    JSON.stringify(
      { repo, capturedAt: new Date().toISOString(), signals: safe },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`\nCaptured ${safe.length} PRs → fixtures/prs.json\n`);
  for (const signal of safe) {
    const risk = assessRisk(signal, { thresholds: config.thresholds });
    console.log(
      `  #${String(signal.number).padStart(4)} ` +
        `${String(risk.score).padStart(3)} ${risk.level.padEnd(8)} ` +
        `${signal.title.slice(0, 48)}`,
    );
  }

  console.log(
    "\nPatches were stripped — the fixtures carry measurements, not source.",
  );
}

main().catch((error) => {
  console.error(
    "Capture failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
