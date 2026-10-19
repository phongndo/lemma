import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Checks that focused tests catch the faults they are there for: each mutation puts one back (in the harness, or in a
// replacement provider the conformance suites run), in a copy of the working tree, and must fail its test with an
// assertion.
//
//   nix develop -c pnpm test:mutations
//
// Logs and vitest's reports for each, and `mutations.json`, are kept under LEMMA_TEST_ARTIFACTS (the OS temp
// directory by default).
const mutations = [
  {
    id: "replacement-provider-duplicate-terminal",
    file: "packages/testing/tests/providers.test.ts",
    from: 'scenario === "abort" ? Stream.concat(Stream.fromIterable(events), Stream.never) : Stream.fromIterable(events)',
    to: 'scenario === "abort" ? Stream.concat(Stream.fromIterable(events), Stream.never) : Stream.fromIterable([...events, events.at(-1)!])',
    test: "packages/testing/tests/providers.test.ts",
    name: "a reply has one terminal",
  },
  {
    id: "replacement-tool-loses-output",
    file: "packages/testing/tests/providers.test.ts",
    from: "Effect.forEach(chunks,",
    to: "Effect.forEach(chunks.slice(1),",
    test: "packages/testing/tests/providers.test.ts",
    name: "all output reaches the caller",
  },
  {
    id: "repair-not-durable",
    file: "domains/sessions/files/src/file.ts",
    from: "await handle.write(bytes, 0, bytesRead, from.lastStart);",
    to: "void bytesRead; // mutation: omit repair write",
    test: "domains/sessions/files/tests/simulation.test.ts",
    name: "a line left by an append whose sync and cut both failed",
  },
  {
    id: "unsafe-reexecuted",
    file: "domains/agent/contract/src/kit/turn.ts",
    from: 'listed.filter((tool) => tool.replay === "safe")',
    to: "listed.filter(() => true)",
    test: "domains/agent/loop/tests/crash.test.ts",
    name: "resumes a turn cut off after any",
  },
  {
    id: "queue-revision-backwards",
    file: "domains/agent/contract/src/kit/state.ts",
    from: "(last ?? 0) + 1",
    to: "(last ?? 0) + 0",
    test: "domains/agent/loop/tests/simulated.test.ts",
    name: "never takes a queue's revision back",
  },
  {
    id: "output-after-result",
    file: "domains/tools/registry/src/registry.ts",
    from: "Exit.isSuccess(exit) ? Fiber.join(sender) : Fiber.interrupt(sender)",
    to: "Fiber.interrupt(sender)",
    test: "domains/tools/registry/tests/tools.test.ts",
    name: "hands a slow listener every chunk",
  },
];
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const root = git("rev-parse", "--show-toplevel");
const evidenceRoot = process.env.LEMMA_TEST_ARTIFACTS ?? tmpdir();
mkdirSync(evidenceRoot, { recursive: true });
const output = mkdtempSync(join(evidenceRoot, "lemma-mutations-"));
const workspace = mkdtempSync(join(tmpdir(), "lemma-mutation-checkout-"));
const checkout = join(workspace, "current");
const results: { id: string; killed: boolean }[] = [];

type Mutation = (typeof mutations)[number];
/** Runs the mutation's one test in the checkout, keeping its log and vitest's JSON report beside the evidence. */
function focused(mutation: Mutation, mode: "control" | "mutant") {
  const report = join(output, `${mutation.id}-${mode}.json`);
  const run = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", mutation.test, "-t", mutation.name, "--reporter=default", "--reporter=json", "--outputFile=" + report],
    { cwd: checkout, encoding: "utf8", timeout: 120_000, env: { ...process.env, LEMMA_HARNESS_RUNS: "1" } },
  );
  writeFileSync(join(output, `${mutation.id}-${mode}.log`), run.stdout + run.stderr);
  const parsed = existsSync(report)
    ? (JSON.parse(readFileSync(report, "utf8")) as {
        numPassedTests: number;
        testResults: { assertionResults: { status: string; failureMessages: string[] }[] }[];
      })
    : undefined;
  return { status: run.status, parsed };
}

/** The test passes on the unmutated source: otherwise its failing under the mutant would prove nothing. */
function control(mutation: Mutation) {
  const { status, parsed } = focused(mutation, "control");
  if (status !== 0 || (parsed?.numPassedTests ?? 0) < 1) throw new Error(`The test for ${mutation.id} fails without the mutation; see ${output}`);
}

/** The mutant is killed only by a failed assertion: a build error or a timeout does not count. */
function killed(mutation: Mutation): boolean {
  const { status, parsed } = focused(mutation, "mutant");
  return (
    status !== 0 &&
    parsed?.testResults.some((file) =>
      file.assertionResults.some(
        (assertion) => assertion.status === "failed" && assertion.failureMessages.some((message) => message.includes("AssertionError")),
      ),
    ) === true
  );
}
try {
  git("worktree", "add", "--detach", checkout, "HEAD");
  // The working tree's edits over HEAD, new files included; the copy installs its own package links.
  const files = git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
  for (const file of files) {
    const target = join(checkout, file);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(join(root, file))) cpSync(join(root, file), target);
    else rmSync(target, { force: true });
  }
  execFileSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: checkout, stdio: "ignore" });
  execFileSync("pnpm", ["build"], { cwd: checkout, stdio: "ignore" });
  for (const mutation of mutations) {
    control(mutation);
    const file = join(checkout, mutation.file);
    const original = readFileSync(file, "utf8");
    if (original.split(mutation.from).length !== 2) throw new Error(`Mutation target moved: ${mutation.id}`);
    writeFileSync(file, original.replace(mutation.from, mutation.to));
    const caught = killed(mutation);
    writeFileSync(file, original);
    results.push({ id: mutation.id, killed: caught });
    console.log(`${caught ? "KILLED" : "SURVIVED"}: ${mutation.id}`);
  }
  if (results.some((result) => !result.killed)) process.exitCode = 1;
} finally {
  writeFileSync(join(output, "mutations.json"), JSON.stringify({ sha: git("rev-parse", "HEAD"), mutations, results }, null, 2) + "\n");
  try {
    git("worktree", "remove", "--force", checkout);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
  console.error(`Mutation evidence: ${output}`);
}
