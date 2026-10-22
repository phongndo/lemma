import { appendFileSync } from "node:fs";
import { relative } from "node:path";
import type { Reporter, TestCase, Vitest } from "vitest/node";

/*
 * Records a check that failed and then passed when CI tried it again (`--retry.count` for the tests, `--retry` for the
 * UI check): a warning on the run, with what its failed try said, and a line of JSON in `LEMMA_FLAKY_OUTPUT`, which
 * `scripts/file-issue.ts --flakes` files. docs/development.md says what CI does with a flake, and why.
 */

export interface Flake {
  /** The check, which its issue is titled by: a test file and the test's full name, or a UI check lane. */
  readonly name: string;
  /** The runner it flaked on. */
  readonly where: string;
  /** The tries it took to pass. */
  readonly tries: number;
  /** What its first failed try said. */
  readonly error: string;
}

/** A workflow command's message, escaped as GitHub reads it. */
const escape = (text: string) => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const firstLine = (text: string) => text.split("\n")[0] ?? "";

/** Appends to `file`, if one is named; a failure to is said, not thrown, so a check that passed is not failed by it. */
const append = (file: string | undefined, text: string, what: string) => {
  if (file === undefined || file === "") return;
  try {
    appendFileSync(file, text);
  } catch (error) {
    console.warn(`Could not record ${what} in ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/** Records `flake`: a warning, on the run when it is a GitHub Actions run, and a line in `LEMMA_FLAKY_OUTPUT` when set. */
export const recordFlake = (flake: Omit<Flake, "where">): Flake => {
  const recorded: Flake = { ...flake, where: process.env.RUNNER_OS ?? process.platform };
  const message = `${recorded.name} passed on try ${recorded.tries}; the failed try: ${firstLine(recorded.error)}`;
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::warning title=Flaky::${escape(message)}`);
  else console.warn(`flaky: ${message}`);
  append(process.env.LEMMA_FLAKY_OUTPUT, `${JSON.stringify(recorded)}\n`, "a flake");
  return recorded;
};

/** Lists `flakes` under `title` in the job's summary (`GITHUB_STEP_SUMMARY`), for checks vitest's summary does not cover. */
export const summarizeFlakes = (title: string, flakes: readonly Flake[]): void => {
  if (flakes.length === 0) return;
  const lines = flakes.map((flake) => `- \`${flake.name}\` passed on try ${flake.tries}; the failed try: ${firstLine(flake.error)}`);
  append(process.env.GITHUB_STEP_SUMMARY, `\n### ${title}\n\n${lines.join("\n")}\n`, "the flakes");
};

/** The tests that passed only on a retry, recorded (`reporters` in vitest.config.ts, on CI). */
export default class FlakyTests implements Reporter {
  private root = process.cwd();

  onInit(vitest: Vitest): void {
    this.root = vitest.config.root;
  }

  onTestCaseResult(test: TestCase): void {
    const diagnostic = test.diagnostic();
    if (diagnostic?.flaky !== true) return;
    const file = relative(this.root, test.module.moduleId).replaceAll("\\", "/");
    recordFlake({ name: `${file} > ${test.fullName}`, tries: diagnostic.retryCount + 1, error: test.result().errors?.[0]?.message ?? "" });
  }
}
